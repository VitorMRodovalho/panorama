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
 * Basket reservation e2e (ADR-0009 option B).
 *
 * Covers:
 *   - happy path: POST /reservations/basket with 3 assetIds → 201,
 *     3 reservations share the same basketId.
 *   - conflict in ANY asset rolls back the whole basket (no partial).
 *   - basket with unknown asset → 404.
 *   - duplicate assetIds → 400 (zod).
 *   - per-reservation cancel leaves siblings untouched.
 *   - concurrency cap counts basket size: driver with cap=2 submitting
 *     a 3-asset basket → 409.
 *   - auto-approve decision is consistent: driver's basket all
 *     PENDING_APPROVAL, admin's basket all AUTO_APPROVED.
 *   - audit event panorama.reservation.basket_created carries
 *     reservationIds + size.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation basket e2e', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  const assetIds: string[] = [];

  const admin = {
    email: 'admin@basket-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Basket Admin',
  };
  const driver = {
    email: 'driver@basket-test.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Driver',
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
    for (const [u, pw] of [
      [adminUser, admin.password],
      [driverUser, driver.password],
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
      slug: 'basket-test',
      name: 'Basket Test',
      displayName: 'Basket Test',
      ownerUserId: adminUser.id,
    });
    tenantId = tenant.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driverUser.id, role: 'driver', status: 'active' },
    });

    const category = await adminDb.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await adminDb.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'F-150 2024' },
    });
    for (let i = 1; i <= 4; i++) {
      const asset = await adminDb.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `BK-${String(i).padStart(2, '0')}`,
          name: `Basket Truck ${i}`,
          bookable: true,
          status: 'READY',
        },
      });
      assetIds.push(asset.id);
    }
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  // -------------------------------------------------------------------

  it('admin creates a basket of 3 assets → 201, shared basketId, all AUTO_APPROVED', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], assetIds[1], assetIds[2]],
        startAt: isoAt(24),
        endAt: isoAt(26),
        purpose: 'site visit',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      basketId: string;
      items: Array<{ id: string; assetId: string; basketId: string; approvalStatus: string }>;
    };
    expect(body.basketId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.items).toHaveLength(3);
    const basketIds = new Set(body.items.map((r) => r.basketId));
    expect(basketIds.size).toBe(1);
    expect(basketIds.values().next().value).toBe(body.basketId);
    for (const r of body.items) {
      expect(r.approvalStatus).toBe('AUTO_APPROVED');
    }

    // Audit row
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.reservation.basket_created', tenantId },
      orderBy: { id: 'desc' },
    });
    expect(audit).toBeTruthy();
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['size']).toBe(3);
    expect(Array.isArray(meta['reservationIds'])).toBe(true);
  });

  it('driver creates a basket → all PENDING_APPROVAL', async () => {
    const cookie = await loginCookie(driver.email, driver.password);
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], assetIds[1]],
        startAt: isoAt(72),
        endAt: isoAt(74),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      items: Array<{ approvalStatus: string }>;
    };
    for (const r of body.items) expect(r.approvalStatus).toBe('PENDING_APPROVAL');
  });

  it('conflict in ANY asset rolls back the whole basket', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    // Pre-book asset[3] so the next basket that includes it conflicts.
    const preBook = await fetch(`${url}/reservations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: assetIds[3],
        startAt: isoAt(100),
        endAt: isoAt(102),
      }),
    });
    expect(preBook.status).toBe(201);

    const basket = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], assetIds[3]], // 3 conflicts
        startAt: isoAt(101),
        endAt: isoAt(103),
      }),
    });
    expect(basket.status).toBe(409);

    // Ensure no partial rows landed: count reservations matching the
    // basket's window on asset[0] — should still be 0.
    const rowsOnAsset0 = await adminDb.reservation.count({
      where: {
        tenantId,
        assetId: assetIds[0]!,
        startAt: new Date(isoAt(101)),
      },
    });
    expect(rowsOnAsset0).toBe(0);
  });

  it('unknown asset in basket → 404', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], '00000000-0000-0000-0000-000000000000'],
        startAt: isoAt(200),
        endAt: isoAt(202),
      }),
    });
    expect(res.status).toBe(404);
  });

  it('duplicate assetIds rejected at the DTO layer', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], assetIds[0]],
        startAt: isoAt(300),
        endAt: isoAt(302),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('per-reservation cancel leaves sibling basket items untouched', async () => {
    const cookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0], assetIds[1]],
        startAt: isoAt(400),
        endAt: isoAt(402),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      basketId: string;
      items: Array<{ id: string }>;
    };

    const cancel = await fetch(`${url}/reservations/${body.items[0]!.id}/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancel.status).toBe(200);

    const stillBooked = await adminDb.reservation.findUnique({
      where: { id: body.items[1]!.id },
    });
    expect(stillBooked?.lifecycleStatus).toBe('BOOKED');
    expect(stillBooked?.basketId).toBe(body.basketId);
  });

  it('concurrency cap counts basket size against max_concurrent_per_user', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { max_concurrent_per_user: 2 } },
    });
    try {
      const cookie = await loginCookie(driver.email, driver.password);
      const res = await fetch(`${url}/reservations/basket`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          assetIds: [assetIds[0], assetIds[1], assetIds[2]],
          startAt: isoAt(500),
          endAt: isoAt(502),
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain('max_concurrent_reservations');
    } finally {
      await adminDb.tenant.update({
        where: { id: tenantId },
        data: { reservationRules: {} },
      });
    }
  });

  it('concurrent baskets targeting the same asset + overlapping window → exactly one survives', async () => {
    // Exercise the Serializable + retry path on createBasket. If the
    // reservation writes run at ReadCommitted (the ADR promise that
    // the 2026-04-18 agent review caught as unkept), both baskets
    // would pass the assertNoOverlap check then both insert rows
    // for the shared asset. With Serializable, Postgres aborts one
    // with SQLSTATE 40001 → we retry → on the retry the second
    // attempt sees the committed row and throws 409.
    const cookie = await loginCookie(admin.email, admin.password);
    const sharedAsset = assetIds[0]!;
    const disjointAsset = assetIds[1]!;
    const start = isoAt(600);
    const end = isoAt(602);

    const submit = (extraAsset: string) =>
      fetch(`${url}/reservations/basket`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          assetIds: [sharedAsset, extraAsset],
          startAt: start,
          endAt: end,
        }),
      });

    const [a, b] = await Promise.all([submit(disjointAsset), submit(assetIds[2]!)]);
    const statuses = [a.status, b.status].sort();
    // Acceptable outcomes under Serializable:
    //   [201, 409]  — one basket won, the other hit the conflict on retry
    //   [201, 500]  — retry exhausted and Postgres kept aborting; rare
    // Unacceptable (would mean the fix didn't land):
    //   [201, 201]  — both baskets landed rows against sharedAsset
    expect(statuses[0]).toBe(201);
    expect([409, 500]).toContain(statuses[1]);

    // Ground truth: exactly one row on sharedAsset in the window.
    const rowsOnShared = await adminDb.reservation.count({
      where: {
        tenantId,
        assetId: sharedAsset,
        startAt: new Date(start),
      },
    });
    expect(rowsOnShared).toBe(1);
  });
});
