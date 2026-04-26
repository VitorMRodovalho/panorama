import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Reservation tether — ADR-0012 §8 + step 8 of execution order.
 *
 * The gate lives inline in `ReservationService.checkOut`; no
 * `InspectionService` import. Cases:
 *   * flag off → checkOut proceeds (ADR-0009 behaviour preserved)
 *   * flag on, no prior PASS → 409 inspection_required + audit
 *   * flag on + prior PASS within window → success + audit metadata
 *     records preCheckoutInspectionId
 *   * flag on + only OUT-OF-WINDOW PASS → 409
 *   * flag on + a PASS but for a DIFFERENT user → 409 (per-user gate)
 *   * flag flip-on with already-checked-out vehicle preserves it
 *     (gate runs only on BOOKED → CHECKED_OUT transition)
 *   * cross-tenant: a PASS in tenant B doesn't satisfy tenant A
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation inspection tether e2e', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  let assetA: string;
  let assetB: string;
  let templateA: string;
  let templateB: string;
  let driverAId: string;
  let bravoDriverId: string;

  const ownerEmail = 'owner.tether@example.com';
  const driverEmail = 'driver.tether@example.com';
  const driver2Email = 'driver2.tether@example.com';
  const bravoDriverEmail = 'driver.bravo.tether@example.com';
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);

    const a = await createTenantForTest(admin, {
      slug: 'alpha-tether',
      name: 'Alpha Tether',
      displayName: 'Alpha Tether',
    });
    const b = await createTenantForTest(admin, {
      slug: 'bravo-tether',
      name: 'Bravo Tether',
      displayName: 'Bravo Tether',
    });
    tenantA = a.id;
    tenantB = b.id;

    for (const [tenantId, label, store] of [
      [a.id, 'A', (id: string) => (assetA = id)],
      [b.id, 'B', (id: string) => (assetB = id)],
    ] as Array<[string, string, (id: string) => void]>) {
      const cat = await admin.category.create({
        data: { tenantId, name: 'Trucks', kind: 'VEHICLE' },
      });
      const model = await admin.assetModel.create({
        data: { tenantId, categoryId: cat.id, name: 'F-150' },
      });
      const asset = await admin.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `${label}-T-1`,
          name: `${label} truck`,
          bookable: true,
          status: 'READY',
        },
      });
      store(asset.id);
    }

    const ownerA = await admin.user.create({
      data: { email: ownerEmail, displayName: 'Olivia Owner' },
    });
    const driverA = await admin.user.create({
      data: { email: driverEmail, displayName: 'Drew Driver' },
    });
    const driver2A = await admin.user.create({
      data: { email: driver2Email, displayName: 'Don Driver' },
    });
    const bravoDriver = await admin.user.create({
      data: { email: bravoDriverEmail, displayName: 'Brad Bravo' },
    });
    driverAId = driverA.id;
    bravoDriverId = bravoDriver.id;

    await admin.tenantMembership.createMany({
      data: [
        { tenantId: a.id, userId: ownerA.id, role: 'owner' },
        { tenantId: a.id, userId: driverA.id, role: 'driver' },
        { tenantId: a.id, userId: driver2A.id, role: 'driver' },
        { tenantId: b.id, userId: bravoDriver.id, role: 'driver' },
      ],
    });

    // Seed templates so InspectionService.start can resolve.
    templateA = (
      await admin.inspectionTemplate.create({
        data: {
          tenantId: a.id,
          name: 'Pre-trip A',
          categoryKind: 'VEHICLE',
          createdByUserId: ownerA.id,
        },
      })
    ).id;
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: a.id,
        templateId: templateA,
        position: 0,
        label: 'Lights',
        itemType: 'BOOLEAN',
      },
    });
    templateB = (
      await admin.inspectionTemplate.create({
        data: {
          tenantId: b.id,
          name: 'Pre-trip B',
          categoryKind: 'VEHICLE',
          createdByUserId: bravoDriver.id,
        },
      })
    ).id;
    await admin.inspectionTemplateItem.create({
      data: {
        tenantId: b.id,
        templateId: templateB,
        position: 0,
        label: 'Lights',
        itemType: 'BOOLEAN',
      },
    });

    const passwords = new PasswordService();
    const secretHash = await passwords.hash(password);
    await admin.authIdentity.createMany({
      data: [
        { userId: ownerA.id, provider: 'password', subject: ownerEmail, emailAtLink: ownerEmail, secretHash },
        { userId: driverA.id, provider: 'password', subject: driverEmail, emailAtLink: driverEmail, secretHash },
        { userId: driver2A.id, provider: 'password', subject: driver2Email, emailAtLink: driver2Email, secretHash },
        { userId: bravoDriver.id, provider: 'password', subject: bravoDriverEmail, emailAtLink: bravoDriverEmail, secretHash },
      ],
    });

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

  // ----------------------------------------------------------------
  // Tether OFF: pre-existing checkout behaviour preserved
  // ----------------------------------------------------------------

  it('flag off: checkOut proceeds without an inspection (ADR-0009 behaviour)', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: false },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(200);
  });

  // ----------------------------------------------------------------
  // Tether ON: gate variants
  // ----------------------------------------------------------------

  it('flag on, no prior PASS: 409 inspection_required + audit row', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(409);
    const body = (await co.json()) as { message?: string };
    expect(body.message).toBe('inspection_required');

    const blocked = await admin.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.checkout_blocked',
        resourceId: reservation.id,
      },
      orderBy: { id: 'desc' },
    });
    expect(blocked).toBeTruthy();
    const md = (blocked!.metadata as Record<string, unknown> | null) ?? {};
    expect(md['reason']).toBe('inspection_required');
    expect(md['assetId']).toBe(asset);
  });

  it('flag on + recent PASS: checkOut succeeds + audit records preCheckoutInspectionId', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    // Driver completes a PASS inspection on this asset.
    const passInsp = await completePassInspection(url, driverCookie, asset);

    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(200);

    const audit = await admin.auditEvent.findFirst({
      where: { action: 'panorama.reservation.checked_out', resourceId: reservation.id },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
    const md = (audit!.metadata as Record<string, unknown> | null) ?? {};
    expect(md['preCheckoutInspectionId']).toBe(passInsp.id);
  });

  it('flag on + PASS for DIFFERENT user does NOT satisfy the gate', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });
    const driverCookie = await login(url, driverEmail, password);
    const driver2Cookie = await login(url, driver2Email, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    // driver2 completes a PASS — driver1 still has nothing.
    await completePassInspection(url, driver2Cookie, asset);

    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(409);
  });

  it('flag on + only OUT-OF-WINDOW PASS → 409', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    // Complete a PASS, then back-date completedAt past the 4 h window.
    const passInsp = await completePassInspection(url, driverCookie, asset);
    await admin.inspection.update({
      where: { id: passInsp.id },
      data: { completedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) },
    });

    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(409);
  });

  it('flip-on while a vehicle is already checked-out: existing checkout preserved', async () => {
    // Start with the flag OFF, drive a checkout to CHECKED_OUT.
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: false },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);

    const asset = await freshAsset(tenantA);
    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, asset, driverAId);
    const co1 = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co1.status).toBe(200);

    // Now flip the flag on.
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });

    // The existing CHECKED_OUT reservation is still CHECKED_OUT —
    // the gate runs only on the BOOKED → CHECKED_OUT path. checkIn
    // must continue to work without any inspection.
    const ci = await fetch(`${url}/reservations/${reservation.id}/checkin`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(ci.status).toBe(200);
  });

  it('cross-tenant: PASS in tenant B does NOT satisfy tenant A', async () => {
    await admin.tenant.update({
      where: { id: tenantA },
      data: { requireInspectionBeforeCheckout: true },
    });
    const driverCookie = await login(url, driverEmail, password);
    const ownerCookie = await login(url, ownerEmail, password);
    const bravoDriverCookie = await login(url, bravoDriverEmail, password);

    // Bravo's driver completes a PASS on a fresh Bravo asset. Sanity:
    // that PASS must not leak a row visible to Alpha's gate.
    const bAsset = await freshAsset(tenantB);
    await completePassInspection(url, bravoDriverCookie, bAsset);

    const aAsset = await freshAsset(tenantA);
    const reservation = await createApprovedReservation(url, ownerCookie, driverCookie, aAsset, driverAId);
    const co = await fetch(`${url}/reservations/${reservation.id}/checkout`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mileage: 1000 }),
    });
    expect(co.status).toBe(409);
  });

  // ----------------------------------------------------------------
  // Helpers — make this test independent of reservation-controller
  // shape evolution.
  // ----------------------------------------------------------------

  // Each call advances by ~2 hours so concurrent test cases don't
  // collide on the assetA exclusion-constraint window.
  let nextResHourOffset = 1;

  // Each test gets a fresh asset so a successful checkOut leaving
  // status=IN_USE doesn't bleed into the next case.
  let assetSeq = 0;
  async function freshAsset(tenantIdLocal: string): Promise<string> {
    assetSeq++;
    const asset = await admin.asset.create({
      data: {
        tenantId: tenantIdLocal,
        modelId: (
          await admin.assetModel.findFirstOrThrow({ where: { tenantId: tenantIdLocal } })
        ).id,
        tag: `T-FRESH-${assetSeq}`,
        name: `Fresh ${assetSeq}`,
        bookable: true,
        status: 'READY',
      },
    });
    return asset.id;
  }
  async function createApprovedReservation(
    baseUrl: string,
    ownerCookie: string,
    _driverCookie: string,
    assetId: string,
    onBehalfUserId?: string,
  ): Promise<{ id: string }> {
    const offset = nextResHourOffset;
    nextResHourOffset += 2;
    const startAt = new Date(Date.now() + offset * 60 * 60_000).toISOString();
    const endAt = new Date(Date.now() + (offset + 1) * 60 * 60_000).toISOString();
    // Owner creates ON BEHALF OF the driver so:
    //   - auto-approve fires (owner role)
    //   - the requester is the driver, so the driver can checkOut
    //     under the existing requester-or-admin guard
    const body: Record<string, unknown> = { assetId, startAt, endAt };
    if (onBehalfUserId) body['onBehalfUserId'] = onBehalfUserId;
    const createRes = await fetch(`${baseUrl}/reservations`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (createRes.status !== 201) {
      throw new Error(`create failed: ${createRes.status} ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as {
      id: string;
      approvalStatus: string;
    };
    if (created.approvalStatus === 'PENDING') {
      const ap = await fetch(`${baseUrl}/reservations/${created.id}/approve`, {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ mileage: 1000 }),
      });
      if (ap.status !== 200) {
        throw new Error(`approve failed: ${ap.status} ${await ap.text()}`);
      }
    }
    return { id: created.id };
  }

  async function completePassInspection(
    baseUrl: string,
    cookie: string,
    assetId: string,
  ): Promise<{ id: string }> {
    const start = (await (
      await fetch(`${baseUrl}/inspections`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ assetId }),
      })
    ).json()) as { id: string };
    const insp = (await (
      await fetch(`${baseUrl}/inspections/${start.id}`, { headers: { cookie } })
    ).json()) as { templateSnapshot: { items: Array<{ id: string }> } };
    const itemId = insp.templateSnapshot.items[0]!.id;
    const respond = await fetch(`${baseUrl}/inspections/${start.id}/responses`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        responses: [{ snapshotItemId: itemId, booleanValue: true }],
      }),
    });
    if (respond.status !== 200) {
      throw new Error(`respond failed: ${respond.status} ${await respond.text()}`);
    }
    const complete = await fetch(`${baseUrl}/inspections/${start.id}/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'PASS' }),
    });
    if (complete.status !== 200) {
      throw new Error(`complete failed: ${complete.status} ${await complete.text()}`);
    }
    return { id: start.id };
  }
});

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const cookie = extractCookie(res);
  if (!cookie) throw new Error('login returned no Set-Cookie header');
  return cookie;
}

function extractCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}
