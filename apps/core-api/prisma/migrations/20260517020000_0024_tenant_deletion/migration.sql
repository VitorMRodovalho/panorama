-- Migration 0024 — Tenant deletion 7-day cool-off (ADR-0020 §7).
--
-- Three coordinated changes:
--
--   1. `tenants.deletionScheduledAt` + `tenants.deletionRequestedByUserId`:
--      the cool-off window state lives on the Tenant row so every
--      authenticated read (banner, dashboard, RLS-scoped query) can
--      see it without joining a separate "pending deletions" table.
--      `deletionScheduledAt IS NULL` = not scheduled; non-NULL = T+7d
--      from the confirm.
--
--   2. `tenants.systemActorUserId` becomes NULLABLE. Per ADR-0020 §7
--      amendment ("NULL Tenant.systemActorUserId first per ON DELETE
--      RESTRICT cascade ordering"), the purge cron MUST null this
--      reference before deleting the system user + then the tenant.
--      The previous NOT NULL constraint (migration 0014) would block
--      that sequence — every tenant tx after creation always sets the
--      column, and runtime code that reads it falls back to null-safe
--      lookups (PR 3 makes the schema match the runtime contract).
--      The FK target's ON DELETE behaviour stays RESTRICT because we
--      WANT writes-after-purge to fail loudly if a forgotten path
--      tries to write through a tenant in the middle of being purged.
--
--   3. `tenant_deletion_tokens` — one-time-use confirmation tokens
--      minted by `POST /tenants/:id/delete-request`. Same shape as
--      `email_verifications` (PR 2 migration 0023): tokenHash UNIQUE,
--      expiresAt (24h), consumedAt (nullable timestamp), createdAt.
--      panorama_app gets NO grants on this table; service operates
--      under runAsSuperAdmin.
--
-- Cascade-related notes:
--   - email_verifications.tenantId is ON DELETE CASCADE (migration
--     0023). When the purge cron DELETEs the tenant, the verification
--     rows it once owned cascade away. Acceptable: by the time the
--     cron runs, any unconsumed verification token for the deleted
--     tenant is moot.
--   - tenant_deletion_tokens.tenantId is also ON DELETE CASCADE so
--     a cancel-then-delete-later cleanup is automatic.
--   - All other tenant-scoped FKs to `tenants(id)` already CASCADE
--     per migrations 0001-0023. The purge cron itself doesn't need
--     to issue explicit per-table DELETEs.

-- ---------------------------------------------------------------------
-- 1. Cool-off state on tenants.
-- ---------------------------------------------------------------------
ALTER TABLE "tenants"
    ADD COLUMN "deletionScheduledAt"       TIMESTAMPTZ,
    ADD COLUMN "deletionRequestedByUserId" UUID;

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_deletionRequestedByUserId_fkey"
        FOREIGN KEY ("deletionRequestedByUserId")
        REFERENCES "users"("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;

CREATE INDEX "tenants_deletionScheduledAt_idx"
    ON "tenants"("deletionScheduledAt")
    WHERE "deletionScheduledAt" IS NOT NULL;

COMMENT ON COLUMN "tenants"."deletionScheduledAt" IS
'ADR-0020 §7 — T+7d the purge cron will execute the delete. NULL = '
'not scheduled. Set by POST /tenants/:id/delete-confirm; cleared by '
'POST /tenants/:id/delete-cancel and POST /tenants/:id/delete-veto.';

COMMENT ON COLUMN "tenants"."deletionRequestedByUserId" IS
'ADR-0020 §7 — the Tenant Owner that initiated POST /tenants/:id/'
'delete-request. ON DELETE SET NULL so a user account deletion '
'does not block the tenant cool-off bookkeeping.';

-- ---------------------------------------------------------------------
-- 2. systemActorUserId — drop NOT NULL.
-- ---------------------------------------------------------------------
ALTER TABLE "tenants"
    ALTER COLUMN "systemActorUserId" DROP NOT NULL;

COMMENT ON COLUMN "tenants"."systemActorUserId" IS
'ADR-0016 §1 system user for auto-suggested maintenance tickets. '
'Nullable as of ADR-0020 §7 amendment: the purge cron NULLs this '
'before deleting the system user + the tenant, so the ON DELETE '
'RESTRICT FK does not block the cascade. Live tenants always have '
'this column set; null only during the brief purge sequence.';

-- ---------------------------------------------------------------------
-- 3. Deletion confirmation tokens.
-- ---------------------------------------------------------------------
CREATE TABLE "tenant_deletion_tokens" (
    "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId"            UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    "requestedByUserId"   UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "tokenHash"           TEXT NOT NULL UNIQUE,
    "expiresAt"           TIMESTAMPTZ NOT NULL,
    "consumedAt"          TIMESTAMPTZ,
    "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "tenant_deletion_tokens_tenantId_idx"
    ON "tenant_deletion_tokens"("tenantId");

COMMENT ON TABLE "tenant_deletion_tokens" IS
'ADR-0020 §7 — one-time-use confirmation tokens minted by POST '
'/tenants/:id/delete-request. Consumed by POST /tenants/:id/'
'delete-confirm. panorama_app has NO grants on this table — all '
'access via prisma.runAsSuperAdmin (the request + confirm paths '
'route through the service layer which runs super-admin txs).';
