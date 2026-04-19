import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Owner enforcement e2e (ADR-0007). Covers:
 *
 *   * DB trigger blocks demoting the last active Owner, whether via
 *     the service or a raw Prisma call — service surfaces 409
 *     `last_owner_must_remain_active`.
 *   * Same for suspend / delete the last active Owner.
 *   * Promote a second member first, THEN demote the first — works.
 *   * Owner cannot be suspended directly (service 400, never hits the
 *     DB).
 *   * Break-glass `nominateOwner` upserts + emits
 *     `panorama.tenant.ownership_restored` audit row with the
 *     operator identity and the reason.
 *   * `createTenantWithOwner` rejects if the owner user doesn't
 *     exist (sanity check on the invariant-at-creation path).
 *   * `countActiveOwners` matches reality before + after transitions.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('owner enforcement e2e', () => {
  let app: INestApplication;
  let url: string;
  let tenants: TenantAdminService;
  let tenantId: string;
  let ownerUserId: string;
  let ownerMembershipId: string;
  let seconderyUserId: string;
  let adminDb: PrismaClient;

  const owner = {
    email: 'owner@enforcement.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Solo Owner',
  };
  const secondary = {
    email: 'secondary@enforcement.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Secondary User',
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;
    process.env.INVITE_RATE_ADMIN_HOUR = '10000';
    process.env.INVITE_RATE_TENANT_DAY = '100000';

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
    tenants = app.get(TenantAdminService);

    const passwords = new PasswordService();
    const ownerUser = await adminDb.user.create({
      data: { email: owner.email, displayName: owner.displayName },
    });
    ownerUserId = ownerUser.id;
    await adminDb.authIdentity.create({
      data: {
        userId: ownerUser.id,
        provider: 'password',
        subject: owner.email,
        emailAtLink: owner.email,
        secretHash: await passwords.hash(owner.password),
      },
    });
    const secondaryUser = await adminDb.user.create({
      data: { email: secondary.email, displayName: secondary.displayName },
    });
    seconderyUserId = secondaryUser.id;
    await adminDb.authIdentity.create({
      data: {
        userId: secondaryUser.id,
        provider: 'password',
        subject: secondary.email,
        emailAtLink: secondary.email,
        secretHash: await passwords.hash(secondary.password),
      },
    });

    const { tenant, ownerMembership } = await tenants.createTenantWithOwner({
      slug: 'enforcement-test',
      name: 'Enforcement Test',
      displayName: 'Enforcement Test',
      ownerUserId,
    });
    tenantId = tenant.id;
    ownerMembershipId = ownerMembership.id;
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // -----------------------------------------------------------------

  it('createTenantWithOwner installs creator as active owner', async () => {
    const count = await tenants.countActiveOwners(tenantId);
    expect(count).toBe(1);
  });

  it('createTenantWithOwner refuses a non-existent owner user', async () => {
    await expect(
      tenants.createTenantWithOwner({
        slug: 'ghost',
        name: 'Ghost',
        displayName: 'Ghost',
        ownerUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/owner_user_not_found/);
  });

  it('service refuses to demote the only active Owner', async () => {
    await expect(
      tenants.updateMembership({
        tenantId,
        membershipId: ownerMembershipId,
        role: 'fleet_admin',
        actorUserId: ownerUserId,
      }),
    ).rejects.toThrow(/last_owner_must_remain_active/);
  });

  it('service refuses to suspend an Owner (ADR rule 8)', async () => {
    await expect(
      tenants.updateMembership({
        tenantId,
        membershipId: ownerMembershipId,
        status: 'suspended',
        actorUserId: ownerUserId,
      }),
    ).rejects.toThrow(/owner_cannot_be_suspended_demote_first/);
  });

  it('service refuses to delete the only active Owner', async () => {
    await expect(
      tenants.deleteMembership({
        tenantId,
        membershipId: ownerMembershipId,
        actorUserId: ownerUserId,
      }),
    ).rejects.toThrow(/last_owner_must_remain_active/);
  });

  it('DB trigger also refuses a raw Prisma demote of the last Owner', async () => {
    await expect(
      adminDb.tenantMembership.update({
        where: { id: ownerMembershipId },
        data: { role: 'fleet_admin' },
      }),
    ).rejects.toThrow(/TENANT_MUST_HAVE_AT_LEAST_ONE_OWNER/);
  });

  it('promote a second member, THEN demote the first — works', async () => {
    const second = await adminDb.tenantMembership.create({
      data: {
        tenantId,
        userId: seconderyUserId,
        role: 'fleet_admin',
        status: 'active',
      },
    });
    // promote to owner
    const promoted = await tenants.updateMembership({
      tenantId,
      membershipId: second.id,
      role: 'owner',
      actorUserId: ownerUserId,
    });
    expect(promoted.role).toBe('owner');
    expect(await tenants.countActiveOwners(tenantId)).toBe(2);

    // now safe to demote the original owner
    const demoted = await tenants.updateMembership({
      tenantId,
      membershipId: ownerMembershipId,
      role: 'fleet_admin',
      actorUserId: seconderyUserId,
    });
    expect(demoted.role).toBe('fleet_admin');
    expect(await tenants.countActiveOwners(tenantId)).toBe(1);
  });

  it('nominateOwner is idempotent and writes an ownership_restored audit row', async () => {
    // Create an orphaned tenant by deleting the last owner via super-admin
    // in a way the trigger allows (we'll transfer to a new owner first,
    // then demote + delete to simulate the "oh no, last admin left" case).
    // Easiest approach: create a brand-new tenant with a unique
    // creator, then have the creator nominate themselves again via
    // the CLI path — idempotency check.

    const lonely = await adminDb.user.create({
      data: { email: 'lonely@enforcement.example', displayName: 'Lonely' },
    });
    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'lonely-tenant',
      name: 'Lonely Tenant',
      displayName: 'Lonely Tenant',
      ownerUserId: lonely.id,
    });

    // Idempotent re-nomination — should update the existing row, not duplicate.
    const before = await adminDb.tenantMembership.count({
      where: { tenantId: tenant.id },
    });
    const result = await tenants.nominateOwner({
      tenantSlug: 'lonely-tenant',
      email: 'lonely@enforcement.example',
      reason: 'confirm break-glass is idempotent',
      operatorEmail: 'ops@panorama.example',
    });
    expect(result.created).toBe(false);
    const after = await adminDb.tenantMembership.count({
      where: { tenantId: tenant.id },
    });
    expect(after).toBe(before);

    // Audit row exists with operator + reason.
    const audit = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.tenant.ownership_restored',
        tenantId: tenant.id,
      },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
    const metadata = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata['operatorEmail']).toBe('ops@panorama.example');
    expect(String(metadata['reason'])).toContain('idempotent');
  });

  it('nominateOwner creates a fresh owner membership when none existed', async () => {
    const rescuedTenant = await createTenantForTest(adminDb, {
      slug: 'orphaned-tenant',
      name: 'Orphaned Tenant',
      displayName: 'Orphaned Tenant',
    });
    const rescueUser = await adminDb.user.create({
      data: { email: 'rescuer@enforcement.example', displayName: 'Rescuer' },
    });

    const { created } = await tenants.nominateOwner({
      tenantSlug: 'orphaned-tenant',
      email: 'rescuer@enforcement.example',
      reason: 'original admin departed 2026-04-01, support ticket #9876',
      operatorEmail: 'ops@panorama.example',
    });
    expect(created).toBe(true);

    const membership = await adminDb.tenantMembership.findUnique({
      where: {
        tenantId_userId: { tenantId: rescuedTenant.id, userId: rescueUser.id },
      },
    });
    expect(membership?.role).toBe('owner');
    expect(membership?.status).toBe('active');
  });

  it('PATCH /tenants/:tenantId/memberships/:id as non-owner returns 401', async () => {
    const res = await fetch(
      `${url}/tenants/${tenantId}/memberships/${ownerMembershipId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'driver' }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('GET /tenants/:tenantId/ownership-summary surfaces count + spof flag', async () => {
    // Log in as the lonely owner (single owner) to assert the SPOF flag.
    const passwords = new PasswordService();
    const lonelyEmail = 'lonely@enforcement.example';
    // Seed a password identity for the lonely user so we can log in.
    const lonelyUser = await adminDb.user.findUnique({ where: { email: lonelyEmail } });
    if (lonelyUser) {
      await adminDb.authIdentity.upsert({
        where: { provider_subject: { provider: 'password', subject: lonelyEmail } },
        update: { secretHash: await passwords.hash('correct-horse-battery-staple') },
        create: {
          userId: lonelyUser.id,
          provider: 'password',
          subject: lonelyEmail,
          emailAtLink: lonelyEmail,
          secretHash: await passwords.hash('correct-horse-battery-staple'),
        },
      });
    }

    const login = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: lonelyEmail, password: 'correct-horse-battery-staple' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .get('set-cookie')!
      .split(',')
      .map((p) => p.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');

    const lonelyTenant = await adminDb.tenant.findUnique({ where: { slug: 'lonely-tenant' } });
    const res = await fetch(
      `${url}/tenants/${lonelyTenant!.id}/ownership-summary`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeOwners: number; isSpof: boolean };
    expect(body.activeOwners).toBe(1);
    expect(body.isSpof).toBe(true);
  });
});
