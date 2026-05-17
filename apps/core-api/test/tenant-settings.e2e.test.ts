import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Round 4 PR5 — Tenant settings endpoint (#48 fold-in).
 *
 * Coverage:
 *   - GET as Owner returns the current setting.
 *   - GET as fleet_admin (read-only role) succeeds.
 *   - GET as driver → 401 admin_role_required.
 *   - PATCH as Owner flips the toggle + emits the
 *     panorama.tenant.settings_updated audit row.
 *   - PATCH as fleet_admin → 401 owner_role_required.
 *   - PATCH with no fields → 400 invalid_body.
 *   - PATCH no-op (same value) returns 200 but does NOT emit a fresh
 *     audit row.
 */

const HOST = process.env['PG_HOST'] ?? 'localhost';
const PORT = process.env['PG_PORT'] ?? '5432';
const DB = process.env['PG_DB'] ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('tenant settings (Round 4 PR5)', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let tenantId: string;
  let ownerEmail: string;
  let fleetAdminEmail: string;
  let driverEmail: string;
  const password = 'correct-horse-battery-staple';

  async function loginCookie(email: string, pw: string): Promise<string> {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie');
    if (!set) throw new Error('no set-cookie');
    return set
      .split(',')
      .map((p) => p.trim().split(';')[0])
      .filter(Boolean)
      .join('; ');
  }

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;

    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await resetTestDb(admin);
    const passwords = new PasswordService();
    const seed = await createTenantForTest(admin, {
      slug: 'settings-test',
      name: 'Settings Test',
      displayName: 'Settings Test',
    });
    tenantId = seed.id;

    const owner = await admin.user.create({
      data: { email: 'owner@settings-test.example', displayName: 'Owner' },
    });
    const fleetAdmin = await admin.user.create({
      data: { email: 'admin@settings-test.example', displayName: 'Fleet Admin' },
    });
    const driver = await admin.user.create({
      data: { email: 'driver@settings-test.example', displayName: 'Driver' },
    });
    for (const u of [owner, fleetAdmin, driver]) {
      await admin.authIdentity.create({
        data: {
          userId: u.id,
          provider: 'password',
          subject: u.email,
          emailAtLink: u.email,
          secretHash: await passwords.hash(password),
        },
      });
    }
    await admin.tenantMembership.create({
      data: { tenantId, userId: owner.id, role: 'owner', status: 'active' },
    });
    await admin.tenantMembership.create({
      data: { tenantId, userId: fleetAdmin.id, role: 'fleet_admin', status: 'active' },
    });
    await admin.tenantMembership.create({
      data: { tenantId, userId: driver.id, role: 'driver', status: 'active' },
    });
    ownerEmail = owner.email;
    fleetAdminEmail = fleetAdmin.email;
    driverEmail = driver.email;
  });

  it('GET /tenants/:id/settings as Owner returns default-false', async () => {
    const cookie = await loginCookie(ownerEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      autoOpenMaintenanceFromInspection: boolean;
    };
    expect(body.tenantId).toBe(tenantId);
    expect(body.autoOpenMaintenanceFromInspection).toBe(false);
  });

  it('GET /tenants/:id/settings as fleet_admin succeeds (read-only role)', async () => {
    const cookie = await loginCookie(fleetAdminEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('GET /tenants/:id/settings as driver → 401 admin_role_required', async () => {
    const cookie = await loginCookie(driverEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('admin_role_required');
  });

  it('PATCH /tenants/:id/settings as Owner flips toggle + emits audit row', async () => {
    const cookie = await loginCookie(ownerEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoOpenMaintenanceFromInspection: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoOpenMaintenanceFromInspection: boolean };
    expect(body.autoOpenMaintenanceFromInspection).toBe(true);

    // Verify DB-side persistence.
    const tenant = await admin.tenant.findUnique({
      where: { id: tenantId },
      select: { autoOpenMaintenanceFromInspection: true },
    });
    expect(tenant?.autoOpenMaintenanceFromInspection).toBe(true);

    // Verify audit row.
    const audit = await admin.auditEvent.findFirst({
      where: { tenantId, action: 'panorama.tenant.settings_updated' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({
      field: 'autoOpenMaintenanceFromInspection',
      previousValue: false,
      newValue: true,
    });
  });

  it('PATCH /tenants/:id/settings as fleet_admin → 401 owner_role_required', async () => {
    const cookie = await loginCookie(fleetAdminEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoOpenMaintenanceFromInspection: true }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('owner_role_required');
  });

  it('PATCH with empty body → 400 invalid_body', async () => {
    const cookie = await loginCookie(ownerEmail, password);
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('PATCH no-op (same value) returns 200 but does NOT emit a fresh audit row', async () => {
    const cookie = await loginCookie(ownerEmail, password);
    // First flip to true.
    await fetch(`${url}/tenants/${tenantId}/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoOpenMaintenanceFromInspection: true }),
    });
    const auditCountAfterFirst = await admin.auditEvent.count({
      where: { tenantId, action: 'panorama.tenant.settings_updated' },
    });
    expect(auditCountAfterFirst).toBe(1);

    // Re-PATCH with the same value.
    const res = await fetch(`${url}/tenants/${tenantId}/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ autoOpenMaintenanceFromInspection: true }),
    });
    expect(res.status).toBe(200);
    const auditCountAfterNoop = await admin.auditEvent.count({
      where: { tenantId, action: 'panorama.tenant.settings_updated' },
    });
    expect(auditCountAfterNoop).toBe(auditCountAfterFirst);
  });
});
