# Rollback: 0004 invitations

This migration adds the `invitations` table (ADR-0008) and the
`tenants.invitationTtlSeconds` column. Rolling back is destructive —
any pending/accepted/revoked invitations are lost.

```sql
BEGIN;
DROP TABLE IF EXISTS invitations;
ALTER TABLE tenants DROP COLUMN IF EXISTS "invitationTtlSeconds";
DELETE FROM _prisma_migrations WHERE migration_name = '20260418042317_0004_invitations';
COMMIT;
```

No data migration is required to roll forward again; re-running
`prisma migrate deploy` recreates the table from scratch.
