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

# Convert OUT_DIR to absolute path. Later steps cd to apps/core-api
# for pnpm chain-verify; relative paths break after that.
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# Echo OUT_DIR up front so a stderr tail in any later failure points at
# the artefact dir (per tech-lead per-PR scan concern).
echo ">> artefact dir: $OUT_DIR" >&2

# ---------------------------------------------------------------------------
# Prereq check + pg-client version-match policy
# ---------------------------------------------------------------------------
#
# pg_dump refuses to dump a server whose major version is newer than the
# client's major (it accepts SAME or OLDER server). Real-world drift:
# Supabase upgraded staging to PG17 while the local dev-stack runs PG16.
# Solution: if local pg_dump major < server major, fall back to running
# pg_dump/pg_restore inside a `postgres:<server-major>` Docker container.
# psql + jq are local-only (no version coupling on the client side for
# the simple metadata queries we run).

for cmd in psql jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH. Install postgresql-client + jq." >&2
    exit 2
  fi
done

# Detect server major version via psql (any client version connects).
# `server_version_num` is integer like 170006 (= 17.6); divide by 10000
# for the major (= 17). Cached so we only probe once per drill.
detect_server_major() {
  local url="$1"
  # `server_version_num` is a GUC, not a column — access via
  # current_setting('server_version_num'). For PG 17.6 this returns
  # '170006'; divided by 10000 gives 17.
  PGPASSWORD="$(echo "$url" | sed -nE 's|^[a-z]+://[^:]+:([^@]+)@.*|\1|p')" \
    psql "$(echo "$url" | sed -E 's|//([^:/@]+):[^@]+@|//\1@|')" \
    -tA -c "SELECT current_setting('server_version_num')::int / 10000" 2>/dev/null \
    | tr -d '[:space:]' \
    | head -c 4
}

# Decide whether to use local pg_dump or Docker fallback.
# Source + target may run different majors; we run the dump under
# max(src_major, dst_major) since that's the version compatible with both
# server-side reads + the restore-target's expectations.
DRILL_PG_DUMP="pg_dump"
DRILL_PG_RESTORE="pg_restore"
USE_DOCKER_PG=0
TARGET_PG_MAJOR=""

# Defer the version-decision logic until SRC_URL + DST_URL are known
# (after refuse-prod). The function below is invoked after pre-flight.
choose_pg_client() {
  local src_major dst_major needed_major local_dump_major
  src_major=$(detect_server_major "$SRC_URL")
  dst_major=$(detect_server_major "$DST_URL")
  if [ -z "$src_major" ] || [ -z "$dst_major" ]; then
    echo "ERROR: failed to detect server PG major version on one of the URLs." >&2
    exit 2
  fi
  # Use the max of the two — the client must support both server-side
  # protocol versions; the higher major is backward-compatible with the
  # lower major on both dump + restore for our use case.
  if [ "$src_major" -ge "$dst_major" ]; then
    needed_major="$src_major"
  else
    needed_major="$dst_major"
  fi
  TARGET_PG_MAJOR="$needed_major"
  echo "   server PG majors: src=$src_major, dst=$dst_major; pg-client target=$needed_major" >&2

  if command -v pg_dump >/dev/null 2>&1; then
    local_dump_major=$(pg_dump --version | awk '{print $3}' | cut -d. -f1)
    if [ "$local_dump_major" -ge "$needed_major" ]; then
      echo "   using LOCAL pg_dump $local_dump_major (>= $needed_major)" >&2
      DRILL_PG_DUMP="pg_dump"
      DRILL_PG_RESTORE="pg_restore"
      return
    fi
    echo "   LOCAL pg_dump $local_dump_major < server $needed_major; trying Docker fallback" >&2
  else
    echo "   LOCAL pg_dump NOT FOUND; trying Docker fallback" >&2
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: pg_dump version mismatch (need PG $needed_major)" >&2
    echo "       AND docker not available for fallback. Install postgresql-client-$needed_major." >&2
    exit 2
  fi

  USE_DOCKER_PG=1
  echo "   using DOCKER pg_dump via postgres:$needed_major image" >&2
}

# ---------------------------------------------------------------------------
# Refuse-prod safety guard
# ---------------------------------------------------------------------------
#
# Heuristic. The maintainer's deployment naming convention (per Fly app
# names + Supabase project slugs as of 2026-05-17) lets us catch the
# obvious miss-paste. NOT a security boundary — an operator can rename
# their prod env to evade. The point is to catch sleep-deprived typos,
# not adversarial input.
#
# Self-hoster override: export `PANORAMA_DRILL_REFUSE_REGEX` to add your
# own prod-environment regex (joined with OR to the default). This is the
# right hook for an operator running `acmecorp-prod.example.com` whose
# host string doesn't match the maintainer's regex by default.

REFUSE_REGEX_DEFAULT='(panorama-prod|panorama-hosted|panorama\.app|panorama-fleet|prod\.supabase\.co)'
REFUSE_REGEX="$REFUSE_REGEX_DEFAULT"
if [ -n "${PANORAMA_DRILL_REFUSE_REGEX:-}" ]; then
  REFUSE_REGEX="${REFUSE_REGEX_DEFAULT}|(${PANORAMA_DRILL_REFUSE_REGEX})"
fi

refuse_prod() {
  local kind="$1" url="$2"
  if echo "$url" | grep -qiE "$REFUSE_REGEX"; then
    echo "ERROR: --$kind-url looks like a production URL." >&2
    echo "       Refusing to run the drill against prod." >&2
    echo "       If this is a false positive (e.g., a staging instance" >&2
    echo "       happens to contain the word 'prod'), edit the heuristic" >&2
    echo "       in scripts/restore-drill.sh OR set PANORAMA_DRILL_REFUSE_REGEX" >&2
    echo "       to a different pattern, and re-run." >&2
    exit 2
  fi
}
refuse_prod src "$SRC_URL"
refuse_prod dst "$DST_URL"

# URL normalization for the identical-src/dst check.
# Strip the query string + trailing slash so `host/db` and
# `host/db?sslmode=disable` and `host/db/` all compare equal.
normalize_url() {
  echo "$1" | sed -E -e 's|\?.*$||' -e 's|/$||'
}

if [ "$(normalize_url "$SRC_URL")" = "$(normalize_url "$DST_URL")" ]; then
  echo "ERROR: --src-url and --dst-url resolve to the same database after" >&2
  echo "       normalising (query string + trailing slash stripped)." >&2
  echo "       The drill must restore INTO a different database than the source." >&2
  exit 2
fi

# --force-truncate-dst extra confirmation: the target DB name should
# contain `drill` or `test` to reduce the chance of an operator typo
# accidentally DROP SCHEMA'ing a different non-prod DB on the same host.
# Override with `PANORAMA_DRILL_ALLOW_ANY_TARGET=1` if the operator has
# audited the target manually.
if [ "$FORCE_TRUNCATE_DST" -eq 1 ]; then
  DST_DBNAME=$(echo "$DST_URL" | sed -E 's|^.*/([^/?]+)(\?.*)?$|\1|')
  if ! echo "$DST_DBNAME" | grep -qiE '(drill|test)'; then
    if [ "${PANORAMA_DRILL_ALLOW_ANY_TARGET:-0}" != "1" ]; then
      echo "ERROR: --force-truncate-dst would DROP SCHEMA public CASCADE on" >&2
      echo "       database '$DST_DBNAME' — name does not contain 'drill' or 'test'." >&2
      echo "       Either (a) rename the target DB, OR (b) set" >&2
      echo "       PANORAMA_DRILL_ALLOW_ANY_TARGET=1 if you've audited it." >&2
      exit 2
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Pre-flight: probe both endpoints; confirm dst empty (or --force-truncate-dst)
# ---------------------------------------------------------------------------

mkdir -p "$OUT_DIR"

# DB-identity probe — confirm WHICH database the URL points at BEFORE
# we trust the URL with destructive operations. SELECT version() alone
# (the previous shape) only proves Postgres responded; it doesn't
# distinguish staging from prod by inspection. Per persona-fleet-ops
# per-PR scan finding "no 'what database is this' pre-flight command".
probe_db_identity() {
  local kind="$1" url="$2"
  local result
  # `tenants` may not exist on the target before restore. Postgres
  # parses CASE-branch subqueries at plan time regardless of branch
  # selection, so we resolve the count via PL/pgSQL DO with dynamic
  # SQL — only runs the count if to_regclass confirms the table.
  if ! result=$(PGOPTIONS='-c statement_timeout=10000' psql "$url" -tA <<'SQL' 2>&1
DO $$
DECLARE
    tenant_count bigint := -1;
BEGIN
    IF to_regclass('public.tenants') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM tenants' INTO tenant_count;
    END IF;
    RAISE NOTICE '%', json_build_object(
        'database',  current_database(),
        'server',    coalesce(inet_server_addr()::text, 'unix'),
        'port',      coalesce(inet_server_port()::text, 'unix'),
        'user',      current_user,
        'tenants',   tenant_count
    )::text;
END $$;
SQL
); then
    echo "ERROR: $kind connection failed:" >&2
    echo "$result" >&2
    exit 2
  fi
  # psql emits NOTICE messages on stderr by default with "NOTICE: "
  # prefix; we redirected 2>&1 above so it's in $result. Extract just
  # the JSON payload (the line after "NOTICE:  ").
  local payload
  payload=$(echo "$result" | sed -nE 's|^NOTICE:[[:space:]]+(.*)$|\1|p' | tail -1)
  echo "   $kind: $payload" >&2
  echo "$payload"
}

echo ">> probing source"
SRC_PROBE=$(probe_db_identity src "$SRC_URL")
echo ">> probing target"
DST_PROBE=$(probe_db_identity dst "$DST_URL")

# Confirm the source has tenants — a real drill against an empty
# source is the smoke-test-the-script flow, not the canonical drill.
# Continue but log a warning so the operator knows.
SRC_TENANT_COUNT=$(echo "$SRC_PROBE" | jq -r '.tenants')
if [ "$SRC_TENANT_COUNT" = "0" ] || [ "$SRC_TENANT_COUNT" = "-1" ]; then
  echo "   WARNING: source has 0 tenants (or no tenants table)." >&2
  echo "            Drill output is smoke-only — re-run against a" >&2
  echo "            populated source for a real result." >&2
fi

# Sanity-check dst is empty (no Panorama tables) AND drop the bare
# `public` schema even when empty, because pg_dump --schema=public
# emits `CREATE SCHEMA public;` and a vanilla Postgres target has
# a pre-existing empty public schema (since PG15+ created at initdb).
# With --force-truncate-dst opt-in, we unconditionally drop+create
# public to give pg_restore a clean slate.
DST_TABLE_COUNT=$(psql "$DST_URL" -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [ "$DST_TABLE_COUNT" -gt 0 ] || [ "$FORCE_TRUNCATE_DST" -eq 1 ]; then
  if [ "$FORCE_TRUNCATE_DST" -eq 1 ]; then
    echo ">> --force-truncate-dst given; dropping + recreating public schema (dst had $DST_TABLE_COUNT existing tables)"
    psql "$DST_URL" -v ON_ERROR_STOP=1 -c \
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
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
# Password extraction — keep the secret out of argv / /proc/<pid>/cmdline.
# ---------------------------------------------------------------------------
# Per security-reviewer per-PR scan finding (CWE-214). Long-lived
# pg_dump + pg_restore put the password in argv otherwise. Decompose
# the URL once into PGPASSWORD env + a URL with the password stripped;
# libpq reads PGPASSWORD when the URL omits a password.
extract_password() {
  echo "$1" | sed -nE 's|^[a-z]+://[^:]+:([^@]+)@.*|\1|p'
}
strip_password() {
  # Replace `://user:password@host` with `://user@host`. No-op for URLs
  # that don't have a password.
  echo "$1" | sed -E 's|//([^:/@]+):[^@]+@|//\1@|'
}

SRC_PASS=$(extract_password "$SRC_URL")
SRC_URL_NOPASS=$(strip_password "$SRC_URL")
DST_PASS=$(extract_password "$DST_URL")
DST_URL_NOPASS=$(strip_password "$DST_URL")

# Choose pg_dump/pg_restore (local or Docker) based on src+dst PG majors.
choose_pg_client

# ---------------------------------------------------------------------------
# 2. pg_dump source (RTO component A — dump duration)
# ---------------------------------------------------------------------------

DUMP_FILE="$OUT_DIR/source.dump"
DUMP_LOG="$OUT_DIR/dump.log"
DUMP_FILE_ABS="$(cd "$(dirname "$DUMP_FILE")" && pwd)/$(basename "$DUMP_FILE")"

echo ">> pg_dump source → $DUMP_FILE"
DUMP_START=$(date +%s)
# `--schema=public` would restrict the dump to the Panorama schema,
# but pg_dump's CREATE SCHEMA public conflicts with a pre-existing
# public schema on every target. Easier path: dump everything,
# excluding provider-internal schemas (Supabase: auth/storage/
# realtime/pgsodium/vault). The dump self-contains the extension
# DDL the tables need.
#
# For Supabase-source drills, target MUST be `supabase/postgres:N`
# image (vanilla postgres lacks pg_cron, supabase_vault, etc.).
# For self-hosted-source drills against vanilla, no exclusions
# needed; the script auto-detects via try-and-fail.
PG_DUMP_FLAGS="--no-owner --no-acl --format=custom \
  --exclude-schema=auth \
  --exclude-schema=storage \
  --exclude-schema=realtime \
  --exclude-schema=_realtime \
  --exclude-schema=pgsodium \
  --exclude-schema=pgsodium_masks \
  --exclude-schema=vault \
  --exclude-schema=graphql \
  --exclude-schema=graphql_public \
  --exclude-schema=net \
  --exclude-schema=supabase_functions \
  --exclude-schema=supabase_migrations \
  --exclude-schema='pg\\_temp\\_%' \
  --exclude-schema='pg\\_toast\\_temp\\_%'"

if [ "$USE_DOCKER_PG" -eq 1 ]; then
  # Docker pg_dump fallback. --network host lets the container reach
  # the Supabase server + the local docker_postgres_1 on its DNS name.
  # Mount the OUT_DIR so the dump file is written to the host filesystem
  # directly.
  if ! docker run --rm --network host \
        -e PGPASSWORD="$SRC_PASS" \
        -v "$(cd "$OUT_DIR" && pwd):/out" \
        "postgres:${TARGET_PG_MAJOR}" \
        pg_dump $PG_DUMP_FLAGS \
        --file="/out/$(basename "$DUMP_FILE")" "$SRC_URL_NOPASS" 2>"$DUMP_LOG"; then
    echo "ERROR: pg_dump (docker) failed; see $DUMP_LOG" >&2
    exit 2
  fi
else
  if ! PGPASSWORD="$SRC_PASS" pg_dump $PG_DUMP_FLAGS \
        --file="$DUMP_FILE" "$SRC_URL_NOPASS" 2>"$DUMP_LOG"; then
    echo "ERROR: pg_dump failed; see $DUMP_LOG" >&2
    exit 2
  fi
fi
DUMP_END=$(date +%s)
DUMP_SECONDS=$((DUMP_END - DUMP_START))
DUMP_BYTES=$(stat -c%s "$DUMP_FILE")
echo "   pg_dump took ${DUMP_SECONDS}s, ${DUMP_BYTES} bytes"

# ---------------------------------------------------------------------------
# 2b. Pre-restore bootstrap — install extensions + create roles on target.
# ---------------------------------------------------------------------------
# pg_dump --schema=public excludes CREATE EXTENSION (extensions are
# pg_catalog-scoped). The dumped tables reference types like
# `public.citext` that depend on the citext extension being installed
# BEFORE the tables are restored. Solution: run supabase-bootstrap.sql
# on the target first, which CREATE EXTENSION IF NOT EXISTS the
# panorama-required extensions (citext, pgcrypto, uuid-ossp,
# btree_gist) and creates the panorama_app + panorama_super_admin
# roles needed for the post-restore rls.sql GRANTs.

PREBOOT_LOG="$OUT_DIR/prerestore-bootstrap.log"
if [ -f "$REPO_ROOT/apps/core-api/prisma/supabase-bootstrap.sql" ]; then
  echo ">> pre-restore bootstrap (extensions + roles)"
  if ! PGPASSWORD="$DST_PASS" psql "$DST_URL_NOPASS" -v ON_ERROR_STOP=1 \
        -f "$REPO_ROOT/apps/core-api/prisma/supabase-bootstrap.sql" \
        >"$PREBOOT_LOG" 2>&1; then
    echo "ERROR: pre-restore bootstrap failed; see $PREBOOT_LOG" >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# 3. pg_restore into target (RTO component B — restore duration)
# ---------------------------------------------------------------------------

RESTORE_LOG="$OUT_DIR/restore.log"

echo ">> pg_restore → target"
RESTORE_START=$(date +%s)
# `--no-owner --no-acl` keeps the restored objects owned by the
# connecting user; the post-restore `apply-migrations.sh` step below
# re-establishes panorama_app / panorama_super_admin grants + RLS
# policies (per tech-lead per-PR scan finding on schema-grant loss).
# `--exit-on-error` aborts on first failure; we capture the log for
# triage. `--verbose` writes per-object progress to stderr so the
# operator can confirm the restore is making progress on long runs.
if [ "$USE_DOCKER_PG" -eq 1 ]; then
  if ! docker run --rm --network host \
        -e PGPASSWORD="$DST_PASS" \
        -v "$(cd "$OUT_DIR" && pwd):/out" \
        "postgres:${TARGET_PG_MAJOR}" \
        pg_restore --no-owner --no-acl --exit-on-error --verbose \
        --dbname="$DST_URL_NOPASS" "/out/$(basename "$DUMP_FILE")" \
        >"$RESTORE_LOG" 2>&1; then
    echo "ERROR: pg_restore (docker) failed; see $RESTORE_LOG" >&2
    exit 2
  fi
else
  if ! PGPASSWORD="$DST_PASS" pg_restore --no-owner --no-acl --exit-on-error --verbose \
        --dbname="$DST_URL_NOPASS" "$DUMP_FILE" >"$RESTORE_LOG" 2>&1; then
    echo "ERROR: pg_restore failed; see $RESTORE_LOG" >&2
    exit 2
  fi
fi
RESTORE_END=$(date +%s)
RESTORE_SECONDS=$((RESTORE_END - RESTORE_START))
echo "   pg_restore took ${RESTORE_SECONDS}s"

# ---------------------------------------------------------------------------
# 3b. Re-apply grants + RLS policies against the restored target.
# ---------------------------------------------------------------------------
# pg_dump --no-acl strips GRANTs from the dump; pg_restore brings the
# tables back without USAGE/SELECT/INSERT/etc. grants to panorama_app /
# panorama_super_admin. Without re-grants the restored DB looks fine
# under the super-admin connecting user but the application can't
# read anything. Per tech-lead per-PR scan veto.
#
# We invoke just the bootstrap + rls.sql parts of apply-migrations.sh,
# NOT prisma migrate deploy (which would be a no-op anyway since
# pg_restore already brought the migrations along, and the .bin/prisma
# wrapper isn't guaranteed to be node-executable across all dev shapes).
# bootstrap.sql + rls.sql are CREATE-OR-REPLACE / DROP-IF-EXISTS, so
# they converge on the right grant + policy shape idempotently.

REAPPLY_LOG="$OUT_DIR/reapply-migrations.log"
echo ">> re-applying rls.sql against target (re-establishes grants + policies)"
{
  # Pre-restore bootstrap (§2b) already ran extensions + role creation.
  # Re-running bootstrap here is also idempotent (CREATE EXTENSION
  # IF NOT EXISTS + DO blocks); we run it again to ensure any post-
  # restore role state matches what the rls.sql files expect (handles
  # the edge case where the dump includes an explicit ROLE grant the
  # bootstrap re-asserts).
  echo "===== bootstrap (idempotent re-apply) ====="
  if [ -f "$REPO_ROOT/apps/core-api/prisma/supabase-bootstrap.sql" ]; then
    PGPASSWORD="$DST_PASS" psql "$DST_URL_NOPASS" -v ON_ERROR_STOP=1 \
      -f "$REPO_ROOT/apps/core-api/prisma/supabase-bootstrap.sql"
  fi

  echo "===== rls.sql loop ====="
  for dir in "$REPO_ROOT/apps/core-api/prisma/migrations/"*/; do
    rls="${dir}rls.sql"
    if [ -f "$rls" ]; then
      echo ">>> apply $rls"
      PGPASSWORD="$DST_PASS" psql "$DST_URL_NOPASS" -v ON_ERROR_STOP=1 -f "$rls"
    fi
  done
} >"$REAPPLY_LOG" 2>&1 || {
  echo "ERROR: bootstrap + rls.sql re-apply failed; see $REAPPLY_LOG" >&2
  exit 2
}
echo "   re-apply ok"

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
# The CLI exit contract is documented in
# `apps/core-api/src/scripts/verify-audit-chain.ts:31-37`:
#   0 — every non-legacy row's selfHash matches its recomputed digest
#   1 — at least one row's selfHash does not match (tamper signal)
#   2 — operational error (empty audit_events on the source, no
#       DATABASE_PRIVILEGED_URL, query failure). Empty audit_events
#       is the realistic "drill against a freshly-reset dev DB"
#       case; we surface it as `inconclusive` (drill exit 3, neither
#       PASS nor FAIL) so a CI cron or PR2b reviewer can distinguish
#       "drill not exercised" from "drill passed".
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

# Exit code:
#   0 — drill PASS: counts match AND chain-verify OK (or skipped)
#   1 — drill FAIL: count mismatch OR chain-verify tamper
#   2 — operational error (covered by exits earlier in the script)
#   3 — drill INCONCLUSIVE: counts match but chain-verify was
#       INCONCLUSIVE (empty source audit_events). Surface this
#       separately so CI cron or PR2b reviewer can distinguish
#       "drill not exercised" from "drill passed" — a freshly-reset
#       dev DB with no audit rows is not a passing drill.
if [ "$COUNTS_MATCH" = "true" ]; then
  case "$CHAIN_OK" in
    true|skipped) exit 0 ;;
    inconclusive) exit 3 ;;
    *) exit 1 ;;
  esac
else
  exit 1
fi
