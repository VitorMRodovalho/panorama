-- Migration 0022 — no RLS surface change.
--
-- The new `tenants.pendingVerification` column inherits the existing
-- `tenants_*` RLS policies from migration 0001 + #41 follow-ups.
-- Tenant Owners and admins can read it via the same `tenant_id = ...`
-- filter that gates every other column on the row.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
