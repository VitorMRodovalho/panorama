-- Migration 0025 — no RLS surface change.
--
-- `tenant_exports` is intentionally NOT granted to panorama_app.
-- All access via `prisma.runAsSuperAdmin` from the export
-- controller + worker. Adding an RLS policy for an audience that
-- has no underlying GRANT would be dead config.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
