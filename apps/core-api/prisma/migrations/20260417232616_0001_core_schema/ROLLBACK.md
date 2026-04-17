# Rollback: 0001_core_schema

Risk class: **medium** — first migration, entire schema. Rollback is only meaningful
before any real data has been written to production.

## What this migration creates

- Enums: `user_status`, `category_kind`, `asset_status`, `approval_status`, `reservation_status`
- Tables: `tenants`, `users`, `auth_identities`, `tenant_memberships`, `categories`,
  `manufacturers`, `asset_models`, `assets`, `reservations`, `audit_events`, `system_settings`
- RLS policies on every tenant-scoped table and on `audit_events` (see `rls.sql`)
- Helper function `panorama_current_tenant()`

## Manual rollback (pre-production)

```sql
BEGIN;
DROP TABLE IF EXISTS audit_events, reservations, assets, asset_models,
    manufacturers, categories, tenant_memberships, auth_identities, users,
    tenants, system_settings CASCADE;
DROP TYPE  IF EXISTS reservation_status, approval_status, asset_status,
    category_kind, user_status;
DROP FUNCTION IF EXISTS panorama_current_tenant();
COMMIT;
```

## Production rollback

Once there are real tenants, do not drop. Steps:

1. Snapshot the database (`pg_basebackup` or the managed-Postgres PITR trigger).
2. Restore the snapshot into a new database; promote it; swap the connection string.
3. Keep the old database around for 30 days before dropping.

## Data loss

Full — this migration contains the entire schema. Every table disappears.

## Automated rollback

Not supported. Prisma does not currently ship `prisma migrate down`; we use
the forward-only migration model and rely on snapshots for recovery.
