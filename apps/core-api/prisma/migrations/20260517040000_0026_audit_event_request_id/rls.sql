-- Migration 0026 — no RLS surface change.
--
-- `audit_events.requestId` is a metadata column on a table that
-- already has its RLS policies set up (`audit_events_tenant_read`
-- per ADR-0003). Adding a new nullable column does not change the
-- visibility predicates — a row's `requestId` is visible to the
-- same audience as the rest of the row's columns.
--
-- Placeholder kept for grep-greppability of the per-migration RLS
-- audit pattern.

SELECT 1;
