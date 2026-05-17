-- Migration 0023 — no RLS surface change.
--
-- `email_verifications` is intentionally NOT granted to panorama_app.
-- The verify endpoint runs from a logged-out browser (no tenant
-- context) and routes through `prisma.runAsSuperAdmin`, so the
-- super-admin role is the only access path. Adding an RLS policy
-- for an audience that has no underlying GRANT would be dead config.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
