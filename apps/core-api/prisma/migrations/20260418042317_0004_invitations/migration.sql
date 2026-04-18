-- Migration 0004 — invitations (ADR-0008).
--
-- Creates the invitations table + a per-tenant TTL default on tenants.
-- Row-level security policy is in rls.sql (applied separately by the
-- migration runner / CI — see 0001/rls.sql for the pattern).
--
-- Hand-written additions below the Prisma-generated block:
--   * invitations_one_open_per_tenant_email — partial unique index that
--     enforces "at most one OPEN (non-accepted, non-revoked) invitation
--     per (tenantId, email)". Prisma cannot model partial indexes.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "invitationTtlSeconds" INTEGER NOT NULL DEFAULT 604800;

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "targetUserId" UUID,
    "invitedByUserId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "emailQueuedAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "emailBouncedAt" TIMESTAMP(3),
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_tenantId_email_idx" ON "invitations"("tenantId", "email");

-- CreateIndex
CREATE INDEX "invitations_expiresAt_idx" ON "invitations"("expiresAt");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: enforce "at most one open invitation per (tenantId, email)".
-- Prisma cannot model partial unique indexes (5.22). The predicate
-- matches the in-flight state the service filters on — see ADR-0008.
CREATE UNIQUE INDEX "invitations_one_open_per_tenant_email"
    ON "invitations" ("tenantId", "email")
    WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
