-- Migration 0021 — Audit chain reproducibility + concurrency hardening.
--
-- Closes the audit-chain-as-trust-anchor gap surfaced by the
-- 2026-05-16 Wave 0 6-agent scan (security-reviewer B2 + data-
-- architect Blocker 3) and ADR-0014's "tamper-evident audit log"
-- claim. Three intertwined defects, fixed together so we only
-- emit one chain-cutover marker:
--
--   D1. The per-row digest is **unreproducible** from the stored
--       columns. The trigger and the TypeScript writer both hash a
--       canonical JSON pre-image, but only the *result* (selfHash)
--       is persisted. `audit_events.metadata` is JSONB, which
--       Postgres recanonicalises (alphabetises keys, strips
--       whitespace) on store, so a verifier reading the row back
--       cannot recompute the digest input byte-for-byte.
--
--       Migration 0020 fixed the timestamp arm of this problem
--       (ms-truncate so to_char and the column INSERT see the same
--       value). The metadata-canonicalisation arm is closed HERE by
--       persisting the exact pre-image bytes alongside the digest.
--
--   D2. Chain-head SELECT under concurrent writers can **fork**
--       the chain. Two transactions reading the same `priorTail`
--       both write rows whose `prevHash` points to the same
--       predecessor — the chain becomes a tree with two children
--       under one parent. data-architect Blocker 3.
--
--       Fixed via `pg_advisory_xact_lock(hashtext('audit:global'))`
--       immediately before the chain-head SELECT in BOTH trigger
--       functions (and in the TypeScript writer, in a sibling
--       change to `audit.service.ts`). The lock scope matches the
--       chain-head SELECT scope: the trigger functions are
--       SECURITY DEFINER owned by `panorama` (BYPASSRLS, per
--       migration 0015), so their SELECT sees the global head — a
--       per-tenant lock would let two cross-tenant writers both
--       read the same global tail and fork. A global lock kills
--       cross-tenant audit-write parallelism; that's acceptable
--       for an append-only log whose write rate is bounded by
--       domain-write volume.
--
--   D3. The tamper-audit triggers fire on specific status
--       transitions only — a row whose UPDATE also flips
--       `tenantId` (cross-tenant re-targeting) slips past the
--       predicate entirely. security-reviewer #15-B2.
--
--       Fixed via `IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
--       THEN RAISE EXCEPTION ...` at the top of each trigger
--       (BEFORE the transition predicate, so it cannot be
--       short-circuited).
--
-- Also: the trigger chain-head SELECT gains a
-- `WHERE "selfHash" IS NOT NULL` defensive filter (data-architect).
-- The column is NOT NULL at the schema level so the filter is
-- currently a no-op, but in raw SQL the cost is zero and the filter
-- makes the read self-documenting + survives any future schema
-- relaxation. The TypeScript writer in `audit.service.ts` does NOT
-- carry the same filter — Prisma's typed where-clause for a
-- non-nullable Bytes column won't accept `{ selfHash: { not: null } }`
-- in a clean way, and the column-level NOT NULL constraint enforces
-- the same property end-to-end. The comment in the service
-- (`audit.service.ts:160-165`) explains the asymmetry.
--
-- Forward-only: pre-0021 rows have `digestPreImage = NULL` and are
-- flagged as "unverifiable (legacy)" by the chain-verify CLI. All
-- post-0021 rows are byte-exact reproducible.

-- ---------------------------------------------------------------------
-- 1. Add the canonical pre-image column.
-- ---------------------------------------------------------------------
ALTER TABLE "audit_events"
    ADD COLUMN "digestPreImage" BYTEA;

COMMENT ON COLUMN "audit_events"."digestPreImage" IS
'Canonical UTF-8 JSON pre-image hashed into selfHash. '
'sha256(COALESCE(prevHash, '''') || digestPreImage) = selfHash for '
'rows written from migration 0021 onward. NULL for pre-0021 rows '
'(legacy, unverifiable).';

-- ---------------------------------------------------------------------
-- 2. Rewrite emit_notification_tamper_audit().
--    Adds: tenant-immutable early-RAISE, per-strand advisory lock,
--    chain-head selfHash filter, digestPreImage persistence.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- #96 (migration 0020): ms-truncate so to_char(MS) and the
    -- column INSERT see the same value.
    occurred      timestamptz := date_trunc('milliseconds', now());
    payload_text  text;
    payload_bytes bytea;
    prev_hash     bytea;
    self_hash     bytea;
BEGIN
    -- D3: reject any UPDATE that flips tenantId. The audit
    -- predicate below only fires on specific status transitions,
    -- so a same-status tenantId swap would otherwise sneak past
    -- unaudited. This check runs FIRST so it cannot be
    -- short-circuited by the early RETURN.
    IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'tenantId_immutable_post_create'
            USING ERRCODE = 'check_violation',
                  DETAIL  = format(
                      'notification_events.id=%s attempted tenantId %s -> %s',
                      NEW.id, OLD."tenantId", NEW."tenantId"
                  );
    END IF;

    IF NOT (
        (OLD."status" = 'PENDING'     AND NEW."status" = 'DISPATCHED') OR
        (OLD."status" = 'DEAD')                                        OR
        (OLD."status" = 'DISPATCHED'  AND NEW."status" <> 'DISPATCHED')
    ) THEN
        RETURN NEW;
    END IF;

    -- D2: serialise audit writes globally so the chain-head SELECT
    -- + INSERT pair is atomic against concurrent writers. The
    -- trigger SELECT is global (SECURITY DEFINER + BYPASSRLS owner
    -- per migration 0015), so the lock must cover the SAME scope.
    -- A per-tenant lock with a global SELECT permits two cross-
    -- tenant writers to both read the same priorTail.selfHash and
    -- both write rows pointing to it — forking the global chain.
    -- Audit writes are sparse and tiny; global serialisation is
    -- well below the contention floor.
    PERFORM pg_advisory_xact_lock(hashtext('audit:global'));

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
     WHERE "selfHash" IS NOT NULL
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
        metadata, "occurredAt", "prevHash", "selfHash", "digestPreImage"
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
        self_hash,
        payload_bytes
    );

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Rewrite emit_pat_resurrected_audit().
--    Same shape as #2 — tenant-immutable + lock + selfHash filter +
--    digestPreImage persistence.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_pat_resurrected_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    prev_hash     bytea;
    -- See emit_notification_tamper_audit comment for rationale.
    occurred      timestamptz := date_trunc('milliseconds', now());
    payload_text  text;
    payload_bytes bytea;
    self_hash     bytea;
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- D3: same tenant-immutable invariant as the notification
    -- trigger. A revoke that *also* swaps tenantId would otherwise
    -- audit-mute itself.
    IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
        RAISE EXCEPTION 'tenantId_immutable_post_create'
            USING ERRCODE = 'check_violation',
                  DETAIL  = format(
                      'personal_access_tokens.id=%s attempted tenantId %s -> %s',
                      NEW.id, OLD."tenantId", NEW."tenantId"
                  );
    END IF;

    IF OLD."revokedAt" IS NULL OR NEW."revokedAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- D2: see emit_notification_tamper_audit comment for the
    -- single-global-lock rationale (SELECT scope = global → lock
    -- scope = global).
    PERFORM pg_advisory_xact_lock(hashtext('audit:global'));

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
     WHERE "selfHash" IS NOT NULL
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
        metadata, "occurredAt", "prevHash", "selfHash", "digestPreImage"
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
        self_hash,
        payload_bytes
    );

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Extend the notification trigger's UPDATE OF column list.
--
--    Migration 0011 created the trigger with
--    `AFTER UPDATE OF "status" ON "notification_events"`, so an
--    UPDATE that flips ONLY `tenantId` (no status change) skips the
--    trigger entirely — the tenant-immutable RAISE added above
--    would never run. Extend the fire-list to include `tenantId`
--    so any column-mention triggers the function. The function's
--    own predicate (the IF NOT (status transition) RETURN NEW
--    branch) is unchanged, so status-only updates still hit the
--    same audit-emission path; tenantId-flipping updates hit the
--    new RAISE first.
--
--    DROP + CREATE under the same name in one statement-batch is
--    atomic w.r.t. concurrent writers (the underlying ACCESS
--    EXCLUSIVE lock on `notification_events` covers both).
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS emit_notification_tamper_audit_trigger
    ON "notification_events";
CREATE TRIGGER emit_notification_tamper_audit_trigger
    AFTER UPDATE OF "status", "tenantId" ON "notification_events"
    FOR EACH ROW EXECUTE FUNCTION emit_notification_tamper_audit();

-- The PAT trigger from 0009 fires on every UPDATE (no column list)
-- so the tenantId-immutable RAISE in emit_pat_resurrected_audit
-- already reaches every tenantId flip. No trigger DDL change needed
-- here.

-- ---------------------------------------------------------------------
-- 5. Cutover marker (apply-time single insert; links into the global
--    strand). Pre-image is also stored so the marker itself verifies
--    via the new chain-verify CLI from migration apply forward.
--
--    No advisory lock here — a DDL migration is a single-writer
--    context by definition.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    occurred       timestamptz := date_trunc('milliseconds', now());
    metadata_json  jsonb;
    payload_text   text;
    payload_bytes  bytea;
    prev_hash      bytea;
    self_hash      bytea;
BEGIN
    metadata_json := jsonb_build_object(
        'migration', '0021',
        'fixes', jsonb_build_array(
                     'audit_events.digestPreImage column (D1: JSONB recanonicalisation)',
                     'pg_advisory_xact_lock global on chain-head SELECT (D2: fork race)',
                     'tenantId-immutable trigger early-RAISE (D3: cross-tenant retarget)',
                     'WHERE "selfHash" IS NOT NULL chain-head guard'
                 ),
        'reason', 'audit_chain_reproducibility_and_concurrency'
    );

    SELECT "selfHash" INTO prev_hash
      FROM audit_events
     WHERE "selfHash" IS NOT NULL
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
        metadata, "occurredAt", "prevHash", "selfHash", "digestPreImage"
    ) VALUES (
        NULL,
        NULL,
        'panorama.audit.chain_repair',
        'audit_chain',
        NULL,
        metadata_json,
        occurred,
        prev_hash,
        self_hash,
        payload_bytes
    );
END $$;
