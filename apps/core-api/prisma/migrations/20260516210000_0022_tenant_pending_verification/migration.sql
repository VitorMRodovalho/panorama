-- Migration 0022 — Tenant.pendingVerification flag.
--
-- ADR-0020 §3 (Email-verification gate) requires that a self-serve
-- signup provisions the tenant in a `pending_verification` state; the
-- first login is blocked until the verification token is consumed by
-- the verify endpoint that lands in PR 2.
--
-- This migration adds ONLY the marker column. The route guard that
-- reads it + the POST /auth/verify flip + the per-email throttle are
-- scoped to PR 2 (per HANDOFF-2026-05-16-session-end-round-3-prereqs
-- §"Endpoint PR 2").
--
-- Forward-only and additive:
--   - Default `false` so every existing tenant continues to behave as
--     a fully-verified tenant. Backfill is implicit (column default).
--   - NOT NULL because a NULL would create a third state (verified /
--     pending / unknown) — the signup-callback writer in PR 1 sets
--     `true`, every other tenant-creation site keeps the default
--     `false`.
--   - No RLS surface change; the column inherits the existing
--     `tenants_*` policies.

ALTER TABLE "tenants"
    ADD COLUMN "pendingVerification" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN "tenants"."pendingVerification" IS
'ADR-0020 §3 — true while the email-verification token minted at '
'self-serve signup is unconsumed. Self-host tenants and seeded '
'tenants stay false. PR 2 adds the route guard + flip endpoint.';
