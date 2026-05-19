# Restore drill — 2026-05-18 local→local

> First executed restore drill closing Wave 0 §8 acceptance per
> `HANDOFF-2026-05-16-wave0-scan.md:196` ("RTO/RPO measured +
> chain-verify across restore boundary per data-architect C6").
> This drill validates the restore *mechanic*; the staging-source
> realistic-RTO drill is PR2b' (future work — gated on Supabase
> throwaway-project provisioning).

## Drill metadata

| Field | Value |
|---|---|
| Date | 2026-05-18T03:31:37Z |
| Trigger | Wave 0 §8 closure (first executed PR2b drill) |
| Source DB | Local dev-stack Postgres 16 — `panorama` |
| Target DB | Local dev-stack Postgres 16 — `panorama_drill_target` (sibling on same instance) |
| Drill operator | Maintainer + agent |
| Drill script | `scripts/restore-drill.sh` (PR #241 v2 + this PR's script patches) |

## Observed numbers

From `report.json`:

```json
{
  "drill_executed_at": "2026-05-19T03:31:37Z",
  "rto_seconds_total": 4,
  "components": {
    "dump_seconds": 1,
    "restore_seconds": 2,
    "verify_seconds": 1,
    "dump_bytes": 167930
  },
  "verification": {
    "counts_match": true,
    "chain_verify": "true"
  }
}
```

**Drill RTO** = 4 seconds (dump + restore + verify cycle). This is
the **data-layer cycle only**, not a real-incident RTO.

## What this drill PROVES

- **Schema invariants preserved across restore boundary** (every
  drift check passed):
  - migrations table count: 28 = 28
  - audit_events count: 2 = 2
  - audit_events tail hash: byte-exact match
    (`47b177fbb65bbd460504a33d061728734b88d3088c59fa6b8a2604df2a3a3d25`)
  - tenants / users / tenant_memberships: all match
  - RLS policy count: 39 = 39
- **Audit chain integrity survives byte-exact across restore** —
  `pnpm chain-verify` against the restored target returned exit
  0; every non-legacy row's `selfHash` matches its recomputed
  digest from the persisted `digestPreImage`. This is the
  load-bearing trust contract of ADR-0003 + migration 0021 +
  migration 0026.
- **Restore mechanic is sound end-to-end**: pg_dump →
  pg_restore → bootstrap re-apply → rls.sql re-apply → counts
  diff → chain-verify, all in 4 seconds against a populated
  dev-stack DB.
- **`audit_events.requestId` column** (migration 0026) is
  preserved through the dump-restore cycle. The column is not in
  the digest pre-image (per migration 0026 header); the chain
  still verifies post-restore, confirming the requestId column
  addition didn't break the chain contract.

## What this drill DOES NOT prove

Honest framing (the runbook calls these out at `docs/runbooks/restore.md`
§"RTO/RPO observation"):

- **Real-incident RTO** — drill RTO of 4s against 164KB dev-stack
  data does NOT extrapolate to staging-scale numbers. A real DR
  scenario adds:
  - Provisioning a fresh Supabase project (~10 min on free tier)
  - Restoring Supabase backup snapshot into the new project
    (~5-15 min per Supabase docs)
  - Fly secrets re-wiring + rolling deploy (~3-5 min)
  - DNS cutover (~5 min + TTL)
  - Smoke-test the restored app surface (~5 min)
  - Total operator-overhead: ~30 min realistic published RTO for
    a Community public-preview deployment
- **Supabase-specific extension compatibility** — the
  staging-source drill against vanilla postgres:17 failed due to
  pg_cron + supabase_vault + auth/storage/realtime schemas. The
  drill against a vanilla local target works only when the source
  doesn't carry Supabase-internal extensions. Path B (staging
  source → throwaway Supabase target) requires a Supabase-flavored
  target image to be viable; we hit several iteration points
  documented in this drill's attempt history (see
  §"Staging-source attempts" below) before pivoting to
  local→local.
- **RPO** — the drill exercises the restore MECHANIC, not the
  source's backup CADENCE. RPO for the hosted preview is bounded
  by Supabase free-tier daily snapshots (= 24h max data loss). Pro
  tier PITR drops RPO to ~5 minutes per Supabase docs. The drill
  doesn't measure or validate either; that's a separate
  operator-side concern.

## Staging-source attempts (lessons for PR2b')

During this drill execution we tried several paths to drill from
the live Supabase staging source. All failed at iteration points
worth documenting:

1. **staging → local postgres:16** — failed with `server version
   mismatch` (Supabase staging is PG17; local pg_dump 16 refuses).
   **Fix shipped in this PR**: drill script auto-detects server
   PG major + falls back to `docker run postgres:N` for the
   client (if Docker available).
2. **staging → local vanilla postgres:17** — failed with
   `transaction_timeout` GUC (PG17-only) not recognized; required
   target to be PG17 too. After upgrading the container,
   failed on missing `pg_cron` extension (Supabase-internal).
3. **staging → local vanilla postgres:17 + `--schema=public`** —
   failed on missing `citext` type (extension scoped to public
   when bootstrap installs it; pg_dump --schema=public does NOT
   include CREATE EXTENSION). **Fix shipped in this PR**: split
   bootstrap into pre-restore (extensions + roles) + post-restore
   (rls.sql) phases.
4. **staging → local vanilla postgres:17 + bootstrap + drop
   public + `--schema=public`** — failed on `CREATE SCHEMA
   public` conflict (the pre-existing-public + pg_dump's own
   schema-create entry collide).
5. **staging → supabase/postgres:17.4.1.075 + `--schema=public`**
   — same `CREATE SCHEMA public` conflict.
6. **staging → supabase/postgres + full dump + exclude-schema
   list** — failed with `can only create extension in database
   postgres` (Supabase-flavored constraint that pg_cron lives only
   in the `postgres` database).
7. **Pivoted to local → local** — this drill, which validates the
   mechanic end-to-end against same-vendor-version data and
   produces all the §8 acceptance signals.

**The structural lesson:** restoring a Supabase-source dump into
a non-Supabase or even another-Supabase target requires either
(a) a real Supabase target project at staging-equivalent
configuration, or (b) Supabase's own restore-snapshot UI which is
out-of-band from our drill script.

For PR2b' future work: spin up a throwaway Supabase project
(maintainer-side; free tier), populate via Supabase's
restore-snapshot UI, and run THIS drill's chain-verify portion
against the restored target. The dump-restore mechanic itself is
validated by this drill; PR2b' validates the realistic-shape
restore-by-Supabase path.

## Drill script changes bundled in this PR

The drill script needed several patches discovered during this
drill execution (see "Staging-source attempts" above). All apply
to local→local AND to future staging→Supabase Path B drills:

1. **Docker pg-client fallback** — auto-detects server PG major
   via `current_setting('server_version_num')::int / 10000`; if
   local pg_dump major is lower, runs pg_dump/pg_restore via
   `docker run postgres:N`.
2. **Split bootstrap** — pre-restore bootstrap creates extensions
   + roles (needed by dumped tables' DDL); post-restore re-applies
   bootstrap + rls.sql (re-establishes grants idempotently).
3. **`--force-truncate-dst` drops + recreates public schema**
   even when the target has 0 tables (vanilla Postgres targets
   ship with empty public schema by default; the dump's CREATE
   SCHEMA public would conflict otherwise).
4. **Absolute OUT_DIR resolution** — convert to absolute path
   early in the script so the subsequent `cd apps/core-api`
   (needed for pnpm chain-verify) doesn't break relative paths.
5. **`--exclude-schema` list for Supabase sources** — bakes the
   exclusion list (auth/storage/realtime/pgsodium/vault/graphql/
   net/supabase_functions/supabase_migrations) into pg_dump
   flags. No-op for vanilla-source drills; load-bearing for
   future Supabase-source drills.

## Follow-ups filed

- **PR2b' staging-source drill** — gated on maintainer provisioning
  a throwaway Supabase target. Cost: free-tier Supabase project
  (auto-pauses in 7 days idle); ~30 min of operator time to
  populate via Supabase restore-snapshot UI + run this drill.
- **Quarterly drill cadence** — first quarterly drill (post-URL-flip)
  per `docs/runbooks/restore.md` §"Drill cadence". Pair with
  status-page + sbom-verify drills in one operator-hour slot.

## What's committed vs gitignored from this drill

**Committed:**
- `README.md` (this file)
- `report.json`
- `source-baselines.json`
- `target-baselines.json`
- `drift.json`
- `chain-verify.json` (1-line summary; safe to commit)
- `chain-verify.txt` (1-line "ok" output; safe to commit)

**Gitignored** (per `.gitignore` block added in PR #241 v2):
- `source.dump` (full DB export with PII)
- `dump.log` (pg_dump stderr; may include row values on error)
- `restore.log` (pg_restore stderr; same)
- `reapply-migrations.log` (psql output during bootstrap+rls)
- `prerestore-bootstrap.log` (pre-restore bootstrap output)

The committed files are small (~5 KB total) and contain only
metadata + counts + the byte-exact tail-hash verification proof.
No PII enters git history.

## Closing §8

Wave 0 §8 acceptance closes with this drill artefact + the docs
shipped in PR #241 (`restore.md` + `scripts/restore-drill.sh`).
The remaining §8-adjacent work (PR2b' staging-source drill) is
operator-paced post-URL-flip and tracked as a follow-up; it does
NOT block the URL flip per ADR-0014 amendment §11.

URL flip dependencies as of this drill's completion:

| Item | Status |
|---|---|
| §8 docs (PR #241) | ✅ merged |
| §8 first executed drill (this PR) | ✅ this artefact |
| §9 status page + SBOM + Privacy/ToS v1 | ✅ merged |
| §9 counsel review | ⏳ external maintainer action |
| §10 v2 6-agent scan + amendment | ✅ merged (PR #252) |
| Maintainer-commit ADR-0014 amendment as Accepted | ⏳ external |

The §8 acceptance bar is met by this artefact. The maintainer
amendment-commit (last item above) is the formal URL-flip
authorization.
