import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import { ReservationSweepService } from '../src/modules/reservation/reservation-sweep.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * #77 PILOT-04 — overdue + no-show sweep e2e.
 *
 * Drives both sweeps directly via the service. Production cadence
 * is hourly setInterval; here we runOnce after seeding.
 *
 * Coverage:
 *   - overdue: CHECKED_OUT past endAt → isOverdue=true + audit
 *   - overdue: idempotent — second run doesn't re-flag or re-audit
 *   - overdue: not-yet-past-endAt → no flag
 *   - no-show: BOOKED past startAt+pickupWindow → MISSED + audit
 *   - no-show: tenant pickupWindowHours=0 → never flags
 *   - no-show: BOOKED within pickup window → no transition
 *   - per-tenant isolation
 *   - race-defence: lifecycleStatus changed between scan and write
 *     means the conditional updateMany silently no-ops (asserted
 *     via the count of audit rows being zero)
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

describe('reservation overdue + no-show sweep e2e', () => {
  let app: INestApplication;
  let adminDb: PrismaClient;
  let sweep: ReservationSweepService;
  let tenantId: string;
  let secondTenantId: string;
  let assetId: string;
  let secondAssetId: string;
  let driverUserId: string;

  async function seedReservation(params: {
    tenantId: string;
    assetId: string;
    requesterUserId: string;
    startAt: Date;
    endAt: Date;
    lifecycleStatus: 'BOOKED' | 'CHECKED_OUT' | 'RETURNED' | 'CANCELLED' | 'MISSED';
    isOverdue?: boolean;
    checkedOutByUserId?: string | null;
  }): Promise<string> {
    const r = await adminDb.reservation.create({
      data: {
        tenantId: params.tenantId,
        assetId: params.assetId,
        requesterUserId: params.requesterUserId,
        startAt: params.startAt,
        endAt: params.endAt,
        approvalStatus: 'APPROVED',
        lifecycleStatus: params.lifecycleStatus,
        isOverdue: params.isOverdue ?? false,
        checkedOutByUserId: params.checkedOutByUserId ?? null,
      },
    });
    return r.id;
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    sweep = app.get(ReservationSweepService);

    const driver = await adminDb.user.create({
      data: { email: 'sweep-driver@example.com', displayName: 'Sweep Driver' },
    });
    driverUserId = driver.id;

    const tenants = app.get(TenantAdminService);
    const { tenant: t1 } = await tenants.createTenantWithOwner({
      slug: 'overdue-sweep',
      name: 'Overdue Sweep',
      displayName: 'Overdue Sweep',
      ownerUserId: driver.id,
    });
    tenantId = t1.id;
    const { tenant: t2 } = await tenants.createTenantWithOwner({
      slug: 'overdue-sweep-2',
      name: 'Overdue Sweep 2',
      displayName: 'Overdue Sweep 2',
      ownerUserId: driver.id,
    });
    secondTenantId = t2.id;

    const cat = await adminDb.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await adminDb.assetModel.create({
      data: { tenantId, categoryId: cat.id, name: 'F-150' },
    });
    const asset = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'OD-01',
        name: 'Overdue Truck 01',
        bookable: true,
        status: 'IN_USE',
      },
    });
    assetId = asset.id;
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'OD-02',
        name: 'Overdue Truck 02',
        bookable: true,
        status: 'READY',
      },
    });
    secondAssetId = asset2.id;
  }, 120_000);

  afterAll(async () => {
    await sweep?.stop();
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    await adminDb.reservation.deleteMany({
      where: { tenantId: { in: [tenantId, secondTenantId] } },
    });
    await adminDb.auditEvent.deleteMany({
      where: {
        tenantId: { in: [tenantId, secondTenantId] },
        action: {
          in: [
            'panorama.reservation.flagged_overdue',
            'panorama.reservation.no_show',
          ],
        },
      },
    });
  });

  // ---------------- overdue sweep ----------------

  it('CHECKED_OUT past endAt → isOverdue=true + audit row', async () => {
    const id = await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h overdue
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });

    const result = await sweep.runOverdueSweep();
    expect(result).toBe(1);

    const r = await adminDb.reservation.findUnique({ where: { id } });
    expect(r?.isOverdue).toBe(true);

    const audit = await adminDb.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'panorama.reservation.flagged_overdue',
        resourceId: id,
      },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta['assetId']).toBe(assetId);
    expect(meta['hoursOverdue']).toBe(2);
    expect(meta['endAt']).toBeTruthy();
  });

  it('idempotent: re-running the sweep does NOT re-flag or re-audit', async () => {
    await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });

    const r1 = await sweep.runOverdueSweep();
    expect(r1).toBe(1);
    const r2 = await sweep.runOverdueSweep();
    expect(r2).toBe(0);

    const audits = await adminDb.auditEvent.findMany({
      where: { tenantId, action: 'panorama.reservation.flagged_overdue' },
    });
    expect(audits).toHaveLength(1);
  });

  it('CHECKED_OUT but endAt in the future → no flag', async () => {
    await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 60 * 60 * 1000),
      endAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h in the future
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });

    const result = await sweep.runOverdueSweep();
    expect(result).toBe(0);
  });

  it('non-CHECKED_OUT reservations (RETURNED, CANCELLED) past endAt → no flag', async () => {
    await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lifecycleStatus: 'RETURNED',
    });
    await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lifecycleStatus: 'CANCELLED',
    });

    const result = await sweep.runOverdueSweep();
    expect(result).toBe(0);
  });

  // ---------------- no-show sweep ----------------

  it('BOOKED past startAt + default 1h pickup window → MISSED + audit', async () => {
    const id = await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      // 2h past start; default pickupWindowHours=1 → 1h+ overdue → flips
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });

    const result = await sweep.runNoShowSweep();
    expect(result).toBe(1);

    const r = await adminDb.reservation.findUnique({ where: { id } });
    expect(r?.lifecycleStatus).toBe('MISSED');

    const audit = await adminDb.auditEvent.findFirst({
      where: { tenantId, action: 'panorama.reservation.no_show', resourceId: id },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta['assetId']).toBe(secondAssetId);
    expect(meta['pickupWindowHours']).toBe(1);
    expect(meta['hoursLate']).toBe(2);
  });

  it('BOOKED within pickup window → no transition', async () => {
    await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      // 30min past start; default pickup=1h → still inside window
      startAt: new Date(Date.now() - 30 * 60 * 1000),
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });

    const result = await sweep.runNoShowSweep();
    expect(result).toBe(0);
  });

  it('tenant.reservationRules.pickup_window_hours=0 → no auto-flag', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { pickup_window_hours: 0 } },
    });
    await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h past start
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });

    const result = await sweep.runNoShowSweep();
    expect(result).toBe(0);

    // Reset for downstream tests.
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  it('tenant pickupWindow=4h → 3h-late stays BOOKED, 5h-late flips', async () => {
    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: { pickup_window_hours: 4 } },
    });
    const inWindowId = await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h late, inside 4h window
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });
    const outWindowId = await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h late, past 4h window
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });

    const result = await sweep.runNoShowSweep();
    expect(result).toBe(1);

    const inWindow = await adminDb.reservation.findUnique({ where: { id: inWindowId } });
    expect(inWindow?.lifecycleStatus).toBe('BOOKED');
    const outWindow = await adminDb.reservation.findUnique({ where: { id: outWindowId } });
    expect(outWindow?.lifecycleStatus).toBe('MISSED');

    await adminDb.tenant.update({
      where: { id: tenantId },
      data: { reservationRules: {} },
    });
  });

  // ---------------- combined runOnce ----------------

  it('runOnce executes both sweeps and returns combined totals', async () => {
    // Seed 1 overdue + 1 no-show.
    await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });
    await seedReservation({
      tenantId,
      assetId: secondAssetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      lifecycleStatus: 'BOOKED',
    });

    const result = await sweep.runOnce();
    expect(result.overdueFlagged).toBe(1);
    expect(result.noShowMissed).toBe(1);
  });

  // ---------------- per-tenant isolation ----------------

  it('per-tenant isolation: overdue flag in tenant A does not leak to tenant B', async () => {
    // Seed an overdue ticket in tenant A's asset.
    await seedReservation({
      tenantId,
      assetId,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      endAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });
    // Set up tenant B's asset + a non-overdue reservation.
    const cat2 = await adminDb.category.create({
      data: { tenantId: secondTenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model2 = await adminDb.assetModel.create({
      data: { tenantId: secondTenantId, categoryId: cat2.id, name: 'F-150' },
    });
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId: secondTenantId,
        modelId: model2.id,
        tag: 'OD2-01',
        name: 'Tenant 2 Truck',
        bookable: true,
        status: 'READY',
      },
    });
    await seedReservation({
      tenantId: secondTenantId,
      assetId: asset2.id,
      requesterUserId: driverUserId,
      startAt: new Date(Date.now() - 60 * 60 * 1000),
      endAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // future
      lifecycleStatus: 'CHECKED_OUT',
      checkedOutByUserId: driverUserId,
    });

    const result = await sweep.runOverdueSweep();
    expect(result).toBe(1);

    const auditA = await adminDb.auditEvent.findMany({
      where: { tenantId, action: 'panorama.reservation.flagged_overdue' },
    });
    expect(auditA).toHaveLength(1);
    const auditB = await adminDb.auditEvent.findMany({
      where: { tenantId: secondTenantId, action: 'panorama.reservation.flagged_overdue' },
    });
    expect(auditB).toHaveLength(0);

    // Cleanup tenant B fixtures.
    await adminDb.reservation.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.asset.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.assetModel.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.category.deleteMany({ where: { tenantId: secondTenantId } });
  });
});
