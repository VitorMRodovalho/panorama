import type { PrismaClient } from '@prisma/client';

/**
 * Shared test helper: create a tenant with its required system user
 * (ADR-0016 §1) in one go. Tests that previously called
 * `prisma.tenant.create({ data: { slug, name, displayName } })`
 * directly now go through this helper because Tenant.systemActorUserId
 * is NOT NULL (the system user is the audit-attribution actor for
 * auto-suggested maintenance tickets).
 *
 * The system user mirrors the production migration 0014 backfill
 * shape: email under the RFC-2606 reserved `.invalid` TLD, no
 * AuthIdentity row (so it can never log in), tenant_membership row
 * with role='system'.
 */
export interface CreateTenantInput {
  slug: string;
  name: string;
  displayName: string;
  locale?: string;
  timezone?: string;
  allowedEmailDomains?: string[];
}

export async function createTenantForTest(
  admin: PrismaClient,
  input: CreateTenantInput,
): Promise<{ id: string; slug: string; name: string; displayName: string }> {
  return admin.$transaction(async (tx) => {
    const systemUser = await tx.user.create({
      data: {
        email: `system+${input.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@panorama.invalid`,
        displayName: `${input.slug} System`,
        status: 'ACTIVE',
      },
    });
    const tenant = await tx.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        displayName: input.displayName,
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.allowedEmailDomains ? { allowedEmailDomains: input.allowedEmailDomains } : {}),
        systemActorUserId: systemUser.id,
      },
    });
    await tx.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId: systemUser.id,
        role: 'system',
        status: 'active',
      },
    });
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      displayName: tenant.displayName,
    };
  });
}
