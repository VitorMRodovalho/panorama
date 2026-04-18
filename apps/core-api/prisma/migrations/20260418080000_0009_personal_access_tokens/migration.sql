-- Migration 0009 — Personal Access Tokens (ADR-0010).
--
-- Per-user, tenant-scoped Bearer tokens that authenticate callers of
-- the Snipe-IT compatibility shim (/api/v1/*). Hashed at rest; plaintext
-- is returned once at creation and then only ever compared via
-- sha256(inbound) against `tokenHash`.
--
-- Schema invariants enforced at the DB layer:
--   * Unique tokenHash — lookup index + duplicate-secret defence.
--   * FK userId → users.id ON DELETE CASCADE — a deleted user's tokens
--     vanish with them.
--   * FK tenantId → tenants.id ON DELETE CASCADE — same, for tenant.
--   * FK issuerUserId → users.id ON DELETE RESTRICT — the provenance of
--     "who minted this token" stays stable; a user with outstanding
--     issued tokens cannot be deleted without first revoking or
--     reassigning. Issuer is usually = userId; differs under super-
--     admin impersonation (bulk onboarding).
--
-- The resurrection trigger at the bottom emits
-- `panorama.pat.resurrected` whenever `revokedAt` transitions
-- non-NULL → NULL. Our service layer never un-revokes; a row changing
-- back to NULL is a signal that someone poked the DB directly (CLI,
-- psql session, compromised super-admin credential). The trigger writes
-- an audit row as tamper evidence. The hash chain may not link
-- cryptographically on that row (the trigger does not re-read
-- `audit_events` under the same isolation the service layer does), but
-- the row itself is the signal that out-of-band state change happened
-- — verification tooling will flag the chain discontinuity.
--
-- RLS policies live in rls.sql (same split as earlier migrations).

-- CreateTable
CREATE TABLE "personal_access_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "issuerUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByIp" TEXT,
    "createdByUserAgent" TEXT,

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_access_tokens_tokenHash_key" ON "personal_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "personal_access_tokens_tenantId_userId_idx" ON "personal_access_tokens"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "personal_access_tokens_tenantId_revokedAt_idx" ON "personal_access_tokens"("tenantId", "revokedAt");

-- CreateIndex
CREATE INDEX "personal_access_tokens_userId_revokedAt_idx" ON "personal_access_tokens"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_issuerUserId_fkey"
    FOREIGN KEY ("issuerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Resurrection audit trigger — see header for rationale.
--
-- Builds the audit payload via json_build_object (key order matches
-- AuditService.recordWithin's JSON.stringify exactly so operator-side
-- verification tooling sees a single consistent shape across service
-- and trigger paths). Hash is sha256(prev_selfHash || payload_bytes),
-- matching AuditService's chain step.
CREATE OR REPLACE FUNCTION emit_pat_resurrected_audit()
RETURNS trigger AS $$
DECLARE
    prev_hash     bytea;
    occurred      timestamptz := now();
    payload_text  text;
    payload_bytes bytea;
    self_hash     bytea;
BEGIN
    -- Fire only on non-NULL → NULL. INSERT and NULL→NULL and NULL→ts
    -- are all no-ops.
    IF TG_OP <> 'UPDATE' THEN
        RETURN NEW;
    END IF;
    IF OLD."revokedAt" IS NULL OR NEW."revokedAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
      ORDER BY id DESC
      LIMIT 1;

    -- Payload keys match AuditService.recordWithin order:
    -- action, resourceType, resourceId, tenantId, actorUserId,
    -- metadata, occurredAt. actorUserId is NULL here — we don't know
    -- who made the direct UPDATE.
    payload_text := json_build_object(
        'action',       'panorama.pat.resurrected',
        'resourceType', 'personal_access_token',
        'resourceId',   NEW.id::text,
        'tenantId',     NEW."tenantId"::text,
        'actorUserId',  NULL,
        'metadata',     json_build_object(
                            'tokenId',     NEW.id::text,
                            'tokenPrefix', NEW."tokenPrefix",
                            'userId',      NEW."userId"::text,
                            'previousRevokedAt', to_char(OLD."revokedAt" AT TIME ZONE 'UTC',
                                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        ),
        'occurredAt',   to_char(occurred AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text;
    payload_bytes := convert_to(payload_text, 'UTF8');

    IF prev_hash IS NOT NULL THEN
        self_hash := digest(prev_hash || payload_bytes, 'sha256');
    ELSE
        self_hash := digest(payload_bytes, 'sha256');
    END IF;

    INSERT INTO audit_events (
        "tenantId", "actorUserId", action, "resourceType", "resourceId",
        metadata, "occurredAt", "prevHash", "selfHash"
    ) VALUES (
        NEW."tenantId",
        NULL,
        'panorama.pat.resurrected',
        'personal_access_token',
        NEW.id::text,
        json_build_object(
            'tokenId',     NEW.id::text,
            'tokenPrefix', NEW."tokenPrefix",
            'userId',      NEW."userId"::text,
            'previousRevokedAt', to_char(OLD."revokedAt" AT TIME ZONE 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        occurred,
        prev_hash,
        self_hash
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS emit_pat_resurrected_audit_trigger ON "personal_access_tokens";
CREATE TRIGGER emit_pat_resurrected_audit_trigger
    AFTER UPDATE ON "personal_access_tokens"
    FOR EACH ROW EXECUTE FUNCTION emit_pat_resurrected_audit();
