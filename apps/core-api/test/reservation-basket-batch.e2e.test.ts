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
 * Basket batch approve / reject / cancel e2e
 * (ADR-0009 §"Basket batch decisions").
 *
 * Covers:
 *   - happy path approve: basket of 3 PENDING → all APPROVED; per-row
 *     audit events + 1 envelope event carry the processed vector
 *   - happy path reject: mirror shape for panorama.reservation.basket_rejected
 *   - cancel with 1 CHECKED_OUT row: 2 cancelled, 1 skipped
 *     (cannot_cancel_checked_out)
 *   - approve with sibling-overlap conflict: the conflicting row is
 *     skipped with reason reservation_conflict while the other row
 *     is approved normally — best-effort in action
 *   - approveBasket as driver → 403 admin_role_required
 *   - cancelBasket by a non-owner driver → 403 not_allowed_to_cancel
 *   - approveBasket on an unknown basketId → 404 basket_not_found
 *   - feature flag enable_basket_batch=false → 403 basket_batch_disabled
 *   - approveBasket on a basket where every row is already AUTO_APPROVED
 *     → processed 0, skipped N (not_pending:auto_approved)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation basket batch e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  let assetIds: string[] = [];
  let driverUserId: string;
  let otherDriverUserId: string;

  const admin = {
    email: 'admin@basket-batch.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Basket Batch Admin',
  };
  const driver = {
    email: 'driver@basket-batch.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Basket Batch Driver',
  };
  const otherDriver = {
    email: 'other-driver@basket-batch.example',
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

  async function createBasketAs(
    cookie: string,
    ids: string[],
    startHours: number,
    endHours: number,
  ): Promise<{ basketId: string; items: Array<{ id: string; assetId: string }> }> {
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: ids,
        startAt: isoAt(startHours),
        endAt: isoAt(endHours),
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      basketId: string;
      items: Array<{ id: string; assetId: string }>;
    };
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
    driverUserId = driverUser.id;
    otherDriverUserId = otherUser.id;
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
      slug: 'basket-batch',
      name: 'Basket Batch',
      displayName: 'Basket Batch',
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
    assetIds = [];
    for (let i = 1; i <= 6; i++) {
      const asset = await adminDb.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `BB-${String(i).padStart(2, '0')}`,
          name: `Batch Truck ${i}`,
          bookable: true,
          status: 'READY',
        },
      });
      assetIds.push(asset.id);
    }
    // reference these in at least one test closure so TS strict-unused
    // flags don't bite on the user ids.
    expect(driverUserId).toBeTruthy();
    expect(otherDriverUserId).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // ---- happy paths ---------------------------------------------------

  it('admin approveBasket on a 3-row driver-pending basket → all APPROVED', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(
      driverCookie,
      [assetIds[0]!, assetIds[1]!, assetIds[2]!],
      24,
      26,
    );

    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'ok for the site visit' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      basketId: string;
      processed: Array<{ reservationId: string; outcome: string }>;
      skipped: Array<{ reservationId: string; reason: string }>;
    };
    expect(body.basketId).toBe(basket.basketId);
    expect(body.processed).toHaveLength(3);
    for (const p of body.processed) expect(p.outcome).toBe('approved');
    expect(body.skipped).toHaveLength(0);

    // DB ground truth.
    const rows = await adminDb.reservation.findMany({
      where: { basketId: basket.basketId },
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.approvalStatus).toBe('APPROVED');

    // Envelope audit.
    const envelope = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.basket_approved',
        resourceId: basket.basketId,
      },
      orderBy: { id: 'desc' },
    });
    expect(envelope).toBeTruthy();
    const meta = (envelope?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['processedCount']).toBe(3);
    expect(meta['skippedCount']).toBe(0);
    expect(Array.isArray(meta['processedReservationIds'])).toBe(true);
    expect(
      (meta['processedReservationIds'] as string[]).sort(),
    ).toEqual(basket.items.map((i) => i.id).sort());

    // Per-row audit symmetry with single-row approve.
    const perRow = await adminDb.auditEvent.findMany({
      where: {
        action: 'panorama.reservation.approved',
        resourceId: { in: basket.items.map((i) => i.id) },
      },
    });
    expect(perRow).toHaveLength(3);
  });

  it('admin rejectBasket → per-row REJECTED + envelope basket_rejected', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(
      driverCookie,
      [assetIds[3]!, assetIds[4]!],
      48,
      50,
    );

    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/reject`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'out of fleet budget window' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: unknown[]; skipped: unknown[] };
    expect(body.processed).toHaveLength(2);
    expect(body.skipped).toHaveLength(0);

    const envelope = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.basket_rejected',
        resourceId: basket.basketId,
      },
    });
    expect(envelope).toBeTruthy();
  });

  // OPS-01 (#33): rejectBasket also requires a non-empty note. The
  // single-reservation rule applies to multi-asset baskets too.
  it('rejectBasket without note → 400 note_required', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(
      driverCookie,
      [assetIds[3]!, assetIds[4]!],
      96,
      98,
    );

    const adminCookie = await loginCookie(admin.email, admin.password);

    const noBody = await fetch(`${url}/reservations/basket/${basket.basketId}/reject`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noBody.status).toBe(400);
    expect(((await noBody.json()) as { message?: string }).message).toContain('note_required');

    const blankNote = await fetch(`${url}/reservations/basket/${basket.basketId}/reject`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: '   ' }),
    });
    expect(blankNote.status).toBe(400);
  });

  // ---- mixed outcomes ------------------------------------------------

  it('cancelBasket with 1 CHECKED_OUT row → 2 cancelled, 1 skipped', async () => {
    // Admin creates an AUTO_APPROVED basket of 3 so we can check one out.
    const adminCookie = await loginCookie(admin.email, admin.password);
    const basket = await createBasketAs(
      adminCookie,
      [assetIds[0]!, assetIds[1]!, assetIds[2]!],
      200,
      202,
    );

    // Check out the first row.
    const checkout = await fetch(
      `${url}/reservations/${basket.items[0]!.id}/checkout`,
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ mileage: 1000 }),
      },
    );
    expect(checkout.status).toBe(200);

    const cancel = await fetch(`${url}/reservations/basket/${basket.basketId}/cancel`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'plans changed' }),
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as {
      processed: Array<{ reservationId: string; outcome: string }>;
      skipped: Array<{ reservationId: string; reason: string }>;
    };
    expect(body.processed).toHaveLength(2);
    for (const p of body.processed) expect(p.outcome).toBe('cancelled');
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.reservationId).toBe(basket.items[0]!.id);
    expect(body.skipped[0]!.reason).toBe('cannot_cancel_checked_out');

    // DB ground truth.
    const checkedOut = await adminDb.reservation.findUnique({
      where: { id: basket.items[0]!.id },
    });
    expect(checkedOut?.lifecycleStatus).toBe('CHECKED_OUT');
    const cancelled = await adminDb.reservation.findMany({
      where: {
        id: { in: [basket.items[1]!.id, basket.items[2]!.id] },
      },
    });
    for (const r of cancelled) expect(r.lifecycleStatus).toBe('CANCELLED');
  });

  it('approveBasket skips a row that picked up a blackout at approval time, approves the rest', async () => {
    // The 0.3 migration 0010 exclusion constraint now makes concurrent
    // overlapping PENDING rows on the same asset impossible at the DB
    // layer — the "sibling conflict" race this test originally
    // simulated via raw SQL can't happen any more. The analogous
    // re-check path still matters for BLACKOUTS, which are a separate
    // table not covered by the reservation exclusion index: an admin
    // can carve out a maintenance window between basket creation and
    // batch approval, and the per-row assertNoBlackout inside
    // decideWithin must still catch it.
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(
      driverCookie,
      [assetIds[3]!, assetIds[4]!],
      300,
      302,
    );

    // Admin drops an asset-scoped blackout spanning 300-302 on
    // assetIds[3]. Row 0 should get skipped as blackout_conflict;
    // row 1 approves cleanly.
    const adminCookie = await loginCookie(admin.email, admin.password);
    const blackout = await fetch(`${url}/blackouts`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: assetIds[3]!,
        title: 'Brake inspection (mid-basket)',
        startAt: isoAt(299),
        endAt: isoAt(303),
      }),
    });
    expect(blackout.status).toBe(201);

    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: Array<{ reservationId: string; outcome: string }>;
      skipped: Array<{ reservationId: string; reason: string }>;
    };
    expect(body.processed).toHaveLength(1);
    expect(body.processed[0]!.reservationId).toBe(basket.items[1]!.id);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.reservationId).toBe(basket.items[0]!.id);
    expect(body.skipped[0]!.reason).toContain('blackout_conflict');
  });

  // ---- authorization -------------------------------------------------

  it('approveBasket as driver → 403 admin_role_required', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(driverCookie, [assetIds[5]!], 400, 402);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('admin_role_required');
  });

  it('cancelBasket by a non-owner driver → 403 not_allowed_to_cancel', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(driverCookie, [assetIds[5]!], 500, 502);
    const otherCookie = await loginCookie(otherDriver.email, otherDriver.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/cancel`, {
      method: 'POST',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('not_allowed_to_cancel');
  });

  it('cancelBasket by the owning driver → cancels their own basket', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const basket = await createBasketAs(driverCookie, [assetIds[5]!], 600, 602);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/cancel`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'plans shifted' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: unknown[]; skipped: unknown[] };
    expect(body.processed).toHaveLength(1);
  });

  // ---- error paths ---------------------------------------------------

  it('approveBasket on an unknown basketId → 404 basket_not_found', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${url}/reservations/basket/${fakeId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('basket_not_found');
  });

  it('approveBasket on an already AUTO_APPROVED basket → processed 0, skipped N', async () => {
    const adminCookie = await loginCookie(admin.email, admin.password);
    // Admin creates the basket, so rows land AUTO_APPROVED.
    const basket = await createBasketAs(
      adminCookie,
      [assetIds[3]!, assetIds[4]!],
      700,
      702,
    );
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: unknown[];
      skipped: Array<{ reason: string }>;
    };
    expect(body.processed).toHaveLength(0);
    expect(body.skipped).toHaveLength(2);
    for (const s of body.skipped) {
      expect(s.reason).toBe('not_pending:auto_approved');
    }
  });

  it('feature flag enable_basket_batch=false → 403 basket_batch_disabled', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { enable_basket_batch: false } },
    });
    try {
      const adminCookie = await loginCookie(admin.email, admin.password);
      const basket = await createBasketAs(adminCookie, [assetIds[5]!], 800, 802);
      const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain('basket_batch_disabled');
    } finally {
      await adminDb.tenant.update({
        where: { id: tenantId },
        data: { reservationRules: {} },
      });
    }
  });
});
