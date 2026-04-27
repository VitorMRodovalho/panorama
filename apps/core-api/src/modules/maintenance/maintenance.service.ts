/**
 * MVP slice of the maintenance domain (ADR-0016 §2-3 + §7). Ships as
 * the floor of #74 (PILOT-03):
 *
 *   - openTicket  — admin or requester (when triggering reservation
 *                   is theirs) opens an OPEN ticket. Asset flips to
 *                   MAINTENANCE if not IN_USE; otherwise the
 *                   reservation is marked stranded and an
 *                   `opened_on_checked_out` audit row records it.
 *   - openTicketAuto — system-attributed entry point for the
 *                   MaintenanceTicketSubscriber (ADR-0016 §5). Same
 *                   ticket-creation + asset-state semantics as
 *                   openTicket, minus the user-authz checks. Idempotent
 *                   via the `existing OPEN/IN_PROGRESS` skip rule so
 *                   dispatcher retries cannot double-open. Caller passes
 *                   a tx and `tenant.systemActorUserId`.
 *   - list        — paginated, tenant-scoped, optional filters.
 *   - getById     — single ticket within tenant.
 *   - updateStatus — service-layer state machine:
 *                   OPEN → IN_PROGRESS → COMPLETED, OPEN → COMPLETED,
 *                   OPEN/IN_PROGRESS → CANCELLED.
 *                   On COMPLETED, the asset flips back to READY iff
 *                   no other open tickets remain.
 *
 * Deferred to follow-up PRs (ADR-0016 §4-9):
 *   - PM-due cron / mileage threshold sweep
 *   - Stranded-reservation auto-recovery
 *   - Reopen flow with within-window guard
 *   - Cluster-wide photo retention
 *   - Snipe-IT compat shim wiring
 *
 * RLS / tenant policy: all writes go through `runInTenant`. The
 * `runAsSuperAdmin` helper is **forbidden** in this module per the
 * ADR-0016 head-comment + grep gate (#58 allowlist).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AssetMaintenance, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { OpenTicketInput, UpdateStatusInput } from './maintenance.dto.js';

export interface MaintenanceContext {
  tenantId: string;
  userId: string;
  role: string;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

function isAdmin(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

export interface ListTicketsParams {
  actor: MaintenanceContext;
  status?: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  assetId?: string;
  assigneeUserId?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Input for the system-attributed auto-open path consumed by the
 * MaintenanceTicketSubscriber. Mirrors `OpenTicketInput` but trims the
 * fields the subscriber never sets (assignee, supplier, cost, …) and
 * adds the audit-trail metadata required by ADR-0016 §5.
 */
export interface AutoOpenTicketParams {
  tenantId: string;
  assetId: string;
  maintenanceType: 'Repair';
  title: string;
  notes: string | null;
  triggeringReservationId?: string;
  triggeringInspectionId?: string;
  /** `tenant.systemActorUserId` — the audit row's `actorUserId` is null
   *  (system-attributed), but the maintenance row needs a real FK. */
  createdByUserId: string;
  /** The human who triggered upstream — recorded in audit metadata so the
   *  chain ties back. ADR-0016 §5 `originalActorUserId`. */
  originalActorUserId: string;
  source: 'inspection_subscriber' | 'checkin_subscriber';
}

export type AutoOpenResult =
  | { status: 'opened'; ticketId: string }
  | { status: 'skipped'; reason: 'existing_open_ticket' | 'asset_archived' | 'asset_retired'; existingTicketId: string | null };

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async openTicket(
    actor: MaintenanceContext,
    input: OpenTicketInput,
  ): Promise<AssetMaintenance> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      // Confirm asset belongs to this tenant + is not RETIRED. RLS
      // already filters by tenant; the visible-not-found case is the
      // RETIRED + tenant-mismatch coalesced read.
      const asset = await tx.asset.findUnique({
        where: { id: input.assetId },
        select: { id: true, tenantId: true, status: true, archivedAt: true },
      });
      // tenantId equality is redundant under runInTenant + RLS — kept as
      // belt-and-braces so a future refactor that drops runInTenant
      // doesn't silently widen the scope.
      if (!asset || asset.tenantId !== actor.tenantId) {
        throw new NotFoundException('asset_not_found');
      }
      if (asset.archivedAt) throw new BadRequestException('asset_archived');
      if (asset.status === 'RETIRED') {
        throw new BadRequestException('asset_retired');
      }

      // Authorise: admin can open any; non-admin only when a triggering
      // reservation is theirs.
      if (!isAdmin(actor.role)) {
        // Security-reviewer blocker: non-admin openers cannot pass
        // `assigneeUserId`. Otherwise driver A could open a ticket on
        // their own reservation but elect driver B as assignee, and B
        // would gain rights to drive the ticket to COMPLETED — bypassing
        // the implicit "admin closes work the requester opened" rule.
        if (input.assigneeUserId) {
          throw new ForbiddenException('admin_role_required_for_assignee');
        }
        if (!input.triggeringReservationId) {
          throw new ForbiddenException('admin_role_required');
        }
        const triggering = await tx.reservation.findUnique({
          where: { id: input.triggeringReservationId },
          select: {
            tenantId: true,
            requesterUserId: true,
            onBehalfUserId: true,
            checkedOutByUserId: true,
            assetId: true,
          },
        });
        if (!triggering || triggering.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        const ownsReservation =
          triggering.requesterUserId === actor.userId ||
          triggering.onBehalfUserId === actor.userId ||
          triggering.checkedOutByUserId === actor.userId;
        if (!ownsReservation) {
          throw new ForbiddenException('not_reservation_owner');
        }
        if (triggering.assetId !== input.assetId) {
          throw new BadRequestException('reservation_asset_mismatch');
        }
      }

      // Cross-tenant FK guards exist as DB triggers (ADR-0016 §1
      // security-reviewer blocker #2) — but we still pre-check so
      // user-facing errors don't bubble up as raw Prisma errors.
      if (input.triggeringReservationId) {
        const r = await tx.reservation.findUnique({
          where: { id: input.triggeringReservationId },
          select: { tenantId: true },
        });
        if (!r || r.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
      }
      if (input.triggeringInspectionId) {
        const ins = await tx.inspection.findUnique({
          where: { id: input.triggeringInspectionId },
          select: { tenantId: true },
        });
        if (!ins || ins.tenantId !== actor.tenantId) {
          throw new NotFoundException('inspection_not_found');
        }
      }
      if (input.assigneeUserId) {
        const m = await tx.tenantMembership.findFirst({
          where: {
            tenantId: actor.tenantId,
            userId: input.assigneeUserId,
            status: 'active',
          },
          select: { id: true },
        });
        if (!m) throw new NotFoundException('assignee_not_in_tenant');
      }

      // HTML-escape `notes` per security-reviewer blocker #3 in
      // ADR-0016. Light escaping at write — display layer can decode if
      // needed but the column should never carry live HTML.
      const escapedNotes = input.notes ? escapeHtml(input.notes) : null;

      const created = await tx.assetMaintenance.create({
        data: {
          tenantId: actor.tenantId,
          assetId: input.assetId,
          maintenanceType: input.maintenanceType,
          title: input.title,
          status: 'OPEN',
          severity: input.severity ?? null,
          triggeringReservationId: input.triggeringReservationId ?? null,
          triggeringInspectionId: input.triggeringInspectionId ?? null,
          assigneeUserId: input.assigneeUserId ?? null,
          supplierName: input.supplierName ?? null,
          mileageAtService: input.mileageAtService ?? null,
          expectedReturnAt: input.expectedReturnAt
            ? new Date(input.expectedReturnAt)
            : null,
          cost: input.cost ?? null,
          isWarranty: input.isWarranty ?? false,
          notes: escapedNotes,
          createdByUserId: actor.userId,
        },
      });

      // Asset state integration (ADR-0016 §3):
      //  - asset IN_USE  → leave status; mark reservation stranded;
      //                    emit `opened_on_checked_out`.
      //  - otherwise     → flip to MAINTENANCE.
      let strandedReservationId: string | null = null;
      if (asset.status === 'IN_USE') {
        const inUse = await tx.reservation.findFirst({
          where: {
            tenantId: actor.tenantId,
            assetId: input.assetId,
            lifecycleStatus: 'CHECKED_OUT',
          },
          select: { id: true },
        });
        if (inUse) {
          strandedReservationId = inUse.id;
          await tx.reservation.update({
            where: { id: inUse.id },
            data: { isStranded: true },
          });
        }
      } else {
        await tx.asset.update({
          where: { id: input.assetId },
          data: { status: 'MAINTENANCE' },
        });
      }

      await this.audit.recordWithin(tx, {
        action: 'panorama.maintenance.opened',
        resourceType: 'asset_maintenance',
        resourceId: created.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          assetId: input.assetId,
          maintenanceType: input.maintenanceType,
          severity: input.severity ?? null,
          triggeringReservationId: input.triggeringReservationId ?? null,
          triggeringInspectionId: input.triggeringInspectionId ?? null,
          assetWasInUse: asset.status === 'IN_USE',
          strandedReservationId,
        },
      });
      if (asset.status === 'IN_USE' && strandedReservationId) {
        await this.audit.recordWithin(tx, {
          action: 'panorama.maintenance.opened_on_checked_out',
          resourceType: 'asset_maintenance',
          resourceId: created.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            assetId: input.assetId,
            strandedReservationId,
          },
        });
      }

      return created;
    });
  }

  async list(params: ListTicketsParams): Promise<{
    items: AssetMaintenance[];
    nextCursor: string | null;
  }> {
    const { actor, status, assetId, assigneeUserId } = params;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const items = await tx.assetMaintenance.findMany({
        where: {
          tenantId: actor.tenantId,
          ...(status ? { status } : {}),
          ...(assetId ? { assetId } : {}),
          ...(assigneeUserId ? { assigneeUserId } : {}),
        },
        // `id` tiebreaker so two rows with identical startedAt don't
        // race the cursor boundary (security-reviewer pagination note).
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      });
      const hasMore = items.length > limit;
      const trimmed = hasMore ? items.slice(0, limit) : items;
      const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;
      return { items: trimmed, nextCursor };
    });
  }

  async getById(actor: MaintenanceContext, id: string): Promise<AssetMaintenance> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const row = await tx.assetMaintenance.findUnique({ where: { id } });
      // tenantId equality is redundant under runInTenant + RLS —
      // belt-and-braces, see openTicket head-comment.
      if (!row || row.tenantId !== actor.tenantId) {
        throw new NotFoundException('maintenance_not_found');
      }
      return row;
    });
  }

  async updateStatus(
    actor: MaintenanceContext,
    id: string,
    input: UpdateStatusInput,
  ): Promise<AssetMaintenance> {
    // Completion-only fields can't ride along on non-COMPLETED
    // transitions — stops callers drifting state silently.
    if (input.status !== 'COMPLETED') {
      const stray = ['completionNote', 'nextServiceMileage', 'nextServiceDate', 'cost'].filter(
        (k) => (input as Record<string, unknown>)[k] !== undefined,
      );
      if (stray.length > 0) {
        throw new BadRequestException(
          `completion_fields_only_on_completed:${stray.join(',')}`,
        );
      }
    }

    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const existing = await tx.assetMaintenance.findUnique({ where: { id } });
      // tenantId equality is redundant under runInTenant + RLS —
      // belt-and-braces, see openTicket head-comment.
      if (!existing || existing.tenantId !== actor.tenantId) {
        throw new NotFoundException('maintenance_not_found');
      }

      // Authorise per ADR-0016 §2 transition matrix.
      const isAssignee =
        existing.assigneeUserId !== null && existing.assigneeUserId === actor.userId;
      const admin = isAdmin(actor.role);
      if (input.status === 'CANCELLED') {
        if (!admin) throw new ForbiddenException('admin_role_required');
      } else {
        if (!admin && !isAssignee) {
          throw new ForbiddenException('admin_or_assignee_required');
        }
      }

      // Service-layer state machine. The DB CHECK constraint is the
      // safety net; user-facing errors live here.
      const allowedNext: Record<string, string[]> = {
        OPEN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
        IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
        COMPLETED: [], // reopen is 0.4 follow-up
        CANCELLED: [],
      };
      if (!allowedNext[existing.status]!.includes(input.status)) {
        throw new ConflictException(
          `invalid_transition:${existing.status.toLowerCase()}_to_${input.status.toLowerCase()}`,
        );
      }

      const now = new Date();
      const data: Record<string, unknown> = { status: input.status };
      if (input.status === 'COMPLETED') {
        data['completedAt'] = now;
        data['completedByUserId'] = actor.userId;
        if (input.completionNote !== undefined) {
          data['completionNote'] = escapeHtml(input.completionNote);
        }
        if (input.nextServiceMileage !== undefined) {
          data['nextServiceMileage'] = input.nextServiceMileage;
        }
        if (input.nextServiceDate !== undefined) {
          data['nextServiceDate'] = new Date(input.nextServiceDate);
        }
        if (input.cost !== undefined) data['cost'] = input.cost;
      }

      const updated = await tx.assetMaintenance.update({
        where: { id },
        data,
      });

      // Asset-state flip on terminal transitions. Count-aware: only flip
      // back to READY if no other open ticket remains on this asset.
      // ADR-0016 §3 calls for SERIALIZABLE wrapping here; the runInTenant
      // default already runs single-statement-atomic; a follow-up will
      // promote to runTxWithRetry once the auto-suggest subscriber lands
      // (until then the race window is admin-only and trivially small).
      let assetFlipped: 'READY' | 'kept' = 'kept';
      if (input.status === 'COMPLETED' || input.status === 'CANCELLED') {
        const stillOpen = await tx.assetMaintenance.count({
          where: {
            tenantId: actor.tenantId,
            assetId: existing.assetId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
        });
        if (stillOpen === 0) {
          const asset = await tx.asset.findUnique({
            where: { id: existing.assetId },
            select: { status: true },
          });
          if (asset?.status === 'MAINTENANCE') {
            await tx.asset.update({
              where: { id: existing.assetId },
              data: { status: 'READY' },
            });
            assetFlipped = 'READY';
          }
        }
      }

      // If a stranded reservation still exists for this asset and the
      // ticket transitioned to a terminal state with no other open
      // tickets, clear isStranded so the driver returning the vehicle
      // doesn't see a sticky banner. (Recovery flow proper is 0.4 —
      // this is the basic clear-the-flag path.) Capture the cleared
      // reservation IDs for the audit row so a tenant admin can trace
      // which bookings transitioned without a dedicated event row.
      let strandedClearedReservationIds: string[] = [];
      if (
        (input.status === 'COMPLETED' || input.status === 'CANCELLED') &&
        assetFlipped === 'READY'
      ) {
        const toClear = await tx.reservation.findMany({
          where: {
            tenantId: actor.tenantId,
            assetId: existing.assetId,
            isStranded: true,
            lifecycleStatus: { in: ['BOOKED', 'CHECKED_OUT'] },
          },
          select: { id: true },
        });
        strandedClearedReservationIds = toClear.map((r) => r.id);
        if (strandedClearedReservationIds.length > 0) {
          await tx.reservation.updateMany({
            where: { id: { in: strandedClearedReservationIds } },
            data: { isStranded: false },
          });
        }
      }

      const action =
        input.status === 'IN_PROGRESS'
          ? 'panorama.maintenance.work_started'
          : input.status === 'COMPLETED'
            ? 'panorama.maintenance.completed'
            : 'panorama.maintenance.cancelled';

      await this.audit.recordWithin(tx, {
        action,
        resourceType: 'asset_maintenance',
        resourceId: id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          assetId: existing.assetId,
          fromStatus: existing.status,
          toStatus: input.status,
          assetFlipped,
          strandedClearedReservationIds,
          ...(input.status === 'COMPLETED'
            ? {
                completionNotePresent: input.completionNote !== undefined,
                nextServiceMileage: input.nextServiceMileage ?? null,
                nextServiceDate: input.nextServiceDate ?? null,
                cost: input.cost ?? null,
              }
            : {}),
        },
      });

      return updated;
    });
  }

  /**
   * System-attributed auto-open path (ADR-0016 §5). Called by
   * `MaintenanceTicketSubscriber` from inside its `runInTenant` scope —
   * caller supplies the `tx` so this nests, no separate transaction.
   *
   * Idempotency model: at most one OPEN/IN_PROGRESS ticket per asset.
   * If one already exists, this returns `skipped` with the existing
   * ticket id and audits `panorama.maintenance.auto_suggest_skipped`.
   * That covers two scenarios:
   *   1. Dispatcher retry of an event whose first invocation succeeded
   *      but failed to mark dispatched.
   *   2. A second upstream signal (e.g. damage check-in then FAIL
   *      inspection on the same asset) where one ticket is enough —
   *      ops can amend the existing ticket rather than juggle two.
   *
   * Asset-state flip and stranded-reservation marking match the public
   * `openTicket` shape so auto-suggested and manually-opened tickets are
   * indistinguishable to downstream consumers (banner UI, dashboards).
   *
   * The audit row carries `source` + `originalActorUserId` so the chain
   * remains traceable — without those fields every auto-suggested ticket
   * would attribute to "system" with no path back to the human signal.
   */
  async openTicketAuto(
    tx: Prisma.TransactionClient,
    params: AutoOpenTicketParams,
  ): Promise<AutoOpenResult> {
    const asset = await tx.asset.findUnique({
      where: { id: params.assetId },
      select: { id: true, tenantId: true, status: true, archivedAt: true },
    });
    // tenantId equality is redundant under the subscriber's runInTenant
    // RLS scope — kept as belt-and-braces so a future refactor does not
    // silently widen.
    if (!asset || asset.tenantId !== params.tenantId) {
      throw new NotFoundException('asset_not_found');
    }
    if (asset.archivedAt) {
      await this.audit.recordWithin(tx, {
        action: 'panorama.maintenance.auto_suggest_skipped',
        resourceType: 'asset',
        resourceId: params.assetId,
        tenantId: params.tenantId,
        actorUserId: null,
        metadata: {
          reason: 'asset_archived',
          source: params.source,
          triggeringInspectionId: params.triggeringInspectionId ?? null,
          triggeringReservationId: params.triggeringReservationId ?? null,
        },
      });
      return { status: 'skipped', reason: 'asset_archived', existingTicketId: null };
    }
    if (asset.status === 'RETIRED') {
      await this.audit.recordWithin(tx, {
        action: 'panorama.maintenance.auto_suggest_skipped',
        resourceType: 'asset',
        resourceId: params.assetId,
        tenantId: params.tenantId,
        actorUserId: null,
        metadata: {
          reason: 'asset_retired',
          source: params.source,
          triggeringInspectionId: params.triggeringInspectionId ?? null,
          triggeringReservationId: params.triggeringReservationId ?? null,
        },
      });
      return { status: 'skipped', reason: 'asset_retired', existingTicketId: null };
    }

    const existingOpen = await tx.assetMaintenance.findFirst({
      where: {
        tenantId: params.tenantId,
        assetId: params.assetId,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (existingOpen) {
      await this.audit.recordWithin(tx, {
        action: 'panorama.maintenance.auto_suggest_skipped',
        resourceType: 'asset_maintenance',
        resourceId: existingOpen.id,
        tenantId: params.tenantId,
        actorUserId: null,
        metadata: {
          reason: 'existing_open_ticket',
          assetId: params.assetId,
          source: params.source,
          triggeringInspectionId: params.triggeringInspectionId ?? null,
          triggeringReservationId: params.triggeringReservationId ?? null,
          originalActorUserId: params.originalActorUserId,
        },
      });
      return { status: 'skipped', reason: 'existing_open_ticket', existingTicketId: existingOpen.id };
    }

    const escapedNotes = params.notes ? escapeHtml(params.notes) : null;
    const created = await tx.assetMaintenance.create({
      data: {
        tenantId: params.tenantId,
        assetId: params.assetId,
        maintenanceType: params.maintenanceType,
        title: params.title,
        status: 'OPEN',
        triggeringReservationId: params.triggeringReservationId ?? null,
        triggeringInspectionId: params.triggeringInspectionId ?? null,
        notes: escapedNotes,
        createdByUserId: params.createdByUserId,
      },
    });

    let strandedReservationId: string | null = null;
    if (asset.status === 'IN_USE') {
      const inUse = await tx.reservation.findFirst({
        where: {
          tenantId: params.tenantId,
          assetId: params.assetId,
          lifecycleStatus: 'CHECKED_OUT',
        },
        select: { id: true },
      });
      if (inUse) {
        strandedReservationId = inUse.id;
        await tx.reservation.update({
          where: { id: inUse.id },
          data: { isStranded: true },
        });
      }
    } else {
      await tx.asset.update({
        where: { id: params.assetId },
        data: { status: 'MAINTENANCE' },
      });
    }

    await this.audit.recordWithin(tx, {
      action: 'panorama.maintenance.opened',
      resourceType: 'asset_maintenance',
      resourceId: created.id,
      tenantId: params.tenantId,
      // System-attributed: actorUserId null. The human chain lives in
      // `metadata.originalActorUserId` per ADR-0016 §5.
      actorUserId: null,
      metadata: {
        assetId: params.assetId,
        maintenanceType: params.maintenanceType,
        severity: null,
        triggeringReservationId: params.triggeringReservationId ?? null,
        triggeringInspectionId: params.triggeringInspectionId ?? null,
        assetWasInUse: asset.status === 'IN_USE',
        strandedReservationId,
        source: params.source,
        originalActorUserId: params.originalActorUserId,
      },
    });
    if (asset.status === 'IN_USE' && strandedReservationId) {
      await this.audit.recordWithin(tx, {
        action: 'panorama.maintenance.opened_on_checked_out',
        resourceType: 'asset_maintenance',
        resourceId: created.id,
        tenantId: params.tenantId,
        actorUserId: null,
        metadata: {
          assetId: params.assetId,
          strandedReservationId,
          source: params.source,
          originalActorUserId: params.originalActorUserId,
        },
      });
    }

    return { status: 'opened', ticketId: created.id };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
