-- Migration 0026 — Audit event request-id correlation column.
--
-- Closes issue #229 (Round 6 follow-up to ADR-0018 §3). Adds
-- `audit_events.requestId TEXT NULL` so an operator triaging a 500
-- can `WHERE requestId = 'req_…'` directly against the audit row
-- instead of inferring the match by (tenantId + occurredAt window)
-- — the workaround documented in
-- docs/audits/HANDOFF-2026-05-17-round-5-pr2-complete.md §"Triage".
--
-- Scope (per data-architect's #229 pre-impl scoping):
--
--   * Forward-only ADD COLUMN. No backfill — pre-0026 rows stay
--     NULL by design. The triage flow already handles the
--     mixed-NULL state (operator falls back to tenantId + occurredAt
--     for legacy rows).
--   * No new index. The existing `(tenantId, occurredAt DESC)`
--     index (line 719 of schema.prisma) covers the realistic query
--     shape: request-id lookups are point-in-time + naturally
--     bounded by the requesting tenant. Add an index only when a
--     runbook query justifies it.
--   * Not part of the digest pre-image. `requestId` is observational
--     metadata about *who* requested (analogous to ipAddress and
--     userAgent, which migration 0021's header explicitly calls out
--     as "stored but not hashed — observational metadata about the
--     actor, not part of the audit-row's logical identity"). Adding
--     it to the digest would change the canonical pre-image format
--     and break chain-verify on pre-0026 rows.
--   * Both the TypeScript service path and the SECURITY DEFINER
--     trigger functions write rows; only the service path has access
--     to `currentRequestId()` (the trigger functions run inside a
--     SQL trigger, no Node ALS). Trigger-emitted rows keep
--     `requestId = NULL`, which is correct: a trigger fire is a
--     DB-internal correctness check, not a request-bound action.
--
-- `ALTER TABLE ADD COLUMN TEXT NULL` is metadata-only — takes
-- ACCESS EXCLUSIVE on `audit_events` for sub-millisecond, no
-- rewrite. Safe under load. The advisory lock from migration 0021
-- is unaffected (it's a runtime advisory, not a relation lock).

ALTER TABLE "audit_events"
    ADD COLUMN "requestId" TEXT NULL;

COMMENT ON COLUMN "audit_events"."requestId" IS
'Per-request correlation id (ADR-0018 §3). NULL for rows written before migration 0026, '
'for trigger-emitted rows (SECURITY DEFINER triggers run without Node ALS context), '
'and for service-driven writes outside an HTTP request (BootAuditModule, BullMQ workers, '
'scripts). Not part of the audit chain digest — observational metadata about the actor, '
'analogous to ipAddress / userAgent (per migration 0021 header).';
