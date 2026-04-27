-- Migration 0018 — no RLS surface change.
--
-- Adds one column + one partial index on `reservations`. RLS
-- policies on `reservations` from migration 0001 / 0010 continue
-- to apply unchanged; the new `isOverdue` column inherits the
-- per-tenant scoping of the row.
--
-- Placeholder kept for grep-greppability of the per-migration
-- RLS audit pattern.

SELECT 1;
