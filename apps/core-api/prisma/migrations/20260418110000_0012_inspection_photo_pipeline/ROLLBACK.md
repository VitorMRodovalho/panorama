# Rollback: 0012 inspection checklists + photo evidence

Destructive — every inspection, every response, every photo row is
dropped. The S3 objects under `tenants/*/inspections/*` are
intentionally RETAINED at rollback (audit evidence trumps storage
cost); operator does `mc rm --recursive` if / when that evidence is
no longer needed. The feature is additive at 0.3 (no pre-existing
domain service depends on it; retention sweep + FAIL email
subscriber + reservation tether are all net-new at 0.3 and unwind
cleanly with the module flag off).

## Pre-rollback

1. Flip `FEATURE_INSPECTIONS=false` in the environment, redeploy
   core-api. The module + retention-sweep cron + FAIL email
   subscriber all drop. Reservation checkout stops reading the
   inspections table; existing `requireInspectionBeforeCheckout`
   tenants become effectively open again (bulletin-board note: this
   is the break-glass; prefer flipping the per-tenant boolean off
   cleanly in product settings instead of a full module drop).
2. Super-admin data-export sweep of evidence still living:

   ```bash
   pg_dump -U panorama panorama \
     --table=inspection_templates \
     --table=inspection_template_items \
     --table=inspections \
     --table=inspection_responses \
     --table=inspection_photos \
     > inspection-evidence-$(date +%Y%m%d).sql
   ```

3. (Optional) S3 object snapshot — rollback does NOT touch S3:

   ```bash
   mc cp --recursive panorama/tenants s3-cold-archive/inspection-evidence-$(date +%Y%m%d)/
   ```

4. `audit_events` rows matching `action LIKE 'panorama.inspection.%'`
   survive rollback independently; they do NOT need to be re-dumped.

## SQL (single transaction)

```sql
BEGIN;

-- Triggers + functions first (before the tables they reference).
DROP TRIGGER IF EXISTS enforce_inspection_snapshot_immutable_trigger
    ON inspections;
DROP TRIGGER IF EXISTS validate_inspection_response_snapshot_ref_trigger
    ON inspection_responses;
DROP FUNCTION IF EXISTS enforce_inspection_snapshot_immutable();
DROP FUNCTION IF EXISTS validate_inspection_response_snapshot_ref();

-- RLS policies (FORCE RLS tables need explicit policy drops before
-- the table goes).
DROP POLICY IF EXISTS inspection_photos_tenant_isolation        ON inspection_photos;
DROP POLICY IF EXISTS inspection_responses_tenant_isolation     ON inspection_responses;
DROP POLICY IF EXISTS inspections_tenant_isolation              ON inspections;
DROP POLICY IF EXISTS inspection_template_items_tenant_isolation ON inspection_template_items;
DROP POLICY IF EXISTS inspection_templates_tenant_isolation      ON inspection_templates;

-- Tables in reverse-FK order. CHECK constraints + indexes drop
-- automatically with the table.
DROP TABLE IF EXISTS inspection_photos;
DROP TABLE IF EXISTS inspection_responses;
DROP TABLE IF EXISTS inspections;
DROP TABLE IF EXISTS inspection_template_items;
DROP TABLE IF EXISTS inspection_templates;

-- Enums (safe now the tables referring to them are gone).
DROP TYPE IF EXISTS inspection_photo_status;
DROP TYPE IF EXISTS inspection_outcome;
DROP TYPE IF EXISTS inspection_status;
DROP TYPE IF EXISTS inspection_item_type;

-- Tenant columns added by this migration (nullable / defaulted, no
-- rows lose important data).
ALTER TABLE tenants DROP COLUMN IF EXISTS "requireInspectionBeforeCheckout";
ALTER TABLE tenants DROP COLUMN IF EXISTS "inspectionPhotoRetentionDays";
ALTER TABLE tenants DROP COLUMN IF EXISTS "inspectionConfig";
-- Tenant CHECK constraints drop with their columns automatically.

DELETE FROM _prisma_migrations
 WHERE migration_name = '20260418110000_0012_inspection_photo_pipeline';

COMMIT;
```

## Prisma client regeneration

Update `apps/core-api/prisma/schema.prisma`:

- Remove the five models: `InspectionTemplate`, `InspectionTemplateItem`,
  `Inspection`, `InspectionResponse`, `InspectionPhoto`.
- Remove the four enums: `InspectionItemType`, `InspectionStatus`,
  `InspectionOutcome`, `InspectionPhotoStatus`.
- Remove back-relations on FOUR existing models — grep `inspection`
  on the schema to find them:
  - `Tenant`: `inspectionTemplates`, `inspectionTemplateItems`,
    `inspections`, `inspectionResponses`, `inspectionPhotos`
  - `User`: `inspectionTemplatesCreated`, `inspectionsStarted`,
    `inspectionsCompleted`, `inspectionsReviewed`,
    `inspectionPhotosUploaded`
  - `Category`: `inspectionTemplates`
  - `Asset`: `inspections`
  - `Reservation`: `inspections`
- Remove three `Tenant` columns: `inspectionConfig`,
  `inspectionPhotoRetentionDays`, `requireInspectionBeforeCheckout`.

Run `pnpm -F @panorama/core-api prisma:generate` after the edits.

## Post-rollback smoke

- `POST /reservations/:id/checkout` still succeeds for an existing
  tenant (no inspection-required branch hit).
- `GET /assets/:id` still renders (no inspection-count block).
- `audit_events` query for `action = 'panorama.reservation.checkout'`
  returns recent rows; `panorama.inspection.*` rows are preserved
  historically for compliance.

## Common pitfalls

- **S3 bucket still has objects.** Intentional. Decide separately
  whether to `mc rm --recursive panorama/tenants/*/inspections/`;
  the rollback SQL does NOT.
- **Redactor entries linger.** `PRISMA_REDACT_FIELDS` additions
  (`accessKeyId`, `secretAccessKey`, etc.) were forward-compatible
  additions — leftover entries just redact nothing. No code rollback
  required.
- **`AppLogger` wrapper.** If `ObjectStorageService` was removed in
  the same rollback, the wrapper is orphaned. Either keep it (cheap)
  or drop the file in the same PR.
- **Audit rows.** `panorama.inspection.*` rows in `audit_events`
  survive rollback. Queries referencing them need to either tolerate
  nulls or filter the action prefix.
