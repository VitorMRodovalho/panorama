# Rollback: 0005 owner enforcement

Removes the trigger + function that enforces ADR-0007's "every tenant
must have at least one active Owner" invariant. Safe to roll back —
the service-layer guards in `TenantAdminService` keep the invariant
during normal operation; the trigger is defence-in-depth.

```sql
BEGIN;
DROP TRIGGER IF EXISTS enforce_at_least_one_owner_trigger ON tenant_memberships;
DROP FUNCTION IF EXISTS enforce_at_least_one_owner();
DELETE FROM _prisma_migrations WHERE migration_name = '20260418043200_0005_owner_enforcement';
COMMIT;
```
