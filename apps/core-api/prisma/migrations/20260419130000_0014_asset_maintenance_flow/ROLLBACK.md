# Rollback — migration 0014 (asset maintenance flow, ADR-0016)

Destructive — drops two tables, one enum, one trigger function +
trigger, four+ added columns. Photos in S3 are NOT deleted by this
rollback (audit-safe; manual `mc rm --recursive` if needed).

Run in this order; each block is idempotent.

```sql
BEGIN;

-- 1. Drop the trigger and function (no rows left after table drop,
--    but drop them explicitly so a future re-introduction starts clean).
DROP TRIGGER IF EXISTS asset_maintenances_assert_triggers_same_tenant ON "asset_maintenances";
DROP FUNCTION IF EXISTS assert_maintenance_triggers_same_tenant();

-- 2. Drop the two tables (cascades drop indexes, constraints, FKs,
--    and the privileged-bypass + tenant-isolation policies attached
--    to them).
DROP TABLE IF EXISTS "maintenance_photos";
DROP TABLE IF EXISTS "asset_maintenances";

-- 3. Drop the enum (no longer referenced).
DROP TYPE IF EXISTS "maintenance_status";

-- 4. Drop the added columns from existing tables.
ALTER TABLE "tenants"
    DROP COLUMN IF EXISTS "systemActorUserId",
    DROP COLUMN IF EXISTS "autoOpenMaintenanceFromInspection",
    DROP COLUMN IF EXISTS "notifyLastRequesterOnMaintenanceOpen",
    DROP COLUMN IF EXISTS "maintenanceMileageInterval",
    DROP COLUMN IF EXISTS "maintenanceDayInterval",
    DROP COLUMN IF EXISTS "maintenanceStaleWarningDays",
    DROP COLUMN IF EXISTS "maintenanceReopenWindowDays";

ALTER TABLE "reservations"
    DROP COLUMN IF EXISTS "isStranded";

ALTER TABLE "assets"
    DROP CONSTRAINT IF EXISTS "assets_last_read_mileage_nonneg",
    DROP COLUMN IF EXISTS "lastReadMileage";

-- 5. Demote system users to plain requesters (so they don't appear
--    in admin lists or surprise downstream consumers expecting
--    'owner'/'fleet_admin'/'fleet_staff'/'requester'). The system
--    users themselves are NOT deleted — they have audit-event
--    references via createdByUserId on the rolled-back tickets,
--    and User deletes are Restrict-blocked anyway.
UPDATE "tenant_memberships"
   SET role = 'requester'
 WHERE role = 'system';

-- 6. Drop the migration row from the Prisma ledger so a re-apply
--    can proceed clean.
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20260419130000_0014_asset_maintenance_flow';

COMMIT;
```

## Notes

- **Photos in S3** are not removed by the rollback. After confirming
  no business need, run:
  ```
  mc rm --recursive --force local/panorama-photos/tenants/<tenantId>/maintenance/
  ```
  for each tenant, or wait for the inspection-photo retention sweep
  to age them out (they share the same `inspectionPhotoRetentionDays`
  config, default 425 d).

- **System users**: their `users` row + `tenant_memberships` row
  remain after rollback (now with role='requester'). They have NO
  `auth_identities` row so they cannot log in. They occupy one row
  per tenant indefinitely. If you need to fully purge them post-
  rollback (e.g. before a clean re-apply), run:
  ```sql
  DELETE FROM "tenant_memberships"
   WHERE "userId" IN (
     SELECT id FROM "users" WHERE email LIKE 'system+%@panorama.invalid'
   );
  DELETE FROM "users" WHERE email LIKE 'system+%@panorama.invalid';
  ```
  This will fail if any AuditEvent rows reference them via `actorUserId`
  (the audit chain is Restrict-protected); inspect + null those out
  first if you really need a clean wipe.

- **Asset.lastReadMileage** rebuilds losslessly from per-reservation
  `Reservation.mileageIn` if the column is re-introduced later — the
  migration's backfill query is the canonical recipe.

- **Reservation.isStranded** rolled-back means any reservations in
  the stranded state lose the flag. They stay `lifecycleStatus =
  CHECKED_OUT`, which is operationally accurate (the keys ARE out);
  only the discriminator is gone. Manual ops process can re-handle
  via reservation cancel / mileage-in.

- **FEATURE_MAINTENANCE** flag should be set to `false` BEFORE running
  the rollback (otherwise the running app will throw on missing
  tables until restart). Rollback ordering:
  1. Set `FEATURE_MAINTENANCE=false` in env.
  2. Restart core-api.
  3. Run the rollback SQL.
  4. Verify `\d asset_maintenances` returns "does not exist".
