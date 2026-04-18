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
 * Reservation check-out / check-in e2e (ADR-0009 Part B).
 *
 * Covers:
 *   - happy path: approved reservation → checkout → checkin
 *   - asset.status transitions READY → IN_USE → READY
 *   - damageFlag on checkin routes asset → MAINTENANCE
 *   - refuse checkout when approval is PENDING_APPROVAL
 *   - refuse checkout when asset.status is MAINTENANCE / RETIRED
 *   - refuse checkin when lifecycle is not CHECKED_OUT
 *   - mileage monotonicity: in < out → 400
 *   - driver who didn't check out CAN'T check in (unless admin or the
 *     user who did the checkout)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation check-out / check-in e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  let assetId: string;
  let otherAssetId: string;

  const admin = {
    email: 'admin@checkout-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Checkout Admin',
  };
  const driver = {
    email: 'driver@checkout-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Driver',
  };
  const otherDriver = {
    email: 'driver2@checkout-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Other Driver',
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

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    const passwords = new PasswordService();
    const adminUser = await adminDb.user.create({
      data: { email: admin.email, displayName: admin.displayName },
    });
    const driverUser = await adminDb.user.create({
      data: { email: driver.email, displayName: driver.displayName },
    });
    const otherUser = await adminDb.user.create({
      data: { email: otherDriver.email, displayName: otherDriver.displayName },
    });
    for (const [u, pw] of [
      [adminUser, admin.password],
      [driverUser, driver.password],
      [otherUser, otherDriver.password],
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

    const tenants = app.get(TenantAdminService);
    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'checkout-test',
      name: 'Checkout Test',
      displayName: 'Checkout Test',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driverUser.id, role: 'driver', status: 'active' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: otherUser.id, role: 'driver', status: 'active' },
    });

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
        tag: 'CO-01',
        name: 'Checkout Truck 01',
        bookable: true,
        status: 'READY',
      },
    });
    assetId = asset.id;
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'CO-02',
        name: 'Checkout Truck 02',
        bookable: true,
        status: 'READY',
      },
    });
    otherAssetId = asset2.id;
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  async function createApproved(params: {
    cookie: string;
    assetId: string;
    startHours?: number;
    endHours?: number;
  }): Promise<string> {
    const res = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: params.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: params.assetId,
        startAt: isoAt(params.startHours ?? 24),
        endAt: isoAt(params.endHours ?? 26),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; approvalStatus: string };
    expect(['APPROVED', 'AUTO_APPROVED']).toContain(body.approvalStatus);
    return body.id;
  }

  // -------------------------------------------------------------------

  it('happy path: admin creates + checkout + checkin; asset READY → IN_USE → READY', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const id = await createApproved({ cookie: adminCookie, assetId });

    const out = await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 12_345, condition: 'clean' }),
    });
    expect(out.status).toBe(200);
    const outBody = (await out.json()) as {
      lifecycleStatus: string;
      mileageOut: number;
      conditionOut: string;
    };
    expect(outBody.lifecycleStatus).toBe('CHECKED_OUT');
    expect(outBody.mileageOut).toBe(12_345);
    expect(outBody.conditionOut).toBe('clean');

    const asset = await adminDb.asset.findUnique({ where: { id: assetId } });
    expect(asset?.status).toBe('IN_USE');

    const inRes = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 12_400, condition: 'refueled' }),
    });
    expect(inRes.status).toBe(200);
    const inBody = (await inRes.json()) as {
      lifecycleStatus: string;
      mileageIn: number;
      damageFlag: boolean;
    };
    expect(inBody.lifecycleStatus).toBe('RETURNED');
    expect(inBody.mileageIn).toBe(12_400);
    expect(inBody.damageFlag).toBe(false);

    const assetAfter = await adminDb.asset.findUnique({ where: { id: assetId } });
    expect(assetAfter?.status).toBe('READY');
  });

  it('damageFlag on checkin routes asset → MAINTENANCE', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const id = await createApproved({
      cookie: adminCookie,
      assetId: otherAssetId,
      startHours: 48,
      endHours: 50,
    });

    await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 20_000 }),
    });

    const inRes = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        mileage: 20_030,
        damageFlag: true,
        damageNote: 'scratched rear bumper',
      }),
    });
    expect(inRes.status).toBe(200);
    const body = (await inRes.json()) as { damageFlag: boolean; damageNote: string };
    expect(body.damageFlag).toBe(true);
    expect(body.damageNote).toContain('scratched');

    const asset = await adminDb.asset.findUnique({ where: { id: otherAssetId } });
    expect(asset?.status).toBe('MAINTENANCE');

    // Restore for subsequent tests.
    await adminDb.asset.update({ where: { id: otherAssetId }, data: { status: 'READY' } });
  });

  it('refuse checkout when approvalStatus is PENDING_APPROVAL', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const created = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: otherAssetId,
        startAt: isoAt(100),
        endAt: isoAt(102),
      }),
    });
    const { id, approvalStatus } = (await created.json()) as {
      id: string;
      approvalStatus: string;
    };
    expect(approvalStatus).toBe('PENDING_APPROVAL');

    const out = await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(out.status).toBe(400);
    const body = (await out.json()) as { message: string };
    expect(body.message).toContain('cannot_checkout_when_approval');
  });

  it('refuse checkout when asset.status is MAINTENANCE', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    // Reserve while asset is READY to land APPROVED, then pretend asset went to
    // maintenance between approval and check-out.
    const id = await createApproved({
      cookie: adminCookie,
      assetId: otherAssetId,
      startHours: 200,
      endHours: 202,
    });
    await adminDb.asset.update({ where: { id: otherAssetId }, data: { status: 'MAINTENANCE' } });
    const out = await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(out.status).toBe(409);
    expect(((await out.json()) as { message: string }).message).toContain('asset_not_ready');
    await adminDb.asset.update({ where: { id: otherAssetId }, data: { status: 'READY' } });
  });

  it('refuse checkin when lifecycle is not CHECKED_OUT', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const id = await createApproved({
      cookie: adminCookie,
      assetId: otherAssetId,
      startHours: 300,
      endHours: 302,
    });
    const inRes = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 100 }),
    });
    expect(inRes.status).toBe(400);
    expect(((await inRes.json()) as { message: string }).message).toContain(
      'cannot_checkin_when_lifecycle',
    );
  });

  it('mileage monotonicity: mileageIn < mileageOut → 400', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const id = await createApproved({
      cookie: adminCookie,
      assetId: otherAssetId,
      startHours: 400,
      endHours: 402,
    });

    await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 50_000 }),
    });

    const inRes = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 49_000 }),
    });
    expect(inRes.status).toBe(400);
    expect(((await inRes.json()) as { message: string }).message).toContain(
      'mileage_not_monotonic',
    );
    // clean up the CHECKED_OUT state so next tests get a clean asset
    await adminDb.asset.update({ where: { id: otherAssetId }, data: { status: 'READY' } });
    await adminDb.reservation.update({
      where: { id },
      data: { lifecycleStatus: 'CANCELLED', cancelledAt: new Date() },
    });
  });

  it('unrelated driver cannot check in a reservation they did not check out', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const otherCookie = await loginCookie(otherDriver.email, otherDriver.password);

    const adminCookie = await loginCookie(admin.email, admin.password);
    const id = await createApproved({
      cookie: adminCookie,
      assetId: otherAssetId,
      startHours: 500,
      endHours: 502,
    });
    // The driver (requester) isn't the requester here — admin is. So this
    // exercises the "admin checks out, different driver tries to check in"
    // path even more strictly.
    await fetch(`${url}/reservations/${id}/checkout`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 60_000 }),
    });

    const nope = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 60_050 }),
    });
    expect(nope.status).toBe(403);

    const nope2 = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 60_050 }),
    });
    expect(nope2.status).toBe(403);

    // Admin (who checked out) can check it in.
    const ok = await fetch(`${url}/reservations/${id}/checkin`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 60_050 }),
    });
    expect(ok.status).toBe(200);
  });
});
