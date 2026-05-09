/**
 * Additive + idempotent seed for a managed-PG staging / canary
 * environment. Surfaced from the 2026-05-09 first-Supabase-bring-up
 * and promoted from /tmp because the same shape will onboard the
 * canary tenant once that decision lands.
 *
 * What it creates (skipping if already present):
 *   * tenant: `smoke-test` + its system-actor user + system membership
 *   * owner user: `smoke-owner@panorama.invalid` + password identity
 *     + owner membership
 *   * 1 category (HARDWARE) → 1 asset model → 1 asset (SMK-001)
 *
 * Safe to re-run on the same DB. Skips on existing slug / email /
 * (tenantId,name) for category + model / (tenantId,serial) for asset.
 *
 * SECURITY: refuses to run unless `ALLOW_STAGING_SEED=true`. Reads the
 * password from `SEED_OWNER_PASSWORD` (env) or
 * `SEED_OWNER_PASSWORD_FILE` (file path; mode-600 expected). Hashes
 * with the same Argon2id parameters PasswordService uses
 * (apps/core-api/src/modules/auth/password.service.ts).
 *
 * Usage:
 *   set -a && . apps/core-api/.env.staging && set +a
 *   DATABASE_URL="$DATABASE_PRIVILEGED_URL" \
 *   ALLOW_STAGING_SEED=true \
 *   SEED_OWNER_PASSWORD_FILE=/path/to/pwd.txt \
 *     pnpm --filter @panorama/core-api exec tsx \
 *       scripts/smoke-staging-seed.ts
 *
 * NOTE on AuthIdentity.subject: the schema comment claims password
 * identities use `subject = userId`. The runtime code in
 * AuthService.loginWithPassword actually looks up by `subject = email`
 * — so this script writes `subject = OWNER_EMAIL`. Tracked in #187.
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { readFileSync } from 'node:fs';

const TENANT_SLUG = 'smoke-test';
const OWNER_EMAIL = 'smoke-owner@panorama.invalid';
const ASSET_SERIAL = 'SMOKE-ASSET-001';

async function main(): Promise<void> {
  if (process.env.ALLOW_STAGING_SEED !== 'true') {
    console.error('Refusing — set ALLOW_STAGING_SEED=true to confirm.');
    process.exit(1);
  }

  let password: string | undefined = process.env.SEED_OWNER_PASSWORD;
  if (!password && process.env.SEED_OWNER_PASSWORD_FILE) {
    password = readFileSync(process.env.SEED_OWNER_PASSWORD_FILE, 'utf8').trim();
  }
  if (!password || password.length < 12) {
    console.error('SEED_OWNER_PASSWORD or SEED_OWNER_PASSWORD_FILE required (>=12 chars).');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    // 1. Tenant + its system-actor user (mirrors test/_create-tenant.ts).
    const existingTenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
    let tenantId: string;
    if (existingTenant) {
      console.log(`tenant ${TENANT_SLUG} exists (id=${existingTenant.id}); skipping create`);
      tenantId = existingTenant.id;
    } else {
      const result = await prisma.$transaction(async (tx) => {
        const systemUser = await tx.user.create({
          data: {
            email: `system+${TENANT_SLUG}-${Date.now()}@panorama.invalid`,
            displayName: `${TENANT_SLUG} System`,
            status: 'ACTIVE',
          },
        });
        const tenant = await tx.tenant.create({
          data: {
            slug: TENANT_SLUG,
            name: 'Smoke Test',
            displayName: 'Smoke Test',
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
        return tenant;
      });
      console.log(`tenant ${TENANT_SLUG} created (id=${result.id})`);
      tenantId = result.id;
    }

    // 2. Owner user + AuthIdentity (password) + TenantMembership.
    const existingOwner = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
    let ownerId: string;
    if (existingOwner) {
      console.log(`owner ${OWNER_EMAIL} exists (id=${existingOwner.id}); skipping create`);
      ownerId = existingOwner.id;
    } else {
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      const owner = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: OWNER_EMAIL,
            displayName: 'Smoke Owner',
            status: 'ACTIVE',
          },
        });
        await tx.authIdentity.create({
          data: {
            userId: user.id,
            provider: 'password',
            // subject = email per AuthService.loginWithPassword (schema
            // comment says userId; code uses email — see issue #187).
            subject: OWNER_EMAIL,
            emailAtLink: OWNER_EMAIL,
            secretHash: passwordHash,
          },
        });
        await tx.tenantMembership.create({
          data: {
            tenantId,
            userId: user.id,
            role: 'owner',
            status: 'active',
          },
        });
        return user;
      });
      console.log(`owner ${OWNER_EMAIL} created (id=${owner.id})`);
      ownerId = owner.id;
    }

    // 3. Category → AssetModel → Asset (chain of relations).
    const existingCategory = await prisma.category.findFirst({
      where: { tenantId, name: 'Smoke Category' },
    });
    const category =
      existingCategory ??
      (await prisma.category.create({
        data: {
          tenant: { connect: { id: tenantId } },
          name: 'Smoke Category',
          kind: 'HARDWARE',
        },
      }));
    if (!existingCategory) console.log(`category created (id=${category.id})`);

    const existingModel = await prisma.assetModel.findFirst({
      where: { tenantId, name: 'Smoke Model' },
    });
    const model =
      existingModel ??
      (await prisma.assetModel.create({
        data: {
          tenantId,
          category: { connect: { id: category.id } },
          name: 'Smoke Model',
        },
      }));
    if (!existingModel) console.log(`assetModel created (id=${model.id})`);

    const existingAsset = await prisma.asset.findFirst({
      where: { tenantId, serial: ASSET_SERIAL },
    });
    if (existingAsset) {
      console.log(`asset ${ASSET_SERIAL} exists (id=${existingAsset.id}); skipping create`);
    } else {
      const asset = await prisma.asset.create({
        data: {
          tenant: { connect: { id: tenantId } },
          model: { connect: { id: model.id } },
          name: 'Smoke Asset 001',
          tag: 'SMK-001',
          serial: ASSET_SERIAL,
          status: 'READY',
          bookable: true,
        },
      });
      console.log(`asset ${ASSET_SERIAL} created (id=${asset.id})`);
    }

    console.log('\nseed done. summary:');
    console.log(`  tenant: slug=${TENANT_SLUG} id=${tenantId}`);
    console.log(`  owner:  email=${OWNER_EMAIL} id=${ownerId}`);
    console.log(`  asset:  serial=${ASSET_SERIAL}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
