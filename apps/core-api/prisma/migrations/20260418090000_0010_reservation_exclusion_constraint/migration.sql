-- Migration 0010 — Reservation no-overlap exclusion constraint (ADR-0009
-- §Alternatives "Exclusion constraint via btree_gist", deferred at 0.2,
-- shipped at 0.3 as promised).
--
-- Moves the "no double-booking" invariant from service-level (assertNoOverlap
-- + Serializable + P2034 retry) to a DB-level guarantee. The service checks
-- stay in place as defense in depth + a fast-path that surfaces nice error
-- messages BEFORE the INSERT attempt; the exclusion constraint is the
-- belt-and-suspenders backstop that would fire if a future code path ever
-- bypassed the service layer (raw psql, a misbehaving plugin, a regression).
--
-- Shape:
--   * `btree_gist` extension — needed because GIST alone can't handle
--     equality (`WITH =`) on UUID; btree_gist bridges that.
--   * A GENERATED ALWAYS column `booking_range tsrange` mirrors the half-
--     open `[startAt, endAt)` interval. tsrange (timestamp without time
--     zone) matches our `timestamp(3)` columns directly — no implicit
--     conversion. STORED so the exclusion index has a stable column to
--     reference.
--   * The EXCLUDE constraint checks (tenantId =, assetId =, booking_range &&)
--     filtered by `approvalStatus IN (in-play) AND lifecycleStatus IN
--     (in-play) AND assetId IS NOT NULL` — the SAME predicate the service's
--     `assertNoOverlap` uses. Rows that transition to REJECTED / CANCELLED /
--     RETURNED fall out of the index automatically.
--
-- Rollback: DROP CONSTRAINT + DROP COLUMN. No data loss — the column is
-- generated, not written by any code. The extension stays; dropping it
-- would affect other installations that might already use it.
--
-- No RLS change. The existing reservations policy (migration 0001) covers
-- every write through the policy's tenantId filter; adding an exclusion
-- constraint doesn't widen the surface.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Generated column for the exclusion index. `[)` = half-open so
-- back-to-back reservations `[12:00,14:00) [14:00,16:00)` don't collide.
ALTER TABLE "reservations"
    ADD COLUMN "bookingRange" tsrange
    GENERATED ALWAYS AS (tsrange("startAt", "endAt", '[)')) STORED;

-- EXCLUSION constraint: reject writes where (tenantId, assetId, booking_range)
-- overlaps an existing in-play row for the same asset. Partial index via
-- WHERE keeps the constraint cheap — terminal-state rows don't participate.
ALTER TABLE "reservations"
    ADD CONSTRAINT "reservations_no_overlap"
    EXCLUDE USING gist (
        "tenantId" WITH =,
        "assetId"  WITH =,
        "bookingRange" WITH &&
    )
    WHERE (
        "assetId" IS NOT NULL
        AND "approvalStatus" IN ('PENDING_APPROVAL', 'AUTO_APPROVED', 'APPROVED')
        AND "lifecycleStatus" IN ('BOOKED', 'CHECKED_OUT')
    );

COMMENT ON CONSTRAINT "reservations_no_overlap" ON "reservations" IS
    'ADR-0009 §Alternatives: btree_gist-backed no-overlap guarantee. '
    'DB-level backstop over the service-level assertNoOverlap.';
