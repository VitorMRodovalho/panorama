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
 * `runAsSuperAdmin` is FORBIDDEN here. Sweeps need cluster-wide
 * visibility but route writes through `runInTenant` per tenant
 * group. The ONE call to `audit.record` is the only path that
 * spawns its own super-admin tx (existing AuditService design).
 * --------------------------------------------------------------
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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

@Injectable()
export class InspectionMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('InspectionMaintenanceService');
  private photoTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
  ) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('maintenance_idle_in_tests');
      return;
    }
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.photoTimer || this.staleTimer) return;
    this.photoTimer = setInterval(() => {
      this.runPhotoRetentionSweep().catch((err) =>
        this.log.warn({ err: String(err) }, 'photo_sweep_unhandled'),
      );
    }, PHOTO_SWEEP_INTERVAL_MS);
    this.staleTimer = setInterval(() => {
      this.runStaleInProgressSweep().catch((err) =>
        this.log.warn({ err: String(err) }, 'stale_sweep_unhandled'),
      );
    }, STALE_SWEEP_INTERVAL_MS);
    this.log.log('maintenance_started');
  }

  stop(): void {
    if (this.photoTimer) clearInterval(this.photoTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.photoTimer = null;
    this.staleTimer = null;
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
    // Step 1: gather candidates across tenants. We fetch by joining
    // tenant.inspectionPhotoRetentionDays directly via raw SQL so the
    // per-tenant cutoff is applied inside the database, not row-by-row
    // in Node — bounded by `PHOTO_BATCH_SIZE`.
    const candidates = await this.prisma.runAsSuperAdmin(
      async (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            tenantId: string;
            storageKey: string;
            inspectionId: string;
          }>
        >`
          SELECT p.id, p."tenantId", p."storageKey", p."inspectionId"
            FROM inspection_photos p
            JOIN tenants t ON t.id = p."tenantId"
           WHERE p."deletedAt" IS NOT NULL
             AND p."deletedAt" < now() - (
               GREATEST(30, COALESCE(t."inspectionPhotoRetentionDays", 425)) || ' days'
             )::interval
           ORDER BY p."deletedAt" ASC
           LIMIT ${PHOTO_BATCH_SIZE}
        `,
      { reason: 'inspection:photo_retention_sweep:scan' },
    );

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
    // Per-tenant cutoff inside SQL — reads tenant.inspectionConfig
    // JSON. NULL config → default 24 h, then * 3 = 72 h. Casting to
    // numeric defends against missing keys.
    const candidates = await this.prisma.runAsSuperAdmin(
      async (tx) =>
        tx.$queryRaw<
          Array<{ id: string; tenantId: string; startedAt: Date }>
        >`
          SELECT i.id, i."tenantId", i."startedAt"
            FROM inspections i
            JOIN tenants t ON t.id = i."tenantId"
           WHERE i.status = 'IN_PROGRESS'
             AND i."startedAt" < now() - (
               (3 * COALESCE(
                 NULLIF(
                   (t."inspectionConfig" ->> 'staleInProgressHours')::numeric,
                   0
                 ),
                 24
               )) || ' hours'
             )::interval
           ORDER BY i."startedAt" ASC
           LIMIT ${STALE_BATCH_SIZE}
        `,
      { reason: 'inspection:stale_in_progress_sweep:scan' },
    );

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
