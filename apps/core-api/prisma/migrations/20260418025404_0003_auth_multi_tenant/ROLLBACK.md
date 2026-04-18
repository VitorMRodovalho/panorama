# Rollback: 0003_auth_multi_tenant

Risk class: **medium** — additive on tenant_memberships and auth_identities,
destructive if rolled back on a DB that already holds user passwords or
invitation state.

## What this migration adds

- `auth_identities.secretHash TEXT NULL` — argon2id password hashes
- `tenants.allowedEmailDomains TEXT[] NOT NULL DEFAULT '{}'` — domain claims
- `tenant_memberships.status TEXT NOT NULL DEFAULT 'active'`
- `tenant_memberships.invitedByUserId UUID NULL`
- `tenant_memberships.invitedAt TIMESTAMPTZ NULL`
- `tenant_memberships.acceptedAt TIMESTAMPTZ NULL`
- Index `(tenantId, status)` on tenant_memberships

## Manual rollback (pre-production)

```sql
BEGIN;
DROP INDEX IF EXISTS tenant_memberships_tenantId_status_idx;
ALTER TABLE tenant_memberships
    DROP COLUMN IF EXISTS "acceptedAt",
    DROP COLUMN IF EXISTS "invitedAt",
    DROP COLUMN IF EXISTS "invitedByUserId",
    DROP COLUMN IF EXISTS status;
ALTER TABLE tenants
    DROP COLUMN IF EXISTS "allowedEmailDomains";
ALTER TABLE auth_identities
    DROP COLUMN IF EXISTS "secretHash";
COMMIT;
```

## Data loss if rolled back in prod

- **All password hashes** in `auth_identities.secretHash` — users who only
  have a password identity (no OIDC link) will not be able to log in. They
  would need password resets (which are external — email-based reset flow
  lands in 0.4).
- **All invitation state** on `tenant_memberships` (invitedBy, invitedAt,
  acceptedAt) and the pending-invitation `status` distinction. Rows become
  indistinguishable from active members.
- **Tenant `allowedEmailDomains` claims** — home-realm discovery stops
  routing based on email domain.

Only roll back if these are acceptable losses OR if no password/invitation
data exists yet.

## RLS

No new RLS policies. `auth_identities` is a global (non-tenant-scoped) table;
access is gated at the application layer (users can only see their own
identities). `tenants` and `tenant_memberships` already have RLS policies
that the new columns inherit.
