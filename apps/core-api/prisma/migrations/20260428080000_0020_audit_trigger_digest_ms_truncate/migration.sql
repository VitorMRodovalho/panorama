-- Migration 0020 — Audit trigger digest reproducibility fix (#96).
--
-- Problem
-- -------
-- Both SECURITY DEFINER audit triggers landed in migration 0015
-- declared `occurred timestamptz := now()` (microsecond precision)
-- and used the same value in two places:
--
--   1. `to_char(occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
--      → built into the digest payload. `to_char` with `MS` truncates
--      to 3 digits.
--   2. `INSERT INTO audit_events (..., "occurredAt", ...) VALUES (..., occurred, ...)`
--      → the column is `timestamp(3) without time zone`, which ROUNDS
--      to ms.
--
-- For ~50% of trigger fires (those where now() lands in
-- `[.xxx500, .yyy000)`), the to_char output uses `.xxx` while the
-- column rounds to `.yyy`. Verification tooling reading the row
-- can't recompute the digest because the original sub-millisecond
-- value is lost — the column-stored `occurredAt` differs from the
-- value to_char fed into the digest.
--
-- The chain itself is unaffected (prev_hash links are well-formed);
-- only the per-row digest verifiability is broken.
--
-- Fix
-- ---
-- Pre-truncate `occurred` to millisecond precision via
-- `date_trunc('milliseconds', now())`. Both the to_char output and
-- the column-stored value then use the SAME truncated value, so a
-- verifier reading the row can recompute the digest deterministically.
--
-- Pre-existing rows
-- -----------------
-- Rows written by the buggy version remain. Their digests are
-- internally consistent (the trigger and the verifier-of-the-time
-- both saw the same timestamptz), but a new verifier reading the
-- column-stored `occurredAt` cannot match them with certainty for
-- the rounded-up cases. The fix is forward-looking: from this
-- migration onward, rows are uniquely verifiable. Verifiers
-- inspecting historical rows should accept either
-- `(stored_ms, stored_ms - 1ms)` as candidate digest inputs and
-- match either.
--
-- Apply-time chain marker emitted at the bottom so verifier tooling
-- can locate the cutover.

-- ---------------------------------------------------------------------
-- Recreate emit_notification_tamper_audit with date_trunc'd occurred.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- #96: ms-truncate at declaration so to_char and the column INSERT
    -- both see the SAME value. Pre-#96 we declared `now()` directly
    -- (µs precision); to_char(MS) truncated to ms while the column
    -- rounded to ms, breaking digest reproducibility for ~50% of fires.
    occurred      timestamptz := date_trunc('milliseconds', now());
    payload_text  text;
    payload_bytes bytea;
    prev_hash     bytea;
    self_hash     bytea;
BEGIN
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

-- ---------------------------------------------------------------------
-- Recreate emit_pat_resurrected_audit with date_trunc'd occurred.
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

-- ---------------------------------------------------------------------
-- Cutover marker (apply-time, single insert, links into the global
-- chain so verifier tooling can find the rounding-fix boundary).
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
        'migration', '0020',
        'fixes', jsonb_build_array(
                     'emit_notification_tamper_audit timestamptz_ms_truncate',
                     'emit_pat_resurrected_audit timestamptz_ms_truncate'
                 ),
        'reason', 'digest_reproducibility_rounding_vs_truncation_mismatch'
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
END $$;
