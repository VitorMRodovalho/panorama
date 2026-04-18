import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { NotificationEvent, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChannelRegistry, type ChannelHandler } from './channel-registry.js';

/**
 * Poll-based outbox dispatcher (ADR-0011).
 *
 *   - Polls PENDING / FAILED rows every `pollIntervalMs` (default 2 s).
 *   - Claims via optimistic UPDATE → IN_PROGRESS.
 *   - Invokes each matching ChannelHandler inside
 *     `runInTenant(event.tenantId, …)` so a buggy handler's Prisma
 *     calls land under the event's tenant RLS, not super-admin.
 *     Cluster-wide events (tenantId=null) run under runAsSuperAdmin
 *     with an audit breadcrumb.
 *   - Records per-channel outcome in `channelResults` so a DEAD row
 *     still tells the truth about which channel(s) actually ran.
 *   - Separately every `rescueIntervalMs` (default 60 s) a stuck-row
 *     sweep flips IN_PROGRESS rows older than `stuckThresholdMs` back
 *     to FAILED + audit `panorama.notification.rescued`.
 *
 * In tests, the dispatcher's interval timers are NOT started; tests
 * drive it manually via `tickOnce()` / `runRescueSweepOnce()`.
 */

const POLL_INTERVAL_MS = 2_000;
const RESCUE_INTERVAL_MS = 60_000;
const STUCK_THRESHOLD_MS = 60_000;
const CLAIM_BATCH_SIZE = 32;
const MAX_ATTEMPTS = 5;

/** Exponential backoff: 1 m, 2 m, 4 m, 8 m, 16 m. */
function backoffMs(attempt: number): number {
  return 60_000 * Math.pow(2, Math.max(0, attempt - 1));
}

interface ChannelOutcome {
  status: 'dispatched' | 'failed' | 'skipped';
  lastError?: string;
  attemptedAt: string;
}

@Injectable()
export class NotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NotificationDispatcher');
  private pollTimer: NodeJS.Timeout | null = null;
  private rescueTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly channels: ChannelRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('dispatcher_idle_in_tests');
      return;
    }
    if (process.env['FEATURE_NOTIFICATION_BUS'] === 'false') {
      this.log.log('dispatcher_disabled_by_feature_flag');
      return;
    }
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      this.tickOnce().catch((err) =>
        this.log.warn({ err: String(err) }, 'dispatcher_poll_unhandled'),
      );
    }, POLL_INTERVAL_MS);
    this.rescueTimer = setInterval(() => {
      this.runRescueSweepOnce().catch((err) =>
        this.log.warn({ err: String(err) }, 'dispatcher_rescue_unhandled'),
      );
    }, RESCUE_INTERVAL_MS);
    this.log.log('dispatcher_started');
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rescueTimer) clearInterval(this.rescueTimer);
    this.pollTimer = null;
    this.rescueTimer = null;
    this.running = false;
  }

  // ----------------------------------------------------------------
  // Polling / claim / dispatch
  // ----------------------------------------------------------------

  /**
   * One pass of the dispatcher loop. Exposed for tests so they can
   * drive progress deterministically without waiting on setInterval.
   * Returns the number of rows processed in this pass.
   */
  async tickOnce(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) return 0;
    let processed = 0;
    for (const event of claimed) {
      await this.dispatchOne(event);
      processed++;
    }
    return processed;
  }

  private async claimBatch(): Promise<NotificationEvent[]> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        // Pick candidate rows: due + retryable.
        const candidates = await tx.notificationEvent.findMany({
          where: {
            status: { in: ['PENDING', 'FAILED'] },
            availableAt: { lte: new Date() },
          },
          orderBy: { availableAt: 'asc' },
          take: CLAIM_BATCH_SIZE,
          select: { id: true },
        });
        if (candidates.length === 0) return [];
        const ids = candidates.map((c) => c.id);
        // Optimistic flip to IN_PROGRESS. Rows that lost the race
        // (another dispatcher instance claimed first) drop out of
        // the returned set.
        await tx.notificationEvent.updateMany({
          where: {
            id: { in: ids },
            status: { in: ['PENDING', 'FAILED'] },
          },
          data: { status: 'IN_PROGRESS', lastAttemptAt: new Date() },
        });
        return tx.notificationEvent.findMany({
          where: { id: { in: ids }, status: 'IN_PROGRESS' },
        });
      },
      { reason: 'notification:claim' },
    );
  }

  private async dispatchOne(event: NotificationEvent): Promise<void> {
    const handlers = this.channels.handlersFor(event.eventType);
    if (handlers.length === 0) {
      // No one cares — mark dispatched to move the row out of the
      // polling set. Not an error condition per ADR-0011.
      await this.markDispatched(event, {});
      return;
    }

    // Per-event tenant scope. Handlers making Prisma calls land
    // under the event's tenant RLS. Cluster-wide events run as
    // super-admin with an audit breadcrumb.
    const results: Record<string, ChannelOutcome> = {};
    try {
      if (event.tenantId === null) {
        this.log.warn(
          { eventId: event.id, eventType: event.eventType },
          'cluster_wide_event_runAsSuperAdmin',
        );
        await this.prisma.runAsSuperAdmin(
          async () => this.invokeHandlers(event, handlers, results),
          { reason: `notification:dispatch:${event.id}` },
        );
      } else {
        await this.prisma.runInTenant(event.tenantId, async () =>
          this.invokeHandlers(event, handlers, results),
        );
      }
    } catch (err) {
      this.log.warn(
        { eventId: event.id, err: String(err) },
        'dispatch_unhandled_tx_error',
      );
      await this.markFailed(event, results, String(err));
      return;
    }

    const anyFailed = Object.values(results).some((r) => r.status === 'failed');
    if (anyFailed) {
      await this.markFailed(event, results, firstError(results));
    } else {
      await this.markDispatched(event, results);
    }
  }

  private async invokeHandlers(
    event: NotificationEvent,
    handlers: ChannelHandler[],
    out: Record<string, ChannelOutcome>,
  ): Promise<void> {
    // Run handlers in parallel. One channel's failure doesn't block
    // siblings.
    await Promise.all(
      handlers.map(async (h) => {
        const attemptedAt = new Date().toISOString();
        try {
          await h.handle(event);
          out[h.name] = { status: 'dispatched', attemptedAt };
        } catch (err) {
          out[h.name] = {
            status: 'failed',
            attemptedAt,
            lastError: String((err as Error)?.message ?? err),
          };
        }
      }),
    );
  }

  private async markDispatched(
    event: NotificationEvent,
    results: Record<string, ChannelOutcome>,
  ): Promise<void> {
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        await tx.notificationEvent.update({
          where: { id: event.id },
          data: {
            status: 'DISPATCHED',
            dispatchedAt: new Date(),
            channelResults: results as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.notification.dispatched',
          resourceType: 'notification_event',
          resourceId: event.id,
          tenantId: event.tenantId,
          actorUserId: null,
          metadata: {
            eventType: event.eventType,
            channelResults: results,
          },
        });
      },
      { reason: `notification:markDispatched:${event.id}` },
    );
  }

  private async markFailed(
    event: NotificationEvent,
    results: Record<string, ChannelOutcome>,
    lastError: string,
  ): Promise<void> {
    const nextAttempt = event.dispatchAttempts + 1;
    const historyEntry = {
      attempt: nextAttempt,
      at: new Date().toISOString(),
      error: lastError,
      channelResults: results,
    };
    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        if (nextAttempt >= MAX_ATTEMPTS) {
          await tx.$executeRaw`
            UPDATE notification_events
               SET "dispatchAttempts" = ${nextAttempt},
                   "status"           = 'DEAD',
                   "lastError"        = ${lastError},
                   "errorHistory"     = COALESCE("errorHistory", '[]'::jsonb) ||
                                        ${JSON.stringify([historyEntry])}::jsonb,
                   "channelResults"   = ${JSON.stringify(results)}::jsonb
             WHERE id = ${event.id}::uuid
          `;
          await this.audit.recordWithin(tx, {
            action: 'panorama.notification.dead',
            resourceType: 'notification_event',
            resourceId: event.id,
            tenantId: event.tenantId,
            actorUserId: null,
            metadata: {
              eventType: event.eventType,
              attempts: nextAttempt,
              channelResults: results,
              lastError,
            },
          });
        } else {
          await tx.$executeRaw`
            UPDATE notification_events
               SET "dispatchAttempts" = ${nextAttempt},
                   "status"           = 'FAILED',
                   "availableAt"      = ${new Date(Date.now() + backoffMs(nextAttempt))},
                   "lastError"        = ${lastError},
                   "errorHistory"     = COALESCE("errorHistory", '[]'::jsonb) ||
                                        ${JSON.stringify([historyEntry])}::jsonb,
                   "channelResults"   = ${JSON.stringify(results)}::jsonb
             WHERE id = ${event.id}::uuid
          `;
        }
      },
      { reason: `notification:markFailed:${event.id}` },
    );
  }

  // ----------------------------------------------------------------
  // Stuck-row rescue
  // ----------------------------------------------------------------

  /**
   * Flips IN_PROGRESS rows older than `STUCK_THRESHOLD_MS` back to
   * FAILED so they re-enter the polling set. Exposed for tests.
   * Returns the number of rows rescued.
   */
  async runRescueSweepOnce(): Promise<number> {
    const rescued = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
        const stuck = await tx.notificationEvent.findMany({
          where: {
            status: 'IN_PROGRESS',
            lastAttemptAt: { lt: threshold },
          },
          select: { id: true, tenantId: true, eventType: true },
          take: 100,
        });
        if (stuck.length === 0) return 0;
        const ids = stuck.map((s) => s.id);
        await tx.notificationEvent.updateMany({
          where: {
            id: { in: ids },
            status: 'IN_PROGRESS',
            lastAttemptAt: { lt: threshold },
          },
          data: {
            status: 'FAILED',
            lastError: 'stuck_in_progress_rescued',
          },
        });
        for (const s of stuck) {
          await this.audit.recordWithin(tx, {
            action: 'panorama.notification.rescued',
            resourceType: 'notification_event',
            resourceId: s.id,
            tenantId: s.tenantId,
            actorUserId: null,
            metadata: { eventType: s.eventType },
          });
        }
        return stuck.length;
      },
      { reason: 'notification:rescueSweep' },
    );
    if (rescued > 0) {
      this.log.warn({ rescued }, 'notification_rescued');
    }
    return rescued;
  }
}

function firstError(results: Record<string, ChannelOutcome>): string {
  for (const [name, out] of Object.entries(results)) {
    if (out.status === 'failed') {
      return `${name}:${out.lastError ?? 'unknown'}`;
    }
  }
  return 'unknown';
}
