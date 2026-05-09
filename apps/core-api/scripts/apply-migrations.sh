#!/bin/sh
# Applies all Prisma schema migrations + the per-migration rls.sql files.
#
# Run by the `migrator` service in `infra/docker/compose.prod.yml` AND
# documented in `docs/en/self-hosting.md` as the canonical first-deploy +
# upgrade command for self-hosters.
#
# Idempotent — Prisma's `migrate deploy` skips already-applied migrations
# via `_prisma_migrations`, and the rls.sql files use `CREATE OR REPLACE`
# / `DROP POLICY IF EXISTS` patterns so re-runs converge on the same
# state.
#
# Three env vars are consumed:
#   DATABASE_URL          — connection string the runtime app uses (may
#                           be a connection-pooled / pgBouncer endpoint
#                           on managed PG; do not assume session-level
#                           ops work here).
#   DATABASE_DIRECT_URL   — optional; when set, `prisma migrate deploy`
#                           uses this instead of DATABASE_URL. Required
#                           on managed PG with pgBouncer (Supabase, Neon)
#                           because Prisma's migration engine relies on
#                           session-level features (advisory locks,
#                           multi-statement transactions) that
#                           transaction-mode pooling strips.
#   DATABASE_PRIVILEGED_URL — optional; when set, rls.sql + the
#                             pre-migration bootstrap run against this
#                             URL instead. Useful when the panorama_app
#                             role can't CREATE POLICY / CREATE ROLE.

set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL must be set" >&2
  exit 64
fi

ADMIN_URL="${DATABASE_PRIVILEGED_URL:-$DATABASE_URL}"

cd "$(dirname "$0")/.."

# Pre-migration bootstrap (idempotent). Creates panorama_app +
# panorama_super_admin roles, grants membership to the connecting user,
# and ensures required extensions. On self-hosted this is a no-op via
# IF NOT EXISTS guards (postgres-init.sql ran first on container init).
# On managed PG (Supabase, Neon, RDS, …) this is the prereq for the
# role GRANTs in subsequent migrations to resolve. Surfaced 2026-05-09
# during the first Supabase staging bring-up.
if [ -f prisma/supabase-bootstrap.sql ]; then
  echo ">> pre-migration bootstrap (prisma/supabase-bootstrap.sql)"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f prisma/supabase-bootstrap.sql
fi

# Use DATABASE_DIRECT_URL for `migrate deploy` when set — managed PG
# (Supabase, Neon) routes DATABASE_URL through pgBouncer, which breaks
# Prisma's session-level migration ops. Self-hosted leaves
# DATABASE_DIRECT_URL unset and the fallback to DATABASE_URL works
# unchanged.
MIGRATE_URL="${DATABASE_DIRECT_URL:-$DATABASE_URL}"

echo ">> prisma migrate deploy"
DATABASE_URL="$MIGRATE_URL" node ./node_modules/.bin/prisma migrate deploy

echo ">> applying rls.sql files in migration order"
for dir in prisma/migrations/*/; do
  rls="${dir}rls.sql"
  if [ -f "$rls" ]; then
    echo "   apply $rls"
    PGPASSWORD="$(echo "$ADMIN_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')" \
      psql "$ADMIN_URL" \
      -v ON_ERROR_STOP=1 \
      -f "$rls"
  fi
done

echo ">> done"
