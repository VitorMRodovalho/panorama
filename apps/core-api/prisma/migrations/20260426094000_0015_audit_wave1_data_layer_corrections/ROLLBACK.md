# Rollback — 0015_audit_wave1_data_layer_corrections

Bundles five Wave 1 corrections + one related fix surfaced during
the data-layer review (PAT trigger SECURITY DEFINER). Each is
independently reversible. Section numbers below align with the
section numbers in `migration.sql`.

## Reversibility

Reversible without data loss. The migration is forward-only on the
hash-chain side (#41) — pre-fix audit rows with `prevHash = NULL`
remain readable. The cutover marker row (`panorama.audit.chain_repair`)
written at the end of the migration is the deterministic boundary
between "may have NULL prevHash legitimately or pre-fix" and "must
have non-NULL prevHash unless first chain row".

## Revert SQL (in reverse migration order)

```sql
-- 5. Cutover marker — delete the chain_repair row.
DELETE FROM audit_events WHERE action = 'panorama.audit.chain_repair'
  AND metadata->>'migration' = '20260426094000_0015_audit_wave1_data_layer_corrections';

-- 4. PERF-06 / #65 — drop the index.
DROP INDEX IF EXISTS "reservations_tenantId_onBehalfUserId_idx";

-- 3. DATA-05 / #43 — restore the NULL-distinct dedup index.
DROP INDEX IF EXISTS "notification_events_dedup_unique";
CREATE UNIQUE INDEX "notification_events_dedup_unique"
    ON "notification_events" ("tenantId", "eventType", "dedupKey")
    WHERE "dedupKey" IS NOT NULL;

-- 2. DATA-03 / #41 — restore the broken trigger functions.
--    Two functions were replaced. The original bodies live in:
--      apps/core-api/prisma/migrations/20260418100000_0011_notification_events/migration.sql
--        §emit_notification_tamper_audit  (broken — prevHash = NULL)
--      apps/core-api/prisma/migrations/20260418080000_0009_personal_access_tokens/migration.sql
--        §emit_pat_resurrected_audit  (chain-correct, but invoker-rights — per-tenant strand)
--    Reverting is unusual; you'd only do it if SECURITY DEFINER
--    caused a regression in a role-restricted production path.
--    Drop the functions and re-create from the source migrations:
-- WARNING: CASCADE silently drops `emit_notification_tamper_audit_trigger`
-- on notification_events AND `emit_pat_resurrected_audit_trigger` on
-- personal_access_tokens. The reverter MUST re-issue both triggers
-- after re-CREATE'ing the functions, or the audit chain stops being
-- written entirely. See migrations 0011 §CREATE TRIGGER and 0009
-- §CREATE TRIGGER for the originals.
DROP FUNCTION IF EXISTS emit_notification_tamper_audit() CASCADE;
DROP FUNCTION IF EXISTS emit_pat_resurrected_audit() CASCADE;
-- Then re-apply the original CREATE TRIGGER + CREATE FUNCTION blocks
-- from the source migrations (don't paste here — copy from source
-- to avoid drift).

-- 1. DATA-04 / #42 — drop the FK.
ALTER TABLE "tenants"
    DROP CONSTRAINT IF EXISTS "tenants_systemActorUserId_fkey";

-- 0. DATA-02 / SEC-06 / #30 — restore the raw GUC casts (rls.sql).
--    See 0014 rls.sql for the original policy bodies.
BEGIN;
DROP POLICY IF EXISTS asset_maintenances_tenant_isolation ON "asset_maintenances";
CREATE POLICY asset_maintenances_tenant_isolation ON "asset_maintenances"
    FOR ALL TO panorama_app
    USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);
DROP POLICY IF EXISTS maintenance_photos_tenant_isolation ON "maintenance_photos";
CREATE POLICY maintenance_photos_tenant_isolation ON "maintenance_photos"
    FOR ALL TO panorama_app
    USING ("tenantId" = current_setting('panorama.current_tenant', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('panorama.current_tenant', true)::uuid);
COMMIT;
```

## When you would actually revert

- The chain-reading version of `emit_notification_tamper_audit` causes
  a deadlock on hot notification-status churn. The
  `SELECT ... ORDER BY id DESC LIMIT 1` reads `audit_events` under the
  trigger's transaction; under sustained dispatcher write load
  this could become contention. Mitigation: revert and patch the
  function to read with `FOR SHARE OF audit_events` or to skip
  prev_hash when contention is detected.
- The FK on `tenants.systemActorUserId` blocks a legitimate
  hard-delete in a cleanup flow. Mitigation: remove the FK or change
  to `ON DELETE SET NULL` — but the column is NOT NULL so SET NULL
  would itself break.
- `NULLS NOT DISTINCT` triggers a planner regression on cluster-wide
  enqueues at 1000+ rows. Mitigation: revert and switch to a
  COALESCE-with-sentinel UUID approach.
- SECURITY DEFINER on the audit triggers is mis-using the function
  owner's privileges (e.g., the function gets edited by an
  unprivileged author and slips a payload manipulation). Mitigation:
  ALTER FUNCTION ... SECURITY INVOKER and re-grant SELECT on
  audit_events to whichever role updates the affected tables.

## Production migration timing

- `ALTER TABLE ADD CONSTRAINT FK` (#42) takes ACCESS EXCLUSIVE on
  `tenants` briefly. Tenants is a small table (single-digit rows
  pre-pilot, low hundreds at scale); fine.
- `CREATE INDEX` (#65) takes SHARE on `reservations` for the build
  duration. Pre-pilot fine. **Production-scale (~100k+ rows)**:
  switch to `CREATE INDEX CONCURRENTLY` in its own migration file
  (CONCURRENTLY cannot run inside a transaction).
- `DROP POLICY ... CREATE POLICY` (#30, in rls.sql) has a brief
  no-policy window. FORCE RLS makes that window deny-all on
  `panorama_app` (fail-safe). Wrapped in `BEGIN/COMMIT` to bound
  the window to the transaction's lifetime.

## Schema implications

`schema.prisma` was updated to mirror the new constraints:
- `Tenant.systemActor` `@relation("TenantSystemActor")` (FK relation)
- `User.tenantsAsSystemActor` `Tenant[]` (inverse)
- `Reservation @@index([tenantId, onBehalfUserId])`

A revert of THIS migration must also revert those three lines from
`schema.prisma` — otherwise `prisma migrate status` will diff against
the rolled-back DB.
