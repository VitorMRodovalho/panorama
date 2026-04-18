-- Migration 0011 — Notification event bus (ADR-0011).
--
-- Outbox table + status enum + partial unique dedup index + payload
-- size cap + tamper-detection trigger + narrow dispatcher role +
-- per-tenant retention column. Pre-code review by tech-lead and
-- security-reviewer closed every blocker before this migration was
-- drafted (see ADR-0011 §Review log).
--
-- Schema shape is justified in the ADR; see it for the "why".

-- CreateEnum
CREATE TYPE "notification_event_status" AS ENUM (
    'PENDING', 'IN_PROGRESS', 'DISPATCHED', 'FAILED', 'DEAD'
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "notification_event_status" NOT NULL DEFAULT 'PENDING',
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorHistory" JSONB NOT NULL DEFAULT '[]',
    "channelResults" JSONB NOT NULL DEFAULT '{}',
    "dedupKey" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_events_status_availableAt_idx"
    ON "notification_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notification_events_tenantId_eventType_createdAt_idx"
    ON "notification_events"("tenantId", "eventType", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "notification_events"
    ADD CONSTRAINT "notification_events_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index — dedup enforcement at the DB layer. ONE row
-- per (tenantId, eventType, dedupKey) across the whole lifetime of
-- the key, regardless of status. Two concurrent enqueues both race
-- the INSERT; the second one fails with 23505 which the service
-- treats as a successful dedup skip. A dead-lettered row blocks new
-- attempts with the same key until the operator prunes it (by
-- design — same-key reuse requires human intent).
CREATE UNIQUE INDEX "notification_events_dedup_unique"
    ON "notification_events" ("tenantId", "eventType", "dedupKey")
    WHERE "dedupKey" IS NOT NULL;

-- Payload size cap — 16 kB. Stops a domain author from accidentally
-- stuffing { JSON.stringify(fullUser) } into the event row.
ALTER TABLE "notification_events"
    ADD CONSTRAINT "notification_events_payload_size_cap"
    CHECK (pg_column_size("payload") <= 16384);

-- Per-tenant retention override. NULL = default 90 d fallback; a
-- tenant with stricter data-governance can override. Ships NOW so a
-- Q3 audit can't trigger a migration scramble.
ALTER TABLE "tenants"
    ADD COLUMN "notificationRetentionDays" INTEGER;

-- Tamper-detection trigger — catches direct-SQL status flips that
-- bypass the dispatcher. A compromised super-admin flipping status
-- to DISPATCHED to suppress a legit notification leaves an audit row
-- in the hash-chain (same pattern as ADR-0010's pat.resurrected).
CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger AS $$
DECLARE
    occurred      timestamptz := now();
    payload_text  text;
    payload_bytes bytea;
    self_hash     bytea;
BEGIN
    -- Disallowed transitions: direct PENDING→DISPATCHED skips the
    -- IN_PROGRESS claim + handler run; DEAD→* resurrects a
    -- permanently-failed row; DISPATCHED→* re-opens a terminal row.
    -- These are the shapes an attacker flipping status by hand would
    -- produce. The dispatcher's happy path goes
    -- PENDING→IN_PROGRESS→DISPATCHED|FAILED→DEAD|DISPATCHED, which
    -- never hits these.
    IF NOT (
        (OLD."status" = 'PENDING'     AND NEW."status" = 'DISPATCHED') OR
        (OLD."status" = 'DEAD')                                        OR
        (OLD."status" = 'DISPATCHED'  AND NEW."status" <> 'DISPATCHED')
    ) THEN
        RETURN NEW;
    END IF;

    payload_text := json_build_object(
        'action',       'panorama.notification.status_tampered',
        'resourceType', 'notification_event',
        'resourceId',   NEW.id::text,
        'tenantId',     NEW."tenantId"::text,
        'actorUserId',  NULL,
        'metadata',     json_build_object(
                            'fromStatus', OLD."status"::text,
                            'toStatus',   NEW."status"::text,
                            'eventType',  NEW."eventType"
                        ),
        'occurredAt',   to_char(occurred AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text;
    payload_bytes := convert_to(payload_text, 'UTF8');
    self_hash := digest(payload_bytes, 'sha256');

    INSERT INTO audit_events (
        "tenantId", "actorUserId", action, "resourceType", "resourceId",
        metadata, "occurredAt", "prevHash", "selfHash"
    ) VALUES (
        NEW."tenantId",
        NULL,
        'panorama.notification.status_tampered',
        'notification_event',
        NEW.id::text,
        json_build_object(
            'fromStatus', OLD."status"::text,
            'toStatus',   NEW."status"::text,
            'eventType',  NEW."eventType"
        ),
        occurred,
        NULL,
        self_hash
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS emit_notification_tamper_audit_trigger
    ON "notification_events";
CREATE TRIGGER emit_notification_tamper_audit_trigger
    AFTER UPDATE OF "status" ON "notification_events"
    FOR EACH ROW EXECUTE FUNCTION emit_notification_tamper_audit();

-- Narrow role for the dispatcher process. SELECT + UPDATE on
-- notification_events and INSERT on audit_events is the entire
-- surface — a compromised channel handler can't exfiltrate other
-- tables under this role (ADR-0011 least-privilege requirement).
-- Idempotent with an exception guard so re-running the migration on
-- an already-provisioned DB doesn't error.
DO $$
BEGIN
    CREATE ROLE panorama_notification_dispatcher NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT CONNECT ON DATABASE panorama TO panorama_notification_dispatcher;
GRANT USAGE ON SCHEMA public TO panorama_notification_dispatcher;
GRANT SELECT, UPDATE ON "notification_events" TO panorama_notification_dispatcher;
GRANT INSERT ON "audit_events"                  TO panorama_notification_dispatcher;
-- The role also needs access to the audit sequence to insert rows.
GRANT USAGE, SELECT ON SEQUENCE "audit_events_id_seq"
    TO panorama_notification_dispatcher;

-- Allow the app role to SET LOCAL ROLE into the dispatcher role
-- (same pattern as panorama_app → panorama_super_admin).
GRANT panorama_notification_dispatcher TO panorama_app;
