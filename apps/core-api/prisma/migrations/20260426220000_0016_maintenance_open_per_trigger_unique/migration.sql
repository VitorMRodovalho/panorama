-- Migration 0016 — Per-trigger UNIQUE partial indexes on
-- `asset_maintenances` (closes the auto-suggest retry race).
--
-- Filed during the auto-suggest landing review (#74 PILOT-03 +
-- #40 ARCH-15 PR), tech-lead + security-reviewer convergent BLOCKER
-- on the "concurrent dispatcher" race.
--
-- The reviewers' first proposal was a UNIQUE partial on
-- `(tenantId, assetId) WHERE status IN ('OPEN','IN_PROGRESS')` — a
-- single-ticket-per-asset invariant. That conflicts with ADR-0016
-- §3 "count-aware update" semantics + the manual `openTicket`
-- path's multi-ticket capability + persona-fleet-ops's explicit
-- ask for distinct tickets per distinct signal (a manual "rotate
-- tires" plus an auto-suggested "cracked windshield" should both
-- exist, not collapse).
--
-- The actual idempotency hole lives at the EVENT layer, not the
-- ASSET layer: a single notification event being processed twice
-- (multi-pod retry / dispatcher rescue) must produce one ticket,
-- not two. The event's identity is its trigger ID — either
-- `triggeringInspectionId` (FAIL inspection completion) or
-- `triggeringReservationId` (damage check-in). Per-trigger UNIQUE
-- partial indexes close the retry race exactly where it lives,
-- without forbidding multi-ticket semantics.
--
-- ADR-0016 v3 §5 documents this design and supersedes v2's
-- `DomainEventSubscriber` primitive proposal. The subscriber
-- continues to do an application-level "any OPEN ticket on asset?"
-- check first (friendly skip path, persona-acknowledged SHIPPABLE
-- friction); the per-trigger UNIQUE catches retries that the check
-- can't see.

-- ---------------------------------------------------------------
-- 1. UNIQUE partial: at most one OPEN/IN_PROGRESS ticket per
--    triggering inspection.
--
--    Closes: same `panorama.inspection.completed` event re-fired
--    by dispatcher rescue / multi-pod claim race produces the
--    same ticket twice.
-- ---------------------------------------------------------------

CREATE UNIQUE INDEX "asset_maintenances_open_per_inspection_unique"
    ON "asset_maintenances" ("tenantId", "triggeringInspectionId")
    WHERE "triggeringInspectionId" IS NOT NULL
      AND status IN ('OPEN', 'IN_PROGRESS');

COMMENT ON INDEX "asset_maintenances_open_per_inspection_unique" IS
    'ADR-0016 v3 §5 — at most one OPEN/IN_PROGRESS ticket per '
    'triggering inspection. Catches the multi-pod auto-suggest '
    'retry race; preserves multi-ticket-per-asset semantics.';

-- ---------------------------------------------------------------
-- 2. UNIQUE partial: at most one OPEN/IN_PROGRESS ticket per
--    triggering reservation.
--
--    Closes: same `panorama.reservation.checked_in_with_damage`
--    event re-fired produces the same ticket twice.
-- ---------------------------------------------------------------

CREATE UNIQUE INDEX "asset_maintenances_open_per_reservation_unique"
    ON "asset_maintenances" ("tenantId", "triggeringReservationId")
    WHERE "triggeringReservationId" IS NOT NULL
      AND status IN ('OPEN', 'IN_PROGRESS');

COMMENT ON INDEX "asset_maintenances_open_per_reservation_unique" IS
    'ADR-0016 v3 §5 — at most one OPEN/IN_PROGRESS ticket per '
    'triggering reservation. Catches the damage-check-in retry '
    'race; preserves multi-ticket-per-asset semantics.';

-- The existing `asset_maintenances_open_per_asset_partial`
-- (tenantId, assetId, startedAt) WHERE OPEN/IN_PROGRESS index from
-- migration 0014 is kept AS-IS (non-unique) — it serves the
-- close-ticket "last open ticket on this asset" + hourly stale
-- sweep queries, which need to count rather than dedup.
