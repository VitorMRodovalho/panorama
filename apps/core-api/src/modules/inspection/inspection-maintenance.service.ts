/**
 * InspectionMaintenanceService — ADR-0012 §9 + §10 background sweeps.
 *
 *   * Photo retention (§10): daily — soft-deleted photos past the
 *     per-tenant `inspectionPhotoRetentionDays` (default 425 d, floor
 *     30) get hard-deleted from S3 + DB, audit
 *     `panorama.inspection.photo.hard_deleted reason='retention_sweep'`.
 *     Batch 500 per run bounds load.
 *   * Stale IN_PROGRESS (§9): hourly — inspections still IN_PROGRESS
 *     past `inspectionConfig.staleInProgressHours * 3` flip to
 *     CANCELLED with audit `panorama.inspection.auto_cancelled`,
 *     reason='auto_cancel_stale'.
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * `runAsSuperAdmin` is FORBIDDEN here for tenant-scoped reads
 * and ALL writes. The two sweeps below loop over tenants and
 * route every candidate scan + update through `runInTenant`.
 *
 * The ONE allowed cluster-wide path is the tenant LIST itself,
 * which is intrinsically cross-tenant — `panorama_app` can only
 * see its own row in `tenants`, so we use `runAsSuperAdmin` for
 * the list of tenant ids + per-tenant config. Each per-tenant
 * scan + update then runs under RLS. `audit.record` opens its
 * own super-admin tx via the existing AuditService design.
 *
 * The CI gate `pnpm rls:allowlist-check` (#58) budgets this file
 * at 1 super-admin call (the tenant list). Adding more requires
 * security-reviewer sign-off.
 * --------------------------------------------------------------
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ObjectStorageService } from '../object-storage/object-storage.service.js';
import {
  effectiveRetentionDays,
  parseInspectionTenantConfig,
} from './inspection.config.js';

const PHOTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const PHOTO_BATCH_SIZE = 500;
const STALE_BATCH_SIZE = 500;

// ADR-0015 v2 — durable scheduling for the photo retention sweep.
// `setInterval` resets on Fly machine restart; the 24 h cadence on a
// DOT 49 CFR §396.3 compliance signal can drift by days under
// restart-heavy days. BullMQ's repeatable-job dedupes on jobId so a
// restart re-attaches to the existing schedule. Stale-IN_PROGRESS
// (1 h) stays on setInterval — losing a poll cycle there is fine.
const PHOTO_SWEEP_QUEUE = 'inspection-photo-retention';
const PHOTO_SWEEP_JOB_NAME = 'sweep';
const PHOTO_SWEEP_REPEATABLE_KEY = 'photo-retention-daily';

@Injectable()
export class InspectionMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('InspectionMaintenanceService');
  private staleTimer: NodeJS.Timeout | null = null;
  private photoSweepQueue: Queue | null = null;
  private photoSweepWorker: Worker | null = null;
  private redisConnections: Redis[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('maintenance_idle_in_tests');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    // Stale sweep stays on setInterval — losing a poll cycle on restart
    // is fine for a 1 h cadence.
    if (!this.staleTimer) {
      this.staleTimer = setInterval(() => {
        this.runStaleInProgressSweep().catch((err) =>
          this.log.warn({ err: String(err) }, 'stale_sweep_unhandled'),
        );
      }, STALE_SWEEP_INTERVAL_MS);
    }

    // Photo retention sweep — durable BullMQ repeatable job. The
    // jobId-based dedupe means a Fly machine restart re-attaches
    // to the existing schedule rather than spawning a duplicate or
    // skipping a run.
    if (!this.photoSweepQueue) {
      this.photoSweepQueue = new Queue(PHOTO_SWEEP_QUEUE, {
        connection: this.makeRedis(),
      });
      this.photoSweepWorker = new Worker(
        PHOTO_SWEEP_QUEUE,
        async () => {
          const swept = await this.runPhotoRetentionSweep();
          return { swept };
        },
        { connection: this.makeRedis(), concurrency: 1 },
      );
      this.photoSweepWorker.on('failed', (_job, err) =>
        this.log.warn({ err: String(err) }, 'photo_sweep_job_failed'),
      );
      await this.photoSweepQueue.add(
        PHOTO_SWEEP_JOB_NAME,
        {},
        {
          jobId: PHOTO_SWEEP_REPEATABLE_KEY,
          repeat: { every: PHOTO_SWEEP_INTERVAL_MS },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 30 },
          removeOnFail: { age: 30 * 24 * 60 * 60, count: 30 },
        },
      );
    }

    this.log.log('maintenance_started');
  }

  async stop(): Promise<void> {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    const closers: Array<Promise<unknown>> = [];
    if (this.photoSweepWorker) closers.push(this.photoSweepWorker.close());
    if (this.photoSweepQueue) closers.push(this.photoSweepQueue.close());
    await Promise.allSettled(closers);
    this.photoSweepWorker = null;
    this.photoSweepQueue = null;
    for (const conn of this.redisConnections) {
      try {
        await conn.quit();
      } catch (err) {
        this.log.debug({ err: String(err) }, 'redis_quit_error');
      }
    }
    this.redisConnections = [];
  }

  /**
   * BullMQ requires the same `lazyConnect: false` /
   * `enableReadyCheck: false` / `maxRetriesPerRequest: null` shape on
   * every connection — mirrors the invitation queue pattern at
   * `invitation-email.queue.ts:230-239`.
   */
  private makeRedis(): Redis {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';
    const conn = new Redis(url, {
      lazyConnect: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });
    this.redisConnections.push(conn);
    return conn;
  }

  // ----------------------------------------------------------------
  // Photo retention sweep
  // ----------------------------------------------------------------

  /**
   * One pass of the photo retention sweep. Returns the count of
   * hard-deleted rows. Exposed for tests + manual operator triggers.
   *
   * Algorithm (per ADR §10):
   *   1. Pull a batch of soft-deleted photo rows across all tenants
   *      (super-admin scope inside an explicit `runInTenant(tenantId,...)`
   *      per row — see invariant above. Implementation detail: the
   *      candidate scan is done with a single per-tenant Prisma call
   *      after grouping IDs by tenant).
   *   2. Per row: per-tenant retention check using
   *      `Tenant.inspectionPhotoRetentionDays` (null → default 425 d;
   *      service-layer floor 30 d).
   *   3. Per qualifying row: ObjectStorageService.delete(storageKey)
   *      (idempotent on missing keys), then hard-delete the DB row.
   *   4. Audit `panorama.inspection.photo.hard_deleted reason='retention_sweep'`.
   */
  async runPhotoRetentionSweep(): Promise<number> {
    // Step 1: list tenants + per-tenant retention. Only allowed
    // cluster-wide read in this module — `panorama_app` cannot see
    // other tenants' rows in `tenants`, so the list itself needs
    // privileged context. Per-tenant photo scans + deletes that
    // follow run under runInTenant.
    const tenants = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          select: { id: true, inspectionPhotoRetentionDays: true },
        }),
      { reason: 'inspection:photo_retention_sweep:list_tenants' },
    );

    // Step 2: per-tenant scan under RLS. Each tenant gets its own
    // PHOTO_BATCH_SIZE budget per sweep tick — under 1k tenants
    // this is acceptable. Bigger fleets should switch to a
    // priority-queue scheduler (out of scope).
    const candidates: Array<{
      id: string;
      tenantId: string;
      storageKey: string;
      inspectionId: string;
    }> = [];
    for (const tenant of tenants) {
      const days = effectiveRetentionDays(tenant.inspectionPhotoRetentionDays);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rows = await this.prisma.runInTenant(tenant.id, (tx) =>
        tx.inspectionPhoto.findMany({
          where: { deletedAt: { lt: cutoff, not: null } },
          orderBy: { deletedAt: 'asc' },
          take: PHOTO_BATCH_SIZE,
          select: { id: true, tenantId: true, storageKey: true, inspectionId: true },
        }),
      );
      candidates.push(...rows);
    }

    if (candidates.length === 0) return 0;

    let hardDeleted = 0;
    for (const photo of candidates) {
      try {
        await this.storage.delete(photo.storageKey, photo.tenantId);
      } catch (err) {
        // S3 outage — leave the row for the next sweep. Log + skip.
        this.log.warn(
          { photoId: photo.id, err: String(err) },
          'photo_retention_s3_delete_failed',
        );
        continue;
      }
      try {
        await this.prisma.runInTenant(photo.tenantId, async (tx) => {
          await tx.inspectionPhoto.delete({ where: { id: photo.id } });
        });
      } catch (err) {
        this.log.warn(
          { photoId: photo.id, err: String(err) },
          'photo_retention_db_delete_failed',
        );
        continue;
      }
      await this.audit.record({
        action: 'panorama.inspection.photo.hard_deleted',
        resourceType: 'inspection_photo',
        resourceId: photo.id,
        tenantId: photo.tenantId,
        actorUserId: null,
        metadata: {
          inspectionId: photo.inspectionId,
          reason: 'retention_sweep',
          storageKey: photo.storageKey,
        },
      });
      hardDeleted++;
    }
    if (hardDeleted > 0) {
      this.log.log({ hardDeleted }, 'photo_retention_swept');
    }
    return hardDeleted;
  }

  // ----------------------------------------------------------------
  // Stale-in-progress sweep
  // ----------------------------------------------------------------

  /**
   * One pass of the stale-IN_PROGRESS sweep. Flips inspections older
   * than `staleInProgressHours * 3` (per-tenant config, default 24 h →
   * 72 h cutoff) to CANCELLED. Photos attached are NOT deleted — they
   * follow the soft-delete + retention-sweep path.
   */
  async runStaleInProgressSweep(): Promise<number> {
    // Same shape as runPhotoRetentionSweep — list tenants
    // (cluster-wide), then per-tenant scan + update under RLS.
    const tenants = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          select: { id: true, inspectionConfig: true },
        }),
      { reason: 'inspection:stale_in_progress_sweep:list_tenants' },
    );

    const candidates: Array<{ id: string; tenantId: string; startedAt: Date }> = [];
    for (const tenant of tenants) {
      const cfg = parseInspectionTenantConfig(tenant.inspectionConfig);
      const cutoffMs = 3 * cfg.staleInProgressHours * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - cutoffMs);
      const rows = await this.prisma.runInTenant(tenant.id, (tx) =>
        tx.inspection.findMany({
          where: { status: 'IN_PROGRESS', startedAt: { lt: cutoff } },
          orderBy: { startedAt: 'asc' },
          take: STALE_BATCH_SIZE,
          select: { id: true, tenantId: true, startedAt: true },
        }),
      );
      candidates.push(...rows);
    }

    if (candidates.length === 0) return 0;

    let cancelled = 0;
    for (const insp of candidates) {
      try {
        const updated = await this.prisma.runInTenant(insp.tenantId, async (tx) => {
          // Conditional updateMany defeats the race against a driver
          // submitting a `complete` between scan and write.
          const r = await tx.inspection.updateMany({
            where: { id: insp.id, status: 'IN_PROGRESS' },
            data: { status: 'CANCELLED' },
          });
          return r.count === 1;
        });
        if (!updated) continue;
      } catch (err) {
        this.log.warn(
          { inspectionId: insp.id, err: String(err) },
          'stale_sweep_update_failed',
        );
        continue;
      }
      const hoursStale = Math.round(
        (Date.now() - insp.startedAt.getTime()) / (60 * 60 * 1000),
      );
      await this.audit.record({
        action: 'panorama.inspection.auto_cancelled',
        resourceType: 'inspection',
        resourceId: insp.id,
        tenantId: insp.tenantId,
        actorUserId: null,
        metadata: { reason: 'auto_cancel_stale', hoursStale },
      });
      cancelled++;
    }
    if (cancelled > 0) {
      this.log.log({ cancelled }, 'stale_in_progress_swept');
    }
    return cancelled;
  }
}

// Re-exports for ergonomic test imports.
export { effectiveRetentionDays, parseInspectionTenantConfig };
// Prevent the Prisma import from being elided (it isn't used directly,
// but keeping the type import documents the namespace this service
// reads).
export type _PrismaPlaceholder = Prisma.InputJsonValue;
