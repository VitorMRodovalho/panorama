-- Migration 0012 — Inspection checklists + photo evidence (ADR-0012).
--
-- Five tables, four enums, three Tenant columns, seven CHECK
-- constraints, two triggers, five indexes (two of them partial
-- composites hand-written because Prisma can't model partials).
-- RLS policies live in the companion rls.sql file run after this.
-- Rollback is in ROLLBACK.md; destructive — drops tables + S3
-- objects optional but retained by default.
--
-- Review log + rationale: see docs/adr/0012-inspection-photo-pipeline.md.

-- CreateEnum
CREATE TYPE "inspection_item_type"     AS ENUM ('BOOLEAN', 'TEXT', 'NUMBER', 'PHOTO');
CREATE TYPE "inspection_status"        AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "inspection_outcome"       AS ENUM ('PASS', 'FAIL', 'NEEDS_MAINTENANCE');
CREATE TYPE "inspection_photo_status"  AS ENUM ('UPLOADED', 'REJECTED');

-- AlterTable: Tenant gets three new columns. All nullable / defaulted
-- so existing rows are unaffected (no UPDATE sweep required).
ALTER TABLE "tenants"
    ADD COLUMN "inspectionConfig"                JSONB,
    ADD COLUMN "inspectionPhotoRetentionDays"    INTEGER,
    ADD COLUMN "requireInspectionBeforeCheckout" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: inspection_templates
CREATE TABLE "inspection_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "categoryKind" "category_kind",
    "categoryId" UUID,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspection_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: inspection_template_items
CREATE TABLE "inspection_template_items" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "itemType" "inspection_item_type" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "photoRequired" BOOLEAN NOT NULL DEFAULT false,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "helpText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspection_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: inspections
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID,
    "templateSnapshot" JSONB NOT NULL,
    "assetId" UUID NOT NULL,
    "reservationId" UUID,
    "startedByUserId" UUID NOT NULL,
    "status" "inspection_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "outcome" "inspection_outcome",
    "summaryNote" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable: inspection_responses
CREATE TABLE "inspection_responses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "snapshotItemId" UUID NOT NULL,
    "booleanValue" BOOLEAN,
    "textValue" TEXT,
    "numberValue" DOUBLE PRECISION,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspection_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable: inspection_photos
CREATE TABLE "inspection_photos" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "responseId" UUID,
    "clientUploadKey" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "exifStripped" JSONB NOT NULL DEFAULT '[]',
    "status" "inspection_photo_status" NOT NULL DEFAULT 'UPLOADED',
    "uploadedByUserId" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "inspection_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraints
CREATE UNIQUE INDEX "inspection_template_items_templateId_position_key"
    ON "inspection_template_items"("templateId", "position");

CREATE UNIQUE INDEX "inspection_responses_inspectionId_snapshotItemId_key"
    ON "inspection_responses"("inspectionId", "snapshotItemId");

CREATE UNIQUE INDEX "inspection_photos_inspectionId_clientUploadKey_key"
    ON "inspection_photos"("inspectionId", "clientUploadKey");

-- ---------------------------------------------------------------------
-- Partial composite indexes (data-architect review — the v1 3-full-
-- index scheme wasted leaf storage on NULL archivedAt values and didn't
-- cover displayOrder). Hand-written because Prisma 5.x can't model
-- partial indexes. Mirror the partial-unique pattern from migration 0004.
-- ---------------------------------------------------------------------

-- Launcher (by kind). Matches the CHECK scope-exclusivity exactly.
CREATE INDEX "inspection_templates_launcher_kind_idx"
    ON "inspection_templates" ("tenantId", "categoryKind", "displayOrder")
    WHERE "archivedAt" IS NULL AND "categoryKind" IS NOT NULL;

-- Launcher (by category override).
CREATE INDEX "inspection_templates_launcher_category_idx"
    ON "inspection_templates" ("tenantId", "categoryId", "displayOrder")
    WHERE "archivedAt" IS NULL AND "categoryId" IS NOT NULL;

-- Asset-detail "last N inspections for this asset" (hot query).
CREATE INDEX "inspections_asset_recent_idx"
    ON "inspections" ("tenantId", "assetId", "startedAt" DESC);

-- "My open inspections" on the driver home page.
CREATE INDEX "inspections_mine_open_idx"
    ON "inspections" ("tenantId", "startedByUserId")
    WHERE "status" = 'IN_PROGRESS';

-- Admin needs-review queue (FAIL / NEEDS_MAINTENANCE + unreviewed).
CREATE INDEX "inspections_needs_review_idx"
    ON "inspections" ("tenantId", "startedAt" DESC)
    WHERE "status" = 'COMPLETED' AND "reviewedAt" IS NULL;

-- Reservation-tether lookup (tether check at checkout).
CREATE INDEX "inspections_reservation_idx"
    ON "inspections" ("tenantId", "reservationId")
    WHERE "reservationId" IS NOT NULL;

-- Per-inspection photo gallery (20-row cap makes this trivial).
CREATE INDEX "inspection_photos_gallery_idx"
    ON "inspection_photos" ("tenantId", "inspectionId")
    WHERE "deletedAt" IS NULL;

-- Per-response photo lookup (partial because many photos are not
-- response-linked).
CREATE INDEX "inspection_photos_response_idx"
    ON "inspection_photos" ("tenantId", "responseId")
    WHERE "responseId" IS NOT NULL AND "deletedAt" IS NULL;

-- Retention-sweep scan (soft-deleted-to-hard-delete job).
CREATE INDEX "inspection_photos_retention_idx"
    ON "inspection_photos" ("deletedAt")
    WHERE "deletedAt" IS NOT NULL;

-- ---------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------

-- inspection_templates
ALTER TABLE "inspection_templates"
    ADD CONSTRAINT "inspection_templates_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspection_templates"
    ADD CONSTRAINT "inspection_templates_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inspection_templates"
    ADD CONSTRAINT "inspection_templates_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- inspection_template_items
ALTER TABLE "inspection_template_items"
    ADD CONSTRAINT "inspection_template_items_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspection_template_items"
    ADD CONSTRAINT "inspection_template_items_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "inspection_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- inspections
ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "inspection_templates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "reservations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_startedByUserId_fkey"
    FOREIGN KEY ("startedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_completedByUserId_fkey"
    FOREIGN KEY ("completedByUserId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- inspection_responses
ALTER TABLE "inspection_responses"
    ADD CONSTRAINT "inspection_responses_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspection_responses"
    ADD CONSTRAINT "inspection_responses_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- inspection_photos
ALTER TABLE "inspection_photos"
    ADD CONSTRAINT "inspection_photos_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspection_photos"
    ADD CONSTRAINT "inspection_photos_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inspection_photos"
    ADD CONSTRAINT "inspection_photos_responseId_fkey"
    FOREIGN KEY ("responseId") REFERENCES "inspection_responses"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inspection_photos"
    ADD CONSTRAINT "inspection_photos_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- CHECK constraints — correctness invariants the application layer
-- must also enforce but the DB refuses to ever violate.
-- ---------------------------------------------------------------------

-- Template scope XOR: exactly one of (categoryKind, categoryId).
ALTER TABLE "inspection_templates"
    ADD CONSTRAINT "inspection_templates_scope_exclusive"
    CHECK (
        ("categoryKind" IS NOT NULL AND "categoryId" IS NULL)
        OR
        ("categoryKind" IS NULL AND "categoryId" IS NOT NULL)
    );

-- Photo storage key: UUID-strict + tenant-prefix. The tenant prefix
-- LIKE check is redundant-but-cheap under the regex; kept as a
-- human-readable assertion that a key is never decoupled from its
-- row's tenantId.
ALTER TABLE "inspection_photos"
    ADD CONSTRAINT "inspection_photos_key_uuid_strict"
    CHECK (
        "storageKey" ~ '^tenants/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/inspections/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
        AND "storageKey" LIKE 'tenants/' || "tenantId"::text || '/%'
    );

-- Response: at most one answer column populated (single-type items).
ALTER TABLE "inspection_responses"
    ADD CONSTRAINT "inspection_responses_single_answer"
    CHECK (
        (
            ("booleanValue" IS NOT NULL)::int +
            ("textValue"    IS NOT NULL)::int +
            ("numberValue"  IS NOT NULL)::int
        ) <= 1
    );

-- Inspection completion coherence: status=COMPLETED ⇔ completedAt +
-- completedByUserId set; status<>COMPLETED ⇔ both null.
ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_completed_coherent"
    CHECK (
        (status = 'COMPLETED' AND "completedAt" IS NOT NULL AND "completedByUserId" IS NOT NULL)
        OR
        (status <> 'COMPLETED' AND "completedAt" IS NULL AND "completedByUserId" IS NULL)
    );

-- Outcome coherent with status: outcome is non-null IFF COMPLETED.
ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_outcome_coherent"
    CHECK (
        (outcome IS NULL AND status <> 'COMPLETED')
        OR
        (outcome IS NOT NULL AND status = 'COMPLETED')
    );

-- Snapshot size cap: 64 kB (40 items × ~1600 B allowing longer helpText).
ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_snapshot_size_cap"
    CHECK (pg_column_size("templateSnapshot") <= 65536);

-- Snapshot well-formed: object containing a non-empty items[] array.
ALTER TABLE "inspections"
    ADD CONSTRAINT "inspections_snapshot_well_formed"
    CHECK (
        jsonb_typeof("templateSnapshot" -> 'items') = 'array'
        AND jsonb_array_length("templateSnapshot" -> 'items') > 0
    );

-- Tenant inspectionConfig size cap (prevents runaway JSON).
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_inspection_config_size_cap"
    CHECK (
        "inspectionConfig" IS NULL
        OR pg_column_size("inspectionConfig") <= 2048
    );

-- Retention floor: 30 d minimum. Below that and legit insurance
-- disputes can't be answered.
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_inspection_retention_floor"
    CHECK (
        "inspectionPhotoRetentionDays" IS NULL
        OR "inspectionPhotoRetentionDays" >= 30
    );

-- ---------------------------------------------------------------------
-- Trigger: snapshot immutability (BEFORE UPDATE OF templateSnapshot).
-- Breakglass via panorama.allow_snapshot_edit = 'true' GUC.
-- Same GUC namespace as 0005/enforce_at_least_one_owner.
-- Raises ERRCODE 22023 (invalid_parameter_value) — distinct from
-- Postgres' 23xxx integrity codes so the service layer can tell
-- them apart and surface a meaningful error.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_inspection_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
    IF OLD."templateSnapshot" IS DISTINCT FROM NEW."templateSnapshot" THEN
        IF current_setting('panorama.allow_snapshot_edit', true) = 'true' THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'inspection_snapshot_immutable'
            USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_inspection_snapshot_immutable_trigger
    ON "inspections";
CREATE TRIGGER enforce_inspection_snapshot_immutable_trigger
    BEFORE UPDATE OF "templateSnapshot" ON "inspections"
    FOR EACH ROW EXECUTE FUNCTION enforce_inspection_snapshot_immutable();

-- ---------------------------------------------------------------------
-- Trigger: response.snapshotItemId references an item inside the
-- parent inspection's templateSnapshot. SECURITY DEFINER so the
-- lookup bypasses RLS on inspections (the inner SELECT would
-- otherwise return zero rows under a runAsSuperAdmin transaction
-- that hasn't also elevated role, causing a false 23503). Function
-- owner is the migration runner (super-admin).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_inspection_response_snapshot_ref()
RETURNS trigger
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    found boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM inspections,
               jsonb_array_elements(inspections."templateSnapshot" -> 'items') AS item
         WHERE inspections.id = NEW."inspectionId"
           AND (item ->> 'id')::uuid = NEW."snapshotItemId"
    ) INTO found;
    IF NOT found THEN
        RAISE EXCEPTION 'inspection_response_snapshot_ref_invalid'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_inspection_response_snapshot_ref_trigger
    ON "inspection_responses";
CREATE TRIGGER validate_inspection_response_snapshot_ref_trigger
    BEFORE INSERT OR UPDATE OF "snapshotItemId" ON "inspection_responses"
    FOR EACH ROW EXECUTE FUNCTION validate_inspection_response_snapshot_ref();
