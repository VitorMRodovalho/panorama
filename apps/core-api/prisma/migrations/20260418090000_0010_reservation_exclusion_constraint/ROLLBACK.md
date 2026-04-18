# Rollback: 0010 reservation exclusion constraint

Non-destructive — the service's `assertNoOverlap` + `Serializable +
P2034 retry` invariants remain intact and are sufficient on their own.
A rollback just removes the DB-level backstop.

```sql
BEGIN;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_no_overlap;
ALTER TABLE reservations DROP COLUMN IF EXISTS "bookingRange";

-- The btree_gist extension is left installed — dropping it would
-- regress any other installation already using it for a non-
-- Panorama purpose. Idempotent re-enable on re-apply.

DELETE FROM _prisma_migrations
 WHERE migration_name = '20260418090000_0010_reservation_exclusion_constraint';

COMMIT;
```

After rollback, re-run `prisma generate` if `schema.prisma` was updated
with the `bookingRange Unsupported("tsrange")?` field — removing it
keeps the client types aligned with the table.
