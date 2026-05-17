import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Regression test for ADR-0020 §3 — the cross-flow login bypass
 * surfaced by the security-reviewer 3rd-pass: a user who completed
 * self-serve signup creates a tenant with `pendingVerification=true`,
 * and `buildSessionForUser` MUST NOT mint a session on that tenant
 * (regardless of whether the call comes via the signup callback,
 * the /auth/oidc/...login flow, or any other surface that ends up
 * calling buildSessionForUser).
 *
 * The filter lives at `auth.service.ts` (the `tenant: {
 * pendingVerification: false }` clause on the memberships
 * findMany). If a future refactor drops the clause, this test
 * catches it.
 *
 * Single test; uses raw PrismaClient on the privileged URL to seed
 * fixtures, the AppModule to obtain the same AuthService production
 * uses.
 */

const HOST = process.env['PG_HOST'] ?? 'localhost';
const PORT = process.env['PG_PORT'] ?? '5432';
const DB = process.env['PG_DB'] ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('buildSessionForUser — pendingVerification filter (ADR-0020 §3)', () => {
  let admin: PrismaClient;
  let auth: AuthService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    auth = app.get(AuthService);
    close = () => app.close();
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await admin?.$disconnect();
  });

  it('refuses session for a user whose only membership is on a pendingVerification tenant', async () => {
    const user = await admin.user.create({
      data: { email: 'pending-only@example.invalid', displayName: 'Pending Only' },
    });
    const systemUser = await admin.user.create({
      data: {
        email: 'system+pending@example.invalid',
        displayName: 'system pending',
        status: 'ACTIVE',
      },
    });
    const tenant = await admin.tenant.create({
      data: {
        slug: `pending-${Date.now()}`,
        name: 'Pending Tenant',
        displayName: 'Pending Tenant',
        systemActorUserId: systemUser.id,
        pendingVerification: true,
      },
    });
    await admin.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: 'owner', status: 'active' },
    });

    await expect(
      auth.buildSessionForUser(user.id, 'google'),
    ).rejects.toThrow('no_tenant_memberships');
  });

  it('surfaces only verified memberships when a user has BOTH a verified and a pending tenant', async () => {
    const user = await admin.user.create({
      data: { email: 'mixed@example.invalid', displayName: 'Mixed' },
    });
    const sysA = await admin.user.create({
      data: { email: 'system+mixed-a@example.invalid', displayName: 'sys a', status: 'ACTIVE' },
    });
    const sysB = await admin.user.create({
      data: { email: 'system+mixed-b@example.invalid', displayName: 'sys b', status: 'ACTIVE' },
    });
    const verified = await admin.tenant.create({
      data: {
        slug: `verified-${Date.now()}`,
        name: 'Verified',
        displayName: 'Verified',
        systemActorUserId: sysA.id,
        pendingVerification: false,
      },
    });
    const pending = await admin.tenant.create({
      data: {
        slug: `pending-${Date.now()}-b`,
        name: 'Pending',
        displayName: 'Pending',
        systemActorUserId: sysB.id,
        pendingVerification: true,
      },
    });
    await admin.tenantMembership.create({
      data: { tenantId: verified.id, userId: user.id, role: 'owner', status: 'active' },
    });
    await admin.tenantMembership.create({
      data: { tenantId: pending.id, userId: user.id, role: 'owner', status: 'active' },
    });

    const session = await auth.buildSessionForUser(user.id, 'google');
    const tenantIds = session.memberships.map((m) => m.tenantId);
    expect(tenantIds).toContain(verified.id);
    expect(tenantIds).not.toContain(pending.id);
  });
});
