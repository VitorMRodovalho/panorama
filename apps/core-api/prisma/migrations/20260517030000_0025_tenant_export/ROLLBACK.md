# Rollback — 0025 tenant data export

## Pre-flight (operator MUST verify BEFORE running)

Adds ONE table (`tenant_exports`) used by ADR-0020 §8 export jobs.
Rollback drops the table.

Only roll back if PR 4's TenantExportModule (controller + worker +
service) is also reverted — the runtime code reads `tenant_exports`
unconditionally and would crash on a missing column otherwise.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
DROP TABLE "tenant_exports";
```

The FKs ON DELETE CASCADE to `tenants` + ON DELETE SET NULL to
`users` keep the table self-contained — dropping the table does
not affect `users` or `tenants`.

## Data-loss warnings

- **All export-job rows are dropped.** Operators that need to find
  a previously-issued export's S3 object key to re-mint a signed URL
  must consult the audit log (`TenantExported` rows carry the
  `objectKey` in `metadata`). The audit chain survives the rollback.
- **Pending exports (status=queued/processing) lose their job
  bookkeeping.** Any BullMQ jobs already in flight will fail to find
  their `tenant_exports` row and error. The S3 lifecycle rule (TTL
  ≤24h) cleans up any uploaded objects automatically.

## When you would actually revert

- PR 4 (tenant export endpoint + worker) is being rolled back as
  part of a broader Wave 0.5 revert.
- The `tenant_exports` shape turns out to be unworkable (extremely
  unlikely — the field set is the minimal viable surface for a
  request-completion job ledger).

## Re-apply pattern

Forward-only by design. Re-applying after a rollback is a clean
additive operation; no data backfill needed.

## Schema implications

`schema.prisma` was updated to add the `TenantExport` model + back-
relations on `User` and `Tenant`. A revert of THIS migration must
also revert those edits — otherwise `prisma migrate status` will
diff against the rolled-back DB.

## Production migration timing

- `CREATE TABLE` is fast; ACCESS EXCLUSIVE on the new relation only.
- The two indexes build against zero rows at apply time (fresh
  table), also instantaneous.
- No trigger, function, or RLS policy changes.
