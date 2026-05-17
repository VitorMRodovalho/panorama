# Rollback — 0022 tenant pendingVerification flag

## Pre-flight (operator MUST verify BEFORE running)

This migration adds ONE column to `tenants` (NOT NULL, default `false`).
Rollback drops the column.

Only roll back if PR 1's signup-callback writer is also reverted — the
service-layer code in `signup.controller.ts` writes `true` into the
column for every self-serve tenant, and a column-missing error would
break every signup attempt while leaving Prisma's typed client in a
drift state.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
ALTER TABLE "tenants"
    DROP COLUMN "pendingVerification";
```

## Data-loss warnings

- **Pending tenants become indistinguishable from verified tenants.**
  Any tenant signed up via the self-serve flow after 0022 was applied
  but BEFORE rollback loses the marker. If the PR 2 verify-endpoint
  routes guard ever shipped (it doesn't yet at the time of writing
  0022), those tenants would silently become "verified" with no audit
  trail of the bypass.

## When you would actually revert

- The signup-callback writer in `signup.controller.ts` is being
  rolled back as part of a broader Wave 0.5 revert and the column is
  now dead schema.
- The `pendingVerification` flag turns out to be unworkable for the
  PR 2 verify flow (extremely unlikely — the field shape is the
  minimal viable surface for a binary verified/unverified gate).

## Re-apply pattern

Forward-only by design. Re-applying after a rollback is a clean
additive operation; no data backfill needed because the default
`false` matches every tenant's pre-signup-flow state.

## Schema implications

`schema.prisma` was updated to mirror the new column:

```prisma
model Tenant {
  // ...
  pendingVerification Boolean @default(false)
}
```

A revert of THIS migration must also revert that line from
`schema.prisma` — otherwise `prisma migrate status` will diff
against the rolled-back DB. The SQL revert block above only handles
the database side; the schema edit is a separate manual step that
MUST land in the same commit as the SQL revert.

## Production migration timing

- `ALTER TABLE ADD COLUMN BOOLEAN NOT NULL DEFAULT FALSE` is
  metadata-only on Postgres 11+ (no row rewrite); takes ACCESS
  EXCLUSIVE on `tenants` for sub-millisecond. Safe under load.
- No trigger or function changes.
- No advisory lock; trivial DDL.
