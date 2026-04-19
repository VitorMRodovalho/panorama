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
# Two env vars are consumed:
#   DATABASE_URL          — connection string Prisma uses (must be writable)
#   DATABASE_PRIVILEGED_URL — optional; when set, rls.sql runs against this
#                             URL instead. Useful when the panorama_app role
#                             can't CREATE POLICY (e.g. RLS files create
#                             roles + grants the app role doesn't have
#                             permission to issue).

set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL must be set" >&2
  exit 64
fi

ADMIN_URL="${DATABASE_PRIVILEGED_URL:-$DATABASE_URL}"

cd "$(dirname "$0")/.."

echo ">> prisma migrate deploy"
node ./node_modules/.bin/prisma migrate deploy

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
