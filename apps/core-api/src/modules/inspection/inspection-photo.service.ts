/**
 * InspectionPhotoService — photo upload + presigned-GET (ADR-0012 §4 + §3).
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * Same forbid as siblings — `runAsSuperAdmin` is OFF-LIMITS in this
 * module. Every Prisma write goes through `runInTenant`. The only
 * escape is `AuditService.record` (which lives outside this module).
 * --------------------------------------------------------------
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { InspectionPhoto, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ObjectStorageService } from '../object-storage/object-storage.service.js';
import { inspectionPhotoKey } from '../object-storage/object-storage.keys.js';
import {
  PhotoPipeline,
  PhotoTooLargePixelsError,
  PhotoUnsupportedTypeError,
  PhotoPipelineError,
} from '../photo-pipeline/photo-pipeline.service.js';
import { PhotoUploadRateLimiter } from '../photo-pipeline/photo-upload-rate-limiter.js';
import { RedisService } from '../redis/redis.service.js';
import { parseInspectionTenantConfig } from './inspection.config.js';

const ADMIN_ROLES = new Set(['owner', 'fleet_admin', 'fleet_staff']);

export interface PhotoActor {
  tenantId: string;
  userId: string;
  role: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface PhotoUploadInput {
  buffer: Buffer;
  originalFilename: string;
  /** Client-generated UUID — idempotency key scoped to inspection. */
  clientUploadKey: string;
  /** When set, must reference an existing response on this inspection. */
  responseId?: string;
}

export interface PhotoUploadResult {
  /** True when the existing row was returned via idempotency. */
  deduped: boolean;
  photo: InspectionPhoto;
  /** Presigned GET URL with detail-view TTL — caller can return inline. */
  signedUrl: string;
}

export type PhotoViewKind = 'list' | 'detail';

@Injectable()
export class InspectionPhotoService {
  private readonly log = new Logger('InspectionPhotoService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
    private readonly pipeline: PhotoPipeline,
    private readonly rateLimiter: PhotoUploadRateLimiter,
    private readonly redis: RedisService,
  ) {}

  // ----------------------------------------------------------------
  // upload
  // ----------------------------------------------------------------

  /**
   * runInTenant — driver-or-admin write. ADR §4 ordering:
   *   1. tenant-cap rate limiter (Redis, fails-closed)
   *   2. inspection lookup + auth
   *   3. SERIALIZABLE-isolation per-inspection cap check
   *   4. PhotoPipeline.process (sniff → metadata → sanitise → sha256)
   *   5. S3 PUT (overwriting any orphan from a prior partial)
   *   6. DB row + audit (in tx)
   *
   * Idempotency: 23505 on `(inspectionId, clientUploadKey)` triggers a
   * re-load + ownership check (uploadedByUserId == ctx.userId). On
   * mismatch we audit `panorama.inspection.photo.rejected` with
   * reason='upload_key_collision' and refuse with 409.
   */
  async upload(
    actor: PhotoActor,
    inspectionId: string,
    input: PhotoUploadInput,
  ): Promise<PhotoUploadResult> {
    if (!isValidUuid(input.clientUploadKey)) {
      throw new BadRequestException('clientUploadKey_must_be_uuid');
    }

    // 1. Rate limit (cluster-wide). Fails closed.
    const rl = await this.rateLimiter.check(actor.tenantId, actor.userId);
    if (!rl.allowed) {
      // Audit BEFORE throwing so a denied surge is forensically visible.
      await this.audit.record({
        action: 'panorama.inspection.photo.rejected',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          reason: 'rate_limited',
          bucket: rl.bucket ?? 'unknown',
          retryAfterSeconds: rl.retryAfterSeconds,
        },
      });
      throw new RateLimitedException(rl.retryAfterSeconds);
    }

    // 2. Inspection lookup + tenant isolation + auth + cap pre-fetch.
    const lookup = await this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await tx.inspection.findUnique({ where: { id: inspectionId } });
      if (!insp || insp.tenantId !== actor.tenantId) return null;
      if (insp.status !== 'IN_PROGRESS') {
        return { reason: 'inspection_not_in_progress' as const };
      }
      const isAdmin = ADMIN_ROLES.has(actor.role);
      if (!isAdmin && insp.startedByUserId !== actor.userId) {
        return { reason: 'forbidden' as const };
      }
      const tenant = await tx.tenant.findUnique({
        where: { id: actor.tenantId },
        select: { inspectionConfig: true },
      });
      const cfg = parseInspectionTenantConfig(tenant?.inspectionConfig);
      let response: { id: string } | null = null;
      if (input.responseId) {
        const r = await tx.inspectionResponse.findUnique({
          where: { id: input.responseId },
          select: { id: true, inspectionId: true, tenantId: true },
        });
        if (!r || r.inspectionId !== inspectionId || r.tenantId !== actor.tenantId) {
          return { reason: 'response_not_in_inspection' as const };
        }
        response = { id: r.id };
      }
      const currentCount = await tx.inspectionPhoto.count({
        where: { inspectionId, deletedAt: null },
      });
      return { insp, cfg, response, currentCount };
    });
    if (!lookup) throw new NotFoundException('inspection_not_found');
    if ('reason' in lookup) {
      switch (lookup.reason) {
        case 'inspection_not_in_progress':
          throw new ConflictException('inspection_not_in_progress');
        case 'forbidden':
          throw new ForbiddenException('not_inspection_starter');
        case 'response_not_in_inspection':
          throw new BadRequestException('response_not_in_inspection');
      }
    }
    const { insp, cfg, response, currentCount } = lookup;

    // 3. Per-inspection cap. Race-tolerant via SERIALIZABLE retry on
    //    the final write tx; pre-check here cuts the obvious case.
    if (currentCount >= cfg.maxPhotosPerInspection) {
      await this.audit.record({
        action: 'panorama.inspection.photo.rejected',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { reason: 'cap_reached', cap: cfg.maxPhotosPerInspection },
      });
      throw new ConflictException('inspection_photo_cap_reached');
    }

    // 4. Sanitise. Throws PhotoUnsupportedTypeError / TooLargePixels /
    //    ProcessingError; mapped to HTTP codes here.
    let sanitised;
    try {
      sanitised = await this.pipeline.process({
        buffer: input.buffer,
        maxDimensionOverride: cfg.maxPhotoDimension,
      });
    } catch (err) {
      if (err instanceof PhotoUnsupportedTypeError) {
        await this.audit.record({
          action: 'panorama.inspection.photo.rejected',
          resourceType: 'inspection',
          resourceId: inspectionId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { reason: 'unsupported_type', detectedMime: err.detectedMime },
        });
        throw new UnsupportedMediaTypeException('unsupported_media_type');
      }
      if (err instanceof PhotoTooLargePixelsError) {
        await this.audit.record({
          action: 'panorama.inspection.photo.processing_failed',
          resourceType: 'inspection',
          resourceId: inspectionId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { reason: 'limit_input_pixels', errorClass: err.errorClass },
        });
        throw new BadRequestException('photo_too_large_pixels');
      }
      if (err instanceof PhotoPipelineError) {
        await this.audit.record({
          action: 'panorama.inspection.photo.processing_failed',
          resourceType: 'inspection',
          resourceId: inspectionId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { reason: err.reason, errorClass: err.errorClass },
        });
        throw new BadRequestException('photo_processing_failed');
      }
      throw err;
    }

    // 5. S3 PUT — server-minted photoId becomes both the row PK and
    //    the storage key path component. Idempotent on the key (an
    //    earlier failed attempt's bytes get overwritten on retry).
    const photoId = randomUUID();
    const storageKey = inspectionPhotoKey(actor.tenantId, inspectionId, photoId);
    await this.storage.put(storageKey, sanitised.sanitisedBuffer, {
      contentType: sanitised.contentType,
      sha256: sanitised.sha256,
      tenantId: actor.tenantId,
    });

    // 6. DB row + audit in tx.
    try {
      const photo = await this.prisma.runInTenant(actor.tenantId, async (tx) => {
        const created = await tx.inspectionPhoto.create({
          data: {
            id: photoId,
            tenantId: actor.tenantId,
            inspectionId,
            responseId: response?.id ?? null,
            clientUploadKey: input.clientUploadKey,
            storageKey,
            contentType: sanitised.contentType,
            sizeBytes: sanitised.sizeBytes,
            sha256: sanitised.sha256,
            width: sanitised.width,
            height: sanitised.height,
            capturedAt: sanitised.capturedAt,
            exifStripped: sanitised.inputMetadataFields as unknown as Prisma.InputJsonValue,
            uploadedByUserId: actor.userId,
          },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.inspection.photo.uploaded',
          resourceType: 'inspection_photo',
          resourceId: created.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            inspectionId,
            reservationId: insp.reservationId,
            sizeBytes: created.sizeBytes,
            sha256: created.sha256,
            width: created.width,
            height: created.height,
            exifStripped: sanitised.exifStripped,
            capturedAt: created.capturedAt?.toISOString() ?? null,
            sourceMime: sanitised.sourceMime,
          },
        });
        return created;
      });
      const signedUrl = await this.storage.getSignedUrl(storageKey, {
        tenantId: actor.tenantId,
      });
      return { deduped: false, photo, signedUrl };
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        // Idempotency replay: same clientUploadKey on same inspection.
        // Verify ownership; if mismatch, refuse + audit.
        return this.handleIdempotencyReplay(actor, inspectionId, input, sanitised.sha256);
      }
      throw err;
    }
  }

  // ----------------------------------------------------------------
  // signed GET
  // ----------------------------------------------------------------

  /**
   * runInTenant — read. Verifies the photo belongs to the actor's
   * tenant + the actor can see the parent inspection; mints a
   * signed URL with appropriate TTL; emits viewed audit dedup-per-minute.
   */
  async getSignedUrlForView(
    actor: PhotoActor,
    inspectionId: string,
    photoId: string,
    viewKind: PhotoViewKind,
  ): Promise<string> {
    const { row, insp } = await this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const r = await tx.inspectionPhoto.findUnique({ where: { id: photoId } });
      if (!r || r.tenantId !== actor.tenantId || r.inspectionId !== inspectionId) {
        throw new NotFoundException('photo_not_found');
      }
      if (r.deletedAt !== null) {
        throw new NotFoundException('photo_not_found');
      }
      const i = await tx.inspection.findUnique({ where: { id: inspectionId } });
      if (!i || i.tenantId !== actor.tenantId) {
        throw new NotFoundException('photo_not_found');
      }
      const isAdmin = ADMIN_ROLES.has(actor.role);
      if (!isAdmin && i.startedByUserId !== actor.userId) {
        throw new NotFoundException('photo_not_found');
      }
      return { row: r, insp: i };
    });

    // assertKeyForTenant runs again here (storage.getSignedUrl will
    // re-call it internally too); explicit double-check is cheap and
    // keeps the surface intent visible.
    this.storage.assertKeyForTenant(row.storageKey, actor.tenantId);

    const ttl = viewKind === 'list' ? 60 : undefined;
    const signedUrl = await this.storage.getSignedUrl(row.storageKey, {
      tenantId: actor.tenantId,
      ...(ttl !== undefined ? { expiresIn: ttl } : {}),
      thumbnail: viewKind === 'list',
    });

    await this.maybeRecordView(actor, photoId, inspectionId, viewKind, insp.reservationId);
    return signedUrl;
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async handleIdempotencyReplay(
    actor: PhotoActor,
    inspectionId: string,
    input: PhotoUploadInput,
    incomingSha256: string,
  ): Promise<PhotoUploadResult> {
    const { existing } = await this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const e = await tx.inspectionPhoto.findUnique({
        where: {
          inspectionId_clientUploadKey: {
            inspectionId,
            clientUploadKey: input.clientUploadKey,
          },
        },
      });
      return { existing: e };
    });
    if (!existing) {
      // Race: row was deleted between insert + replay lookup.
      throw new ConflictException('upload_replay_race');
    }
    if (existing.uploadedByUserId !== actor.userId) {
      // The closed-existence-oracle behaviour from ADR §4: a
      // mismatched uploader on the same key is a probe, not a retry.
      await this.audit.record({
        action: 'panorama.inspection.photo.rejected',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          reason: 'upload_key_collision',
          incomingSha256,
          existingUploadedByUserId: existing.uploadedByUserId,
        },
      });
      throw new ConflictException('upload_key_collision');
    }
    const signedUrl = await this.storage.getSignedUrl(existing.storageKey, {
      tenantId: actor.tenantId,
    });
    return { deduped: true, photo: existing, signedUrl };
  }

  /**
   * Dedup-per-minute via Redis SETNX. The user → photo → viewKind
   * tuple keys the dedup window: 60 s for detail, 300 s for list
   * thumbnail. Skipping the audit row when SETNX fails keeps the
   * audit chain compact (a list scroll over 50 photos shouldn't
   * generate 50 rows).
   */
  private async maybeRecordView(
    actor: PhotoActor,
    photoId: string,
    inspectionId: string,
    viewKind: PhotoViewKind,
    reservationId: string | null,
  ): Promise<void> {
    const ttlSeconds = viewKind === 'list' ? 300 : 60;
    const key = `audit:photo-view:${actor.userId}:${photoId}:${viewKind}`;
    let shouldRecord = true;
    try {
      const reply = await this.redis.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      shouldRecord = reply === 'OK';
    } catch (err) {
      // Redis hiccup — record ANYWAY so a real view isn't lost.
      this.log.warn({ err: String(err) }, 'photo_view_dedup_redis_failed');
      shouldRecord = true;
    }
    if (!shouldRecord) return;
    await this.audit.record({
      action: 'panorama.inspection.photo.viewed',
      resourceType: 'inspection_photo',
      resourceId: photoId,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        inspectionId,
        reservationId,
        viewKind,
        ttlSeconds,
      },
    });
  }
}

/** 23505 = unique_violation; per Prisma client error code. */
function isPrismaUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'P2002';
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** 429 with a Retry-After header — Nest's HttpException class. */
import { HttpException, HttpStatus } from '@nestjs/common';
class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      { message: 'rate_limited', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// Re-export typed error so the controller can also map 413 explicitly.
export { PayloadTooLargeException };
