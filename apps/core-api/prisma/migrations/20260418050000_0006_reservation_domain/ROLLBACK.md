# Rollback: 0006 reservation domain

Reverts the ADR-0009 schema additions. Destructive — any blackouts
or approval / cancellation trail on reservations are lost.

```sql
BEGIN;

DROP TABLE IF EXISTS blackout_slots;

ALTER TABLE reservations
    DROP CONSTRAINT IF EXISTS reservations_requesterUserId_fkey,
    DROP CONSTRAINT IF EXISTS reservations_onBehalfUserId_fkey,
    DROP CONSTRAINT IF EXISTS reservations_approverUserId_fkey,
    DROP CONSTRAINT IF EXISTS reservations_cancelledByUserId_fkey,
    DROP COLUMN IF EXISTS "approvalNote",
    DROP COLUMN IF EXISTS "approvedAt",
    DROP COLUMN IF EXISTS "approverUserId",
    DROP COLUMN IF EXISTS "cancelReason",
    DROP COLUMN IF EXISTS "cancelledAt",
    DROP COLUMN IF EXISTS "cancelledByUserId";

DROP INDEX IF EXISTS reservations_tenantId_requesterUserId_idx;
DROP INDEX IF EXISTS reservations_tenantId_lifecycleStatus_idx;

ALTER TABLE tenants DROP COLUMN IF EXISTS "reservationRules";

DELETE FROM _prisma_migrations WHERE migration_name = '20260418050000_0006_reservation_domain';
COMMIT;
```
