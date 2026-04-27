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
import { NotificationService } from '../notification/notification.service.js';
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

export interface BasketBatchParams {
  actor: ReservationContext;
  basketId: string;
  note?: string;
  reason?: string;
}

export interface BasketBatchResult {
  basketId: string;
  processed: Array<{ reservationId: string; outcome: 'approved' | 'rejected' | 'cancelled' }>;
  skipped: Array<{ reservationId: string; reason: string }>;
}

export interface CheckoutParams {
  actor: ReservationContext;
  reservationId: string;
  // Required at the API boundary (OPS-02 / #32) — DOT 49 CFR + ADR-0016
  // PM-due cron both depend on real numbers.
  mileage: number;
  condition?: string;
}

export interface CheckinParams {
  actor: ReservationContext;
  reservationId: string;
  mileage: number;
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
    private readonly notifications: NotificationService,
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

    return this.prisma.runInTenant(
      actor.tenantId,
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
      { isolationLevel: 'Serializable' },
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

    return this.prisma.runInTenant(
      actor.tenantId,
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

          // Per-row audit event so queries by resourceType=reservation
          // catch basket rows the same way they catch single-asset
          // creates. The basket-level event below still fires for
          // "what baskets exist" audit slices.
          await this.audit.recordWithin(tx, {
            action:
              decision === 'AUTO_APPROVED'
                ? 'panorama.reservation.auto_approved'
                : 'panorama.reservation.created',
            resourceType: 'reservation',
            resourceId: row.id,
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            metadata: {
              assetId,
              basketId,
              onBehalfUserId: params.onBehalfUserId ?? null,
              startAt: params.startAt.toISOString(),
              endAt: params.endAt.toISOString(),
              approvalStatus: decision,
            },
          });
        }

        // Basket-level event — one row summarising the whole creation.
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
      { isolationLevel: 'Serializable' },
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

    return this.prisma.runInTenant(
      actor.tenantId,
      (tx) =>
        tx.reservation.findMany({
          where,
          orderBy: [{ startAt: 'asc' }, { createdAt: 'asc' }],
          take: limit,
        }),
    );
  }

  // ---------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------

  async cancel(params: CancelReservationParams): Promise<Reservation> {
    return this.prisma.runInTenant(
      params.actor.tenantId,
      (tx) => this.cancelWithin(tx, params),
    );
  }

  /**
   * Per-row cancel body shared by the single-row endpoint and
   * `cancelBasket`. Caller owns the transaction + any authorisation
   * gate above the basket level. This method still enforces the
   * per-row authorisation (requester / onBehalf / admin) so a
   * mis-used call site can't cancel a row it shouldn't.
   */
  private async cancelWithin(
    tx: Prisma.TransactionClient,
    params: CancelReservationParams,
  ): Promise<Reservation> {
    const { actor, reservationId, reason } = params;
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
    if (!isAdmin(params.actor.role)) {
      throw new ForbiddenException('admin_role_required');
    }
    return this.prisma.runInTenant(
      params.actor.tenantId,
      (tx) => this.decideWithin(tx, params, target),
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Per-row approve/reject body shared by the single-row endpoint and
   * `approveBasket` / `rejectBasket`. Caller owns the transaction and
   * the admin-role check. Throws `BadRequestException` / `ConflictException`
   * on skippable preconditions so batch callers can catch and record
   * a per-row skip reason.
   */
  private async decideWithin(
    tx: Prisma.TransactionClient,
    params: ApprovalDecisionParams,
    target: 'APPROVED' | 'REJECTED',
  ): Promise<Reservation> {
    const { actor, reservationId, note } = params;
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
    const action =
      target === 'APPROVED'
        ? 'panorama.reservation.approved'
        : 'panorama.reservation.rejected';
    await this.audit.recordWithin(tx, {
      action,
      resourceType: 'reservation',
      resourceId: reservationId,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      metadata: { note: note ?? null },
    });
    // Fan-out via the notification bus (ADR-0011). Same tx so the
    // event emit is atomic with the decision — rollback takes it
    // with the domain write. dedupKey prevents double-email on a
    // racing approve+re-approve.
    await this.notifications.enqueueWithin(tx, {
      eventType: action,
      tenantId: actor.tenantId,
      dedupKey: `${action}:${reservationId}`,
      payload: {
        reservationId,
        assetId: updated.assetId,
        requesterUserId: updated.requesterUserId,
        approverUserId: actor.userId,
        startAt: updated.startAt.toISOString(),
        endAt: updated.endAt.toISOString(),
        ...(note ? { note } : {}),
      },
    });
    return updated;
  }

  // ---------------------------------------------------------------------
  // Basket batch decisions (ADR-0009 §"Basket batch decisions")
  // ---------------------------------------------------------------------
  //
  // Single-tx best-effort semantics: each eligible row transitions, each
  // ineligible row is recorded as skipped with a machine-readable reason.
  // Audit emits per-row events (symmetry with single-row approve/reject/
  // cancel) plus one envelope event per basket carrying the full
  // processed/skipped vector so an on-call at 3am finds everything with
  // a single query on `panorama.reservation.basket_*`.

  async approveBasket(params: BasketBatchParams): Promise<BasketBatchResult> {
    if (!isAdmin(params.actor.role)) {
      throw new ForbiddenException('admin_role_required');
    }
    return this.runBasketBatch(params, 'APPROVED');
  }

  async rejectBasket(params: BasketBatchParams): Promise<BasketBatchResult> {
    if (!isAdmin(params.actor.role)) {
      throw new ForbiddenException('admin_role_required');
    }
    return this.runBasketBatch(params, 'REJECTED');
  }

  async cancelBasket(params: BasketBatchParams): Promise<BasketBatchResult> {
    return this.runBasketBatch(params, 'CANCELLED');
  }

  private async runBasketBatch(
    params: BasketBatchParams,
    operation: 'APPROVED' | 'REJECTED' | 'CANCELLED',
  ): Promise<BasketBatchResult> {
    const { actor, basketId, note, reason } = params;
    await this.assertBatchEnabled(actor.tenantId);

    return this.prisma.runInTenant(
      actor.tenantId,
      async (tx) => {
        const rows = await tx.reservation.findMany({
          where: { tenantId: actor.tenantId, basketId },
          orderBy: { id: 'asc' },
        });
        if (rows.length === 0) throw new NotFoundException('basket_not_found');

        // cancel-specific authorisation: non-admins must be
        // requester/onBehalf on EVERY row of the basket. Baskets today
        // are always single-requester by construction (createBasket
        // copies the actor's id to every row); this defensive check
        // closes the "one row not mine" leak surfaced in tech-lead
        // review — a non-admin never learns the composition of a
        // basket they don't fully own.
        if (operation === 'CANCELLED' && !isAdmin(actor.role)) {
          const notMine = rows.find(
            (r) =>
              r.requesterUserId !== actor.userId &&
              r.onBehalfUserId !== actor.userId,
          );
          if (notMine) {
            throw new ForbiddenException('not_allowed_to_cancel');
          }
        }

        const processed: BasketBatchResult['processed'] = [];
        const skipped: BasketBatchResult['skipped'] = [];

        for (const row of rows) {
          try {
            if (operation === 'CANCELLED') {
              // cancelWithin is idempotent on already-cancelled rows;
              // treat "already cancelled" and "returned / checked-out"
              // as a skip so a mixed basket (1 checked-out, 2 booked)
              // still cancels the 2 bookable rows.
              if (row.lifecycleStatus === 'CANCELLED') {
                skipped.push({ reservationId: row.id, reason: 'already_cancelled' });
                continue;
              }
              if (row.lifecycleStatus === 'RETURNED') {
                skipped.push({ reservationId: row.id, reason: 'cannot_cancel_returned' });
                continue;
              }
              if (row.lifecycleStatus === 'CHECKED_OUT') {
                skipped.push({ reservationId: row.id, reason: 'cannot_cancel_checked_out' });
                continue;
              }
              const rowParams: CancelReservationParams = { actor, reservationId: row.id };
              if (reason) rowParams.reason = reason;
              await this.cancelWithin(tx, rowParams);
              processed.push({ reservationId: row.id, outcome: 'cancelled' });
            } else {
              // approve / reject — per-row predicate check before the
              // write so we don't burn a re-check overlap probe on
              // rows that are already decided.
              if (row.approvalStatus !== 'PENDING_APPROVAL') {
                skipped.push({
                  reservationId: row.id,
                  reason: `not_pending:${row.approvalStatus.toLowerCase()}`,
                });
                continue;
              }
              if (row.lifecycleStatus === 'CANCELLED') {
                skipped.push({ reservationId: row.id, reason: 'already_cancelled' });
                continue;
              }
              const rowParams: ApprovalDecisionParams = { actor, reservationId: row.id };
              if (note) rowParams.note = note;
              await this.decideWithin(tx, rowParams, operation);
              processed.push({
                reservationId: row.id,
                outcome: operation === 'APPROVED' ? 'approved' : 'rejected',
              });
            }
          } catch (err) {
            // ConflictException = re-check overlap or blackout fired
            // on this row; BadRequestException = lifecycle/approval
            // predicate we didn't pre-filter (defence in depth — the
            // Within methods own their own invariants). Both are
            // per-row skippable; anything else propagates and rolls
            // back the whole batch (the basket-level audit event
            // below rolls back with it, so no lying envelope event).
            if (err instanceof ConflictException || err instanceof BadRequestException) {
              skipped.push({ reservationId: row.id, reason: err.message });
              continue;
            }
            throw err;
          }
        }

        const envelopeAction =
          operation === 'APPROVED'
            ? 'panorama.reservation.basket_approved'
            : operation === 'REJECTED'
              ? 'panorama.reservation.basket_rejected'
              : 'panorama.reservation.basket_cancelled';

        await this.audit.recordWithin(tx, {
          action: envelopeAction,
          resourceType: 'reservation_basket',
          resourceId: basketId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            basketId,
            processedCount: processed.length,
            skippedCount: skipped.length,
            processedReservationIds: processed.map((p) => p.reservationId),
            skipped,
            note: note ?? null,
            reason: reason ?? null,
          },
        });

        return { basketId, processed, skipped };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async assertBatchEnabled(tenantId: string): Promise<void> {
    const rules = await this.loadRules(tenantId);
    if (!rules.enableBasketBatch) {
      throw new ForbiddenException('basket_batch_disabled');
    }
  }

  // ---------------------------------------------------------------------
  // Check-out / Check-in (ADR-0009 Part B)
  // ---------------------------------------------------------------------

  async checkOut(params: CheckoutParams): Promise<Reservation> {
    const { actor, reservationId } = params;
    return this.prisma.runInTenant(
      actor.tenantId,
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

        // ADR-0012 §8 — reservation tether. When the tenant flag is
        // on, a recent COMPLETED+PASS inspection by THIS actor on
        // THIS asset is required. Inline query (no InspectionService
        // import) per the v3 cross-domain coupling fix.
        // Flip-on with already-checked-out vehicles preserves them:
        // gate runs ONLY in the BOOKED → CHECKED_OUT path here, never
        // on already-CHECKED_OUT rows.
        const preCheckoutInspectionId = await this.assertInspectionTether(
          tx,
          actor,
          asset.id,
          reservationId,
        );

        const now = new Date();
        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            lifecycleStatus: 'CHECKED_OUT',
            checkedOutAt: now,
            checkedOutByUserId: actor.userId,
            mileageOut: params.mileage,
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
            mileage: params.mileage,
            condition: params.condition ?? null,
            ...(preCheckoutInspectionId
              ? { preCheckoutInspectionId }
              : {}),
          },
        });
        return updated;
      },
    );
  }

  /**
   * ADR-0012 §8 reservation tether — inline so no InspectionService
   * import. Returns the pre-checkout inspection ID for the success
   * audit row, or null when the tether is off (no audit decoration).
   * Throws ConflictException('inspection_required') + audits
   * `panorama.reservation.checkout_blocked` when the tether is on
   * and no qualifying inspection exists in window.
   */
  private async assertInspectionTether(
    tx: Prisma.TransactionClient,
    actor: ReservationContext,
    assetId: string,
    reservationId: string,
  ): Promise<string | null> {
    const tenant = await tx.tenant.findUnique({
      where: { id: actor.tenantId },
      select: {
        requireInspectionBeforeCheckout: true,
        inspectionConfig: true,
      },
    });
    if (!tenant?.requireInspectionBeforeCheckout) return null;

    // Per-tenant window override; null falls back to the cluster
    // default (240 min = 4 h). Inline parse so this method has no
    // import on the inspection module.
    const cfg = (tenant.inspectionConfig ?? {}) as Record<string, unknown>;
    const rawWindow = cfg['preCheckoutInspectionMaxAgeMinutes'];
    const windowMin =
      typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow >= 30 && rawWindow <= 1440
        ? rawWindow
        : 240;
    const cutoff = new Date(Date.now() - windowMin * 60_000);

    const passed = await tx.inspection.findFirst({
      where: {
        tenantId: actor.tenantId,
        assetId,
        startedByUserId: actor.userId,
        status: 'COMPLETED',
        outcome: 'PASS',
        completedAt: { gte: cutoff },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    });

    if (!passed) {
      // Audit must SURVIVE the rollback — `recordWithin` would commit
      // with the outer tx, but the throw immediately below rolls it
      // back. `record` opens its own tx (audit chain integrity stays
      // because the chain is single-writer per ADR-0003).
      await this.audit.record({
        action: 'panorama.reservation.checkout_blocked',
        resourceType: 'reservation',
        resourceId: reservationId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          reason: 'inspection_required',
          assetId,
          windowMinutes: windowMin,
        },
      });
      throw new ConflictException('inspection_required');
    }
    return passed.id;
  }

  async checkIn(params: CheckinParams): Promise<Reservation> {
    const { actor, reservationId } = params;
    return this.prisma.runInTenant(
      actor.tenantId,
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
          existing.mileageOut !== null &&
          existing.mileageOut !== undefined &&
          params.mileage < existing.mileageOut
        ) {
          throw new BadRequestException('mileage_not_monotonic');
        }

        const damageFlag = params.damageFlag ?? false;
        const nextAssetStatus = damageFlag ? 'MAINTENANCE' : 'READY';
        const now = new Date();

        // DATA-01 / ARCH-03 (#31): write Asset.lastReadMileage so the
        // ADR-0016 §9 PM-due cron has a real number to compare against
        // nextServiceMileage. Monotonic guard so a stale check-in (or
        // an out-of-order admin correction) doesn't move the column
        // backwards. The reservation-level monotonic check above
        // already guarantees `params.mileage >= mileageOut`, but we
        // re-check against the asset row separately because two
        // concurrent reservations on the same asset could race —
        // we want the higher reading to win.
        const existingAsset = await tx.asset.findUnique({
          where: { id: existing.assetId },
          select: { lastReadMileage: true },
        });
        const shouldUpdateMileage =
          existingAsset === null ||
          existingAsset.lastReadMileage === null ||
          params.mileage > existingAsset.lastReadMileage;

        const updated = await tx.reservation.update({
          where: { id: reservationId },
          data: {
            lifecycleStatus: 'RETURNED',
            checkedInAt: now,
            checkedInByUserId: actor.userId,
            mileageIn: params.mileage,
            conditionIn: params.condition ?? null,
            damageFlag,
            damageNote: params.damageNote ?? null,
          },
        });
        await tx.asset.update({
          where: { id: existing.assetId },
          data: {
            status: nextAssetStatus,
            ...(shouldUpdateMileage ? { lastReadMileage: params.mileage } : {}),
          },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.reservation.checked_in',
          resourceType: 'reservation',
          resourceId: reservationId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            assetId: existing.assetId,
            mileage: params.mileage,
            condition: params.condition ?? null,
            damageFlag,
            damageNote: params.damageNote ?? null,
            assetNextStatus: nextAssetStatus,
            lastReadMileageUpdated: shouldUpdateMileage,
          },
        });

        // ADR-0016 §5 / #40 ARCH-15: emit the dominant auto-suggest
        // trigger event when the driver flagged damage at check-in. The
        // event flows through the same notification bus as
        // `panorama.inspection.completed`; the MaintenanceTicketSubscriber
        // (gated per-tenant by `autoOpenMaintenanceFromInspection`)
        // decides whether to open a draft ticket.
        //
        // The event is emitted regardless of the per-tenant flag — the
        // bus row is the audit-recoverable trail of "the driver reported
        // damage on this reservation," letting a later flag-flip + manual
        // backfill replay missed events. The subscriber's no-op-when-flag-
        // off is logged + benign.
        //
        // dedupKey is keyed on the reservation so an idempotent retry of
        // checkIn (a 5xx-after-commit + client retry, hypothetically)
        // does not enqueue twice. The subscriber additionally guards via
        // an existing-OPEN-ticket check so re-emission cannot double-open.
        if (damageFlag) {
          await this.notifications.enqueueWithin(tx, {
            eventType: 'panorama.reservation.checked_in_with_damage',
            tenantId: actor.tenantId,
            payload: {
              reservationId,
              assetId: existing.assetId,
              requesterUserId: existing.requesterUserId,
              checkedInByUserId: actor.userId,
              checkedInAt: now.toISOString(),
              mileageIn: params.mileage,
              ...(params.damageNote ? { damageNote: params.damageNote } : {}),
            },
            dedupKey: `checkin_damage:${reservationId}`,
          });
        }
        return updated;
      },
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
    const tenant = await this.prisma.runInTenant(
      tenantId,
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { reservationRules: true },
        }),
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
