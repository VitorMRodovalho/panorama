-- Migration 0015 — Audit Wave 1 data-layer corrections.
--
-- Bundles five surgical fixes filed during the 2026-04-23 QA/QC
-- baseline audit (Wave 1). They share a "shipped migration left a
-- correctness gap" theme; landing them as one migration keeps the
-- audit trail readable and gives ROLLBACK.md a single revert handle.
--
-- Issue        | Severity | Surface
-- -------------|----------|---------
-- DATA-04 #42  | high     | Tenant.systemActorUserId — missing FK
-- DATA-03 #41  | high     | notification tamper-audit prevHash always NULL
-- DATA-05 #43  | high     | notification dedup gap on cluster events (tenantId IS NULL)
-- PERF-06 #65  | high     | reservations(tenantId, onBehalfUserId) missing index
-- DATA-02 #30  | critical | migration 0014 RLS uses raw GUC cast (rls.sql)
--
-- The DATA-02 / #30 fix lives in this migration's `rls.sql` because the
-- defects it patches were introduced through 0014's `rls.sql`. The
-- other four fixes are DDL/DML and live here.

-- ---------------------------------------------------------------
-- 1. DATA-04 / #42 — FK on Tenant.systemActorUserId.
--    Migration 0014 added the column NOT NULL after backfill but
--    never added the FK constraint. Without it, a hard-delete of a
--    User leaves dangling tenant references and breaks
--    auto-suggested maintenance ticket creation at runtime
--    (createdByUserId resolves to a non-existent row).
-- ---------------------------------------------------------------

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_systemActorUserId_fkey"
    FOREIGN KEY ("systemActorUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------
-- 2. DATA-03 / #41 — notification tamper-audit prevHash.
--    The trigger in 0011 inserted audit rows with prevHash = NULL
--    and computed selfHash from the payload alone, breaking the
--    append-only hash chain.
--
--    Two corrections layered (security-reviewer #15-B1, B2):
--
--    a) Read the prior chain head and write its hash into prevHash
--       (chain-reading pattern from emit_pat_resurrected_audit).
--    b) SECURITY DEFINER + SET search_path. Without it, the trigger
--       fires under the invoker role (panorama_notification_dispatcher
--       has INSERT-only on audit_events; the SELECT for prev_hash
--       would error). It would also see only the per-tenant strand
--       of the chain (audit_events has FORCE RLS, scoped by
--       panorama_current_tenant()). Definer = panorama (BYPASSRLS),
--       so the chain remains global and the SELECT/INSERT succeed.
--
--    Forward-only: pre-fix rows (if any wrote during the broken
--    window — none in production today, possible in dev DBs) keep
--    their NULL prevHash. The cutover marker emitted at the end of
--    this migration delineates pre/post-fix rows for any future
--    chain verifier.
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    occurred      timestamptz := now();
    payload_text  text;
    payload_bytes bytea;
    prev_hash     bytea;
    self_hash     bytea;
BEGIN
    -- Same predicate as the original — only disallowed transitions
    -- raise an audit row. Happy-path dispatcher updates short-circuit.
    IF NOT (
        (OLD."status" = 'PENDING'     AND NEW."status" = 'DISPATCHED') OR
        (OLD."status" = 'DEAD')                                        OR
        (OLD."status" = 'DISPATCHED'  AND NEW."status" <> 'DISPATCHED')
    ) THEN
        RETURN NEW;
    END IF;

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
      ORDER BY id DESC
      LIMIT 1;

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
        'panorama.notification.status_tampered',
        'notification_event',
        NEW.id::text,
        json_build_object(
            'fromStatus', OLD."status"::text,
            'toStatus',   NEW."status"::text,
            'eventType',  NEW."eventType"
        ),
        occurred,
        prev_hash,
        self_hash
    );

    RETURN NEW;
END;
$$;

-- The PAT trigger from migration 0009 has the same RLS-strand
-- defect (silently scoped chain when invoked under a non-BYPASSRLS
-- role under FORCE RLS on audit_events). Fix it the same way:
-- replace the function with a SECURITY DEFINER wrapper of the
-- existing body. Body is byte-identical to 0009 §emit_pat_resurrected_audit
-- modulo the function header.
CREATE OR REPLACE FUNCTION emit_pat_resurrected_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

-- ---------------------------------------------------------------
-- 3. DATA-05 / #43 — notification dedup gap for cluster events.
--    The original partial unique index treats two NULL `tenantId`
--    values as distinct (Postgres default), so cluster-wide events
--    (tenantId IS NULL) skip dedup entirely. PG 15+ supports
--    NULLS NOT DISTINCT which collapses the NULL-equals-NULL semantics
--    we want for dedup.
-- ---------------------------------------------------------------

DROP INDEX IF EXISTS "notification_events_dedup_unique";
CREATE UNIQUE INDEX "notification_events_dedup_unique"
    ON "notification_events" ("tenantId", "eventType", "dedupKey")
    NULLS NOT DISTINCT
    WHERE "dedupKey" IS NOT NULL;

-- ---------------------------------------------------------------
-- 4. PERF-06 / #65 — reservations(tenantId, onBehalfUserId) index.
--    The "my reservations" query OR-arms over (requesterUserId =
--    $userId OR onBehalfUserId = $userId). Existing index covers
--    the requester arm; the onBehalfUserId arm seq-scans the tenant
--    partition. At pre-alpha scale this is a millisecond; at 100k
--    rows/tenant it's ~50ms+.
--
--    CREATE INDEX (non-CONCURRENT) is fine pre-alpha and acquires
--    SHARE on reservations for the build duration — at <50k rows
--    that's milliseconds. **At production scale (~100k+ rows or
--    sustained writer traffic), switch to `CREATE INDEX CONCURRENTLY`.
--    CONCURRENTLY cannot run inside a transaction, so it would need
--    its own migration file with no other DDL statements.** Don't
--    repeat the pattern in this migration when reservations grows.
-- ---------------------------------------------------------------

CREATE INDEX "reservations_tenantId_onBehalfUserId_idx"
    ON "reservations" ("tenantId", "onBehalfUserId");

-- ---------------------------------------------------------------
-- 5. Chain cutover marker (data-architect #15-2 + security-reviewer
--    #15-Concerns).
--
--    Writes a single audit row immediately after the trigger
--    replacements above so chain-verification tooling has a
--    deterministic boundary, not a heuristic on migration timestamp.
--    Rows with id < this row's id may have NULL prevHash (pre-fix
--    notification trigger output, pre-fix PAT trigger output, or
--    legitimate first-row-of-chain). Rows with id > this row's id
--    must have non-NULL prevHash unless they are themselves the
--    chain head at the time of write.
--
--    The marker uses panorama.audit.chain_repair as its action so
--    a verifier finds it via grep on action, not by parsing
--    metadata. tenantId IS NULL — this is a cluster-wide event.
-- ---------------------------------------------------------------

DO $$
DECLARE
    prev_hash     bytea;
    payload_text  text;
    payload_bytes bytea;
    self_hash     bytea;
    occurred      timestamptz := now();
    metadata_json jsonb;
BEGIN
    metadata_json := jsonb_build_object(
        'migration', '20260426094000_0015_audit_wave1_data_layer_corrections',
        'reason',    'forward-only chain repair after #41 / DATA-03',
        'fixes',     jsonb_build_array(
                         'emit_notification_tamper_audit chain-reading',
                         'emit_pat_resurrected_audit SECURITY DEFINER'
                     )
    );

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
      ORDER BY id DESC
      LIMIT 1;

    payload_text := json_build_object(
        'action',       'panorama.audit.chain_repair',
        'resourceType', 'audit_chain',
        'resourceId',   NULL,
        'tenantId',     NULL,
        'actorUserId',  NULL,
        'metadata',     metadata_json,
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
        NULL,
        NULL,
        'panorama.audit.chain_repair',
        'audit_chain',
        NULL,
        metadata_json,
        occurred,
        prev_hash,
        self_hash
    );
END
$$;
