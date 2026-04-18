# Rollback: 0008 reservation basket

Destructive — any basket grouping is lost (individual reservations
keep their own state; only the basket association goes).

```sql
BEGIN;
DROP INDEX IF EXISTS reservations_tenantId_basketId_idx;
ALTER TABLE reservations DROP COLUMN IF EXISTS "basketId";
DELETE FROM _prisma_migrations WHERE migration_name = '20260418070000_0008_reservation_basket';
COMMIT;
```
