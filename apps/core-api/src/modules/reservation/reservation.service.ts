import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, Reservation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ReservationConfigService,
  type ReservationRules,
} from './reservation.config.js';

/**
 * Reservation domain service (ADR-0009).
 *
 * Entry points:
 *   * `create` — validates rules, runs conflict + blackout checks,
 *     decides auto-approve vs pending, writes the row + audit event.
 *   * `list` — owner-or-admin view; scope=mine|tenant.
 *   * `cancel` — requester or admin.
 *   * `approve` / `reject` — admins flip approval_status on PENDING rows.
 *
 * Conflict detection stays at service level for 0.2 (see ADR §Alternatives).
 * Wrapping the create path in SERIALIZABLE isolation serializes two
 * concurrent reservations on the same asset + overlapping window.
 */

export interface ReservationContext {
  tenantId: string;
  userId: string;
  role: string;
  isVip: boolean;
}

export interface CreateReservationParams {
  actor: ReservationContext;
  assetId: string | null;
  onBehalfUserId?: string;
  startAt: Date;
  endAt: Date;
  purpose?: string;
}

export interface CreateBasketParams {
  actor: ReservationContext;
  assetIds: string[];
  onBehalfUserId?: string;
  startAt: Date;
  endAt: Date;
  purpose?: string;
}

export interface CreateBasketResult {
  basketId: string;
  reservations: Reservation[];
}

export interface ListReservationsParams {
  actor: ReservationContext;
  scope: 'mine' | 'tenant';
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all';
  from?: Date;
  to?: Date;
  limit: number;
}

export interface CancelReservationParams {
  actor: ReservationContext;
  reservationId: string;
  reason?: string;
}

export interface ApprovalDecisionParams {
  actor: ReservationContext;
  reservationId: string;
  note?: string;
}

export interface CheckoutParams {
  actor: ReservationContext;
  reservationId: string;
  mileage?: number;
  condition?: string;
}

export interface CheckinParams {
  actor: ReservationContext;
  reservationId: string;
  mileage?: number;
  condition?: string;
  damageFlag?: boolean;
  damageNote?: string;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

function isAdmin(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

@Injectable()
export class ReservationService {
  private readonly log = new Logger('ReservationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cfg: ReservationConfigService,
  ) {}

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  async create(params: CreateReservationParams): Promise<Reservation> {
    const { actor, assetId, onBehalfUserId, startAt, endAt, purpose } = params;
    if (startAt >= endAt) throw new BadRequestException('start_must_be_before_end');

    // onBehalf authorisation: only auto-approve-role or VIP can create
    // on behalf of someone else. Drivers cannot forge reservations for
    // other people (ADR-0009 §Permissions).
    if (onBehalfUserId && onBehalfUserId !== actor.userId) {
      const rules = await this.loadRules(actor.tenantId);
      const canOnBehalf = rules.autoApproveRoles.includes(actor.role) || actor.isVip;
      if (!canOnBehalf) throw new ForbiddenException('cannot_reserve_on_behalf');
    }

    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: actor.tenantId },
          select: { reservationRules: true },
        });
        if (!tenant) throw new NotFoundException('tenant_not_found');
        const rules = this.cfg.fromJson(tenant.reservationRules);

        if (assetId) {
          const asset = await tx.asset.findUnique({
            where: { id: assetId },
            select: { id: true, tenantId: true, bookable: true, archivedAt: true, status: true },
          });
          if (!asset || asset.tenantId !== actor.tenantId) {
            throw new NotFoundException('asset_not_found');
          }
          if (asset.archivedAt) throw new BadRequestException('asset_archived');
          if (!asset.bookable) throw new BadRequestException('asset_not_bookable');
          if (asset.status === 'RETIRED' || asset.status === 'MAINTENANCE') {
            throw new ConflictException(`asset_not_available:${asset.status}`);
          }
        }

        if (onBehalfUserId) {
          const member = await tx.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId: actor.tenantId, userId: onBehalfUserId } },
            select: { status: true },
          });
          if (!member || member.status !== 'active') {
            throw new NotFoundException('on_behalf_user_not_found');
          }
        }

        this.enforceRulesAtCreate(rules, startAt, endAt, actor);

        // Concurrency cap — count the actor's (or on-behalf target's)
        // currently-alive reservations (not cancelled/returned/rejected/missed
        // and end in the future).
        if (rules.maxConcurrentPerUser > 0 && !rules.autoApproveRoles.includes(actor.role)) {
          const concurrency = await tx.reservation.count({
            where: {
              tenantId: actor.tenantId,
              OR: [
                { requesterUserId: onBehalfUserId ?? actor.userId },
                { onBehalfUserId: onBehalfUserId ?? actor.userId },
              ],
              approvalStatus: { in: ['PENDING_APPROVAL', 'AUTO_APPROVED', 'APPROVED'] },
              lifecycleStatus: { in: ['BOOKED', 'CHECKED_OUT'] },
              endAt: { gt: new Date() },
            },
          });
          if (concurrency >= rules.maxConcurrentPerUser) {
            throw new ConflictException(
              `max_concurrent_reservations:${rules.maxConcurrentPerUser}`,
            );
          }
        }

        if (assetId) {
          await this.assertNoOverlap(tx, actor.tenantId, assetId, startAt, endAt);
          await this.assertNoBlackout(tx, actor.tenantId, assetId, startAt, endAt);
        }

        const decision = this.decideApproval(rules, actor);

        const created = await tx.reservation.create({
          data: {
            tenantId: actor.tenantId,
            assetId: assetId ?? null,
            requesterUserId: actor.userId,
            onBehalfUserId: onBehalfUserId ?? null,
            startAt,
            endAt,
            purpose: purpose ?? null,
            approvalStatus: decision,
            lifecycleStatus: 'BOOKED',
            ...(decision === 'AUTO_APPROVED'
              ? { approverUserId: actor.userId, approvedAt: new Date() }
              : {}),
          },
        });

        await this.audit.recordWithin(tx, {
          action:
            decision === 'AUTO_APPROVED'
              ? 'panorama.reservation.auto_approved'
              : 'panorama.reservation.created',
          resourceType: 'reservation',
          resourceId: created.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            assetId: assetId ?? null,
            onBehalfUserId: onBehalfUserId ?? null,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            approvalStatus: decision,
          },
        });

        return created;
      },
      { reason: `reservation:create:${actor.tenantId}` },
    );
  }

  // ---------------------------------------------------------------------
  // Create basket (ADR-0009 option B)
  // ---------------------------------------------------------------------

  async createBasket(params: CreateBasketParams): Promise<CreateBasketResult> {
    const { actor } = params;
    if (params.assetIds.length === 0) {
      throw new BadRequestException('empty_basket');
    }
    if (new Set(params.assetIds).size !== params.assetIds.length) {
      throw new BadRequestException('duplicate_asset_ids');
    }
    if (params.startAt >= params.endAt) {
      throw new BadRequestException('start_must_be_before_end');
    }

    // On-behalf gating matches the single-create path.
    if (params.onBehalfUserId && params.onBehalfUserId !== actor.userId) {
      const rules = await this.loadRules(actor.tenantId);
      const canOnBehalf = rules.autoApproveRoles.includes(actor.role) || actor.isVip;
      if (!canOnBehalf) throw new ForbiddenException('cannot_reserve_on_behalf');
    }

    const basketId = randomUUID();

    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: actor.tenantId },
          select: { reservationRules: true },
        });
        if (!tenant) throw new NotFoundException('tenant_not_found');
        const rules = this.cfg.fromJson(tenant.reservationRules);

        this.enforceRulesAtCreate(rules, params.startAt, params.endAt, actor);

        if (params.onBehalfUserId) {
          const member = await tx.tenantMembership.findUnique({
            where: {
              tenantId_userId: { tenantId: actor.tenantId, userId: params.onBehalfUserId },
            },
            select: { status: true },
          });
          if (!member || member.status !== 'active') {
            throw new NotFoundException('on_behalf_user_not_found');
          }
        }

        // Per-user concurrency applies to the basket as a whole — a driver
        // with a max_concurrent of 2 cannot bypass the limit by creating a
        // basket of 10. Count the target user's current actives and the
        // basket's size against the cap.
        if (
          rules.maxConcurrentPerUser > 0 &&
          !rules.autoApproveRoles.includes(actor.role)
        ) {
          const concurrency = await tx.reservation.count({
            where: {
              tenantId: actor.tenantId,
              OR: [
                { requesterUserId: params.onBehalfUserId ?? actor.userId },
                { onBehalfUserId: params.onBehalfUserId ?? actor.userId },
              ],
              approvalStatus: { in: ['PENDING_APPROVAL', 'AUTO_APPROVED', 'APPROVED'] },
              lifecycleStatus: { in: ['BOOKED', 'CHECKED_OUT'] },
              endAt: { gt: new Date() },
            },
          });
          if (concurrency + params.assetIds.length > rules.maxConcurrentPerUser) {
            throw new ConflictException(
              `max_concurrent_reservations:${rules.maxConcurrentPerUser}`,
            );
          }
        }

        // Validate every asset + check every conflict + blackout BEFORE
        // writing anything — first failure rolls back the whole basket.
        for (const assetId of params.assetIds) {
          const asset = await tx.asset.findUnique({
            where: { id: assetId },
            select: { id: true, tenantId: true, bookable: true, archivedAt: true, status: true },
          });
          if (!asset || asset.tenantId !== actor.tenantId) {
            throw new NotFoundException(`asset_not_found:${assetId}`);
          }
          if (asset.archivedAt) throw new BadRequestException(`asset_archived:${assetId}`);
          if (!asset.bookable) throw new BadRequestException(`asset_not_bookable:${assetId}`);
          if (asset.status === 'RETIRED' || asset.status === 'MAINTENANCE') {
            throw new ConflictException(`asset_not_available:${assetId}:${asset.status}`);
          }
          await this.assertNoOverlap(tx, actor.tenantId, assetId, params.startAt, params.endAt);
          await this.assertNoBlackout(tx, actor.tenantId, assetId, params.startAt, params.endAt);
        }

        const decision = this.decideApproval(rules, actor);
        const createdAt = new Date();
        const rows: Reservation[] = [];
        for (const assetId of params.assetIds) {
          const row = await tx.reservation.create({
            data: {
              tenantId: actor.tenantId,
              assetId,
              basketId,
              requesterUserId: actor.userId,
              onBehalfUserId: params.onBehalfUserId ?? null,
              startAt: params.startAt,
              endAt: params.endAt,
              purpose: params.purpose ?? null,
              approvalStatus: decision,
              lifecycleStatus: 'BOOKED',
              ...(decision === 'AUTO_APPROVED'
                ? { approverUserId: actor.userId, approvedAt: createdAt }
                : {}),
            },
          });
          rows.push(row);
        }

        await this.audit.recordWithin(tx, {
          action: 'panorama.reservation.basket_created',
          resourceType: 'reservation_basket',
          resourceId: basketId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            basketId,
            size: rows.length,
            reservationIds: rows.map((r) => r.id),
            assetIds: params.assetIds,
            startAt: params.startAt.toISOString(),
            endAt: params.endAt.toISOString(),
            approvalStatus: decision,
          },
        });

        return { basketId, reservations: rows };
      },
      { reason: `reservation:createBasket:${actor.tenantId}` },
    );
  }

  // ---------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------

  async list(params: ListReservationsParams): Promise<Reservation[]> {
    const { actor, scope, status, from, to, limit } = params;
    if (scope === 'tenant' && !isAdmin(actor.role)) {
      throw new ForbiddenException('admin_role_required_for_tenant_scope');
    }

    const where: Prisma.ReservationWhereInput = { tenantId: actor.tenantId };
    if (scope === 'mine') {
      where.OR = [
        { requesterUserId: actor.userId },
        { onBehalfUserId: actor.userId },
      ];
    }
    const statusFilter = this.statusToWhereFragment(status);
    if (statusFilter) Object.assign(where, statusFilter);
    if (to) where.startAt = { lte: to };
    if (from) where.endAt = { gte: from };

    return this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.reservation.findMany({
          where,
          orderBy: [{ startAt: 'asc' }, { createdAt: 'asc' }],
          take: limit,
        }),
      { reason: `reservation:list:${actor.tenantId}` },
    );
  }

  // ---------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------

  async cancel(params: CancelReservationParams): Promise<Reservation> {
    const { actor, reservationId, reason } = params;
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        if (existing.lifecycleStatus === 'CANCELLED') return existing;
        if (existing.lifecycleStatus === 'RETURNED') {
          throw new BadRequestException('cannot_cancel_returned');
        }
        if (existing.lifecycleStatus === 'CHECKED_OUT') {
          throw new BadRequestException('cannot_cancel_checked_out');
        }
        const isRequester =
          existing.requesterUserId === actor.userId ||
          existing.onBehalfUserId === actor.userId;
        if (!isRequester && !isAdmin(actor.role)) {
          throw new ForbiddenException('not_allowed_to_cancel');
        }

        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            lifecycleStatus: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledByUserId: actor.userId,
            cancelReason: reason ?? null,
          },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.reservation.cancelled',
          resourceType: 'reservation',
          resourceId: reservationId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            reason: reason ?? null,
            wasApprovalStatus: existing.approvalStatus,
          },
        });
        return updated;
      },
      { reason: `reservation:cancel:${reservationId}` },
    );
  }

  // ---------------------------------------------------------------------
  // Approve / Reject
  // ---------------------------------------------------------------------

  async approve(params: ApprovalDecisionParams): Promise<Reservation> {
    return this.decide(params, 'APPROVED');
  }

  async reject(params: ApprovalDecisionParams): Promise<Reservation> {
    return this.decide(params, 'REJECTED');
  }

  private async decide(
    params: ApprovalDecisionParams,
    target: 'APPROVED' | 'REJECTED',
  ): Promise<Reservation> {
    const { actor, reservationId, note } = params;
    if (!isAdmin(actor.role)) {
      throw new ForbiddenException('admin_role_required');
    }
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        if (existing.approvalStatus !== 'PENDING_APPROVAL') {
          throw new BadRequestException(
            `not_pending:${existing.approvalStatus.toLowerCase()}`,
          );
        }
        if (existing.lifecycleStatus === 'CANCELLED') {
          throw new BadRequestException('already_cancelled');
        }

        // Re-check overlap at approval time — the asset may have been
        // double-booked by another approved reservation since the
        // requester submitted this one.
        if (target === 'APPROVED' && existing.assetId) {
          await this.assertNoOverlap(
            tx,
            actor.tenantId,
            existing.assetId,
            existing.startAt,
            existing.endAt,
            { ignoreId: existing.id },
          );
          await this.assertNoBlackout(
            tx,
            actor.tenantId,
            existing.assetId,
            existing.startAt,
            existing.endAt,
          );
        }

        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            approvalStatus: target,
            approverUserId: actor.userId,
            approvedAt: new Date(),
            approvalNote: note ?? null,
          },
        });
        await this.audit.recordWithin(tx, {
          action:
            target === 'APPROVED'
              ? 'panorama.reservation.approved'
              : 'panorama.reservation.rejected',
          resourceType: 'reservation',
          resourceId: reservationId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { note: note ?? null },
        });
        return updated;
      },
      { reason: `reservation:${target.toLowerCase()}:${reservationId}` },
    );
  }

  // ---------------------------------------------------------------------
  // Check-out / Check-in (ADR-0009 Part B)
  // ---------------------------------------------------------------------

  async checkOut(params: CheckoutParams): Promise<Reservation> {
    const { actor, reservationId } = params;
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        this.assertRequesterOrAdmin(existing, actor);
        if (
          existing.approvalStatus !== 'APPROVED' &&
          existing.approvalStatus !== 'AUTO_APPROVED'
        ) {
          throw new BadRequestException(
            `cannot_checkout_when_approval:${existing.approvalStatus.toLowerCase()}`,
          );
        }
        if (existing.lifecycleStatus !== 'BOOKED') {
          throw new BadRequestException(
            `cannot_checkout_when_lifecycle:${existing.lifecycleStatus.toLowerCase()}`,
          );
        }
        if (!existing.assetId) {
          throw new BadRequestException('no_asset_to_checkout');
        }

        const asset = await tx.asset.findUnique({
          where: { id: existing.assetId },
          select: { id: true, tenantId: true, status: true, archivedAt: true },
        });
        if (!asset || asset.tenantId !== actor.tenantId) {
          throw new NotFoundException('asset_not_found');
        }
        if (asset.archivedAt) throw new BadRequestException('asset_archived');
        if (asset.status !== 'READY' && asset.status !== 'RESERVED') {
          // RESERVED is acceptable — it means an earlier approval already
          // reserved the asset for this booking. READY is the default.
          throw new ConflictException(`asset_not_ready:${asset.status}`);
        }

        const now = new Date();
        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            lifecycleStatus: 'CHECKED_OUT',
            checkedOutAt: now,
            checkedOutByUserId: actor.userId,
            mileageOut: params.mileage ?? null,
            conditionOut: params.condition ?? null,
          },
        });
        await tx.asset.update({
          where: { id: asset.id },
          data: { status: 'IN_USE' },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.reservation.checked_out',
          resourceType: 'reservation',
          resourceId: reservationId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            assetId: asset.id,
            mileage: params.mileage ?? null,
            condition: params.condition ?? null,
          },
        });
        return updated;
      },
      { reason: `reservation:checkout:${reservationId}` },
    );
  }

  async checkIn(params: CheckinParams): Promise<Reservation> {
    const { actor, reservationId } = params;
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const existing = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.tenantId !== actor.tenantId) {
          throw new NotFoundException('reservation_not_found');
        }
        this.assertRequesterOrAdmin(existing, actor, {
          alsoAllow: existing.checkedOutByUserId,
        });
        if (existing.lifecycleStatus !== 'CHECKED_OUT') {
          throw new BadRequestException(
            `cannot_checkin_when_lifecycle:${existing.lifecycleStatus.toLowerCase()}`,
          );
        }
        if (!existing.assetId) {
          throw new BadRequestException('no_asset_to_checkin');
        }
        if (
          params.mileage !== undefined &&
          existing.mileageOut !== null &&
          existing.mileageOut !== undefined &&
          params.mileage < existing.mileageOut
        ) {
          throw new BadRequestException('mileage_not_monotonic');
        }

        const damageFlag = params.damageFlag ?? false;
        const nextAssetStatus = damageFlag ? 'MAINTENANCE' : 'READY';
        const now = new Date();

        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            lifecycleStatus: 'RETURNED',
            checkedInAt: now,
            checkedInByUserId: actor.userId,
            mileageIn: params.mileage ?? null,
            conditionIn: params.condition ?? null,
            damageFlag,
            damageNote: params.damageNote ?? null,
          },
        });
        await tx.asset.update({
          where: { id: existing.assetId },
          data: { status: nextAssetStatus },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.reservation.checked_in',
          resourceType: 'reservation',
          resourceId: reservationId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            assetId: existing.assetId,
            mileage: params.mileage ?? null,
            condition: params.condition ?? null,
            damageFlag,
            damageNote: params.damageNote ?? null,
            assetNextStatus: nextAssetStatus,
          },
        });
        return updated;
      },
      { reason: `reservation:checkin:${reservationId}` },
    );
  }

  private assertRequesterOrAdmin(
    reservation: { requesterUserId: string; onBehalfUserId: string | null },
    actor: ReservationContext,
    opts: { alsoAllow?: string | null } = {},
  ): void {
    if (isAdmin(actor.role)) return;
    if (reservation.requesterUserId === actor.userId) return;
    if (reservation.onBehalfUserId === actor.userId) return;
    if (opts.alsoAllow && opts.alsoAllow === actor.userId) return;
    throw new ForbiddenException('not_allowed');
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async loadRules(tenantId: string): Promise<ReservationRules> {
    const tenant = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { reservationRules: true },
        }),
      { reason: `reservation:loadRules:${tenantId}` },
    );
    return this.cfg.fromJson(tenant?.reservationRules);
  }

  private enforceRulesAtCreate(
    rules: ReservationRules,
    startAt: Date,
    endAt: Date,
    actor: ReservationContext,
  ): void {
    if (rules.autoApproveRoles.includes(actor.role)) return; // staff bypass

    const now = Date.now();
    if (rules.minNoticeHours > 0) {
      const minStart = now + rules.minNoticeHours * 3_600_000;
      if (startAt.getTime() < minStart) {
        throw new BadRequestException(`min_notice_hours:${rules.minNoticeHours}`);
      }
    }
    if (rules.maxDurationHours > 0) {
      const durationHours = (endAt.getTime() - startAt.getTime()) / 3_600_000;
      if (durationHours > rules.maxDurationHours) {
        throw new BadRequestException(`max_duration_hours:${rules.maxDurationHours}`);
      }
    }
  }

  private decideApproval(
    rules: ReservationRules,
    actor: ReservationContext,
  ): 'AUTO_APPROVED' | 'PENDING_APPROVAL' {
    if (rules.autoApproveRoles.includes(actor.role)) return 'AUTO_APPROVED';
    if (actor.isVip) return 'AUTO_APPROVED';
    return 'PENDING_APPROVAL';
  }

  /**
   * Half-open overlap check: two ranges conflict when
   *   existing.startAt < candidate.endAt AND existing.endAt > candidate.startAt
   * which lets back-to-back bookings (`[12:00, 14:00)` then `[14:00, 16:00)`)
   * coexist without false positives.
   *
   * `ignoreId` skips a specific row (for the re-check at approval time
   * — we're allowed to approve the row we're looking at).
   */
  private async assertNoOverlap(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assetId: string,
    startAt: Date,
    endAt: Date,
    opts: { ignoreId?: string } = {},
  ): Promise<void> {
    const overlap = await tx.reservation.findFirst({
      where: {
        tenantId,
        assetId,
        approvalStatus: { in: ['PENDING_APPROVAL', 'AUTO_APPROVED', 'APPROVED'] },
        lifecycleStatus: { in: ['BOOKED', 'CHECKED_OUT'] },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(opts.ignoreId ? { id: { not: opts.ignoreId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) {
      throw new ConflictException('reservation_conflict');
    }
  }

  private async assertNoBlackout(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assetId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<void> {
    const blackout = await tx.blackoutSlot.findFirst({
      where: {
        tenantId,
        OR: [{ assetId }, { assetId: null }],
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { id: true, title: true },
    });
    if (blackout) {
      throw new ConflictException(`blackout_conflict:${blackout.title}`);
    }
  }

  private statusToWhereFragment(
    status: ListReservationsParams['status'],
  ): Prisma.ReservationWhereInput | null {
    switch (status) {
      case 'all':
        return null;
      case 'open':
        return {
          approvalStatus: { in: ['PENDING_APPROVAL', 'AUTO_APPROVED', 'APPROVED'] },
          lifecycleStatus: { in: ['BOOKED', 'CHECKED_OUT'] },
        };
      case 'pending':
        return { approvalStatus: 'PENDING_APPROVAL' };
      case 'approved':
        return { approvalStatus: { in: ['AUTO_APPROVED', 'APPROVED'] } };
      case 'rejected':
        return { approvalStatus: 'REJECTED' };
      case 'cancelled':
        return { lifecycleStatus: 'CANCELLED' };
    }
  }
}
