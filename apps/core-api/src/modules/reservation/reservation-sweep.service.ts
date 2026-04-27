/**
 * ReservationSweepService — #77 PILOT-04 hourly sweeps.
 *
 * Two related-but-orthogonal sweeps:
 *
 *   * **Overdue return sweep** — `lifecycleStatus = CHECKED_OUT AND
 *     endAt < now() AND isOverdue = false` → flip `isOverdue = true`
 *     and emit `panorama.reservation.flagged_overdue`. Driver kept
 *     the asset past their booked window; admin needs to chase.
 *     Idempotent via the `isOverdue = false` filter — once flagged,
 *     subsequent sweeps skip.
 *
 *   * **No-show sweep** — `lifecycleStatus = BOOKED AND startAt +
 *     pickupWindow < now()` → transition to `MISSED` and emit
 *     `panorama.reservation.no_show`. Driver never picked up; the
 *     slot is freed (the asset.status invariant chain leaves the
 *     asset at READY since it was never CHECKED_OUT). `pickupWindow`
 *     comes from `tenant.reservationRules.pickup_window_hours`
 *     (default 1, 0 = never auto-flag).
 *
 * Both sweeps run hourly via `setInterval` (mirrors
 * `InspectionMaintenanceService.runStaleInProgressSweep` cadence
 * pattern — losing a poll cycle on Fly machine restart is fine for
 * a 1 h cadence, simpler than BullMQ scaffolding).
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * `runAsSuperAdmin` is FORBIDDEN here for tenant-scoped reads + ALL
 * writes. Per-tenant scan + state transitions run under
 * `runInTenant`. The ONE allowed cluster-wide path is the tenant
 * LIST (panorama_app cannot see other tenants' rows in `tenants`).
 * --------------------------------------------------------------
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ReservationConfigService,
} from './reservation.config.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const PER_TENANT_BATCH_SIZE = 1_000;

@Injectable()
export class ReservationSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReservationSweepService');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cfg: ReservationConfigService,
  ) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('reservation_sweep_idle_in_tests');
      return;
    }
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) =>
        this.log.error({ err: String(err) }, 'reservation_sweep_unhandled'),
      );
    }, SWEEP_INTERVAL_MS);
    this.log.log('reservation_sweep_started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over both sweeps. Returns the totals so manual operator
   * triggers + tests can assert. Sweeps run sequentially (not in
   * parallel) so an overdue-flag write and a same-tenant no-show
   * write don't race the per-tenant runInTenant scope. Volume is
   * tiny (single-digit transitions per tenant per hour at typical
   * fleet size) so sequential is fine.
   */
  async runOnce(): Promise<{ overdueFlagged: number; noShowMissed: number }> {
    const overdueFlagged = await this.runOverdueSweep();
    const noShowMissed = await this.runNoShowSweep();
    return { overdueFlagged, noShowMissed };
  }

  /**
   * One pass of the overdue-return sweep. Flips `isOverdue = true`
   * for CHECKED_OUT reservations past their `endAt`. Idempotent
   * via the `isOverdue = false` filter — already-flagged rows are
   * silently skipped.
   *
   * Audit `panorama.reservation.flagged_overdue` carries the asset
   * + requester + the hours-overdue snapshot so the dashboard can
   * render "X hours overdue" without a re-query.
   */
  async runOverdueSweep(): Promise<number> {
    const tenants = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          select: { id: true },
          where: { deletedAt: null },
        }),
      { reason: 'reservation:overdue_sweep:list_tenants' },
    );

    const now = new Date();
    let totalFlagged = 0;
    for (const tenant of tenants) {
      const candidates = await this.prisma.runInTenant(tenant.id, (tx) =>
        tx.reservation.findMany({
          where: {
            lifecycleStatus: 'CHECKED_OUT',
            isOverdue: false,
            endAt: { lt: now },
          },
          orderBy: { endAt: 'asc' },
          take: PER_TENANT_BATCH_SIZE,
          select: {
            id: true,
            tenantId: true,
            assetId: true,
            requesterUserId: true,
            checkedOutByUserId: true,
            endAt: true,
          },
        }),
      );
      if (candidates.length === 0) continue;

      for (const r of candidates) {
        try {
          const flipped = await this.prisma.runInTenant(tenant.id, async (tx) => {
            // Conditional updateMany defeats the race against a
            // driver returning the asset between scan and write —
            // if the row no longer matches `isOverdue=false AND
            // lifecycleStatus=CHECKED_OUT`, the update silently
            // matches zero and we skip the audit.
            const result = await tx.reservation.updateMany({
              where: {
                id: r.id,
                lifecycleStatus: 'CHECKED_OUT',
                isOverdue: false,
              },
              data: { isOverdue: true },
            });
            return result.count === 1;
          });
          if (!flipped) continue;
        } catch (err) {
          this.log.warn(
            { reservationId: r.id, err: String(err) },
            'reservation_overdue_flag_failed',
          );
          continue;
        }
        const hoursOverdue = Math.round(
          (now.getTime() - r.endAt.getTime()) / (60 * 60 * 1000),
        );
        await this.audit.record({
          action: 'panorama.reservation.flagged_overdue',
          resourceType: 'reservation',
          resourceId: r.id,
          tenantId: r.tenantId,
          actorUserId: null,
          metadata: {
            assetId: r.assetId,
            requesterUserId: r.requesterUserId,
            checkedOutByUserId: r.checkedOutByUserId,
            endAt: r.endAt.toISOString(),
            hoursOverdue,
          },
        });
        totalFlagged++;
      }
    }
    if (totalFlagged > 0) {
      this.log.log({ totalFlagged }, 'reservation_overdue_swept');
    }
    return totalFlagged;
  }

  /**
   * One pass of the no-show sweep. Transitions BOOKED reservations
   * past `startAt + pickupWindow` to `MISSED`. `pickupWindow` comes
   * from the per-tenant `reservationRules.pickup_window_hours`;
   * value 0 disables the sweep for that tenant entirely.
   *
   * Audit `panorama.reservation.no_show` carries the asset + the
   * tenant-effective pickupWindow so an ops trace can correlate
   * the transition to the active config at the time.
   */
  async runNoShowSweep(): Promise<number> {
    const tenants = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          select: { id: true, reservationRules: true },
          where: { deletedAt: null },
        }),
      { reason: 'reservation:no_show_sweep:list_tenants' },
    );

    const now = new Date();
    let totalMissed = 0;
    for (const tenant of tenants) {
      const rules = this.cfg.fromJson(tenant.reservationRules);
      // 0 = never auto-flag no-show. Skip the per-tenant scan so we
      // don't burn a query when the tenant explicitly opted out.
      if (rules.pickupWindowHours <= 0) continue;
      const cutoff = new Date(
        now.getTime() - rules.pickupWindowHours * 60 * 60 * 1000,
      );
      const candidates = await this.prisma.runInTenant(tenant.id, (tx) =>
        tx.reservation.findMany({
          where: {
            lifecycleStatus: 'BOOKED',
            startAt: { lt: cutoff },
          },
          orderBy: { startAt: 'asc' },
          take: PER_TENANT_BATCH_SIZE,
          select: {
            id: true,
            tenantId: true,
            assetId: true,
            requesterUserId: true,
            startAt: true,
          },
        }),
      );
      if (candidates.length === 0) continue;

      for (const r of candidates) {
        try {
          const flipped = await this.prisma.runInTenant(tenant.id, async (tx) => {
            // Conditional updateMany — if the requester checked out
            // between scan and write, lifecycleStatus is no longer
            // BOOKED, the update matches zero, and we skip the audit.
            const result = await tx.reservation.updateMany({
              where: { id: r.id, lifecycleStatus: 'BOOKED' },
              data: { lifecycleStatus: 'MISSED' },
            });
            return result.count === 1;
          });
          if (!flipped) continue;
        } catch (err) {
          this.log.warn(
            { reservationId: r.id, err: String(err) },
            'reservation_no_show_transition_failed',
          );
          continue;
        }
        const hoursLate = Math.round(
          (now.getTime() - r.startAt.getTime()) / (60 * 60 * 1000),
        );
        await this.audit.record({
          action: 'panorama.reservation.no_show',
          resourceType: 'reservation',
          resourceId: r.id,
          tenantId: r.tenantId,
          actorUserId: null,
          metadata: {
            assetId: r.assetId,
            requesterUserId: r.requesterUserId,
            startAt: r.startAt.toISOString(),
            pickupWindowHours: rules.pickupWindowHours,
            hoursLate,
          },
        });
        totalMissed++;
      }
    }
    if (totalMissed > 0) {
      this.log.log({ totalMissed }, 'reservation_no_show_swept');
    }
    return totalMissed;
  }
}
