/**
 * Dev seed — creates two tenants ("Alpha" / "Bravo") and a handful of
 * assets under each, plus one user in each tenant. Used to prove
 * tenancy in the integration test and for local development.
 *
 * Never runs in production: the script exits immediately if the DATABASE_URL
 * looks prod-like, unless ALLOW_DESTRUCTIVE_SEED=true.
 */
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../src/modules/auth/password.service.js';

const prisma = new PrismaClient();
const passwords = new PasswordService();

/**
 * Documented dev-only password for the seeded tenant Owners. Long
 * enough to satisfy PasswordService's 12-char floor. The quickstart
 * runbook (`docs/en/quickstart.md`) is the only place a user should
 * ever read this from. NEVER set this as a production secret — the
 * `looksProd(DATABASE_URL)` guard above stops the seed from running
 * against anything that smells like prod.
 */
const DEV_OWNER_PASSWORD = 'panorama-dev-2026';

function looksProd(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('prod') ||
    lower.includes('production') ||
    (lower.includes('amazonaws.com') && !lower.includes('localhost')) ||
    (lower.includes('rds.') && !lower.includes('localhost'))
  );
}

async function main(): Promise<void> {
  if (looksProd(process.env.DATABASE_URL) && process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
    console.error('Refusing to run destructive seed against prod-looking DATABASE_URL.');
    process.exit(1);
  }

  // Purge previous seed rows (OK in dev only — the guard above
  // enforces it). Wrap in a single transaction with the
  // `panorama.bypass_owner_check` GUC set so the
  // `enforce_at_least_one_owner` trigger (migration 0005) doesn't
  // refuse the Owner-membership deletes. Same pattern as the test
  // helper `apps/core-api/test/_reset-db.ts`. Order is reverse-FK-
  // dependency so the deletes succeed without relying on CASCADE.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL panorama.bypass_owner_check = 'on'");
    await tx.blackoutSlot.deleteMany();
    await tx.invitation.deleteMany();
    await tx.inspectionPhoto.deleteMany();
    await tx.inspectionResponse.deleteMany();
    await tx.inspection.deleteMany();
    await tx.inspectionTemplateItem.deleteMany();
    await tx.inspectionTemplate.deleteMany();
    await tx.maintenancePhoto.deleteMany();
    await tx.assetMaintenance.deleteMany();
    await tx.reservation.deleteMany();
    await tx.asset.deleteMany();
    await tx.assetModel.deleteMany();
    await tx.manufacturer.deleteMany();
    await tx.category.deleteMany();
    await tx.personalAccessToken.deleteMany();
    await tx.notificationEvent.deleteMany();
    await tx.tenantMembership.deleteMany();
    await tx.authIdentity.deleteMany();
    await tx.tenant.deleteMany();
    await tx.user.deleteMany();
    await tx.importIdentityMap.deleteMany();
    await tx.auditEvent.deleteMany();
  });

  // ADR-0016 §1 — every tenant carries a NOT NULL system actor user
  // for auto-suggested maintenance attribution. Seed both atomically.
  const alphaSystem = await prisma.user.create({
    data: { email: 'system+alpha@panorama.invalid', displayName: 'alpha System', status: 'ACTIVE' },
  });
  const alpha = await prisma.tenant.create({
    data: { slug: 'alpha', name: 'Alpha Logistics', displayName: 'Alpha Logistics', locale: 'en', systemActorUserId: alphaSystem.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: alpha.id, userId: alphaSystem.id, role: 'system', status: 'active' },
  });
  const bravoSystem = await prisma.user.create({
    data: { email: 'system+bravo@panorama.invalid', displayName: 'bravo System', status: 'ACTIVE' },
  });
  const bravo = await prisma.tenant.create({
    data: { slug: 'bravo', name: 'Bravo Transport', displayName: 'Bravo Transport', locale: 'pt-br', systemActorUserId: bravoSystem.id },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: bravo.id, userId: bravoSystem.id, role: 'system', status: 'active' },
  });

  for (const [tenant, tag] of [
    [alpha, 'ALPHA'],
    [bravo, 'BRAVO'],
  ] as const) {
    const category = await prisma.category.create({
      data: { tenantId: tenant.id, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const manufacturer = await prisma.manufacturer.create({
      data: { tenantId: tenant.id, name: 'Ford' },
    });
    const model = await prisma.assetModel.create({
      data: {
        tenantId: tenant.id,
        categoryId: category.id,
        manufacturerId: manufacturer.id,
        name: 'F-150 2024',
      },
    });

    for (let i = 1; i <= 3; i++) {
      await prisma.asset.create({
        data: {
          tenantId: tenant.id,
          modelId: model.id,
          tag: `${tag}-${String(i).padStart(3, '0')}`,
          name: `${tenant.displayName} truck ${i}`,
          bookable: true,
        },
      });
    }

    const user = await prisma.user.create({
      data: {
        email: `admin@${tenant.slug}.example`,
        displayName: `${tenant.displayName} Admin`,
        firstName: 'Admin',
        lastName: tenant.displayName,
        status: 'ACTIVE',
      },
    });
    // ADR-0007 rule 2: creator of a tenant is its first Owner.
    await prisma.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        role: 'owner',
        status: 'active',
        acceptedAt: new Date(),
      },
    });
    // Password identity so the seeded Owner can log in via the
    // email/password flow without going through OIDC setup. The
    // quickstart runbook tells the user this exists; nothing in
    // production code path reads `DEV_OWNER_PASSWORD`.
    await prisma.authIdentity.create({
      data: {
        userId: user.id,
        provider: 'password',
        subject: user.email,
        emailAtLink: user.email,
        secretHash: await passwords.hash(DEV_OWNER_PASSWORD),
      },
    });
  }

  const [alphaCount, bravoCount] = await Promise.all([
    prisma.asset.count({ where: { tenantId: alpha.id } }),
    prisma.asset.count({ where: { tenantId: bravo.id } }),
  ]);
  console.log(`Seed complete. alpha=${alphaCount} assets, bravo=${bravoCount} assets.`);
  console.log(`alpha id: ${alpha.id}`);
  console.log(`bravo id: ${bravo.id}`);
  console.log('');
  console.log('Owner login credentials (DEV ONLY — see docs/en/quickstart.md):');
  console.log('  admin@alpha.example / panorama-dev-2026');
  console.log('  admin@bravo.example / panorama-dev-2026');
  console.log('');
  console.log('Web URL: http://localhost:3000');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
