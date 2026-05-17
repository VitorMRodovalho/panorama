-- Migration 0024 — no RLS surface change.
--
-- `tenant_deletion_tokens` is intentionally NOT granted to panorama_app.
-- All access via `prisma.runAsSuperAdmin`. Adding an RLS policy for
-- an audience that has no underlying GRANT would be dead config.
--
-- The two new columns on `tenants` (`deletionScheduledAt`,
-- `deletionRequestedByUserId`) inherit the existing `tenants_*`
-- policies. Tenant Owners + admins see them via the same tenant-
-- scoped filter that already gates every other tenant column.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
