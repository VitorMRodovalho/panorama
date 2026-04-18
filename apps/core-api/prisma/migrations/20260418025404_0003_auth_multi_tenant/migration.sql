-- AlterTable
ALTER TABLE "auth_identities" ADD COLUMN     "secretHash" TEXT;

-- AlterTable
ALTER TABLE "tenant_memberships" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "invitedAt" TIMESTAMP(3),
ADD COLUMN     "invitedByUserId" UUID,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "allowedEmailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "tenant_memberships_tenantId_status_idx" ON "tenant_memberships"("tenantId", "status");
