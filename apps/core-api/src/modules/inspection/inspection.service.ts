/**
 * InspectionService — lifecycle owner for ADR-0012 §Execution-order step 7b.
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * Every method here routes Prisma writes through
 * `prisma.runInTenant(tenantId, ...)`. `runAsSuperAdmin` is FORBIDDEN
 * — the only allowed escape is `AuditService.record` (which lives
 * outside this module). A grep gate enforces in 0.3; an ESLint
 * custom rule comes 0.4. Reviewer: if you see `runAsSuperAdmin`
 * or `tx.$executeRawUnsafe` in this file, BLOCK the diff.
 * --------------------------------------------------------------
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  Inspection,
  InspectionOutcome,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationService } from '../notification/notification.service.js';
import {
  parseInspectionTenantConfig,
  type InspectionTenantConfig,
} from './inspection.config.js';
import {
  InspectionSnapshotSchema,
  type InspectionSnapshot,
  type InspectionSnapshotItem,
} from './inspection-snapshot.schema.js';
import type {
  CancelInspectionInput,
  CompleteInspectionInput,
  ListInspectionsInput,
  RespondBatchInput,
  ReviewInspectionInput,
  ReviewNoteUpdateInput,
  StartInspectionInput,
} from './inspection.dto.js';

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);
const isAdmin = (role: string) => ADMIN_ROLES.has(role);

export interface InspectionActor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface StartResult {
  inspection: Inspection;
  resumed: boolean;
}

@Injectable()
export class InspectionService {
  private readonly log = new Logger('InspectionService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ----------------------------------------------------------------
  // start / resume
  // ----------------------------------------------------------------

  /**
   * runInTenant — driver-or-admin write. Resolves the template (or
   * uses the explicit `templateId`), then either resumes an
   * IN_PROGRESS inspection inside the stale window or writes a fresh
   * row with a snapshot.
   *
   * Resume guard is best-effort, not race-proof — two concurrent
   * `start` calls from the same driver on the same asset can both
   * skip resume and create two IN_PROGRESS rows. The next resume
   * call surfaces one of them; the other lingers until the
   * stale-cancel cron sweeps it (§9). Acceptable for 0.3.
   */
  async start(actor: InspectionActor, input: StartInspectionInput): Promise<StartResult> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: actor.tenantId },
        select: { inspectionConfig: true },
      });
      const cfg = parseInspectionTenantConfig(tenant?.inspectionConfig);

      const asset = await tx.asset.findUnique({
        where: { id: input.assetId },
        select: {
          tenantId: true,
          model: { select: { category: { select: { id: true, kind: true } } } },
        },
      });
      if (!asset || asset.tenantId !== actor.tenantId) {
        throw new NotFoundException('asset_not_found');
      }

      // Reservation tether: the actual gate lives in
      // ReservationService.checkOut (inline query per ADR §8). Here
      // we ONLY validate the optional reservationId belongs to this
      // tenant. Belt against an attacker passing a foreign UUID.
      if (input.reservationId) {
        const r = await tx.reservation.findUnique({
          where: { id: input.reservationId },
          select: { tenantId: true, assetId: true },
        });
        if (!r || r.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        if (r.assetId !== input.assetId) {
          throw new BadRequestException('reservation_asset_mismatch');
        }
      }

      // --- Resume? ---
      const cutoff = new Date(Date.now() - cfg.staleInProgressHours * 60 * 60 * 1000);
      const existing = await tx.inspection.findFirst({
        where: {
          tenantId: actor.tenantId,
          startedByUserId: actor.userId,
          assetId: input.assetId,
          status: 'IN_PROGRESS',
          startedAt: { gte: cutoff },
        },
        orderBy: { startedAt: 'desc' },
      });
      if (existing) {
        await this.audit.recordWithin(tx, {
          action: 'panorama.inspection.resumed',
          resourceType: 'inspection',
          resourceId: existing.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            secondsSinceStarted: Math.round(
              (Date.now() - existing.startedAt.getTime()) / 1000,
            ),
          },
        });
        return { inspection: existing, resumed: true };
      }

      // --- Resolve template ---
      const template = await this.resolveTemplate(tx, actor.tenantId, {
        templateId: input.templateId ?? null,
        categoryId: asset.model?.category?.id ?? null,
        categoryKind: asset.model?.category?.kind ?? null,
      });
      if (!template) {
        throw new NotFoundException('no_template_for_asset');
      }

      // --- Snapshot ---
      const snapshot = buildSnapshot(template);
      const snapshotParse = InspectionSnapshotSchema.safeParse(snapshot);
      if (!snapshotParse.success) {
        // Programmer error — the snapshot is generated server-side
        // from validated rows. Surface loudly.
        this.log.error(
          { templateId: template.id, issues: snapshotParse.error.issues },
          'snapshot_validation_failed',
        );
        throw new BadRequestException('snapshot_validation_failed');
      }

      const inspection = await tx.inspection.create({
        data: {
          tenantId: actor.tenantId,
          templateId: template.id,
          templateSnapshot: snapshotParse.data,
          assetId: input.assetId,
          reservationId: input.reservationId ?? null,
          startedByUserId: actor.userId,
        },
      });

      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.started',
        resourceType: 'inspection',
        resourceId: inspection.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          assetId: inspection.assetId,
          templateId: template.id,
          reservationId: inspection.reservationId,
          snapshotItemCount: snapshot.items.length,
          templateVersionAt: snapshot.templateVersionAt,
        },
      });

      return { inspection, resumed: false };
    });
  }

  // ----------------------------------------------------------------
  // respond — batch upsert against snapshot
  // ----------------------------------------------------------------

  /**
   * runInTenant — driver-or-admin write on IN_PROGRESS rows.
   * Validates each `snapshotItemId` exists in the inspection's
   * snapshot (the DB trigger is the load-bearing belt; this is
   * the user-facing braces with a clean 400 message).
   */
  async respond(
    actor: InspectionActor,
    inspectionId: string,
    input: RespondBatchInput,
  ): Promise<{ count: number }> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await this.loadInspectionForWrite(tx, actor, inspectionId);
      if (insp.status !== 'IN_PROGRESS') {
        throw new ConflictException('inspection_not_in_progress');
      }
      const snapshot = parseSnapshot(insp.templateSnapshot);
      const idSet = new Set(snapshot.items.map((it) => it.id));
      for (const r of input.responses) {
        if (!idSet.has(r.snapshotItemId)) {
          throw new BadRequestException('snapshot_item_id_not_in_snapshot');
        }
      }
      // Per-item value-shape check: NUMBER carries numberValue, etc.
      for (const r of input.responses) {
        const item = snapshot.items.find((it) => it.id === r.snapshotItemId)!;
        validateResponseShape(item, r);
      }

      // Upsert each response against the unique (inspectionId, snapshotItemId).
      let count = 0;
      for (const r of input.responses) {
        await tx.inspectionResponse.upsert({
          where: {
            inspectionId_snapshotItemId: {
              inspectionId,
              snapshotItemId: r.snapshotItemId,
            },
          },
          create: {
            tenantId: actor.tenantId,
            inspectionId,
            snapshotItemId: r.snapshotItemId,
            booleanValue: r.booleanValue ?? null,
            textValue: r.textValue ?? null,
            numberValue: r.numberValue ?? null,
            note: r.note ?? null,
          },
          update: {
            booleanValue: r.booleanValue ?? null,
            textValue: r.textValue ?? null,
            numberValue: r.numberValue ?? null,
            note: r.note ?? null,
          },
        });
        count++;
      }
      return { count };
    });
  }

  // ----------------------------------------------------------------
  // complete
  // ----------------------------------------------------------------

  /**
   * runInTenant — driver-or-admin write. Validates required items
   * have a response (or photo for PHOTO items) before flipping
   * status. Enqueues `panorama.inspection.completed` in the same
   * tx so the notification commits atomically with the status flip.
   */
  async complete(
    actor: InspectionActor,
    inspectionId: string,
    input: CompleteInspectionInput,
  ): Promise<Inspection> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await this.loadInspectionForWrite(tx, actor, inspectionId);
      if (insp.status !== 'IN_PROGRESS') {
        throw new ConflictException('inspection_not_in_progress');
      }

      const snapshot = parseSnapshot(insp.templateSnapshot);
      const responses = await tx.inspectionResponse.findMany({
        where: { inspectionId },
        select: { snapshotItemId: true },
      });
      const respondedIds = new Set(responses.map((r) => r.snapshotItemId));

      const photos = await tx.inspectionPhoto.count({
        where: { inspectionId, deletedAt: null },
      });
      // Pre-fetch which snapshotItem each non-deleted photo references —
      // used for photoRequired item enforcement below.
      const photoItemRows = await tx.inspectionPhoto.findMany({
        where: { inspectionId, deletedAt: null, responseId: { not: null } },
        select: { responseId: true },
      });
      const responsesWithPhotos = new Set(
        photoItemRows.map((p) => p.responseId).filter(Boolean) as string[],
      );

      const missing: string[] = [];
      for (const it of snapshot.items) {
        if (it.required && it.itemType !== 'PHOTO' && !respondedIds.has(it.id)) {
          missing.push(it.label);
        }
        if (it.photoRequired || it.itemType === 'PHOTO') {
          // PHOTO item: must have at least one photo attached to the
          // response row for this item.
          const responseRow = await tx.inspectionResponse.findUnique({
            where: {
              inspectionId_snapshotItemId: {
                inspectionId,
                snapshotItemId: it.id,
              },
            },
            select: { id: true },
          });
          if (!responseRow || !responsesWithPhotos.has(responseRow.id)) {
            missing.push(`${it.label} (photo required)`);
          }
        }
      }
      if (missing.length > 0) {
        throw new BadRequestException(
          `required_items_missing:${missing.slice(0, 5).join('|')}`,
        );
      }

      const completed = await tx.inspection.update({
        where: { id: inspectionId },
        data: {
          status: 'COMPLETED',
          outcome: input.outcome,
          summaryNote: input.summaryNote ?? null,
          completedAt: new Date(),
          completedByUserId: actor.userId,
        },
      });

      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.completed',
        resourceType: 'inspection',
        resourceId: completed.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          outcome: completed.outcome,
          responseCount: responses.length,
          photoCount: photos,
          summaryNote: completed.summaryNote,
          reservationId: completed.reservationId,
        },
      });

      // Notification: same tx as the status flip — see the
      // inspection-outcome-email channel (step 6) for the consumer.
      // PASS events are still enqueued; the channel itself decides
      // whether to send.
      await this.notifications.enqueueWithin(tx, {
        eventType: 'panorama.inspection.completed',
        tenantId: actor.tenantId,
        payload: {
          inspectionId: completed.id,
          assetId: completed.assetId,
          reservationId: completed.reservationId,
          startedByUserId: completed.startedByUserId,
          outcome: completed.outcome!,
          photoCount: photos,
          responseCount: responses.length,
          ...(completed.summaryNote ? { summaryNote: completed.summaryNote } : {}),
        },
      });

      return completed;
    });
  }

  // ----------------------------------------------------------------
  // review (admin-only) — close-out + reviewNote append
  // ----------------------------------------------------------------

  /**
   * runInTenant — admin write. Conditional on `reviewedAt IS NULL`
   * to prevent the double-approval bug. The non-null reviewNote is
   * appendable later via `updateReviewNote` for body-shop follow-up.
   */
  async review(
    actor: InspectionActor,
    inspectionId: string,
    input: ReviewInspectionInput,
  ): Promise<Inspection> {
    if (!isAdmin(actor.role)) throw new ForbiddenException('admin_role_required');
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await this.loadInspectionForRead(tx, actor, inspectionId);
      if (insp.status !== 'COMPLETED') {
        throw new ConflictException('inspection_not_completed');
      }
      if (insp.reviewedAt !== null) {
        throw new ConflictException('inspection_already_reviewed');
      }

      // Conditional update — relies on the WHERE clause matching the
      // pre-read state to defeat the two-admins-clicking-Close race.
      const updated = await tx.inspection.updateMany({
        where: { id: inspectionId, reviewedAt: null },
        data: {
          reviewedAt: new Date(),
          reviewedByUserId: actor.userId,
          reviewNote: input.reviewNote ?? null,
        },
      });
      if (updated.count !== 1) {
        // Lost the race — another admin reviewed between findUnique
        // and updateMany. Surface as 409 so the UI can refresh.
        throw new ConflictException('inspection_already_reviewed');
      }

      const fresh = await tx.inspection.findUniqueOrThrow({ where: { id: inspectionId } });

      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.reviewed',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          reviewerUserId: actor.userId,
          reviewNote: fresh.reviewNote,
          outcome: fresh.outcome,
        },
      });
      return fresh;
    });
  }

  /** runInTenant — admin write. Appends / updates `reviewNote` post-review. */
  async updateReviewNote(
    actor: InspectionActor,
    inspectionId: string,
    input: ReviewNoteUpdateInput,
  ): Promise<Inspection> {
    if (!isAdmin(actor.role)) throw new ForbiddenException('admin_role_required');
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await this.loadInspectionForRead(tx, actor, inspectionId);
      if (insp.reviewedAt === null) {
        throw new ConflictException('inspection_not_yet_reviewed');
      }
      const prev = insp.reviewNote ?? '';
      const updated = await tx.inspection.update({
        where: { id: inspectionId },
        data: { reviewNote: input.reviewNote },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.review_note_updated',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { prevLen: prev.length, newLen: input.reviewNote.length },
      });
      return updated;
    });
  }

  // ----------------------------------------------------------------
  // cancel
  // ----------------------------------------------------------------

  async cancel(
    actor: InspectionActor,
    inspectionId: string,
    input: CancelInspectionInput,
  ): Promise<Inspection> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const insp = await this.loadInspectionForWrite(tx, actor, inspectionId);
      if (insp.status === 'CANCELLED') return insp;
      if (insp.status === 'COMPLETED') {
        throw new ConflictException('inspection_already_completed');
      }
      const updated = await tx.inspection.update({
        where: { id: inspectionId },
        data: { status: 'CANCELLED' },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.cancelled',
        resourceType: 'inspection',
        resourceId: inspectionId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { reason: input.reason ?? null },
      });
      return updated;
    });
  }

  // ----------------------------------------------------------------
  // reads
  // ----------------------------------------------------------------

  async list(
    actor: InspectionActor,
    input: ListInspectionsInput,
  ): Promise<Inspection[]> {
    if (input.scope === 'tenant' && !isAdmin(actor.role)) {
      throw new ForbiddenException('admin_role_required_for_tenant_scope');
    }
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const where: Prisma.InspectionWhereInput = { tenantId: actor.tenantId };
      if (input.scope === 'mine') where.startedByUserId = actor.userId;
      if (input.status !== 'all') where.status = input.status;
      if (input.outcome !== 'all') where.outcome = input.outcome;
      if (input.assetId) where.assetId = input.assetId;
      if (input.reservationId) where.reservationId = input.reservationId;
      if (input.needsReview) {
        where.status = 'COMPLETED';
        where.reviewedAt = null;
        where.outcome = { in: ['FAIL', 'NEEDS_MAINTENANCE'] };
      }
      return tx.inspection.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: input.limit,
      });
    });
  }

  async get(actor: InspectionActor, inspectionId: string): Promise<Inspection> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      return this.loadInspectionForRead(tx, actor, inspectionId);
    });
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  /**
   * Read-only load with auth guard:
   *   - tenant boundary (RLS belt)
   *   - actor must be admin OR the starter
   */
  private async loadInspectionForRead(
    tx: Prisma.TransactionClient,
    actor: InspectionActor,
    inspectionId: string,
  ): Promise<Inspection> {
    const insp = await tx.inspection.findUnique({ where: { id: inspectionId } });
    if (!insp || insp.tenantId !== actor.tenantId) {
      throw new NotFoundException('inspection_not_found');
    }
    if (!isAdmin(actor.role) && insp.startedByUserId !== actor.userId) {
      throw new NotFoundException('inspection_not_found');
    }
    return insp;
  }

  /**
   * Write-side load: same auth as read; additionally any non-admin
   * write must be the original starter (driver can't poke a peer's
   * inspection).
   */
  private async loadInspectionForWrite(
    tx: Prisma.TransactionClient,
    actor: InspectionActor,
    inspectionId: string,
  ): Promise<Inspection> {
    const insp = await this.loadInspectionForRead(tx, actor, inspectionId);
    if (!isAdmin(actor.role) && insp.startedByUserId !== actor.userId) {
      throw new ForbiddenException('not_inspection_starter');
    }
    return insp;
  }

  /**
   * Resolves the template to use for a fresh inspection:
   *  - explicit `templateId` if supplied (verify in tenant + not archived)
   *  - else by `categoryId` (precedence)
   *  - else by `categoryKind`
   *  - returns null if nothing matches
   */
  private async resolveTemplate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scope: { templateId: string | null; categoryId: string | null; categoryKind: string | null },
  ): Promise<TemplateForSnapshot | null> {
    if (scope.templateId) {
      const t = await tx.inspectionTemplate.findUnique({
        where: { id: scope.templateId },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (!t || t.tenantId !== tenantId) {
        throw new NotFoundException('template_not_found');
      }
      if (t.archivedAt) {
        throw new ConflictException('template_archived');
      }
      return t;
    }
    if (scope.categoryId) {
      const t = await tx.inspectionTemplate.findFirst({
        where: { tenantId, categoryId: scope.categoryId, archivedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (t) return t;
    }
    if (scope.categoryKind) {
      const t = await tx.inspectionTemplate.findFirst({
        where: {
          tenantId,
          categoryKind: scope.categoryKind as never,
          archivedAt: null,
        },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (t) return t;
    }
    return null;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface TemplateForSnapshot {
  id: string;
  name: string;
  description: string | null;
  updatedAt: Date;
  items: Array<{
    id: string;
    position: number;
    label: string;
    itemType: 'BOOLEAN' | 'TEXT' | 'NUMBER' | 'PHOTO';
    required: boolean;
    photoRequired: boolean;
    minValue: number | null;
    maxValue: number | null;
    helpText: string | null;
  }>;
}

function buildSnapshot(t: TemplateForSnapshot): InspectionSnapshot {
  return {
    name: t.name,
    description: t.description,
    templateVersionAt: t.updatedAt.toISOString(),
    items: t.items.map<InspectionSnapshotItem>((it) => ({
      id: it.id,
      position: it.position,
      label: it.label,
      itemType: it.itemType,
      required: it.required,
      photoRequired: it.photoRequired,
      minValue: it.minValue,
      maxValue: it.maxValue,
      helpText: it.helpText,
    })),
  };
}

function parseSnapshot(raw: unknown): InspectionSnapshot {
  const parsed = InspectionSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    // Snapshot was invariant-broken at write time OR a super-admin
    // break-glass write left it malformed. Surface a 500 — caller
    // can't recover; super-admin must intervene.
    throw new Error(`invalid_snapshot:${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data;
}

function validateResponseShape(
  item: InspectionSnapshotItem,
  resp: {
    booleanValue?: boolean | null | undefined;
    textValue?: string | null | undefined;
    numberValue?: number | null | undefined;
  },
): void {
  switch (item.itemType) {
    case 'BOOLEAN':
      if (resp.booleanValue == null) {
        throw new BadRequestException(`response_missing_booleanValue:${item.id}`);
      }
      break;
    case 'TEXT':
      if (resp.textValue == null || resp.textValue.length === 0) {
        if (item.required) {
          throw new BadRequestException(`response_missing_textValue:${item.id}`);
        }
      }
      break;
    case 'NUMBER': {
      if (resp.numberValue == null) {
        throw new BadRequestException(`response_missing_numberValue:${item.id}`);
      }
      if (item.minValue != null && resp.numberValue < item.minValue) {
        throw new BadRequestException(`response_below_min:${item.id}`);
      }
      if (item.maxValue != null && resp.numberValue > item.maxValue) {
        throw new BadRequestException(`response_above_max:${item.id}`);
      }
      break;
    }
    case 'PHOTO':
      // Value carried by the photo upload, not the response shape.
      break;
  }
}

// Re-export for the controller / tests.
export type { InspectionTenantConfig };
