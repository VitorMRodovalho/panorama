-- Migration 0016 — no RLS surface change.
--
-- This migration adds two partial UNIQUE indexes on
-- `asset_maintenances` (per-trigger uniqueness — see migration.sql for
-- the design rationale). Indexes do not interact with
-- ENABLE/FORCE ROW LEVEL SECURITY policies; the existing tenant-scoped
-- and privileged-bypass policies on `asset_maintenances` from
-- migration 0014 continue to apply unchanged.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern (project convention since migration 0012 — every
-- migration on a tenant-scoped table either ships an `rls.sql` with
-- the change OR a placeholder no-op so a reviewer can confirm at a
-- glance that RLS was considered).

SELECT 1;
