# Rollback — 0021 audit digest pre-image + chain lock + tenant-immutable

## Pre-flight (operator MUST verify BEFORE running)

This migration closes three intertwined defects (see `migration.sql`
header). Rollback re-opens all three at once:

- D1: per-row digest becomes unreproducible from columns (JSONB
  recanonicalisation race)
- D2: chain-head SELECT can fork under concurrent same-strand writers
- D3: tenant-immutable invariant on `notification_events` and
  `personal_access_tokens` UPDATEs is gone

Only roll back if the chain-verify CLI regresses against the
post-0021 digest format AND the regression cannot be patched in the
verifier itself.

## SQL revert (privileged role)

Run from a psql session against `$DATABASE_PRIVILEGED_URL`.

```sql
-- 5. Cutover marker — leave in place. The marker is an audit row
--    documenting that the fix WAS applied. Deleting it would break
--    the chain (rows written after the marker have prevHash
--    pointing to it).
--
--    The chain-verify CLI treats the marker as a historical
--    waypoint regardless of whether the fix is still in force.

-- 4. Restore the 0011 notification trigger DDL (column fire-list).
--    Migration 0021 extended the trigger to
--      AFTER UPDATE OF "status", "tenantId" ON "notification_events"
--    so the tenant-immutable RAISE could intercept tenantId-only
--    UPDATEs. Reverting restores the 0011 status-only fire-list:
DROP TRIGGER IF EXISTS emit_notification_tamper_audit_trigger
    ON "notification_events";
CREATE TRIGGER emit_notification_tamper_audit_trigger
    AFTER UPDATE OF "status" ON "notification_events"
    FOR EACH ROW EXECUTE FUNCTION emit_notification_tamper_audit();

-- 3 + 2. Restore the pre-0021 trigger function bodies (from
--    migration 0020). Don't `\i` the whole 0020 file — that would
--    re-fire 0020's DO $$ block and emit a spurious second
--    `panorama.audit.chain_repair` marker, polluting the audit
--    provenance trail with a second "0020 was applied" claim.
--    Inline the two CREATE OR REPLACE FUNCTION blocks instead.
--    The function bodies below are byte-identical to the post-0020
--    versions; see migration 0020's `migration.sql` for the source
--    of truth.

CREATE OR REPLACE FUNCTION emit_notification_tamper_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $rollback$
DECLARE
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
    SELECT "selfHash" INTO prev_hash FROM audit_events
        ORDER BY id DESC LIMIT 1;
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
        NEW."tenantId", NULL,
        'panorama.notification.status_tampered', 'notification_event',
        NEW.id::text,
        json_build_object(
            'fromStatus', OLD."status"::text,
            'toStatus',   NEW."status"::text,
            'eventType',  NEW."eventType"
        ),
        occurred, prev_hash, self_hash
    );
    RETURN NEW;
END;
$rollback$;

CREATE OR REPLACE FUNCTION emit_pat_resurrected_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $rollback$
DECLARE
    prev_hash     bytea;
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
    SELECT "selfHash" INTO prev_hash FROM audit_events
        ORDER BY id DESC LIMIT 1;
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
        NEW."tenantId", NULL,
        'panorama.pat.resurrected', 'personal_access_token',
        NEW.id::text,
        json_build_object(
            'tokenId',     NEW.id::text,
            'tokenPrefix', NEW."tokenPrefix",
            'userId',      NEW."userId"::text,
            'previousRevokedAt', to_char(OLD."revokedAt" AT TIME ZONE 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ),
        occurred, prev_hash, self_hash
    );
    RETURN NEW;
END;
$rollback$;

-- 1. Drop the canonical pre-image column.
--    Pre-0021 rows have digestPreImage IS NULL already; only the
--    rows written between 0021 apply and rollback carry data.
--    Those bytes are recoverable by re-deriving the JSON pre-image
--    from columns (only possible IF the metadata canonicalisation
--    arm D1 happens to not have triggered for the row). Don't
--    rely on this — assume the column data is gone.
ALTER TABLE "audit_events"
    DROP COLUMN "digestPreImage";
```

## Data-loss warnings

- **Cutover marker is preserved.** The `panorama.audit.chain_repair`
  row with `metadata->>'migration' = '0021'` stays. Rows written
  after the marker continue to chain through it. The verifier sees
  the marker on each side of a rollback as a "format change point"
  with two adjacent cutover markers (0020 → 0021 → 0020-replayed).
- **digestPreImage bytes are dropped.** Rows written DURING the
  window 0021 was applied lose their pre-image. They remain
  internally consistent (the trigger and the verifier-of-the-time
  saw the same canonical text), but verifier tooling without the
  pre-image must fall back to "trust selfHash, cannot recompute."
- **Tenant-immutable RAISE goes away.** A pre-existing in-flight
  UPDATE that would have errored under 0021 will succeed under the
  rolled-back trigger.
- **Global advisory lock goes away.** Concurrent writers can again
  fork the chain via the priorTail race documented in
  migration.sql header §D2.

## When you would actually revert

- chain-verify CLI cannot understand the post-0021 digest format
  even after a verifier patch. The pre-image format is intentionally
  the minimal viable surface (canonical UTF-8 JSON of the same shape
  the service hashes) — if the verifier struggles, patch the
  verifier first; rollback is the last resort.
- The global advisory lock causes a deadlock with another
  long-held audit-table lock. Diagnosis: `SELECT * FROM pg_locks
  WHERE locktype = 'advisory' AND classid = 0`. Mitigation: drop
  the `PERFORM pg_advisory_xact_lock(hashtext('audit:global'))`
  lines from the trigger functions and the service (re-opens D2's
  fork race). Investigate the contending caller first — the audit
  writes themselves are tiny.
- The tenant-immutable RAISE blocks a legitimate cross-tenant
  re-targeting operation (extremely unlikely — by design, the only
  cross-tenant write paths are seeded data + `runAsSuperAdmin`
  explicit escape hatches, neither of which fire these triggers).

## Re-apply pattern

Forward-only by design. If 0021 is rolled back and then re-applied
after new audit-event rows have been written:

1. Rows written DURING the rollback window have
   `digestPreImage = NULL` (the pre-0021 trigger functions don't
   populate the column).
2. Re-applying 0021 emits a NEW `panorama.audit.chain_repair`
   marker and restarts digestPreImage persistence from that point
   forward.
3. The chain-verify CLI categorises any NULL-pre-image row as
   "legacy (unverifiable)" — counted but neither pass nor fail.
   The per-row verifier walks linearly and does not need to know
   where the markers are; rows are classified on their own
   `digestPreImage` presence, not on which marker they sit between.

## Schema implications

`schema.prisma` was updated to mirror the new column:

```prisma
model AuditEvent {
  // ...
  digestPreImage Bytes?
}
```

A revert of THIS migration must also revert that line from
`schema.prisma` — otherwise `prisma migrate status` will diff
against the rolled-back DB. The SQL revert block above only
handles the database side; the schema edit is a separate manual
step that MUST land in the same commit as the SQL revert.

## Production migration timing

- `ALTER TABLE ADD COLUMN BYTEA` is metadata-only (no rewrite); takes
  ACCESS EXCLUSIVE on `audit_events` for sub-millisecond. Safe under
  load.
- `CREATE OR REPLACE FUNCTION` does not take a heavy lock. New
  trigger fires use the new function definition; in-flight calls
  finish under the old definition (per Postgres planner cache rules).
- The cutover marker INSERT does NOT take the advisory lock — a
  DDL migration is a single-writer context by construction. Future
  trigger + service writes take `hashtext('audit:global')`; the
  marker doesn't contend with anything.
