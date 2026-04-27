-- Migration 0018 — Reservation overdue flag (closes #77 PILOT-04).
--
-- Adds `Reservation.isOverdue Boolean @default(false)`. Mirrors the
-- ADR-0016 §4 `isStranded` pattern (boolean discriminator on top of
-- `lifecycleStatus`, NOT a new enum value) so:
--   1. The exclusion-constraint predicate
--      (`lifecycleStatus IN ('BOOKED', 'CHECKED_OUT')`) stays
--      untouched — overdue reservations remain exclusion-active
--      because the asset is still operationally checked out.
--   2. No `ALTER TYPE … ADD VALUE` migration-split needed.
--   3. The flag is a "needs admin attention" signal, not a state
--      change. Once a driver checks in, lifecycleStatus → RETURNED;
--      isOverdue stays true as historical record (the dashboard
--      filters on `isOverdue AND lifecycleStatus = CHECKED_OUT`
--      to show currently-overdue items).
--
-- ADR-0009 Part B `lifecycleStatus = MISSED` already exists for the
-- no-show case (BOOKED past pickupWindow without checkout) — that
-- transition lives in `ReservationSweepService.runNoShowSweep` and
-- needs no schema change. This migration just adds the orthogonal
-- overdue-return flag for the CHECKED_OUT-past-endAt case.

ALTER TABLE "reservations"
    ADD COLUMN "isOverdue" BOOLEAN NOT NULL DEFAULT false;

-- Hot-path index for the sweep query and the dashboard filter:
--   `WHERE tenantId = $1 AND isOverdue = true AND lifecycleStatus = 'CHECKED_OUT'`
-- Partial index keeps storage minimal (typical fleet has <1% of
-- reservations in overdue state at any time).
CREATE INDEX "reservations_overdue_partial"
    ON "reservations" ("tenantId", "lifecycleStatus")
    WHERE "isOverdue" = true;

COMMENT ON COLUMN "reservations"."isOverdue" IS
    '#77 PILOT-04 — true when ReservationSweepService detected '
    'lifecycleStatus=CHECKED_OUT past endAt. Discriminator flag, '
    'not a state change (lifecycleStatus stays CHECKED_OUT until '
    'driver returns). Cleared only by manual admin action; '
    'historical signal post-RETURNED.';

COMMENT ON INDEX "reservations_overdue_partial" IS
    '#77 PILOT-04 — supports hourly overdue sweep + dashboard '
    '"show only overdue" filter. Partial WHERE isOverdue=true '
    'keeps storage minimal.';
