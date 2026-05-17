-- Migration 0023 — Email verification table.
--
-- ADR-0020 §3 implementation surface for the self-serve signup
-- verify-endpoint pair (PR 2 endpoint at POST /auth/verify;
-- companion mint+dispatch lives in
-- modules/email-verification/email-verification.service.ts).
--
-- Forward-only and additive:
--   - panorama_app does NOT receive any GRANTs on the table; every
--     access path routes through `prisma.runAsSuperAdmin`. The verify
--     endpoint runs from a logged-out browser with no tenant context,
--     and no operator workflow needs to inspect verification rows
--     from the tenant-scoped surface.
--   - No RLS policies for the same reason — the table is super-admin-
--     only by GRANT, and adding policies for an audience that has
--     no SELECT privilege anyway would be dead config.
--   - The per-email cap (3 / 24h) is enforced via Redis (`RateLimiter`),
--     NOT a DB-side partial unique, because the cap counts DISPATCH
--     ATTEMPTS regardless of token state. A partial unique on
--     (tenantId, consumedAt IS NULL) would conflate "open" rows with
--     "throttled" semantics.
--
-- Cleanup of expired+consumed rows is out of scope for PR 2; a
-- sweep job lives in Round 5 (observability) work.

CREATE TABLE "email_verifications" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"     UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "tenantId"  UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "emailLower" TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL UNIQUE,
    "expiresAt"  TIMESTAMPTZ NOT NULL,
    "consumedAt" TIMESTAMPTZ,
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "email_verifications_tenantId_idx"
    ON "email_verifications"("tenantId");

COMMENT ON TABLE "email_verifications" IS
'ADR-0020 §3 — one-time-use email-verification tokens minted at '
'self-serve signup. Consumed by POST /auth/verify; flips '
'tenants.pendingVerification to false in the same transaction. '
'panorama_app has NO grants on this table — all access via '
'prisma.runAsSuperAdmin. Per-email cap (3/24h) lives in Redis.';
