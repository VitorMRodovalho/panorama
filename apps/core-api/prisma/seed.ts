/**
 * Dev seed — creates two tenants ("Alpha" / "Bravo") and a handful of
 * assets under each, plus one user in each tenant. Used to prove
 * tenancy in the integration test and for local development.
 *
 * Never runs in production: the script exits immediately if the DATABASE_URL
 * looks prod-like, unless ALLOW_DESTRUCTIVE_SEED=true.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

  // Purge previous seed rows (OK in dev only — the guard above enforces it).
  await prisma.invitation.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.assetModel.deleteMany();
  await prisma.manufacturer.deleteMany();
  await prisma.category.deleteMany();
  await prisma.tenantMembership.deleteMany();
  await prisma.authIdentity.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();

  const alpha = await prisma.tenant.create({
    data: { slug: 'alpha', name: 'Alpha Logistics', displayName: 'Alpha Logistics', locale: 'en' },
  });
  const bravo = await prisma.tenant.create({
    data: { slug: 'bravo', name: 'Bravo Transport', displayName: 'Bravo Transport', locale: 'pt-br' },
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
  }

  const [alphaCount, bravoCount] = await Promise.all([
    prisma.asset.count({ where: { tenantId: alpha.id } }),
    prisma.asset.count({ where: { tenantId: bravo.id } }),
  ]);
  console.log(`Seed complete. alpha=${alphaCount} assets, bravo=${bravoCount} assets.`);
  console.log(`alpha id: ${alpha.id}`);
  console.log(`bravo id: ${bravo.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
