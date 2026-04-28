-- Migration 0019 — no RLS surface change.
--
-- Adds one b-tree index on `invitations` for the admin list ORDER BY.
-- RLS policies on `invitations` from migration 0001 continue to apply
-- unchanged; the index is per-row metadata that inherits the same
-- per-tenant scoping the rest of the table already enforces.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern (matches 0017 / 0018 shape).

SELECT 1;
