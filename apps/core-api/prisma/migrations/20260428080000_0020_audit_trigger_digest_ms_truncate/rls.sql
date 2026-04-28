-- Migration 0020 — no RLS surface change.
--
-- Recreates two SECURITY DEFINER trigger functions to fix digest
-- reproducibility (#96 rounding-vs-truncation mismatch). The
-- functions retain SECURITY DEFINER + owner = panorama, so the
-- chain-is-global property from migration 0015 is preserved.
-- Audit_events RLS policies (migration 0001) continue to apply
-- unchanged.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
