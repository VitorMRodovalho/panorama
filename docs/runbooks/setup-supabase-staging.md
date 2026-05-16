# Runbook: Supabase staging project setup

Walk-through for standing up the **internal staging** Supabase project
defined in [ADR-0013](../adr/0013-staging-deploy-architecture.md).
Maintainer-only; this is **not** a customer-facing managed instance.

> **Hard prerequisite**: ADR-0015 (BYPASSRLS-removal refactor) must
> have landed and the test suite must be green against the refactored
> `prisma.service.ts` before you apply migrations to Supabase. Without
> the refactor, ~25 `runAsSuperAdmin` call-sites silently no-op on
> Supabase and the app's audit / maintenance / cross-tenant paths
> break in production-shaped ways.

## Why this runbook exists

The Supabase MCP integration on the maintainer's primary account
(`ai-pm-hub` org) only sees its own project. The Panorama staging
project lives in a **separate Supabase account** because the Free-tier
2-projects-across-all-Free-orgs cap is already filled by `meridianiq`
+ `orenu` under the primary account. The MCP can't touch the
secondary account, so every step below is hand-driven via the
Supabase dashboard's SQL Editor.

If at some point you consolidate accounts (or upgrade the primary
account's Panorama org to Pro), re-authorise the MCP and these steps
collapse to a single `apply_migration` call per migration.

## Prerequisites checklist

- [ ] ADR-0015 refactor landed on `main`.
- [ ] Test suite green at HEAD (`pnpm test` from `apps/core-api/`).
- [ ] Secondary Supabase account login + access to the `Panorama`
      Free org.
- [ ] Project created. Current ID at time of last bring-up:
      `tuswqzeytiobqfkxgkbe` (note the project ID for whichever you
      use; record it in `memory/project_deploy_prep.md`).
- [ ] North Virginia (`us-east-1`) region (US-focused pilot fits;
      data residency matches Amtrak/FDT).

## Step 1 — Capture the connection details

Use `scripts/setup-staging-env.sh` (interactive bootstrapper added
2026-05-09). From the repo root:

```bash
./scripts/setup-staging-env.sh
```

It prompts for the two URLs (hidden input), validates shape, probes
both connections with non-destructive `SELECT`s, and writes
`apps/core-api/.env.staging` at mode 600. The file is gitignored.

In the Supabase dashboard for the project:

1. **Project Settings → Database → Connection string** — copy the
   two strings the script asks for, in order:
   - **Connection pooling → Transaction mode** (port 6543) — runtime.
     Becomes `DATABASE_URL`.
   - **Direct connection** (port 5432) — `prisma migrate deploy` +
     RLS DDL. Becomes `DATABASE_DIRECT_URL` AND
     `DATABASE_PRIVILEGED_URL` (same value; separated by intent —
     see `.env.example` for the contract).

2. The privileged user is the project's `postgres` (Project Settings
   → Database → Database password). **Document this password in your
   password manager and rotate quarterly.** Do NOT use Supabase's
   `service_role` JWT — that's account-root and forbidden in app code
   per security-reviewer.

3. **Project Settings → API**:
   - Note the **Project URL** (`https://<project-ref>.supabase.co`).
   - Note the **anon key** — you do not need this for the Nest API;
     ignore unless you later add Supabase Auth integration.

## Step 2 — Verify extension availability

In Supabase dashboard → SQL Editor:

```sql
SELECT name, default_version, installed_version
  FROM pg_available_extensions
 WHERE name IN ('pgcrypto', 'btree_gist', 'uuid-ossp', 'citext');
```

All four should appear with a default_version. If `installed_version`
is NULL, that's fine — migration `20260418090000_0010_*` enables
`btree_gist` via `CREATE EXTENSION IF NOT EXISTS`. The others enable
themselves where used.

## Step 3 — Apply migrations

**Single command** (since 2026-05-09 — PRs #184/#185 simplified the
former hand-applied SQL Editor walkthrough):

```bash
set -a && . apps/core-api/.env.staging && set +a
cd apps/core-api && pnpm exec sh ./scripts/apply-migrations.sh
```

What this does (each step idempotent on re-run):

1. **`prisma/supabase-bootstrap.sql`** — creates `panorama_app` +
   `panorama_super_admin` roles (the self-hosted `postgres-init.sql`
   never runs on Supabase), grants both to `current_user`, ensures
   `pgcrypto` / `citext` / `uuid-ossp` / `btree_gist` extensions.
   No-op via `IF NOT EXISTS` guards on re-run.
2. **`prisma migrate deploy`** — runs against `DATABASE_DIRECT_URL`
   (port 5432). Skips already-applied migrations via
   `_prisma_migrations`. Required to use the direct URL because
   pgBouncer transaction-mode strips the session-level features
   Prisma's migration engine needs (advisory locks, multi-statement
   transactions).
3. **rls.sql loop** — applies each `prisma/migrations/*/rls.sql`
   against `DATABASE_PRIVILEGED_URL` in alphabetical order. Files
   use `CREATE OR REPLACE` / `DROP POLICY IF EXISTS` so re-runs
   converge on the same state.

If something fails mid-way, the script exits non-zero. Recovery
options:

- For a partially-applied migration: see `prisma migrate resolve
  --rolled-back <name>` (Prisma docs). The 2026-05-09 staging
  bring-up needed this once after migration 0011 hit
  `database "panorama" does not exist` (since fixed to use
  `current_database()` parametrically).
- For an rls.sql file that errored: re-run; idempotent.

## Step 4 — Verify RLS is on + the GUC works

In SQL Editor (privileged):

```sql
-- Every tenant-scoped table should have rowsecurity = t and forcerls = t.
SELECT schemaname, tablename, rowsecurity, forcerowsecurity
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN (
     'tenants', 'tenant_memberships', 'assets', 'reservations',
     'inspections', 'inspection_photos', 'inspection_responses',
     'inspection_template_items', 'inspection_templates',
     'notification_events', 'audit_events'
   )
 ORDER BY tablename;
```

Then test the GUC drives access correctly:

```sql
-- As `postgres` (privileged role), no GUC set: should see ALL rows.
SELECT count(*) FROM tenants;

-- Open a transaction that simulates the app role + a specific tenant.
BEGIN;
SET LOCAL ROLE panorama_app;
SET LOCAL panorama.current_tenant = '<a-known-tenant-uuid>';
SELECT count(*) FROM tenants;  -- should be 1 (just that tenant)
ROLLBACK;
```

If the second count is 0, RLS is too tight (likely the
`panorama_current_tenant()` function isn't reading the new GUC name —
ADR-0015 migration didn't apply cleanly). If it's > 1, RLS is too
loose — investigate before proceeding.

## Step 5 — Configure the staging Fly.io app

Outside Supabase, create the Fly app pointing at the URLs from step 1:

```bash
flyctl apps create panorama-staging --org personal
flyctl secrets set --app panorama-staging \
  DATABASE_URL="postgres://postgres:...@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&sslmode=require" \
  # connection_limit=10 — per Prisma client × 2 clients (app + privileged
  # per ADR-0015) × Fly instances ≤ 100 to leave headroom under Supabase
  # Pro pooler's 200 client-conn cap. Public-preview budget assumes ≤2
  # Fly instances + 50 active tenants × 5 concurrent users × ~0.04 active
  # fraction = ~10 in-flight × 2 clients = 20 client conns per instance.
  # If you ever scale beyond 4 instances, lower this or request the
  # Supabase pooler cap bump first.
  DATABASE_PRIVILEGED_URL="postgres://postgres:...@db.<project-ref>.supabase.co:5432/postgres?sslmode=require" \
  DATABASE_DIRECT_URL="postgres://postgres:...@db.<project-ref>.supabase.co:5432/postgres?sslmode=require" \
  REDIS_URL="rediss://default:...@<upstash-endpoint>:6379" \
  S3_ENDPOINT="https://<r2-account-id>.r2.cloudflarestorage.com" \
  S3_REGION="auto" \
  S3_BUCKET_PHOTOS="panorama-staging-photos" \
  S3_ACCESS_KEY="..." \
  S3_SECRET_KEY="..." \
  S3_FORCE_PATH_STYLE="false" \
  S3_ALLOW_PRIVATE_ENDPOINT="false" \
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" \
  FEATURE_INSPECTIONS="true" \
  SMTP_HOST="..." SMTP_FROM="..." # etc
```

DO NOT set `service_role` anywhere. If you ever need that key for an
ad-hoc operation, use it from a one-shot psql session and rotate
immediately after.

## Step 6 — Smoke-test the deploy

```bash
flyctl deploy --app panorama-staging \
  --dockerfile apps/core-api/Dockerfile \
  --build-arg PANORAMA_VERSION=$(git describe --tags)

# Health check
curl https://panorama-staging.fly.dev/health
# Expect: {"ok":true,"db":"up"}

# Read the boot audits to confirm role separation
psql "$DATABASE_PRIVILEGED_URL" -c "
SELECT \"occurredAt\", action, metadata
  FROM audit_events
 WHERE action LIKE 'panorama.boot.%'
 ORDER BY id DESC
 LIMIT 5;
"
# Look for:
#   panorama.boot.db_pool_configured (TWICE — once per Prisma client; ADR-0015)
#   panorama.boot.object_storage_configured
#   panorama.boot.redis_configured
```

If any of those three boot audits is missing, the corresponding
service didn't initialise correctly.

## Step 7 — Rotation playbook

Quarterly rotation (or sooner on suspected breach):

| Secret | Where it lives | How to rotate |
|---|---|---|
| `SESSION_SECRET` | Fly secret | Generate new 32-byte → `flyctl secrets set SESSION_SECRET=...`. Every active session invalidated. |
| Supabase `postgres` user password | Supabase dashboard → Settings → Database | Reset password → update `DATABASE_*_URL` Fly secrets → `flyctl deploy` |
| R2 access key | Cloudflare dashboard → R2 → Manage tokens | Create new token scoped to `panorama-staging-photos` only → update Fly secrets → revoke old token |
| Upstash Redis password | Upstash dashboard | Rotate → update `REDIS_URL` Fly secret → redeploy |
| Cloudflare account-level API key | Cloudflare profile | Avoid using the global key entirely; prefer scoped API tokens |

**Never rotate `service_role`** unless you've confirmed it's not in
use anywhere — a rotation breaks every Supabase Studio + dashboard
operation until you re-authenticate.

## Step 8 — Tearing it down

If staging is wrong fit and you fall back to single-VPS self-hosted
per ADR-0013's rollback plan:

1. `flyctl apps destroy panorama-staging`
2. `pg_dump` from Supabase to a backup file (just in case).
3. Pause the Supabase project (Project Settings → General → Pause
   project) — paused projects don't count against your Free quota
   and your data is retained for 90 days.
4. Empty the R2 bucket via Cloudflare dashboard or `aws s3 rm
   --recursive`. Don't delete the bucket — just the objects, in case
   you re-stage.
5. Update `docs/adr/0013-staging-deploy-architecture.md` Status line
   with "Staging torn down YYYY-MM-DD; rationale linked here."

## Known gaps + open follow-ups

- **MCP authorisation on the secondary account** is missing. Until
  resolved, every step here is manual. Follow-up: extend MCP integration
  to the secondary account, OR create a maintainer-only personal access
  token that the MCP tooling can use for `apply_migration` against
  this project.
- **Boot audit `panorama.boot.db_pool_configured` doesn't exist yet** —
  it's part of the ADR-0015 refactor. Until that lands, the verification
  step above is informational only.
- **Cron / repeatable-job migration** for the photo retention sweep
  is also part of ADR-0015. Until it lands, Fly machine restarts
  reset the 24h sweep clock — acceptable for staging but documented.
