-- Migration 0025 — Tenant data export job tracking (ADR-0020 §8).
--
-- ADR-0020 §8 commits to:
--   - POST /tenants/:tenantId/export (Owner-only). The ADR § 8 text
--     originally said GET; PR 4 changed to POST because the action
--     mutates the ledger + emits audit on every call. The PR-4
--     amendment to ADR §8 documents the deviation.
--   - GET /tenants/:tenantId/exports/:jobId/download (Owner-only).
--     Session-gated download endpoint added per security-reviewer's
--     middlebox-prefetch finding: the completion email links here
--     instead of the presigned S3 URL so mail-security gateways
--     that prefetch URLs hit 401 (no session) and cache that, not
--     the file bytes.
--   - Async via queue; response is a job id; the actual export runs
--     in a worker that uploads a tarball to S3, mints a presigned
--     URL ≤24h, and emails the URL to the Owner.
--   - Audit row stores S3 object key + recipient + TTL; NEVER the
--     signed URL itself (which embeds credentials).
--   - Per-tenant rate limit: 1 export / tenant / 24h, fail-closed
--     via Redis (not DB-side).
--
-- This migration adds the `tenant_exports` ledger table that
-- tracks each job's lifecycle. panorama_app has NO grants on this
-- table — the export controller + worker route through
-- runAsSuperAdmin (the worker crosses the tenant boundary at write
-- time, and the controller's read uses the same path for
-- simplicity).
--
-- `status` is a TEXT enum (not a Postgres ENUM type) so adding a
-- new status in a future PR is an additive code change without a
-- schema migration. Allowed values today:
--   - `queued`     — controller enqueued; worker hasn't picked up
--   - `processing` — worker took the job; serialising + uploading
--   - `completed`  — uploaded; expiresAt + completedAt set
--   - `failed`     — worker errored; failedReason set
--   - `expired`    — completed but past expiresAt (set by a future
--                    sweep that nulls objectKey + S3 lifecycle
--                    drops the actual object)
--
-- Forward-only and additive. Self-host operators who never call the
-- endpoint never write to this table.

CREATE TABLE "tenant_exports" (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"          UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "requestedByUserId" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "status"            TEXT NOT NULL DEFAULT 'queued',
    "objectKey"         TEXT,
    "objectSizeBytes"   BIGINT,
    "expiresAt"         TIMESTAMPTZ,
    "completedAt"       TIMESTAMPTZ,
    "failedReason"      TEXT,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "tenant_exports_tenantId_createdAt_idx"
    ON "tenant_exports"("tenantId", "createdAt" DESC);

CREATE INDEX "tenant_exports_status_idx"
    ON "tenant_exports"("status")
    WHERE "status" IN ('queued', 'processing');

COMMENT ON TABLE "tenant_exports" IS
'ADR-0020 §8 — tenant-data export job ledger. One row per request. '
'panorama_app has NO grants — service routes via runAsSuperAdmin. '
'Per-tenant 1/24h rate limit lives in Redis (RateLimiter).';
