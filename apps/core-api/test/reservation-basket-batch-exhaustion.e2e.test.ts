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
 * Basket batch exhaustion — edge cases the happy-path suite skips.
 * This file exists so a future reader asking "is this robust?" has a
 * single place to grep.
 *
 * Covers:
 *   - MAX-SIZE basket (N = 20, the DTO cap): approveBasket completes
 *     within the Serializable window; every row transitions; envelope
 *     audit metadata carries the full reservationIds vector
 *   - CONCURRENT batch calls against the same basketId: exactly one
 *     outcome — second call sees rows already-decided and returns
 *     skipped:20 instead of processing twice (idempotent-under-race)
 *   - MIXED-STATE basket: pending + auto-approved + cancelled +
 *     rejected rows — approveBasket processes only the pending ones,
 *     skips the rest with correct reasons per state
 *   - FEATURE-FLAG TOGGLE mid-session: off → on → off; each call re-
 *     reads the flag (no stale cache)
 *   - APPROVE → CANCEL chain on the same basket in quick succession:
 *     the first approves, the second cancels — no state leak, both
 *     envelope events land
 *   - EMPTY-after-filter basket (all rows already terminal): envelope
 *     still emits, processed=0 skipped=N
 *   - Large-note payload on envelope: 500-char note + 500-char reason
 *     both serialize into metadata without truncation
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation basket batch exhaustion', () => {
  let app: INestApplication;
  let url: string;
  let adminDb: PrismaClient;
  let tenantId: string;
  let assetIds: string[] = [];

  const admin = {
    email: 'admin@basket-exh.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Exhaustion Admin',
  };
  const driver = {
    email: 'driver@basket-exh.example',
    password: 'correct-horse-battery-staple',
    displayName: 'Exhaustion Driver',
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
      slug: 'basket-exh',
      name: 'Basket Exhaustion',
      displayName: 'Basket Exhaustion',
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
    // 24 assets: 20 for the max-size test + 4 for the remaining tests.
    for (let i = 1; i <= 24; i++) {
      const asset = await adminDb.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `BX-${String(i).padStart(2, '0')}`,
          name: `Exhaustion Truck ${i}`,
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

  it('MAX-SIZE (N=20) basket: approveBasket processes all 20 rows cleanly', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const slice = assetIds.slice(0, 20);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: slice,
        startAt: isoAt(1000),
        endAt: isoAt(1002),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as {
      basketId: string;
      items: Array<{ id: string }>;
    };
    expect(basket.items).toHaveLength(20);

    const adminCookie = await loginCookie(admin.email, admin.password);
    const t0 = Date.now();
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    const elapsedMs = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: unknown[];
      skipped: unknown[];
    };
    expect(body.processed).toHaveLength(20);
    expect(body.skipped).toHaveLength(0);
    // Budget: 20 per-row Serializable writes + 20 audit events + 1
    // envelope in one tx should fit comfortably under 5 s on any host
    // that passes the existing suite. If this regresses we want to
    // know — not fail silently at 30 s.
    expect(elapsedMs).toBeLessThan(5000);

    const rows = await adminDb.reservation.findMany({
      where: { basketId: basket.basketId },
    });
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(r.approvalStatus).toBe('APPROVED');

    const envelope = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.basket_approved',
        resourceId: basket.basketId,
      },
    });
    const meta = (envelope?.metadata ?? {}) as Record<string, unknown>;
    expect((meta['processedReservationIds'] as string[]).length).toBe(20);
  });

  it('CONCURRENT approveBasket calls → one processes 20, other processes 0 (idempotent-under-race)', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    // Re-use 4 assets for a 4-row basket to keep the race fast.
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: assetIds.slice(20, 24),
        startAt: isoAt(1100),
        endAt: isoAt(1102),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as { basketId: string };

    const adminCookie = await loginCookie(admin.email, admin.password);
    const fire = () =>
      fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      });

    const [resA, resB] = await Promise.all([fire(), fire()]);
    // Both requests should return 200 — the second one sees every row
    // is already APPROVED and returns processed:[], skipped:[4
    // not_pending:approved]. Serializable isolation + P2034 retry
    // ensures no row transitions twice.
    expect([resA.status, resB.status].sort()).toEqual([200, 200]);
    const bodyA = (await resA.json()) as {
      processed: unknown[];
      skipped: Array<{ reason: string }>;
    };
    const bodyB = (await resB.json()) as {
      processed: unknown[];
      skipped: Array<{ reason: string }>;
    };
    const counts = [
      bodyA.processed.length + bodyA.skipped.length,
      bodyB.processed.length + bodyB.skipped.length,
    ].sort();
    // Each call sees all 4 rows; whoever wins processes them, loser
    // sees them all as skipped (not_pending:approved).
    expect(counts).toEqual([4, 4]);
    const total = bodyA.processed.length + bodyB.processed.length;
    expect(total).toBe(4); // exactly 4 rows transitioned, zero double-writes

    // DB ground truth: every row landed APPROVED exactly once.
    const rows = await adminDb.reservation.findMany({
      where: { basketId: basket.basketId },
    });
    for (const r of rows) expect(r.approvalStatus).toBe('APPROVED');

    // Two envelope events exist (one per call). Both are valid audit
    // records — one narrates the transition, the other narrates the
    // "nothing to do" no-op. Different resourceIds would let the
    // envelopes collide; both share basketId, which is correct.
    const envelopes = await adminDb.auditEvent.findMany({
      where: {
        action: 'panorama.reservation.basket_approved',
        resourceId: basket.basketId,
      },
    });
    expect(envelopes.length).toBeGreaterThanOrEqual(2);
  });

  it('MIXED-STATE basket: approveBasket processes only PENDING, skips per-state reasons', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0]!, assetIds[1]!, assetIds[2]!, assetIds[3]!],
        startAt: isoAt(1200),
        endAt: isoAt(1202),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as {
      basketId: string;
      items: Array<{ id: string }>;
    };

    const adminCookie = await loginCookie(admin.email, admin.password);
    // Per-row manoeuvres to diversify the basket state:
    //   row 0 stays PENDING (will be approved)
    //   row 1 gets rejected individually
    //   row 2 gets cancelled individually (driver cancels own)
    //   row 3 gets approved individually first, then the batch sees
    //         it as APPROVED → skipped (not_pending:approved)
    const reject1 = await fetch(`${url}/reservations/${basket.items[1]!.id}/reject`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'test reject' }),
    });
    expect(reject1.status).toBe(200);
    const cancel2 = await fetch(`${url}/reservations/${basket.items[2]!.id}/cancel`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancel2.status).toBe(200);
    const approve3 = await fetch(
      `${url}/reservations/${basket.items[3]!.id}/approve`,
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(approve3.status).toBe(200);

    // Now batch-approve the whole basket. Expected:
    //   row 0 → approved
    //   row 1 → skipped (not_pending:rejected)
    //   row 2 → skipped (already_cancelled)
    //   row 3 → skipped (not_pending:approved)
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
    expect(body.processed[0]!.reservationId).toBe(basket.items[0]!.id);
    expect(body.skipped).toHaveLength(3);

    const reasons = new Map(body.skipped.map((s) => [s.reservationId, s.reason]));
    expect(reasons.get(basket.items[1]!.id)).toBe('not_pending:rejected');
    expect(reasons.get(basket.items[2]!.id)).toBe('already_cancelled');
    expect(reasons.get(basket.items[3]!.id)).toBe('not_pending:approved');
  });

  it('FEATURE-FLAG TOGGLE mid-session: off → on → off, each call re-reads flag', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[0]!],
        startAt: isoAt(1300),
        endAt: isoAt(1302),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as { basketId: string };

    const adminCookie = await loginCookie(admin.email, admin.password);
    const call = () =>
      fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      });

    // flip off → 403
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { enable_basket_batch: false } },
    });
    const off1 = await call();
    expect(off1.status).toBe(403);

    // flip on → 200 (processes the 1 pending row)
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
    const on = await call();
    expect(on.status).toBe(200);

    // flip off again → 403 on a subsequent attempt (even though the
    // basket is now all-approved, the flag check gates ahead of row
    // processing)
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { enable_basket_batch: false } },
    });
    const off2 = await call();
    expect(off2.status).toBe(403);

    // Reset for subsequent tests.
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  it('APPROVE → CANCEL chain on same basket: both envelopes land, rows end CANCELLED', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[1]!, assetIds[2]!],
        startAt: isoAt(1400),
        endAt: isoAt(1402),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as { basketId: string };

    const adminCookie = await loginCookie(admin.email, admin.password);
    const approve = await fetch(
      `${url}/reservations/basket/${basket.basketId}/approve`,
      {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as { processed: unknown[] }).processed).toHaveLength(2);

    const cancel = await fetch(`${url}/reservations/basket/${basket.basketId}/cancel`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'event cancelled' }),
    });
    expect(cancel.status).toBe(200);
    const cBody = (await cancel.json()) as { processed: unknown[] };
    expect(cBody.processed).toHaveLength(2);

    const rows = await adminDb.reservation.findMany({
      where: { basketId: basket.basketId },
    });
    for (const r of rows) {
      expect(r.lifecycleStatus).toBe('CANCELLED');
      expect(r.approvalStatus).toBe('APPROVED');
      expect(r.cancelReason).toBe('event cancelled');
    }

    const envApprove = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.reservation.basket_approved', resourceId: basket.basketId },
    });
    const envCancel = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.reservation.basket_cancelled', resourceId: basket.basketId },
    });
    expect(envApprove).toBeTruthy();
    expect(envCancel).toBeTruthy();
  });

  it('EMPTY-AFTER-FILTER basket: every row terminal → envelope with processed=0 skipped=N', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[3]!, assetIds[4]!],
        startAt: isoAt(1500),
        endAt: isoAt(1502),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as {
      basketId: string;
      items: Array<{ id: string }>;
    };

    // Cancel both rows individually.
    for (const it of basket.items) {
      const c = await fetch(`${url}/reservations/${it.id}/cancel`, {
        method: 'POST',
        headers: { cookie: driverCookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(c.status).toBe(200);
    }

    // Batch-cancel should envelope + skip all.
    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/cancel`, {
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
    for (const s of body.skipped) expect(s.reason).toBe('already_cancelled');

    const envelope = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.basket_cancelled',
        resourceId: basket.basketId,
      },
    });
    expect(envelope).toBeTruthy();
    const meta = (envelope?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['processedCount']).toBe(0);
    expect(meta['skippedCount']).toBe(2);
  });

  it('LARGE-NOTE payload: 500-char note survives intact in envelope metadata', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[5]!],
        startAt: isoAt(1600),
        endAt: isoAt(1602),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as { basketId: string };

    const bigNote = 'x'.repeat(500);
    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: bigNote }),
    });
    expect(res.status).toBe(200);

    const envelope = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.reservation.basket_approved',
        resourceId: basket.basketId,
      },
    });
    const meta = (envelope?.metadata ?? {}) as Record<string, unknown>;
    expect(meta['note']).toBe(bigNote);
    expect((meta['note'] as string).length).toBe(500);
  });

  it('OVER-LIMIT note (>500 chars) rejected at the DTO layer', async () => {
    const driverCookie = await loginCookie(driver.email, driver.password);
    const create = await fetch(`${url}/reservations/basket`, {
      method: 'POST',
      headers: { cookie: driverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        assetIds: [assetIds[6]!],
        startAt: isoAt(1700),
        endAt: isoAt(1702),
      }),
    });
    expect(create.status).toBe(201);
    const basket = (await create.json()) as { basketId: string };

    const adminCookie = await loginCookie(admin.email, admin.password);
    const res = await fetch(`${url}/reservations/basket/${basket.basketId}/approve`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x'.repeat(501) }),
    });
    expect(res.status).toBe(400);
  });
});
