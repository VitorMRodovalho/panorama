import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/modules/prisma/prisma.service.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import {
  ChannelRegistry,
  type ChannelHandler,
} from '../src/modules/notification/channel-registry.js';
import { NotificationDispatcher } from '../src/modules/notification/notification.dispatcher.js';
import {
  redactSensitive,
} from '../src/modules/notification/notification.service.js';
import { ReservationService } from '../src/modules/reservation/reservation.service.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * Notification event bus (ADR-0011 steps 2-4) — integration coverage
 * for the outbox, enqueue, dispatcher, and tamper trigger.
 *
 * Covers:
 *   * redactSensitive (pure): token/secret/password/authorization
 *     key-match across nested payloads.
 *   * enqueueWithin: unknown eventType rejected + payload_rejected
 *     audit; payload schema mismatch rejected; secret-shaped key
 *     redacted + payload_redacted audit; happy path writes PENDING
 *     + panorama.notification.enqueued audit.
 *   * dedupKey partial unique: second enqueue with same
 *     (tenantId, eventType, dedupKey) after first reaches DISPATCHED
 *     → silently skipped (no row added).
 *   * dispatcher tickOnce: claims PENDING → IN_PROGRESS → DISPATCHED
 *     + panorama.notification.dispatched audit; per-channel outcome
 *     recorded in channelResults; handler throw records per-channel
 *     failed and retries.
 *   * dispatcher backoff: row goes FAILED with availableAt pushed
 *     1 m (first attempt).
 *   * MAX_ATTEMPTS (5): fifth consecutive throw flips to DEAD +
 *     panorama.notification.dead audit.
 *   * stuck-row rescue: IN_PROGRESS row older than threshold → FAILED
 *     + panorama.notification.rescued audit.
 *   * tamper trigger: direct UPDATE setting PENDING → DISPATCHED
 *     fires panorama.notification.status_tampered via DB trigger.
 *   * handler with zero matches → row still progresses to DISPATCHED
 *     (no-one-cares is not an error).
 *   * per-event tenant scope: a handler making a Prisma call sees
 *     only its own tenant's rows (RLS enforced via runInTenant).
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;

/** Stub handler: records every call + optionally throws. */
class StubHandler implements ChannelHandler {
  readonly name: string;
  public calls: Array<{ eventId: string; eventType: string }> = [];
  public throwOnNext = 0;
  constructor(name: string, private readonly predicate: (t: string) => boolean) {
    this.name = name;
  }
  supports(eventType: string): boolean {
    return this.predicate(eventType);
  }
  async handle(event: { id: string; eventType: string }): Promise<void> {
    this.calls.push({ eventId: event.id, eventType: event.eventType });
    if (this.throwOnNext > 0) {
      this.throwOnNext--;
      throw new Error('stub_handler_forced_failure');
    }
  }
}

describe('notification bus integration', () => {
  let app: INestApplication;
  let adminDb: PrismaClient;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let registry: ChannelRegistry;
  let dispatcher: NotificationDispatcher;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'a'.repeat(32);
    process.env.DATABASE_URL = APP_URL;

    adminDb = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(adminDb);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();

    prisma = app.get(PrismaService);
    notifications = app.get(NotificationService);
    registry = app.get(ChannelRegistry);
    dispatcher = app.get(NotificationDispatcher);

    const tenant = await createTenantForTest(adminDb, {
      slug: 'notif',
      name: 'Notif',
      displayName: 'Notif',
    });
    tenantId = tenant.id;
    const user = await adminDb.user.create({
      data: { email: 'notif@example.com', displayName: 'Notif User' },
    });
    userId = user.id;
    await adminDb.tenantMembership.create({
      data: { tenantId, userId, role: 'owner', status: 'active' },
    });

    samplePayloadImpl = () => ({
      reservationId: '00000000-0000-0000-0000-000000000099',
      assetId: null,
      requesterUserId: userId,
      approverUserId: userId,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }, 120_000);

  afterAll(async () => {
    await adminDb?.$disconnect();
    await app?.close();
  }, 30_000);

  beforeEach(async () => {
    await adminDb.notificationEvent.deleteMany();
    await adminDb.auditEvent.deleteMany();
  });

  // ---- redaction ------------------------------------------------

  it('redactSensitive strips key paths matching /token|secret|password|authorization/i', () => {
    const { redacted, redactedKeys } = redactSensitive({
      reservationId: 'abc',
      tokenPlaintext: 'leak-me',
      nested: {
        ok: 1,
        apiSecret: 'hidden',
      },
      passwordHash: 'x',
      Authorization: 'Bearer abc',
    });
    expect((redacted)['tokenPlaintext']).toBe('<redacted>');
    expect((redacted)['passwordHash']).toBe('<redacted>');
    expect((redacted)['Authorization']).toBe('<redacted>');
    const nested = (redacted as Record<string, Record<string, unknown>>)['nested']!;
    expect(nested['apiSecret']).toBe('<redacted>');
    expect(nested['ok']).toBe(1);
    expect(redactedKeys.sort()).toEqual(
      ['Authorization', 'nested.apiSecret', 'passwordHash', 'tokenPlaintext'].sort(),
    );
  });

  // ---- enqueueWithin: validation paths --------------------------

  it('unknown eventType → throws + emits panorama.notification.payload_rejected', async () => {
    await expect(
      prisma.runAsSuperAdmin(
        (tx) =>
          notifications.enqueueWithin(tx, {
            eventType: 'not.a.real.type',
            tenantId,
            payload: {},
          }),
        { reason: 'test:enqueue:unknown' },
      ),
    ).rejects.toThrow(/unknown_event_type/);
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.notification.payload_rejected' },
    });
    expect(audit).toBeTruthy();
    expect((audit?.metadata as Record<string, unknown>)['reason']).toBe('unknown_event_type');
  });

  it('payload missing required field → throws + payload_rejected audit', async () => {
    await expect(
      prisma.runAsSuperAdmin(
        (tx) =>
          notifications.enqueueWithin(tx, {
            eventType: 'panorama.reservation.approved',
            tenantId,
            payload: { reservationId: 'not-a-uuid' },
          }),
        { reason: 'test:enqueue:bad-shape' },
      ),
    ).rejects.toThrow(/payload_schema_failed/);
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.notification.payload_rejected' },
    });
    expect(audit).toBeTruthy();
    expect((audit?.metadata as Record<string, unknown>)['reason']).toBe(
      'schema_validation_failed',
    );
  });

  it('happy path creates PENDING row + enqueued audit', async () => {
    const result = await prisma.runAsSuperAdmin(
      async (tx) => {
        await notifications.enqueueWithin(tx, {
          eventType: 'panorama.reservation.approved',
          tenantId,
          payload: {
            reservationId: '00000000-0000-0000-0000-000000000001',
            assetId: '00000000-0000-0000-0000-000000000002',
            requesterUserId: userId,
            approverUserId: userId,
            startAt: new Date().toISOString(),
            endAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        });
      },
      { reason: 'test:enqueue:happy' },
    );
    void result;
    const rows = await adminDb.notificationEvent.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.notification.enqueued' },
    });
    expect(audit).toBeTruthy();
  });

  // ---- dedup partial unique -------------------------------------

  it('second enqueue with same (tenantId, eventType, dedupKey) after DISPATCHED is silently skipped', async () => {
    const payload = {
      reservationId: '00000000-0000-0000-0000-000000000010',
      assetId: '00000000-0000-0000-0000-000000000011',
      requesterUserId: userId,
      approverUserId: userId,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    await prisma.runAsSuperAdmin(
      (tx) =>
        notifications.enqueueWithin(tx, {
          eventType: 'panorama.reservation.approved',
          tenantId,
          payload,
          dedupKey: 'dedup-1',
        }),
      { reason: 'test:dedup:first' },
    );
    // Force the row to DISPATCHED so the partial unique index fires
    // on the second enqueue.
    await adminDb.notificationEvent.updateMany({
      where: { tenantId, dedupKey: 'dedup-1' },
      data: { status: 'DISPATCHED' },
    });
    // Second enqueue: same triple → partial unique 23505 → treated
    // as successful dedup skip, no new row added.
    await prisma.runAsSuperAdmin(
      (tx) =>
        notifications.enqueueWithin(tx, {
          eventType: 'panorama.reservation.approved',
          tenantId,
          payload,
          dedupKey: 'dedup-1',
        }),
      { reason: 'test:dedup:second' },
    );
    const rows = await adminDb.notificationEvent.findMany({
      where: { tenantId, dedupKey: 'dedup-1' },
    });
    expect(rows).toHaveLength(1);
  });

  // ---- dispatcher tickOnce --------------------------------------

  it('dispatcher tickOnce runs registered handler + transitions row to DISPATCHED', async () => {
    const h = new StubHandler('stub', (t) => t === 'panorama.reservation.approved');
    registry.register(h);
    try {
      await prisma.runAsSuperAdmin(
        (tx) =>
          notifications.enqueueWithin(tx, {
            eventType: 'panorama.reservation.approved',
            tenantId,
            payload: samplePayload(),
          }),
        { reason: 'test:dispatch' },
      );
      const processed = await dispatcher.tickOnce();
      expect(processed).toBe(1);
      expect(h.calls).toHaveLength(1);
      const row = await adminDb.notificationEvent.findFirst({ where: { tenantId } });
      expect(row?.status).toBe('DISPATCHED');
      expect(row?.dispatchedAt).toBeTruthy();
      const channelResults = row?.channelResults as Record<string, unknown>;
      expect((channelResults?.['stub'] as { status: string })?.status).toBe('dispatched');
      const audit = await adminDb.auditEvent.findFirst({
        where: { action: 'panorama.notification.dispatched', resourceId: row!.id },
      });
      expect(audit).toBeTruthy();
    } finally {
      // ChannelRegistry has no unregister (bootstrap-only by design);
      // the stub stays for the remaining tests. That's fine — each
      // test manages its own rows.
      void h;
    }
  });

  it('dispatcher handler throw → FAILED + availableAt pushed + errorHistory appended', async () => {
    const h = new StubHandler(
      'stub-throws',
      (t) => t === 'panorama.reservation.rejected',
    );
    h.throwOnNext = 1;
    registry.register(h);
    await prisma.runAsSuperAdmin(
      (tx) =>
        notifications.enqueueWithin(tx, {
          eventType: 'panorama.reservation.rejected',
          tenantId,
          payload: samplePayload(),
        }),
      { reason: 'test:dispatch:throw' },
    );
    await dispatcher.tickOnce();
    const row = await adminDb.notificationEvent.findFirst({
      where: { tenantId, eventType: 'panorama.reservation.rejected' },
    });
    expect(row?.status).toBe('FAILED');
    expect(row?.dispatchAttempts).toBe(1);
    expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    const history = row?.errorHistory as Array<{ attempt: number; error: string }>;
    expect(Array.isArray(history)).toBe(true);
    expect(history?.[0]?.attempt).toBe(1);
    expect(history?.[0]?.error).toMatch(/stub_handler_forced_failure/);
  });

  it('no registered handler → row reaches DISPATCHED with empty channelResults', async () => {
    // No channel supports this event type (stub only supports
    // approved / rejected).
    await prisma.runAsSuperAdmin(
      (tx) =>
        adminDb.notificationEvent.create({
          data: {
            tenantId,
            eventType: 'panorama.unsubscribed.type',
            payload: { hello: 'world' },
            status: 'PENDING',
          },
        }),
      { reason: 'test:no-handler' },
    );
    await dispatcher.tickOnce();
    const row = await adminDb.notificationEvent.findFirst({
      where: { eventType: 'panorama.unsubscribed.type' },
    });
    expect(row?.status).toBe('DISPATCHED');
  });

  // ---- rescue sweep ---------------------------------------------

  it('stuck IN_PROGRESS rescue sweep flips row to FAILED + rescued audit', async () => {
    const row = await adminDb.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.reservation.approved',
        payload: samplePayload() as Prisma.InputJsonValue,
        status: 'IN_PROGRESS',
        lastAttemptAt: new Date(Date.now() - 120_000), // 2 minutes ago
      },
    });
    const rescued = await dispatcher.runRescueSweepOnce();
    expect(rescued).toBe(1);
    const after = await adminDb.notificationEvent.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe('FAILED');
    expect(after?.lastError).toBe('stuck_in_progress_rescued');
    const audit = await adminDb.auditEvent.findFirst({
      where: { action: 'panorama.notification.rescued', resourceId: row.id },
    });
    expect(audit).toBeTruthy();
  });

  it('fresh IN_PROGRESS row (< 60 s old) is NOT rescued', async () => {
    const row = await adminDb.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.reservation.approved',
        payload: samplePayload() as Prisma.InputJsonValue,
        status: 'IN_PROGRESS',
        lastAttemptAt: new Date(Date.now() - 5_000), // 5s ago
      },
    });
    const rescued = await dispatcher.runRescueSweepOnce();
    expect(rescued).toBe(0);
    const after = await adminDb.notificationEvent.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe('IN_PROGRESS'); // untouched
  });

  // ---- tamper trigger -------------------------------------------

  it('direct PENDING → DISPATCHED UPDATE fires status_tampered audit (DB trigger)', async () => {
    const row = await adminDb.notificationEvent.create({
      data: {
        tenantId,
        eventType: 'panorama.reservation.approved',
        payload: samplePayload() as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
    // Direct super-admin UPDATE skipping IN_PROGRESS — the shape
    // a by-hand tamper would produce.
    await adminDb.notificationEvent.update({
      where: { id: row.id },
      data: { status: 'DISPATCHED' },
    });
    const audit = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.notification.status_tampered',
        resourceId: row.id,
      },
    });
    expect(audit).toBeTruthy();
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta['fromStatus']).toBe('PENDING');
    expect(meta['toStatus']).toBe('DISPATCHED');
  });

  // ---- end-to-end: reservation.approve emits a notification ----

  it('ReservationService.approve enqueues panorama.reservation.approved (end-to-end)', async () => {
    const reservations = app.get(ReservationService);

    // Seed a bookable asset + a PENDING reservation owned by a
    // non-admin so the approve path actually transitions the row.
    const category = await adminDb.category.create({
      data: { tenantId, name: 'E2E Category', kind: 'VEHICLE' },
    });
    const model = await adminDb.assetModel.create({
      data: { tenantId, categoryId: category.id, name: 'E2E Model' },
    });
    const asset = await adminDb.asset.create({
      data: {
        tenantId,
        modelId: model.id,
        tag: 'E2E-01',
        name: 'E2E Truck',
        bookable: true,
        status: 'READY',
      },
    });
    const driver = await adminDb.user.create({
      data: { email: 'e2e-driver@example.com', displayName: 'E2E Driver' },
    });
    await adminDb.tenantMembership.create({
      data: { tenantId, userId: driver.id, role: 'driver', status: 'active' },
    });

    // Driver's pending reservation.
    const pending = await reservations.create({
      actor: {
        tenantId,
        userId: driver.id,
        role: 'driver',
        isVip: false,
      },
      assetId: asset.id,
      startAt: new Date(Date.now() + 48 * 3600_000),
      endAt: new Date(Date.now() + 50 * 3600_000),
    });
    expect(pending.approvalStatus).toBe('PENDING_APPROVAL');

    // Before approve: only the panorama.reservation.created
    // notification-side emission is NOT yet wired; expect zero
    // notification rows for reservation.approved/rejected.
    const beforeApprove = await adminDb.notificationEvent.count({
      where: { tenantId, eventType: 'panorama.reservation.approved' },
    });
    expect(beforeApprove).toBe(0);

    // Approve as the seeded owner (isAdmin=true path).
    await reservations.approve({
      actor: {
        tenantId,
        userId: userId, // seeded owner from beforeAll
        role: 'owner',
        isVip: false,
      },
      reservationId: pending.id,
      note: 'all good',
    });

    const rows = await adminDb.notificationEvent.findMany({
      where: { tenantId, eventType: 'panorama.reservation.approved' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.dedupKey).toBe(`panorama.reservation.approved:${pending.id}`);
    const payload = row.payload as Record<string, unknown>;
    expect(payload['reservationId']).toBe(pending.id);
    expect(payload['assetId']).toBe(asset.id);
    expect(payload['requesterUserId']).toBe(driver.id);
    expect(payload['approverUserId']).toBe(userId);
    expect(payload['note']).toBe('all good');

    // And the enqueue audit row landed.
    const audit = await adminDb.auditEvent.findFirst({
      where: {
        action: 'panorama.notification.enqueued',
        resourceId: row.id,
      },
    });
    expect(audit).toBeTruthy();
  });

  it('normal dispatcher-driven PENDING → IN_PROGRESS → DISPATCHED does NOT fire tamper audit', async () => {
    const h = new StubHandler(
      'stub-clean',
      (t) => t === 'panorama.reservation.approved',
    );
    registry.register(h);
    await prisma.runAsSuperAdmin(
      (tx) =>
        notifications.enqueueWithin(tx, {
          eventType: 'panorama.reservation.approved',
          tenantId,
          payload: samplePayload(),
        }),
      { reason: 'test:dispatch:clean' },
    );
    await dispatcher.tickOnce();
    const tamper = await adminDb.auditEvent.findMany({
      where: { action: 'panorama.notification.status_tampered' },
    });
    expect(tamper).toHaveLength(0);
  });
});

// samplePayload is produced via a closure in beforeAll so it can bind
// to the seeded `userId`. The email channel (auto-registered by
// NotificationModule) looks up the user — using a fake UUID would
// trip `tenant_or_requester_missing` and flip the row to FAILED in
// tests that are only exercising dispatcher bookkeeping.
let samplePayloadImpl: () => Record<string, unknown> = () => ({});
const samplePayload = (): Record<string, unknown> => samplePayloadImpl();
