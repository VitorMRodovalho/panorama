# Rollback — 0024 tenant deletion cool-off

## Pre-flight (operator MUST verify BEFORE running)

Three coordinated changes (see `migration.sql` header):

1. New columns on `tenants` (`deletionScheduledAt`,
   `deletionRequestedByUserId`).
2. `tenants.systemActorUserId` made nullable.
3. New table `tenant_deletion_tokens`.

Only roll back if PR 3's tenant-deletion endpoints + the purge cron
are also reverted — the runtime code reads `deletionScheduledAt`
unconditionally and would crash on a missing column otherwise.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
-- 3. Drop the tokens table first (cascade-safe).
DROP TABLE "tenant_deletion_tokens";

-- 2. Restore NOT NULL on systemActorUserId. SAFE because every live
--    tenant has this set (the purge cron is the only path that
--    nulls it, and rolling back ALSO rolls back the cron + the
--    endpoints, so no path can produce a NULL row).
ALTER TABLE "tenants"
    ALTER COLUMN "systemActorUserId" SET NOT NULL;

-- 1. Drop the new columns + their index + FK.
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_deletionRequestedByUserId_fkey";
DROP INDEX "tenants_deletionScheduledAt_idx";
ALTER TABLE "tenants" DROP COLUMN "deletionRequestedByUserId";
ALTER TABLE "tenants" DROP COLUMN "deletionScheduledAt";
```

## Data-loss warnings

- **Active deletion-cool-off state is lost.** Any tenant currently in
  the 7-day window (`deletionScheduledAt IS NOT NULL`) reverts to the
  pre-PR-3 state where the operator must drop the tenant manually if
  they still want it deleted. The Owners who confirmed the deletion
  have no in-app surface to recover from the lost state until PR 3
  re-applies.
- **Unconsumed confirmation tokens are dropped** when the table goes.
  A user mid-flow (after delete-request, before delete-confirm) loses
  their token; they must restart the request flow once PR 3 is
  re-applied.
- **systemActorUserId rollback to NOT NULL is safe** under the
  pre-flight rule above — but only if no path produced a NULL row
  during the PR-3 window. If the purge cron RAN during PR 3 and was
  interrupted mid-sequence, a tenant could have NULL systemActorUserId
  + still-present rows. Verify with
  `SELECT id FROM tenants WHERE systemActorUserId IS NULL;` before
  the SET NOT NULL — fix any orphans manually.

## When you would actually revert

- PR 3 (tenant-deletion endpoints + cron) is being rolled back as
  part of a broader Wave 0.5 revert.
- A bug in the cron purges tenants prematurely or fails to purge —
  in either case, fix-forward on the cron is preferred to
  schema rollback.

## Re-apply pattern

Forward-only by design. Re-applying after a rollback is a clean
additive operation. Tenants with NULL systemActorUserId (if any
slipped through the manual cleanup above) need a new system user
seeded before the column is set NOT NULL again — but PR 3's schema
DOESN'T re-add NOT NULL on re-apply, so this is moot in practice.

## Schema implications

`schema.prisma` updated to mirror:
- `Tenant.systemActorUserId` → nullable (`String? @db.Uuid`).
- `Tenant.deletionScheduledAt`, `Tenant.deletionRequestedByUserId`
  added.
- `TenantDeletionToken` model added with back-relations on User +
  Tenant.

A revert of THIS migration must also revert those edits or
`prisma migrate status` will diff against the rolled-back DB.

## Production migration timing

- `ALTER TABLE ADD COLUMN` (nullable, no default) is metadata-only;
  takes ACCESS EXCLUSIVE on `tenants` for sub-millisecond.
- `ALTER TABLE ALTER COLUMN DROP NOT NULL` is also metadata-only; no
  row rewrite. Safe under load.
- `CREATE TABLE` is fast on an empty table.
- The new partial index `tenants_deletionScheduledAt_idx WHERE
  deletionScheduledAt IS NOT NULL` builds against zero rows at apply
  time (the column is fresh-NULL); also instantaneous.
