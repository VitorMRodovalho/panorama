import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Migration 0010 invariants — the DB-layer `reservations_no_overlap`
 * exclusion constraint backs ADR-0009's "no double-booking" promise.
 *
 * Tests assert the contract at the rawest level (no Nest, no service
 * layer): pure Prisma as super-admin, direct INSERTs.
 *
 *   1. Two in-play overlapping rows on the same (tenantId, assetId)
 *      → second write fails with SQLSTATE 23P01 exclusion_violation.
 *   2. Half-open ranges back-to-back `[12:00,14:00) [14:00,16:00)`
 *      do NOT collide — the range operator is `&&` not `overlaps`.
 *   3. A REJECTED row in the same window does NOT block a new
 *      PENDING one (WHERE predicate keeps terminal-state rows out
 *      of the exclusion index).
 *   4. A CANCELLED row in the same window does NOT block either.
 *   5. Two rows with the same window but different assetIds do NOT
 *      collide — the exclusion is per-(tenant, asset).
 *   6. The bookingRange column is GENERATED: we can't write to it.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

const EXCLUSION_ERROR_RE = /23P01|exclusion|reservations_no_overlap/i;

describe('migration 0010 — reservations_no_overlap exclusion constraint', () => {
  let db: PrismaClient;
  let tenantId: string;
  let assetId: string;
  let secondAssetId: string;
  let userId: string;

  async function insertReservation(opts: {
    assetId: string | null;
    startAt: Date;
    endAt: Date;
    approvalStatus?: string;
    lifecycleStatus?: string;
  }): Promise<string> {
    const row = await db.reservation.create({
      data: {
        tenantId,
        assetId: opts.assetId,
        requesterUserId: userId,
        startAt: opts.startAt,
        endAt: opts.endAt,
        approvalStatus: (opts.approvalStatus ?? 'AUTO_APPROVED') as
          | 'PENDING_APPROVAL'
          | 'AUTO_APPROVED'
          | 'APPROVED'
          | 'REJECTED',
        lifecycleStatus: (opts.lifecycleStatus ?? 'BOOKED') as
          | 'BOOKED'
          | 'CHECKED_OUT'
          | 'RETURNED'
          | 'CANCELLED'
          | 'MISSED'
          | 'MAINTENANCE_REQUIRED'
          | 'REDIRECTED',
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(db);

    const tenant = await createTenantForTest(db, {
      slug: 'exclusion-test',
      name: 'Exclusion Test',
      displayName: 'Exclusion Test',
    });
    tenantId = tenant.id;
    const user = await db.user.create({
      data: { email: 'exclusion@example.com', displayName: 'Exclusion User' },
    });
    userId = user.id;
    await db.tenantMembership.create({
      data: { tenantId, userId, role: 'owner', status: 'active' },
    });
    const category = await db.category.create({
      data: { tenantId, name: 'Vehicles', kind: 'VEHICLE' },
    });
    const model = await db.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'F-150' },
    });
    for (let i = 1; i <= 2; i++) {
      const a = await db.asset.create({
        data: {
          tenantId,
          modelId: model.id,
          tag: `EX-${String(i).padStart(2, '0')}`,
          name: `Exclusion Truck ${i}`,
          bookable: true,
          status: 'READY',
        },
      });
      if (i === 1) assetId = a.id;
      else secondAssetId = a.id;
    }
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  // ---- core overlap rejection --------------------------------------

  it('two in-play overlapping rows → second write fails with 23P01', async () => {
    // Use a disjoint time window so these tests don't collide with the
    // other tests in this suite.
    const start = new Date('2027-01-01T10:00:00Z');
    const end = new Date('2027-01-01T12:00:00Z');

    const firstId = await insertReservation({ assetId, startAt: start, endAt: end });
    expect(firstId).toBeTruthy();

    // Second write overlaps (09:00–11:00). Must fail at DB.
    const overlappedStart = new Date('2027-01-01T09:00:00Z');
    const overlappedEnd = new Date('2027-01-01T11:00:00Z');
    await expect(
      insertReservation({ assetId, startAt: overlappedStart, endAt: overlappedEnd }),
    ).rejects.toThrow(EXCLUSION_ERROR_RE);
  });

  it('half-open back-to-back ranges do NOT collide', async () => {
    const a = await insertReservation({
      assetId,
      startAt: new Date('2027-01-02T12:00:00Z'),
      endAt: new Date('2027-01-02T14:00:00Z'),
    });
    // Starts exactly when the first ends — must be accepted.
    const b = await insertReservation({
      assetId,
      startAt: new Date('2027-01-02T14:00:00Z'),
      endAt: new Date('2027-01-02T16:00:00Z'),
    });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  // ---- predicate exclusion of terminal-state rows ------------------

  it('a REJECTED row in the same window does NOT block a new PENDING one', async () => {
    const start = new Date('2027-01-03T10:00:00Z');
    const end = new Date('2027-01-03T12:00:00Z');
    await insertReservation({
      assetId,
      startAt: start,
      endAt: end,
      approvalStatus: 'REJECTED',
    });
    // Same window, PENDING → must succeed because REJECTED is out of
    // the exclusion predicate.
    const second = await insertReservation({
      assetId,
      startAt: start,
      endAt: end,
      approvalStatus: 'PENDING_APPROVAL',
    });
    expect(second).toBeTruthy();
  });

  it('a CANCELLED row in the same window does NOT block either', async () => {
    const start = new Date('2027-01-04T10:00:00Z');
    const end = new Date('2027-01-04T12:00:00Z');
    await insertReservation({
      assetId,
      startAt: start,
      endAt: end,
      lifecycleStatus: 'CANCELLED',
    });
    const second = await insertReservation({
      assetId,
      startAt: start,
      endAt: end,
      approvalStatus: 'AUTO_APPROVED',
      lifecycleStatus: 'BOOKED',
    });
    expect(second).toBeTruthy();
  });

  // ---- exclusion is per-(tenant, asset) ----------------------------

  it('same window on different assets does NOT collide', async () => {
    const start = new Date('2027-01-05T10:00:00Z');
    const end = new Date('2027-01-05T12:00:00Z');
    const a = await insertReservation({ assetId, startAt: start, endAt: end });
    const b = await insertReservation({
      assetId: secondAssetId,
      startAt: start,
      endAt: end,
    });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  // ---- bookingRange is GENERATED -----------------------------------

  it('bookingRange column is read-only — direct writes are rejected', async () => {
    // Raw SQL to attempt to set the generated column. Postgres rejects.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE reservations SET "bookingRange" = '[2027-01-06 10:00:00, 2027-01-06 12:00:00)'::tsrange`,
      ),
    ).rejects.toThrow(/generated|"bookingRange"/i);
  });
});
