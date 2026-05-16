-- Migration 0021 — no RLS surface change.
--
-- Adds a column to `audit_events` and rewrites two SECURITY DEFINER
-- trigger functions. The column inherits the table's existing RLS
-- policies (migrations 0001 + #41 follow-ups). The trigger
-- functions keep SECURITY DEFINER + owner = panorama so the
-- chain-is-global property from migration 0015 is preserved.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
