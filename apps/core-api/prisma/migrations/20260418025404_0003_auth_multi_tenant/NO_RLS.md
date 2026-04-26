# NO_RLS — 0003_auth_multi_tenant

Migration 0003 is a pure ALTER on tables that already have RLS
policies installed by 0001 — `users`, `tenant_memberships`,
`auth_identities`, `tenants`. It adds columns and FK relationships
but does not introduce a new table that needs its own policy.

The policies on the affected tables continue to apply unmodified:
`tenants_tenant_isolation`, `tenant_memberships_tenant_isolation`,
`users_self_or_tenant`, `auth_identities_self_or_tenant`. No new
RLS surface is created by this migration; nothing to author here.

## Re-evaluate when

- The migration is amended to add a new table (very unlikely — it
  is a column-only ALTER).
- A future audit determines that the column additions changed the
  RLS posture (e.g., a new tenant-routed column on users that
  needs a column-grant). At that point this NO_RLS.md must be
  superseded by a real `rls.sql`.

## Reviewer

- 2026-04-23 audit Wave 1 (data-architect) — confirmed pure ALTER,
  RLS policies on parent tables are unchanged
- 2026-04-26 (audit Wave 2d.F closure) — confirmed at NO_RLS.md
  introduction, paired with `scripts/check-migration-conventions.ts`
