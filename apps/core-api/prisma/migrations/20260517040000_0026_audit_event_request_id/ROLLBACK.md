# Rollback — 0026 audit event request-id correlation column

## Pre-flight

This migration is additive and observational only. Rollback restores
the pre-0026 state where audit-row → log-line correlation must be
inferred from `tenantId + occurredAt` (the workaround the column was
added to replace).

There is no chain-integrity implication: `requestId` is not part of
the digest pre-image, so dropping the column does not invalidate any
selfHash / prevHash. The chain-verify CLI was never updated to read
this column (by design — the column is metadata, not anchor).

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
ALTER TABLE "audit_events"
    DROP COLUMN "requestId";
```

That's it. One column, no triggers, no policies, no indexes.

## Schema implications

`schema.prisma` was updated to mirror the new column at line 718:

```prisma
model AuditEvent {
  // ...
  requestId      String?
}
```

A revert of THIS migration must also revert that line from
`schema.prisma` — otherwise `prisma migrate status` will diff
against the rolled-back DB.

## Data loss

Any `requestId` values written between 0026 apply and rollback are
permanently lost. Re-applying 0026 starts a fresh blank-NULL column;
the pre-rollback values cannot be recovered. Acceptable: the column
was a correlation aid, never a system-of-record.

## When you would actually revert

Hard to imagine. The column is:

- Optional (NULL-able at the schema level)
- Read-only outside the AuditService write path (no app code joins
  on it; triage is by ad-hoc psql)
- Off the digest path (no chain implication)
- Backed by no index (no operational cost)

The realistic rollback scenario is *if migration 0026 somehow
introduces a corruption mode in `audit.service.ts`'s write path*
— which would be a service-layer bug, not a schema bug. Patch the
service; do not revert the column.

## Production migration timing

- `ALTER TABLE ADD COLUMN TEXT NULL` is metadata-only (no row
  rewrite); takes ACCESS EXCLUSIVE on `audit_events` for sub-
  millisecond. Safe under load.
- `COMMENT ON COLUMN` is a catalog-only write; no relation lock.
