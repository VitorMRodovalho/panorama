# Rollback: 0007 reservation check-out/in capture

Destructive — any check-out/in history is lost.

```sql
BEGIN;
ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_checkedOutByUserId_fkey,
    DROP CONSTRAINT IF EXISTS reservations_checkedInByUserId_fkey,
    DROP COLUMN IF EXISTS "checkedOutAt",
    DROP COLUMN IF EXISTS "checkedOutByUserId",
    DROP COLUMN IF EXISTS "mileageOut",
    DROP COLUMN IF EXISTS "conditionOut",
    DROP COLUMN IF EXISTS "checkedInAt",
    DROP COLUMN IF EXISTS "checkedInByUserId",
    DROP COLUMN IF EXISTS "mileageIn",
    DROP COLUMN IF EXISTS "conditionIn",
    DROP COLUMN IF EXISTS "damageFlag",
    DROP COLUMN IF EXISTS "damageNote";
DELETE FROM _prisma_migrations WHERE migration_name = '20260418060000_0007_reservation_checkout';
COMMIT;
```
