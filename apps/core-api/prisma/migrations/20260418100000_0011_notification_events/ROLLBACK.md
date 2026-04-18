# Rollback: 0011 notification event bus

Destructive — every enqueued-but-unsent notification is lost. The
feature is additive (no domain service depends on
NotificationService at migration time), so rollback is clean:

1. Flip `FEATURE_NOTIFICATION_BUS=false` in the environment,
   redeploy. The dispatcher stops polling; domain services STILL
   call `enqueueWithin` but the rows sit pending indefinitely —
   acceptable short-term.
2. Once the dispatcher is quiet, run the SQL below. The subscribers
   (`EmailChannel`, etc.) land in step 6 of the ADR execution order;
   this migration is their foundation only.

```sql
BEGIN;

-- Drop the trigger + function before the table so nothing orphans.
DROP TRIGGER IF EXISTS emit_notification_tamper_audit_trigger
    ON notification_events;
DROP FUNCTION IF EXISTS emit_notification_tamper_audit();

-- Drop the narrow dispatcher role + its grants. The app-role
-- membership grant disappears with the role.
REVOKE ALL PRIVILEGES ON notification_events FROM panorama_notification_dispatcher;
REVOKE ALL PRIVILEGES ON audit_events        FROM panorama_notification_dispatcher;
REVOKE USAGE, SELECT ON SEQUENCE audit_events_id_seq
    FROM panorama_notification_dispatcher;
REVOKE USAGE  ON SCHEMA public  FROM panorama_notification_dispatcher;
REVOKE CONNECT ON DATABASE panorama FROM panorama_notification_dispatcher;
DROP ROLE IF EXISTS panorama_notification_dispatcher;

-- Drop the tenant column added by this migration (nullable, no data
-- loss for tenants that never set it).
ALTER TABLE tenants DROP COLUMN IF EXISTS "notificationRetentionDays";

-- Drop the table + indexes (indexes go automatically). CHECK and
-- partial unique indexes disappear with it.
DROP TABLE IF EXISTS notification_events;

-- Drop the enum last (safe once the table is gone).
DROP TYPE IF EXISTS notification_event_status;

-- Remove the migration row so `prisma migrate deploy` doesn't
-- re-apply on next boot.
DELETE FROM _prisma_migrations
 WHERE migration_name = '20260418100000_0011_notification_events';

COMMIT;
```

After rollback, update `apps/core-api/prisma/schema.prisma` to remove
the `NotificationEvent` model + the `notificationEvents` back-
relation on `Tenant` + the `notificationRetentionDays` column; re-run
`prisma generate`.
