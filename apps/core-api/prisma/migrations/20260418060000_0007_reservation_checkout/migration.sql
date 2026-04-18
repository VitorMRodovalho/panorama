-- Migration 0007 — Reservation check-out / check-in capture
-- (ADR-0009 §Out of scope for Part A; Part B).
--
-- Adds the capture columns the operator fills at release + return:
--   * checkedOut{At, ByUserId}, mileageOut, conditionOut
--   * checkedIn{At, ByUserId}, mileageIn, conditionIn
--   * damageFlag + damageNote — on check-in, `true` routes the asset
--     to MAINTENANCE rather than READY so ops can inspect.
--
-- No constraints on the capture columns themselves — the service
-- layer enforces "checked_out_at < checked_in_at", mileage monotonicity,
-- and the asset-status transitions. Columns are nullable so existing
-- rows (from 0.2 Part A) remain valid.

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "checkedInByUserId" UUID,
ADD COLUMN     "checkedOutAt" TIMESTAMP(3),
ADD COLUMN     "checkedOutByUserId" UUID,
ADD COLUMN     "conditionIn" TEXT,
ADD COLUMN     "conditionOut" TEXT,
ADD COLUMN     "damageFlag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "damageNote" TEXT,
ADD COLUMN     "mileageIn" INTEGER,
ADD COLUMN     "mileageOut" INTEGER;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_checkedOutByUserId_fkey" FOREIGN KEY ("checkedOutByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_checkedInByUserId_fkey" FOREIGN KEY ("checkedInByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
