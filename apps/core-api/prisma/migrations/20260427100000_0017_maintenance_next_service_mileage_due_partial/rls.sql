-- Migration 0017 — no RLS surface change.
--
-- Adds one partial index on `asset_maintenances`. Indexes do not
-- interact with ENABLE/FORCE ROW LEVEL SECURITY policies; the
-- existing tenant-scoped + privileged-bypass policies on
-- `asset_maintenances` from migration 0014 continue to apply
-- unchanged. Placeholder kept for grep-greppability of the
-- per-migration RLS audit pattern.

SELECT 1;
