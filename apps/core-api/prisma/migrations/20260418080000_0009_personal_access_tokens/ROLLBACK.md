# Rollback: 0009 personal access tokens

Destructive — every issued PAT is lost. A FleetManager-era client
consuming `/api/v1/*` via Bearer-auth will start getting 401s the
moment the table is dropped. Coordinate with any compat-shim
consumer BEFORE running this.

The Nest module that registers the PAT guard is gated behind
`FEATURE_SNIPEIT_COMPAT_SHIM=false` — flip that first, redeploy,
confirm callers are quiet, THEN run the SQL below.

```sql
BEGIN;

-- Drop the trigger + function before the table to avoid dependency
-- errors.
DROP TRIGGER IF EXISTS emit_pat_resurrected_audit_trigger
    ON personal_access_tokens;
DROP FUNCTION IF EXISTS emit_pat_resurrected_audit();

-- Drop table + its indexes (indexes go automatically).
DROP TABLE IF EXISTS personal_access_tokens;

-- Remove the migration row so `prisma migrate deploy` doesn't
-- re-apply on next boot.
DELETE FROM _prisma_migrations
 WHERE migration_name = '20260418080000_0009_personal_access_tokens';

COMMIT;
```

After rollback, update `apps/core-api/prisma/schema.prisma` to remove
the `PersonalAccessToken` model + the `personalAccessTokens` and
`issuedAccessTokens` back-relations on `User` and `Tenant`; re-run
`prisma generate`. Until then the Prisma client will carry stale
types that reference a missing table.
