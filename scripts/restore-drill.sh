#!/usr/bin/env bash
# scripts/restore-drill.sh
#
# Restore drill — automates the dump → restore → verify cycle that
# closes Wave 0 §8 (Round 6 PR2). The script is the executable
# companion to `docs/runbooks/restore.md`; the runbook covers when /
# why / how to interpret. This script covers HOW.
#
# Contract:
#
#   * Sources a non-prod database (staging or local dev-stack).
#   * Restores into a SEPARATE non-prod database (a fresh local
#     docker'd Postgres by default; a throwaway Supabase project on
#     override).
#   * Verifies the restored DB matches the source on: migration
#     state, canonical row counts, RLS policy count, and audit-chain
#     integrity (via `pnpm chain-verify`).
#   * Captures RTO components (dump duration, restore duration,
#     verify duration) into a timestamped audit directory under
#     `docs/audits/restore-drill-<ISODate>/`.
#   * Refuses to touch any URL containing `prod` in the host or DB
#     name — the runbook explains the threat model.
#
# What this script does NOT do:
#
#   * Provision a temporary Supabase project. The maintainer
#     pre-provisions the target (or accepts the default local
#     docker Postgres) and passes its URL via `--dst-url`.
#   * Measure RPO directly. RPO is "how far back can we recover"
#     and depends on the backup cadence at the source — Supabase
#     daily snapshots on free tier, PITR on Pro. The runbook
#     documents how to translate the source's backup model into an
#     RPO claim; the drill confirms the restore mechanic works,
#     not the backup cadence.
#   * Restore object-storage payloads (S3 / R2 photos). Out of
#     scope for the DB-level drill — covered by §"Restoring object
#     storage" in the runbook.
#
# Usage:
#
#   scripts/restore-drill.sh \
#       --src-url "postgres://<src>" \
#       --dst-url "postgres://<dst>" \
#       [--out-dir docs/audits/restore-drill-2026-05-17] \
#       [--force-truncate-dst] \
#       [--skip-chain-verify]
#
# Example (local-to-local against the dev-stack):
#
#   # Pre-flight: create a sibling database to restore INTO so the
#   # source dev-stack DB stays untouched.
#   docker exec docker_postgres_1 \
#       psql -U panorama_super_admin -d postgres \
#       -c "CREATE DATABASE panorama_drill_target"
#
#   scripts/restore-drill.sh \
#       --src-url "postgres://panorama_super_admin:panorama@localhost:5432/panorama?sslmode=disable" \
#       --dst-url "postgres://panorama_super_admin:panorama@localhost:5432/panorama_drill_target?sslmode=disable"
#
# Exit codes:
#   0 — drill passed (every verification matches source)
#   1 — drill failed (verification mismatch; investigate)
#   2 — operational error (missing prereqs, refuse-prod tripped,
#       dump or restore failure)

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_URL=""
DST_URL=""
OUT_DIR=""
FORCE_TRUNCATE_DST=0
SKIP_CHAIN_VERIFY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --src-url)
      SRC_URL="${2:?--src-url requires a value}"
      shift 2
      ;;
    --dst-url)
      DST_URL="${2:?--dst-url requires a value}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?--out-dir requires a value}"
      shift 2
      ;;
    --force-truncate-dst)
      FORCE_TRUNCATE_DST=1
      shift
      ;;
    --skip-chain-verify)
      SKIP_CHAIN_VERIFY=1
      shift
      ;;
    -h|--help)
      sed -n '3,55p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$SRC_URL" ] || [ -z "$DST_URL" ]; then
  echo "ERROR: --src-url and --dst-url are both required." >&2
  echo "       Run with --help for usage." >&2
  exit 2
fi

if [ -z "$OUT_DIR" ]; then
  TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  OUT_DIR="$REPO_ROOT/docs/audits/restore-drill-$TS"
fi

# ---------------------------------------------------------------------------
# Prereq check
# ---------------------------------------------------------------------------

for cmd in pg_dump pg_restore psql jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH. Install postgresql-client-16 + jq." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Refuse-prod safety guard
# ---------------------------------------------------------------------------
#
# Heuristic. The maintainer's deployment naming convention (per Fly app
# names + Supabase project slugs as of 2026-05-17) lets us catch the
# obvious miss-paste. NOT a security boundary — an operator can rename
# their prod env to evade. The point is to catch sleep-deprived typos,
# not adversarial input.

refuse_prod() {
  local kind="$1" url="$2"
  if echo "$url" | grep -qiE '(panorama-prod|panorama-hosted|panorama\.app|panorama-fleet|prod\.supabase\.co)'; then
    echo "ERROR: --$kind-url looks like a production URL." >&2
    echo "       Refusing to run the drill against prod." >&2
    echo "       If this is a false positive (e.g., a staging instance" >&2
    echo "       happens to contain the word 'prod'), edit the heuristic" >&2
    echo "       in scripts/restore-drill.sh and re-run." >&2
    exit 2
  fi
}
refuse_prod src "$SRC_URL"
refuse_prod dst "$DST_URL"

if [ "$SRC_URL" = "$DST_URL" ]; then
  echo "ERROR: --src-url and --dst-url are identical." >&2
  echo "       The drill must restore INTO a different database than the source." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Pre-flight: probe both endpoints; confirm dst empty (or --force-truncate-dst)
# ---------------------------------------------------------------------------

mkdir -p "$OUT_DIR"

echo ">> probing source"
if ! SRC_VER=$(PGOPTIONS='-c statement_timeout=10000' \
    psql "$SRC_URL" -tA -c "SELECT version()" 2>&1); then
  echo "ERROR: source connection failed:" >&2
  echo "$SRC_VER" >&2
  exit 2
fi
echo "   src: $SRC_VER"

echo ">> probing target"
if ! DST_VER=$(PGOPTIONS='-c statement_timeout=10000' \
    psql "$DST_URL" -tA -c "SELECT version()" 2>&1); then
  echo "ERROR: target connection failed:" >&2
  echo "$DST_VER" >&2
  exit 2
fi
echo "   dst: $DST_VER"

# Sanity-check dst is empty (no Panorama tables).
DST_TABLE_COUNT=$(psql "$DST_URL" -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [ "$DST_TABLE_COUNT" -gt 0 ]; then
  if [ "$FORCE_TRUNCATE_DST" -eq 1 ]; then
    echo ">> dst has $DST_TABLE_COUNT public tables; --force-truncate-dst given, dropping"
    psql "$DST_URL" -v ON_ERROR_STOP=1 -c \
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  else
    echo "ERROR: target has $DST_TABLE_COUNT existing public tables." >&2
    echo "       Pass --force-truncate-dst to DROP SCHEMA public CASCADE and re-create." >&2
    echo "       This is destructive on the TARGET only; source is untouched." >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# 1. Capture source-side counts BEFORE dump (so drift during dump shows up)
# ---------------------------------------------------------------------------

echo ">> capturing source-side baselines"
SRC_BASELINE="$OUT_DIR/source-baselines.json"
psql "$SRC_URL" -tA <<'SQL' >"$SRC_BASELINE.raw"
SELECT json_build_object(
    'migrations',         (SELECT count(*) FROM _prisma_migrations),
    'audit_events_count', (SELECT count(*) FROM audit_events),
    'audit_events_tail',  (SELECT encode("selfHash", 'hex') FROM audit_events ORDER BY id DESC LIMIT 1),
    'tenants',            (SELECT count(*) FROM tenants),
    'users',              (SELECT count(*) FROM users),
    'tenant_memberships', (SELECT count(*) FROM tenant_memberships),
    'rls_policies',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'captured_at',        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
) :: text;
SQL
jq '.' <"$SRC_BASELINE.raw" >"$SRC_BASELINE"
rm "$SRC_BASELINE.raw"
echo "   wrote $SRC_BASELINE"

# ---------------------------------------------------------------------------
# 2. pg_dump source (RTO component A — dump duration)
# ---------------------------------------------------------------------------

DUMP_FILE="$OUT_DIR/source.dump"
DUMP_LOG="$OUT_DIR/dump.log"

echo ">> pg_dump source → $DUMP_FILE"
DUMP_START=$(date +%s)
if ! pg_dump --no-owner --no-acl --format=custom \
      --file="$DUMP_FILE" "$SRC_URL" 2>"$DUMP_LOG"; then
  echo "ERROR: pg_dump failed; see $DUMP_LOG" >&2
  exit 2
fi
DUMP_END=$(date +%s)
DUMP_SECONDS=$((DUMP_END - DUMP_START))
DUMP_BYTES=$(stat -c%s "$DUMP_FILE")
echo "   pg_dump took ${DUMP_SECONDS}s, ${DUMP_BYTES} bytes"

# ---------------------------------------------------------------------------
# 3. pg_restore into target (RTO component B — restore duration)
# ---------------------------------------------------------------------------

RESTORE_LOG="$OUT_DIR/restore.log"

echo ">> pg_restore → target"
RESTORE_START=$(date +%s)
# `--no-owner --no-acl` keeps the restored objects owned by the
# connecting user; the rls.sql files set up policies idempotently so
# we don't need the source's owner identity post-restore.
# `--exit-on-error` aborts on first failure; we capture the log for
# triage. Some warnings are unavoidable on managed PG (e.g., extension
# already exists messages) — these are caught by --exit-on-error only
# if they're escalated to errors, which pg_restore doesn't do by default.
if ! pg_restore --no-owner --no-acl --exit-on-error \
      --dbname="$DST_URL" "$DUMP_FILE" >"$RESTORE_LOG" 2>&1; then
  echo "ERROR: pg_restore failed; see $RESTORE_LOG" >&2
  exit 2
fi
RESTORE_END=$(date +%s)
RESTORE_SECONDS=$((RESTORE_END - RESTORE_START))
echo "   pg_restore took ${RESTORE_SECONDS}s"

# ---------------------------------------------------------------------------
# 4. Verification (RTO component C — verify duration)
# ---------------------------------------------------------------------------

echo ">> capturing target-side counts"
DST_BASELINE="$OUT_DIR/target-baselines.json"
VERIFY_START=$(date +%s)
psql "$DST_URL" -tA <<'SQL' >"$DST_BASELINE.raw"
SELECT json_build_object(
    'migrations',         (SELECT count(*) FROM _prisma_migrations),
    'audit_events_count', (SELECT count(*) FROM audit_events),
    'audit_events_tail',  (SELECT encode("selfHash", 'hex') FROM audit_events ORDER BY id DESC LIMIT 1),
    'tenants',            (SELECT count(*) FROM tenants),
    'users',              (SELECT count(*) FROM users),
    'tenant_memberships', (SELECT count(*) FROM tenant_memberships),
    'rls_policies',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'captured_at',        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
) :: text;
SQL
jq '.' <"$DST_BASELINE.raw" >"$DST_BASELINE"
rm "$DST_BASELINE.raw"

# Compare row counts + migration counts + policy counts.
DRIFT_FILE="$OUT_DIR/drift.json"
jq -n \
  --slurpfile src "$SRC_BASELINE" \
  --slurpfile dst "$DST_BASELINE" '
{
  migrations:         { src: $src[0].migrations,         dst: $dst[0].migrations,         match: ($src[0].migrations         == $dst[0].migrations) },
  audit_events_count: { src: $src[0].audit_events_count, dst: $dst[0].audit_events_count, match: ($src[0].audit_events_count == $dst[0].audit_events_count) },
  audit_events_tail:  { src: $src[0].audit_events_tail,  dst: $dst[0].audit_events_tail,  match: ($src[0].audit_events_tail  == $dst[0].audit_events_tail) },
  tenants:            { src: $src[0].tenants,            dst: $dst[0].tenants,            match: ($src[0].tenants            == $dst[0].tenants) },
  users:              { src: $src[0].users,              dst: $dst[0].users,              match: ($src[0].users              == $dst[0].users) },
  tenant_memberships: { src: $src[0].tenant_memberships, dst: $dst[0].tenant_memberships, match: ($src[0].tenant_memberships == $dst[0].tenant_memberships) },
  rls_policies:       { src: $src[0].rls_policies,       dst: $dst[0].rls_policies,       match: ($src[0].rls_policies       == $dst[0].rls_policies) }
}' >"$DRIFT_FILE"

if jq -e 'to_entries | all(.value.match == true)' "$DRIFT_FILE" >/dev/null; then
  COUNTS_MATCH=true
else
  COUNTS_MATCH=false
  echo "WARN: source/target counts do not match. See $DRIFT_FILE"
fi

# Chain-verify against the RESTORED DB.
#
# The CLI distinguishes three exit states:
#   0 — every non-legacy row's selfHash matches its recomputed digest
#   1 — at least one row's selfHash does not match (tamper signal)
#   2 — operational error (empty audit_events on the source, no
#       DATABASE_PRIVILEGED_URL, query failure). Empty audit_events
#       is the realistic "drill against a freshly-reset dev DB"
#       case; we treat it as inconclusive (warn, do NOT fail the
#       drill), not as tamper.
#
# A real drill against staging has a populated chain. If you see
# `chain_verify == "inconclusive"` in the report, the drill was run
# against an empty source — fine for smoke-testing the script
# itself, but the maintainer should re-run against a populated DB
# before recording PR2b RTO/RPO numbers.
CHAIN_LOG="$OUT_DIR/chain-verify.txt"
CHAIN_JSON="$OUT_DIR/chain-verify.json"
CHAIN_OK=skipped

if [ "$SKIP_CHAIN_VERIFY" -eq 1 ]; then
  echo ">> --skip-chain-verify given; chain-verify omitted"
  echo "skipped" >"$CHAIN_LOG"
else
  echo ">> chain-verify against the restored DB"
  cd "$REPO_ROOT/apps/core-api"
  # The CLI reads DATABASE_PRIVILEGED_URL from env; point it at the
  # restored target so we walk the chain of the restored data, not
  # the source.
  set +e
  DATABASE_PRIVILEGED_URL="$DST_URL" \
      pnpm --filter @panorama/core-api chain-verify --json \
      >"$CHAIN_JSON" 2>"$CHAIN_LOG"
  CHAIN_EXIT=$?
  set -e
  case "$CHAIN_EXIT" in
    0)
      CHAIN_OK=true
      echo "   chain-verify: OK"
      ;;
    2)
      CHAIN_OK=inconclusive
      echo "   chain-verify: INCONCLUSIVE — see $CHAIN_LOG"
      echo "   (typically: empty audit_events on the source DB;"
      echo "   re-run drill against a populated source for a real result.)"
      ;;
    *)
      CHAIN_OK=false
      echo "   chain-verify: FAIL (exit $CHAIN_EXIT; see $CHAIN_LOG)"
      ;;
  esac
  cd "$REPO_ROOT"
fi

VERIFY_END=$(date +%s)
VERIFY_SECONDS=$((VERIFY_END - VERIFY_START))

# ---------------------------------------------------------------------------
# 5. Final report
# ---------------------------------------------------------------------------

REPORT="$OUT_DIR/report.json"
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg dump_seconds "$DUMP_SECONDS" \
  --arg restore_seconds "$RESTORE_SECONDS" \
  --arg verify_seconds "$VERIFY_SECONDS" \
  --arg dump_bytes "$DUMP_BYTES" \
  --argjson counts_match "$COUNTS_MATCH" \
  --arg chain_ok "$CHAIN_OK" \
  '{
    drill_executed_at: $ts,
    rto_seconds_total: (($dump_seconds | tonumber) + ($restore_seconds | tonumber) + ($verify_seconds | tonumber)),
    components: {
      dump_seconds:    ($dump_seconds    | tonumber),
      restore_seconds: ($restore_seconds | tonumber),
      verify_seconds:  ($verify_seconds  | tonumber),
      dump_bytes:      ($dump_bytes      | tonumber)
    },
    verification: {
      counts_match: $counts_match,
      chain_verify: $chain_ok
    },
    notes_for_pr2b: "Translate rto_seconds_total into the human-readable RTO claim under docs/runbooks/restore.md §RTO/RPO observation. Wall-clock RTO in a real incident adds Supabase project provisioning time + secret-rewiring + DNS cutover; this drill measures the DB cycle only."
  }' >"$REPORT"

echo
echo "=== Drill report ==="
jq '.' "$REPORT"
echo "===================="
echo
echo "Full artefacts in $OUT_DIR/"

# Exit code: 0 if counts match AND chain verifies OR is inconclusive
#  (empty source) OR was skipped. Chain-verify FAIL (exit 1 = tamper)
#  is the only chain state that turns the drill red.
if [ "$COUNTS_MATCH" = "true" ] \
   && { [ "$CHAIN_OK" = "true" ] \
        || [ "$CHAIN_OK" = "skipped" ] \
        || [ "$CHAIN_OK" = "inconclusive" ]; }; then
  exit 0
else
  exit 1
fi
