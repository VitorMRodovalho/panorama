import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { TenantDeletionService } from './tenant-deletion.service.js';

/**
 * ADR-0020 §7 — purge cron.
 *
 * Daily BullMQ repeatable job that asks `TenantDeletionService` to
 * process every tenant whose `deletionScheduledAt` is in the past.
 * Mirrors the `MaintenanceSweepService` shape (#74 / ADR-0016 §9):
 * Queue + Worker on the same process, idle-in-tests, single
 * repeatable-key so a redeploy doesn't accumulate duplicate jobs.
 *
 * The actual cascade work lives in the service; this file is the
 * scheduling shell.
 */

const PURGE_QUEUE = 'tenant-deletion-purge';
const PURGE_JOB_NAME = 'sweep';
const PURGE_REPEATABLE_KEY = 'tenant-deletion-daily';
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TenantDeletionSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TenantDeletionSweepService');
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private redisConnections: Redis[] = [];

  constructor(private readonly deletion: TenantDeletionService) {}

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('tenant_deletion_sweep_idle_in_tests');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.queue) return;
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';

    const queueConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.redisConnections = [queueConn, workerConn];

    this.queue = new Queue(PURGE_QUEUE, { connection: queueConn });
    this.worker = new Worker(
      PURGE_QUEUE,
      async () => {
        const result = await this.deletion.runPurgeBatch();
        this.log.log({ purged: result.purged }, 'tenant_deletion_purge_batch_done');
        return result;
      },
      { connection: workerConn, concurrency: 1 },
    );

    // One repeatable per process — re-creating with the same key is
    // idempotent in BullMQ 5.x; the old upcoming job is replaced.
    await this.queue.add(
      PURGE_JOB_NAME,
      {},
      {
        repeat: { every: PURGE_INTERVAL_MS },
        jobId: PURGE_REPEATABLE_KEY,
        removeOnComplete: true,
        removeOnFail: 10,
      },
    );

    this.log.log({ intervalMs: PURGE_INTERVAL_MS }, 'tenant_deletion_sweep_started');
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    for (const conn of this.redisConnections) {
      await conn.quit().catch(() => {});
    }
    this.redisConnections = [];
  }
}
