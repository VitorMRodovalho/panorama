/**
 * MaintenanceSweepService — ADR-0016 §9 background sweeps.
 *
 *   * PM-due daily sweep (this PR): emits
 *     `panorama.maintenance.next_service_due` audit when an asset has
 *     a COMPLETED ticket whose `nextServiceDate` is within 14 days OR
 *     whose `nextServiceMileage` is within 500 miles of the asset's
 *     `lastReadMileage`. Per-asset dedupe within 24 h via Redis SETNX
 *     so ops gets at most one reminder per asset per day, regardless
 *     of how many overdue tickets the asset has.
 *
 * Deferred to follow-up PRs:
 *   * Hourly stale-OPEN sweep (ADR-0016 §9 stale-warning) — emits
 *     `panorama.maintenance.stale_warning` for OPEN/IN_PROGRESS
 *     tickets older than the per-tenant `maintenanceStaleWarningDays`.
 *   * Daily type-drift audit (ADR-0016 §9 type-drift) — emits
 *     `panorama.maintenance.type_drift_detected` for tickets whose
 *     `maintenanceType` falls outside the §1 allow-list.
 *   * Enterprise email channel for `next_service_due` (ADR-0016 §7,
 *     gated behind `EditionService` + `MaintenanceEmailChannel`).
 *     Community ships the audit row + dashboard query; Enterprise
 *     adds the push email. Self-hosters on Community can wire their
 *     own webhook to the audit row.
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * `runAsSuperAdmin` is FORBIDDEN here for tenant-scoped reads + ALL
 * writes. The sweep below loops over tenants and routes every
 * candidate scan through `runInTenant`.
 *
 * The ONE allowed cluster-wide path is the tenant LIST itself —
 * `panorama_app` cannot see other tenants' rows in `tenants`, so we
 * use `runAsSuperAdmin` for the list of tenant ids. Each per-tenant
 * scan + audit then runs under RLS. `audit.record` opens its own
 * super-admin tx via the existing AuditService design.
 *
 * The CI gate `pnpm rls:allowlist-check` (#58) budgets this file at
 * 1 super-admin call (the tenant list). Adding more requires
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
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

const PM_DUE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PM_DUE_QUEUE = 'maintenance-pm-due';
const PM_DUE_JOB_NAME = 'sweep';
const PM_DUE_REPEATABLE_KEY = 'pm-due-daily';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// ADR-0016 §9 thresholds — hardcoded per the spec (vs. derived from
// the per-tenant `maintenanceMileageInterval` / `maintenanceDayInterval`
// columns, which set completion-time *defaults* for new tickets, not
// the sweep's "approaching due" warning band).
const MILEAGE_WARNING_BAND_MILES = 500;
const DATE_WARNING_BAND_DAYS = 14;
// Circuit-breaker bound on the per-tenant scan. Migration 0014 +
// 0017 give both arms of the UNION a partial index, so the typical
// candidate set is bounded by `assets-with-PM-due-this-cycle`
// (single-digit % of fleet on a typical day). The 10 000 ceiling
// would only fire under a planner regression / unexpected data shape
// — log + alert path picks it up rather than silently dropping
// signals like the previous LIMIT 500 did (data-architect Q3).
const PER_TENANT_CIRCUIT_BREAKER = 10_000;

interface PmDueCandidate {
  id: string;
  assetId: string;
  tenantId: string;
  nextServiceDate: Date | null;
  nextServiceMileage: number | null;
  // Asset's lastReadMileage at scan time. Captured here so the audit
  // metadata records the snapshot the cron actually evaluated, not a
  // value that might change between scan and audit.
  assetLastReadMileage: number | null;
}

@Injectable()
export class MaintenanceSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MaintenanceSweepService');
  private pmDueQueue: Queue | null = null;
  private pmDueWorker: Worker | null = null;
  private redisConnections: Redis[] = [];
  private dedupRedis: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('maintenance_sweep_idle_in_tests');
      return;
    }
    if (process.env['FEATURE_MAINTENANCE'] !== 'true') {
      // Defence-in-depth: app.module.ts already conditionally loads
      // MaintenanceModule on FEATURE_MAINTENANCE, but make the gate
      // explicit at the sweep boundary too — a future module-loading
      // refactor shouldn't accidentally start the BullMQ worker on a
      // Community deploy that hasn't opted into the maintenance domain.
      this.log.log('maintenance_sweep_disabled_by_feature_flag');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.pmDueQueue) return;
    // Mirrors InspectionMaintenanceService.start photo-sweep pattern:
    // BullMQ repeatable with stable jobId so a Fly machine restart
    // re-attaches to the existing schedule rather than spawning a
    // duplicate or skipping a run.
    this.pmDueQueue = new Queue(PM_DUE_QUEUE, {
      connection: this.makeRedis(),
    });
    this.pmDueWorker = new Worker(
      PM_DUE_QUEUE,
      async () => {
        const due = await this.runPmDueSweep();
        return { due };
      },
      { connection: this.makeRedis(), concurrency: 1 },
    );
    this.pmDueWorker.on('failed', (_job, err) =>
      this.log.warn({ err: String(err) }, 'pm_due_sweep_job_failed'),
    );
    await this.pmDueQueue.add(
      PM_DUE_JOB_NAME,
      {},
      {
        jobId: PM_DUE_REPEATABLE_KEY,
        repeat: { every: PM_DUE_INTERVAL_MS },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 30 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 30 },
      },
    );
    this.log.log('maintenance_sweep_started');
  }

  async stop(): Promise<void> {
    const closers: Array<Promise<unknown>> = [];
    if (this.pmDueWorker) closers.push(this.pmDueWorker.close());
    if (this.pmDueQueue) closers.push(this.pmDueQueue.close());
    await Promise.allSettled(closers);
    this.pmDueWorker = null;
    this.pmDueQueue = null;
    if (this.dedupRedis) {
      try {
        await this.dedupRedis.quit();
      } catch (err) {
        this.log.debug({ err: String(err) }, 'redis_quit_error');
      }
      this.dedupRedis = null;
    }
    for (const conn of this.redisConnections) {
      try {
        await conn.quit();
      } catch (err) {
        this.log.debug({ err: String(err) }, 'redis_quit_error');
      }
    }
    this.redisConnections = [];
  }

  // ----------------------------------------------------------------
  // PM-due sweep
  // ----------------------------------------------------------------

  /**
   * One pass of the PM-due sweep. Returns the count of audit rows
   * emitted (post-dedup). Exposed for tests + manual operator triggers.
   *
   * Algorithm (per ADR-0016 §9):
   *   1. List tenants (cluster-wide; the only allowed runAsSuperAdmin
   *      use in this module).
   *   2. Per tenant under `runInTenant`: query candidate
   *      `asset_maintenances` rows joined to `assets`. Status COMPLETED
   *      AND (date trigger OR mileage trigger). Both partial indexes
   *      from migration 0014 (`open_per_asset_partial`,
   *      `next_service_due_partial`) cover the read path.
   *   3. Group candidates by `(tenantId, assetId)` so an asset with
   *      multiple PM-due tickets emits only one audit row.
   *   4. Per asset: SETNX dedup against `pm_due:<tenantId>:<assetId>`
   *      with 24 h TTL. New keys → emit audit; existing keys → skip
   *      silently (the previous run's audit is still within the dedup
   *      window).
   *   5. Audit row carries the matching ticket IDs, the cause
   *      (mileage / date / both), and the asset's lastReadMileage
   *      snapshot at scan time so dashboards can render "X miles
   *      until due" or "Y days until due" without re-querying.
   */
  async runPmDueSweep(): Promise<number> {
    // Step 1: cluster-wide tenant list. Allowlist budget +1 for this
    // file (#58 gate).
    const tenants = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.tenant.findMany({
          select: { id: true },
          where: { deletedAt: null },
        }),
      { reason: 'maintenance:pm_due_sweep:list_tenants' },
    );

    const dateCutoff = new Date(
      Date.now() + DATE_WARNING_BAND_DAYS * 24 * 60 * 60 * 1000,
    );

    // Step 2 + 3: per-tenant scan + group by asset. A typical fleet
    // has at most a handful of PM-due assets per day, so the JS-side
    // grouping is cheap. Avoids a SQL window function for portability.
    const candidatesByAsset = new Map<string, PmDueCandidate[]>();
    let tenantsScanned = 0;
    for (const tenant of tenants) {
      tenantsScanned++;
      const rows = await this.prisma.runInTenant(tenant.id, async (tx) => {
        // Raw SQL: each arm of the UNION uses its own partial index
        // — date-arm via `next_service_due_partial` (migration 0014),
        // mileage-arm via `next_service_mileage_due_partial`
        // (migration 0017). UNION (not UNION ALL) deduplicates the
        // overlap row when both triggers fire on the same ticket
        // — JS-side aggregation per asset still groups multiple
        // tickets correctly because each (id, …) tuple is unique.
        //
        // Postgres's BitmapOr cannot apply across these two arms
        // because the mileage arm joins `assets.lastReadMileage` —
        // the OR predicate would have driven the planner to either
        // a heap scan or an awkward merge. UNION rewrites it as two
        // independent sub-queries the planner optimises separately
        // (data-architect Q6).
        return tx.$queryRaw<
          Array<{
            id: string;
            assetId: string;
            tenantId: string;
            nextServiceDate: Date | null;
            nextServiceMileage: number | null;
            assetLastReadMileage: number | null;
          }>
        >`
          (
            SELECT am.id,
                   am."assetId" AS "assetId",
                   am."tenantId" AS "tenantId",
                   am."nextServiceDate" AS "nextServiceDate",
                   am."nextServiceMileage" AS "nextServiceMileage",
                   a."lastReadMileage" AS "assetLastReadMileage"
              FROM asset_maintenances am
              JOIN assets a
                ON a.id = am."assetId"
               AND a."tenantId" = am."tenantId"
             WHERE am.status = 'COMPLETED'
               AND am."tenantId" = ${tenant.id}::uuid
               AND am."nextServiceDate" IS NOT NULL
               AND am."nextServiceDate" <= ${dateCutoff}
          )
          UNION
          (
            SELECT am.id,
                   am."assetId" AS "assetId",
                   am."tenantId" AS "tenantId",
                   am."nextServiceDate" AS "nextServiceDate",
                   am."nextServiceMileage" AS "nextServiceMileage",
                   a."lastReadMileage" AS "assetLastReadMileage"
              FROM asset_maintenances am
              JOIN assets a
                ON a.id = am."assetId"
               AND a."tenantId" = am."tenantId"
             WHERE am.status = 'COMPLETED'
               AND am."tenantId" = ${tenant.id}::uuid
               AND am."nextServiceMileage" IS NOT NULL
               AND a."lastReadMileage" IS NOT NULL
               AND a."lastReadMileage" + ${MILEAGE_WARNING_BAND_MILES} >= am."nextServiceMileage"
          )
          LIMIT ${PER_TENANT_CIRCUIT_BREAKER}
        `;
      });

      if (rows.length === PER_TENANT_CIRCUIT_BREAKER) {
        // Hard cap fired — log loudly so an SRE seeing it can either
        // raise the cap or chase a planner regression. Without this
        // log we'd be back to the silent-drop failure mode of the
        // pre-data-architect-Q3 code.
        this.log.error(
          { tenantId: tenant.id, cap: PER_TENANT_CIRCUIT_BREAKER },
          'pm_due_circuit_breaker_fired',
        );
      }

      for (const row of rows) {
        const key = `${row.tenantId}:${row.assetId}`;
        const list = candidatesByAsset.get(key);
        if (list) {
          list.push(row);
        } else {
          candidatesByAsset.set(key, [row]);
        }
      }
    }

    if (candidatesByAsset.size === 0) {
      this.log.debug(
        { tenantsScanned, candidates: 0 },
        'pm_due_swept_no_candidates',
      );
      return 0;
    }

    // Step 4: per-asset Redis SETNX dedup BEFORE the batched audit
    // tx. SETNX is atomic so two concurrent sweep ticks (e.g. across
    // pods) won't both pass — the loser sees `acquired === false`
    // and skips. Build the audit-emit list from the survivors.
    interface PendingAudit {
      assetId: string;
      tenantId: string;
      tickets: PmDueCandidate[];
      dedupKey: string;
    }
    const pending: PendingAudit[] = [];
    for (const [key, tickets] of candidatesByAsset) {
      const first = tickets[0]!;
      const dedupKey = `pm_due:${key}`;
      const acquired = await this.acquireDedup(dedupKey);
      if (!acquired) {
        this.log.debug(
          { tenantId: first.tenantId, assetId: first.assetId },
          'pm_due_dedup_skip',
        );
        continue;
      }
      pending.push({
        assetId: first.assetId,
        tenantId: first.tenantId,
        tickets,
        dedupKey,
      });
    }

    if (pending.length === 0) {
      this.log.debug(
        { tenantsScanned, candidates: candidatesByAsset.size, dedupSkipped: candidatesByAsset.size },
        'pm_due_swept_all_dedup',
      );
      return 0;
    }

    // Step 5: emit all audit rows in a SINGLE super-admin tx via
    // `recordWithin`. Previously each `audit.record` opened its own
    // tx (data-architect Q5) — at 100 audits per pass that was 100
    // BEGIN/COMMIT round-trips on the audit hash chain. Batching
    // also gets us all-or-nothing semantics: if one row fails, the
    // whole batch rolls back, and the dedup-release path below
    // releases ALL the keys consistently.
    //
    // `recordWithin` chains hash-of-prev within the tx, so the
    // chain-reading pattern stays correct under batched inserts —
    // each row reads the prior chain head from the same tx-local
    // snapshot, the inserts commit atomically.
    try {
      await this.prisma.runAsSuperAdmin(
        async (tx) => {
          for (const p of pending) {
            const triggers = computeTriggers(p.tickets);
            await this.audit.recordWithin(tx, {
              action: 'panorama.maintenance.next_service_due',
              resourceType: 'asset',
              resourceId: p.assetId,
              tenantId: p.tenantId,
              actorUserId: null,
              metadata: {
                assetId: p.assetId,
                ticketIds: p.tickets.map((t) => t.id),
                ticketCount: p.tickets.length,
                triggeredBy: triggers.triggeredBy,
                // Earliest date / smallest mileage among matching
                // tickets — useful for dashboards rendering
                // "soonest due" without a re-query.
                earliestNextServiceDate: triggers.earliestDate
                  ? triggers.earliestDate.toISOString()
                  : null,
                smallestNextServiceMileage: triggers.smallestMileage,
                assetLastReadMileage: p.tickets[0]!.assetLastReadMileage,
                daysUntilDue: triggers.earliestDate
                  ? Math.round(
                      (triggers.earliestDate.getTime() - Date.now()) /
                        (24 * 60 * 60 * 1000),
                    )
                  : null,
                milesUntilDue:
                  triggers.smallestMileage !== null &&
                  p.tickets[0]!.assetLastReadMileage !== null
                    ? triggers.smallestMileage - p.tickets[0]!.assetLastReadMileage
                    : null,
              },
            });
          }
        },
        { reason: 'maintenance:pm_due_sweep:emit_audits' },
      );
    } catch (err) {
      // Batch failed — release ALL the dedup keys we acquired so the
      // next sweep tick can retry. A missed-then-recovered PM-due
      // signal in a regulated domain (DOT 49 CFR §396.3 PM tracking
      // lineage) is worse than the duplicate-audit risk if the
      // release races against a concurrent sweep tick — log at error
      // level so the alerting pipeline picks it up.
      this.log.error(
        {
          assetCount: pending.length,
          err: String(err),
        },
        'pm_due_audit_batch_failed',
      );
      for (const p of pending) {
        await this.releaseDedup(p.dedupKey);
      }
      return 0;
    }

    this.log.log(
      {
        tenantsScanned,
        candidates: candidatesByAsset.size,
        emitted: pending.length,
      },
      'pm_due_swept',
    );
    return pending.length;
  }

  /**
   * Acquire the per-asset dedup lock for 24 h. Returns true iff this
   * call was the SETNX winner (no prior unexpired key). False = some
   * prior sweep within the last 24 h already audited this asset.
   *
   * Lazy-init a single Redis connection for dedup ops (separate from
   * BullMQ's connections to avoid lifecycle coupling). The connection
   * is closed in `stop()`.
   */
  private async acquireDedup(key: string): Promise<boolean> {
    if (!this.dedupRedis) {
      this.dedupRedis = this.makeRedis();
    }
    const result = await this.dedupRedis.set(key, '1', 'PX', DEDUP_TTL_MS, 'NX');
    return result === 'OK';
  }

  private async releaseDedup(key: string): Promise<void> {
    if (!this.dedupRedis) return;
    try {
      await this.dedupRedis.del(key);
    } catch (err) {
      this.log.debug({ err: String(err), key }, 'pm_due_dedup_release_failed');
    }
  }

  /**
   * BullMQ requires the same `lazyConnect: false` /
   * `enableReadyCheck: false` / `maxRetriesPerRequest: null` shape on
   * every connection — mirrors the invitation queue + photo retention
   * sweep patterns elsewhere in the codebase.
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
}

/**
 * Aggregate the trigger semantics across all PM-due tickets on a
 * single asset: which trigger(s) fired (date / mileage / both), the
 * earliest date, and the smallest mileage.
 *
 * Exported for unit-test directness — the rest of the service is
 * tested via the e2e DB path.
 */
export function computeTriggers(tickets: PmDueCandidate[]): {
  triggeredBy: 'date' | 'mileage' | 'both';
  earliestDate: Date | null;
  smallestMileage: number | null;
} {
  let dateFired = false;
  let mileageFired = false;
  let earliestDate: Date | null = null;
  let smallestMileage: number | null = null;

  const dateCutoff = Date.now() + DATE_WARNING_BAND_DAYS * 24 * 60 * 60 * 1000;
  for (const t of tickets) {
    if (t.nextServiceDate && t.nextServiceDate.getTime() <= dateCutoff) {
      dateFired = true;
      if (!earliestDate || t.nextServiceDate < earliestDate) {
        earliestDate = t.nextServiceDate;
      }
    }
    if (
      t.nextServiceMileage !== null &&
      t.assetLastReadMileage !== null &&
      t.assetLastReadMileage + MILEAGE_WARNING_BAND_MILES >= t.nextServiceMileage
    ) {
      mileageFired = true;
      if (smallestMileage === null || t.nextServiceMileage < smallestMileage) {
        smallestMileage = t.nextServiceMileage;
      }
    }
  }

  const triggeredBy: 'date' | 'mileage' | 'both' =
    dateFired && mileageFired ? 'both' : dateFired ? 'date' : 'mileage';
  return { triggeredBy, earliestDate, smallestMileage };
}
