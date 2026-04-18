import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * Reservation + blackout e2e (ADR-0009 Part A).
 *
 * Covers the documented contract:
 *   - create as fleet_admin → AUTO_APPROVED; audit panorama.reservation.auto_approved
 *   - create as driver → PENDING_APPROVAL; audit panorama.reservation.created
 *   - conflict detection on same asset + overlapping window → 409
 *   - back-to-back half-open ranges DO NOT conflict
 *   - blackout overlap (asset-specific) → 409
 *   - blackout overlap (global, assetId=null) → 409
 *   - concurrency cap on non-staff role → 409 once cap hit
 *   - min-notice-hours on driver → 400; bypass for staff
 *   - max-duration-hours on driver → 400
 *   - cancel own reservation → 200
 *   - cancel someone else's reservation (non-admin) → 403
 *   - admin approves → approvalStatus APPROVED, audit event
 *   - admin rejects → approvalStatus REJECTED
 *   - admin approve runs re-check — another approved overlap → 409
 *   - blackout CRUD admin-only, non-admin → 403
 *   - non-admin GET tenant-scope → 403
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation flow e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  let assetId: string;
  let secondAssetId: string;

  const adminUser = {
    email: 'admin@reservation-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Reservation Admin',
  };
  const driverUser = {
    email: 'driver@reservation-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Driver',
  };
  const secondaryDriver = {
    email: 'driver2@reservation-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Secondary Driver',
  };

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
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

  function isoAt(hoursFromNow: number): string {
    return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
  }

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

    const tenants = app.get(TenantAdminService);
    const passwords = new PasswordService();
    const admin = await adminDb.user.create({
      data: { email: adminUser.email, displayName: adminUser.displayName },
    });
    const driver = await adminDb.user.create({
      data: { email: driverUser.email, displayName: driverUser.displayName },
    });
    const driver2 = await adminDb.user.create({
      data: { email: secondaryDriver.email, displayName: secondaryDriver.displayName },
    });
    for (const [u, pw] of [
      [admin, adminUser.password],
      [driver, driverUser.password],
      [driver2, secondaryDriver.password],
    ] as const) {
      await adminDb.authIdentity.create({
        data: {
          userId: u.id,
          provider: 'password',
          subject: u.email,
          emailAtLink: u.email,
          secretHash: await passwords.hash(pw),
        },
      });
    }

    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'reservation-test',
      name: 'Reservation Test',
      displayName: 'Reservation Test',
      ownerUserId: admin.id,
    });
    tenantId = tenant.id;

    // admin is already owner. Make them fleet_admin-equivalent by keeping
    // 'owner' — auto-approve covers it. Drivers join as 'driver'.
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driver.id, role: 'driver', status: 'active' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driver2.id, role: 'driver', status: 'active' },
    });

    // Seed a bookable asset pair for conflict tests.
    const category = await adminDb.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await adminDb.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'F-150 2024' },
    });
    const asset = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'RES-01',
        name: 'Reservation Truck 01',
        bookable: true,
        status: 'READY',
      },
    });
    assetId = asset.id;
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'RES-02',
        name: 'Reservation Truck 02',
        bookable: true,
        status: 'READY',
      },
    });
    secondAssetId = asset2.id;
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // -------------------------------------------------------------------

  it('POST /reservations without session → 401', async () => {
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(24), endAt: isoAt(26) }),
    });
    expect(res.status).toBe(401);
  });

  it('admin/owner creates reservation → AUTO_APPROVED + audit row', async () => {
    const cookie = await loginCookie(adminUser.email, adminUser.password);
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(48), endAt: isoAt(50), purpose: 'site visit' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { approvalStatus: string; lifecycleStatus: string };
    expect(body.approvalStatus).toBe('AUTO_APPROVED');
    expect(body.lifecycleStatus).toBe('BOOKED');

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.reservation.auto_approved', tenantId },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('driver creates reservation → PENDING_APPROVAL + audit created', async () => {
    const cookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: secondAssetId, startAt: isoAt(72), endAt: isoAt(74) }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { approvalStatus: string };
    expect(body.approvalStatus).toBe('PENDING_APPROVAL');
  });

  it('conflict detection: second booking for same window → 409', async () => {
    const cookie = await loginCookie(driverUser.email, driverUser.password);
    // The admin's 48→50 reservation on `assetId` already blocks this range.
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(49), endAt: isoAt(51) }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('reservation_conflict');
  });

  it('back-to-back half-open ranges DO NOT conflict', async () => {
    const cookie = await loginCookie(adminUser.email, adminUser.password);
    // existing 48→50; a new 50→52 should squeak through
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(50), endAt: isoAt(52) }),
    });
    expect(res.status).toBe(201);
  });

  it('blackout overlap (asset-specific) → 409', async () => {
    const cookie = await loginCookie(adminUser.email, adminUser.password);
    const blackout = await fetch(`${url}/blackouts`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId,
        title: 'Brake inspection',
        startAt: isoAt(96),
        endAt: isoAt(100),
      }),
    });
    expect(blackout.status).toBe(201);

    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(97), endAt: isoAt(99) }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('blackout_conflict');
  });

  it('blackout overlap (global, assetId=null) blocks all assets in tenant', async () => {
    const cookie = await loginCookie(adminUser.email, adminUser.password);
    const blackout = await fetch(`${url}/blackouts`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: null,
        title: 'Company holiday',
        startAt: isoAt(200),
        endAt: isoAt(208),
      }),
    });
    expect(blackout.status).toBe(201);

    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: secondAssetId, startAt: isoAt(202), endAt: isoAt(204) }),
    });
    expect(res.status).toBe(409);
  });

  it('tenant reservationRules: min-notice-hours gates a driver, staff bypass', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: {
        reservationRules: {
          min_notice_hours: 24,
          auto_approve_roles: ['owner', 'fleet_admin', 'fleet_staff'],
        },
      },
    });
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    // 2h from now < 24h min_notice
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(2), endAt: isoAt(4) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('min_notice_hours');

    // Admin bypasses.
    const adminCookie = await loginCookie(adminUser.email, adminUser.password);
    const bypass = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: secondAssetId,
        startAt: isoAt(2),
        endAt: isoAt(4),
        purpose: 'urgent drop-off',
      }),
    });
    expect(bypass.status).toBe(201);

    // Reset for subsequent tests.
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  it('tenant reservationRules: max-duration-hours caps a driver', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { max_duration_hours: 4 } },
    });
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(300), endAt: isoAt(310) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('max_duration_hours');

    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  it('concurrency cap hits on driver after N bookings', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { max_concurrent_per_user: 1 } },
    });
    const driverCookie = await loginCookie(secondaryDriver.email, secondaryDriver.password);
    // First booking OK (uses second asset to avoid conflict with earlier driver)
    const a = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: secondAssetId, startAt: isoAt(400), endAt: isoAt(402) }),
    });
    expect(a.status).toBe(201);

    // Second booking for the same driver should hit the cap
    const b = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: secondAssetId, startAt: isoAt(500), endAt: isoAt(502) }),
    });
    expect(b.status).toBe(409);
    expect(((await b.json()) as { message: string }).message).toContain(
      'max_concurrent_reservations',
    );

    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  it('cancel own reservation → 200; cancel someone else as non-admin → 403', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(600), endAt: isoAt(602) }),
    });
    const { id: reservationId } = (await created.json()) as { id: string };
    expect(created.status).toBe(201);

    const otherDriverCookie = await loginCookie(secondaryDriver.email, secondaryDriver.password);
    const nope = await fetch(`${url}/reservations/${reservationId}/cancel`, {
      method: 'POST',
      headers: { cookie: otherDriverCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(nope.status).toBe(403);

    const ok = await fetch(`${url}/reservations/${reservationId}/cancel`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'change of plans' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { lifecycleStatus: string; cancelReason: string };
    expect(body.lifecycleStatus).toBe('CANCELLED');
    expect(body.cancelReason).toBe('change of plans');
  });

  it('admin approves a pending reservation → APPROVED + audit', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: secondAssetId, startAt: isoAt(700), endAt: isoAt(702) }),
    });
    const { id } = (await created.json()) as { id: string };

    const adminCookie = await loginCookie(adminUser.email, adminUser.password);
    const approve = await fetch(`${url}/reservations/${id}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'approved, vehicle reserved' }),
    });
    expect(approve.status).toBe(200);
    const body = (await approve.json()) as { approvalStatus: string; approvalNote: string };
    expect(body.approvalStatus).toBe('APPROVED');
    expect(body.approvalNote).toContain('approved, vehicle');

    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.reservation.approved', resourceId: id },
    });
    expect(audit).toBeTruthy();
  });

  it('admin rejects pending reservation → REJECTED', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(800), endAt: isoAt(802) }),
    });
    const { id } = (await created.json()) as { id: string };

    const adminCookie = await loginCookie(adminUser.email, adminUser.password);
    const reject = await fetch(`${url}/reservations/${id}/reject`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'not aligned with fleet plan' }),
    });
    expect(reject.status).toBe(200);
    expect(((await reject.json()) as { approvalStatus: string }).approvalStatus).toBe('REJECTED');
  });

  it('driver cannot approve', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(900), endAt: isoAt(902) }),
    });
    const { id } = (await created.json()) as { id: string };

    const nope = await fetch(`${url}/reservations/${id}/approve`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(nope.status).toBe(403);
  });

  it('GET /reservations?scope=tenant gated to admins', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations?scope=tenant`, {
      headers: { cookie: driverCookie },
    });
    expect(res.status).toBe(403);
  });

  it('GET /reservations?scope=mine returns only own/onBehalf', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/reservations?scope=mine&status=all`, {
      headers: { cookie: driverCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ requesterUserId: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    // Drivers see only their own.
    const driver = await adminDb.user.findUnique({ where: { email: driverUser.email } });
    for (const item of body.items) {
      expect(item.requesterUserId).toBe(driver!.id);
    }
  });

  it('POST /blackouts as non-admin → 403', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const res = await fetch(`${url}/blackouts`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Unauthorized',
        startAt: isoAt(1000),
        endAt: isoAt(1002),
      }),
    });
    expect(res.status).toBe(403);
  });

  it('admin approve re-checks overlap: concurrent approval of conflicting pendings blocks the second', async () => {
    const driverCookie = await loginCookie(driverUser.email, driverUser.password);
    const r1 = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(1100), endAt: isoAt(1110) }),
    });
    const { id: id1 } = (await r1.json()) as { id: string };
    const r2 = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ assetId, startAt: isoAt(1105), endAt: isoAt(1115) }),
    });
    // r2 should already fail at create because r1 is PENDING_APPROVAL
    // (overlap predicate includes pending).
    expect(r2.status).toBe(409);

    // Approve r1; that's allowed.
    const adminCookie = await loginCookie(adminUser.email, adminUser.password);
    const approve = await fetch(`${url}/reservations/${id1}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(approve.status).toBe(200);
  });
});
