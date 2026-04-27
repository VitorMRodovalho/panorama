import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { AppModule } from '../src/app.module.js';
import { TenantAdminService } from '../src/modules/tenant/tenant-admin.service.js';
import {
  MaintenanceSweepService,
  computeTriggers,
} from '../src/modules/maintenance/maintenance-sweep.service.js';
import { resetTestDb } from './_reset-db.js';

/**
 * MaintenanceSweepService PM-due cron e2e (ADR-0016 §9 + #74 PILOT-03).
 *
 * Drives the sweep directly via the service. Production cadence is
 * daily (BullMQ repeatable); here we runOnce after seeding fixtures.
 * The sweep is gated `NODE_ENV != 'test' AND FEATURE_MAINTENANCE`
 * at module-init for production; the test imports the service
 * directly and calls `runPmDueSweep()` to bypass that gate.
 *
 * Hard requires: Postgres + Redis (the dev stack).
 *
 * Coverage:
 *   - mileage trigger: completed ticket with nextServiceMileage=N,
 *     asset lastReadMileage = N-499 → audit fires; lastReadMileage
 *     = N-501 → no audit
 *   - date trigger: nextServiceDate within 14d → audit fires; +20d
 *     → no audit
 *   - both triggers fire on the same ticket → triggeredBy='both'
 *   - non-COMPLETED tickets ignored
 *   - multiple due tickets on same asset → one audit row, all
 *     ticket IDs in metadata
 *   - 24h dedup: second runOnce within window → no second audit
 *   - cross-tenant isolation: per-tenant query stays scoped
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0';

describe('maintenance PM-due sweep e2e', () => {
  let app: INestApplication;
  let adminDb: PrismaClient;
  let redis: Redis;
  let sweep: MaintenanceSweepService;
  let tenantId: string;
  let secondTenantId: string;
  let assetId: string;
  let secondAssetId: string;
  let ownerUserId: string;

  async function clearAllSweepDedups(): Promise<void> {
    // Brute-force clear: delete all keys matching the sweep's prefix.
    // Safe in test DB (key 0); real prod would use SCAN, but this
    // suite is the only thing in this Redis at test time.
    const keys = await redis.keys('pm_due:*');
    if (keys.length > 0) await redis.del(...keys);
  }

  async function seedCompletedTicket(params: {
    tenantId: string;
    assetId: string;
    completedAt?: Date;
    nextServiceMileage?: number;
    nextServiceDate?: Date | null;
  }): Promise<string> {
    const t = await adminDb.assetMaintenance.create({
      data: {
        tenantId: params.tenantId,
        assetId: params.assetId,
        maintenanceType: 'Maintenance',
        title: 'Oil change',
        status: 'COMPLETED',
        completedAt: params.completedAt ?? new Date(),
        completedByUserId: ownerUserId,
        nextServiceMileage: params.nextServiceMileage ?? null,
        nextServiceDate: params.nextServiceDate ?? null,
        createdByUserId: ownerUserId,
      },
    });
    return t.id;
  }

  async function setAssetMileage(id: string, mileage: number): Promise<void> {
    await adminDb.asset.update({
      where: { id },
      data: { lastReadMileage: mileage },
    });
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;
    process.env.REDIS_URL = REDIS_URL;

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    redis = new Redis(REDIS_URL, {
      lazyConnect: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });
    await clearAllSweepDedups();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    sweep = app.get(MaintenanceSweepService);

    const tenants = app.get(TenantAdminService);
    const ownerUser = await adminDb.user.create({
      data: { email: 'pm-due-owner@example.com', displayName: 'PM Owner' },
    });
    ownerUserId = ownerUser.id;
    const { tenant } = await tenants.createTenantWithOwner({
      slug: 'pm-due',
      name: 'PM Due',
      displayName: 'PM Due',
      ownerUserId: ownerUser.id,
    });
    tenantId = tenant.id;

    const second = await tenants.createTenantWithOwner({
      slug: 'pm-due-second',
      name: 'PM Due Second',
      displayName: 'PM Due Second',
      ownerUserId: ownerUser.id,
    });
    secondTenantId = second.tenant.id;

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
        tag: 'PM-01',
        name: 'PM Truck 01',
        bookable: true,
        status: 'READY',
      },
    });
    assetId = asset.id;
    const asset2 = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'PM-02',
        name: 'PM Truck 02',
        bookable: true,
        status: 'READY',
      },
    });
    secondAssetId = asset2.id;
  }, 120_000);

  afterAll(async () => {
    await clearAllSweepDedups();
    await redis?.quit();
    await sweep?.stop();
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    await clearAllSweepDedups();
    await adminDb.assetMaintenance.deleteMany({
      where: { tenantId: { in: [tenantId, secondTenantId] } },
    });
    await adminDb.auditEvent.deleteMany({
      where: {
        tenantId: { in: [tenantId, secondTenantId] },
        action: 'panorama.maintenance.next_service_due',
      },
    });
    await setAssetMileage(assetId, 0);
    await setAssetMileage(secondAssetId, 0);
  });

  // ---------------------------------------------------------------

  it('mileage trigger: lastReadMileage within 500 of nextServiceMileage → audit fires', async () => {
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
    });
    await setAssetMileage(assetId, 9_501); // 499 mi until due → within band

    const due = await sweep.runPmDueSweep();
    expect(due).toBeGreaterThanOrEqual(1);

    const audit = await adminDb.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta['triggeredBy']).toBe('mileage');
    expect(meta['smallestNextServiceMileage']).toBe(10_000);
    expect(meta['assetLastReadMileage']).toBe(9_501);
    expect(meta['milesUntilDue']).toBe(499);
    expect(Array.isArray(meta['ticketIds'])).toBe(true);
    expect((meta['ticketIds'] as unknown[]).length).toBe(1);
  });

  it('mileage trigger: lastReadMileage outside 500 band → no audit', async () => {
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
    });
    await setAssetMileage(assetId, 9_499); // 501 mi until due → outside band

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(0);

    const audit = await adminDb.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect(audit).toBeNull();
  });

  it('date trigger: nextServiceDate within 14 days → audit fires', async () => {
    const tenDaysOut = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceDate: tenDaysOut,
    });

    const due = await sweep.runPmDueSweep();
    expect(due).toBeGreaterThanOrEqual(1);

    const audit = await adminDb.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta['triggeredBy']).toBe('date');
    expect(typeof meta['daysUntilDue']).toBe('number');
    expect(meta['daysUntilDue']).toBeGreaterThanOrEqual(9);
    expect(meta['daysUntilDue']).toBeLessThanOrEqual(10);
  });

  it('date trigger: nextServiceDate beyond 14 days → no audit', async () => {
    const twentyDaysOut = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceDate: twentyDaysOut,
    });

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(0);
  });

  it('both triggers on the same ticket → triggeredBy=both', async () => {
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
      nextServiceDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await setAssetMileage(assetId, 9_700);

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(1);

    const audit = await adminDb.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect((audit!.metadata as Record<string, unknown>)['triggeredBy']).toBe('both');
  });

  it('non-COMPLETED tickets are ignored', async () => {
    // Open ticket — has nextServiceMileage but is OPEN, should not fire.
    await adminDb.assetMaintenance.create({
      data: {
        tenantId,
        assetId,
        maintenanceType: 'Maintenance',
        title: 'still open',
        status: 'OPEN',
        nextServiceMileage: 10_000,
        createdByUserId: ownerUserId,
      },
    });
    await setAssetMileage(assetId, 9_700);

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(0);
  });

  it('multiple due tickets on same asset → one audit row, all ticket IDs in metadata', async () => {
    const t1 = await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
      completedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const t2 = await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 12_000,
      completedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await setAssetMileage(assetId, 11_700); // within band of t2 (12_000)
                                            // — lastReadMileage 11_700 + 500
                                            // < 10_000 is false (11_700 +
                                            // 500 = 12_200 ≥ 12_000 ✓; also
                                            // ≥ 10_000 ✓ — both fire)

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(1);

    const audits = await adminDb.auditEvent.findMany({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect(audits).toHaveLength(1);
    const ticketIds = (audits[0]!.metadata as Record<string, unknown>)['ticketIds'] as string[];
    expect(ticketIds.sort()).toEqual([t1, t2].sort());
    expect((audits[0]!.metadata as Record<string, unknown>)['ticketCount']).toBe(2);
    // Smallest nextServiceMileage among the two — relevant for "soonest due."
    expect((audits[0]!.metadata as Record<string, unknown>)['smallestNextServiceMileage']).toBe(10_000);
  });

  it('24h dedup: second runOnce within window → no second audit', async () => {
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
    });
    await setAssetMileage(assetId, 9_700);

    const due1 = await sweep.runPmDueSweep();
    expect(due1).toBe(1);

    const due2 = await sweep.runPmDueSweep();
    expect(due2).toBe(0);

    const audits = await adminDb.auditEvent.findMany({
      where: {
        tenantId,
        action: 'panorama.maintenance.next_service_due',
        resourceId: assetId,
      },
    });
    expect(audits).toHaveLength(1);
  });

  it('per-tenant isolation: tenant A audit does not leak to tenant B', async () => {
    // Seed a due ticket for tenant A on tenant A's asset.
    await seedCompletedTicket({
      tenantId,
      assetId,
      nextServiceMileage: 10_000,
    });
    await setAssetMileage(assetId, 9_700);

    // Seed an asset + ticket on tenant B for parity (no due trigger).
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
        tag: 'PM2-01',
        name: 'PM2 Truck',
        bookable: true,
        status: 'READY',
        lastReadMileage: 100, // far below any threshold
      },
    });
    await adminDb.assetMaintenance.create({
      data: {
        tenantId: secondTenantId,
        assetId: asset2.id,
        maintenanceType: 'Maintenance',
        title: 'PM2 oil change',
        status: 'COMPLETED',
        completedAt: new Date(),
        completedByUserId: ownerUserId,
        nextServiceMileage: 10_000,
        createdByUserId: ownerUserId,
      },
    });

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(1);

    const auditsA = await adminDb.auditEvent.findMany({
      where: { tenantId, action: 'panorama.maintenance.next_service_due' },
    });
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0]!.tenantId).toBe(tenantId);

    const auditsB = await adminDb.auditEvent.findMany({
      where: { tenantId: secondTenantId, action: 'panorama.maintenance.next_service_due' },
    });
    expect(auditsB).toHaveLength(0);

    // Cleanup: drop tenant B's seeded data.
    await adminDb.assetMaintenance.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.asset.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.assetModel.deleteMany({ where: { tenantId: secondTenantId } });
    await adminDb.category.deleteMany({ where: { tenantId: secondTenantId } });
  });

  it('CANCELLED tickets are ignored even with a thresholded nextServiceMileage', async () => {
    await adminDb.assetMaintenance.create({
      data: {
        tenantId,
        assetId,
        maintenanceType: 'Maintenance',
        title: 'cancelled before completion',
        status: 'CANCELLED',
        nextServiceMileage: 10_000,
        createdByUserId: ownerUserId,
      },
    });
    await setAssetMileage(assetId, 9_700);

    const due = await sweep.runPmDueSweep();
    expect(due).toBe(0);
  });
});

describe('computeTriggers (unit)', () => {
  function ticket(overrides: {
    nextServiceDate?: Date | null;
    nextServiceMileage?: number | null;
    assetLastReadMileage?: number | null;
  }): {
    id: string;
    assetId: string;
    tenantId: string;
    nextServiceDate: Date | null;
    nextServiceMileage: number | null;
    assetLastReadMileage: number | null;
  } {
    return {
      id: 't1',
      assetId: 'a1',
      tenantId: 't1',
      nextServiceDate: overrides.nextServiceDate ?? null,
      nextServiceMileage: overrides.nextServiceMileage ?? null,
      assetLastReadMileage: overrides.assetLastReadMileage ?? null,
    };
  }

  it('classifies date-only trigger', () => {
    const t = computeTriggers([
      ticket({ nextServiceDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }),
    ]);
    expect(t.triggeredBy).toBe('date');
    expect(t.earliestDate).toBeInstanceOf(Date);
    expect(t.smallestMileage).toBeNull();
  });

  it('classifies mileage-only trigger', () => {
    const t = computeTriggers([
      ticket({ nextServiceMileage: 10_000, assetLastReadMileage: 9_700 }),
    ]);
    expect(t.triggeredBy).toBe('mileage');
    expect(t.smallestMileage).toBe(10_000);
    expect(t.earliestDate).toBeNull();
  });

  it('classifies both when one ticket has each kind', () => {
    const t = computeTriggers([
      ticket({ nextServiceDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }),
      ticket({ nextServiceMileage: 10_000, assetLastReadMileage: 9_700 }),
    ]);
    expect(t.triggeredBy).toBe('both');
    expect(t.earliestDate).toBeInstanceOf(Date);
    expect(t.smallestMileage).toBe(10_000);
  });

  it('takes the earliest date / smallest mileage across multiple tickets', () => {
    const earlier = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const t = computeTriggers([
      ticket({ nextServiceDate: later, nextServiceMileage: 12_000, assetLastReadMileage: 11_700 }),
      ticket({ nextServiceDate: earlier, nextServiceMileage: 10_000, assetLastReadMileage: 11_700 }),
    ]);
    expect(t.earliestDate?.getTime()).toBe(earlier.getTime());
    expect(t.smallestMileage).toBe(10_000);
    expect(t.triggeredBy).toBe('both');
  });

  it('mileage NOT in band → no mileage trigger', () => {
    const t = computeTriggers([
      ticket({ nextServiceMileage: 10_000, assetLastReadMileage: 9_499 }),
    ]);
    expect(t.smallestMileage).toBeNull();
    // No fields fired — but the function still returns a string.
    // In practice the caller filters out tickets that don't cross
    // a threshold via the SQL predicate, so this branch is defensive.
    expect(['date', 'mileage', 'both']).toContain(t.triggeredBy);
  });
});
