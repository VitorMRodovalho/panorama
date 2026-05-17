import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { TenantExportService } from './tenant-export.service.js';

/**
 * ADR-0020 §8 — BullMQ queue + worker for tenant data export.
 *
 * Mirrors `MaintenanceSweepService` + `TenantDeletionSweepService`
 * shape:
 *   - one Queue + one Worker on the same process,
 *   - idle-in-tests (`NODE_ENV=test` short-circuit) so the test
 *     suite can drive `TenantExportService.runJob` directly,
 *   - single job per request (not a repeatable).
 *
 * Job payload: `{ jobId: string }` — the controller enqueues a
 * row in `tenant_exports` and the worker pulls the rest of the
 * state from there. Keeps the BullMQ payload tiny + replayable.
 */

export const TENANT_EXPORT_QUEUE = 'tenant-export';
const TENANT_EXPORT_JOB_NAME = 'run';

export interface TenantExportJobPayload {
  jobId: string;
}

@Injectable()
export class TenantExportQueue implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TenantExportQueue');
  private queue: Queue<TenantExportJobPayload> | null = null;
  private worker: Worker<TenantExportJobPayload> | null = null;
  private redisConnections: Redis[] = [];

  constructor(private readonly exports: TenantExportService) {}

  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') {
      this.log.log('tenant_export_queue_idle_in_tests');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async enqueue(payload: TenantExportJobPayload): Promise<void> {
    if (!this.queue) {
      // In tests we drive `runJob` directly; this branch is for
      // production / dev where the queue is up.
      throw new Error('tenant_export_queue_not_started');
    }
    await this.queue.add(TENANT_EXPORT_JOB_NAME, payload, {
      removeOnComplete: 50,
      removeOnFail: 50,
    });
  }

  private async start(): Promise<void> {
    if (this.queue) return;
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';

    const queueConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.redisConnections = [queueConn, workerConn];

    this.queue = new Queue<TenantExportJobPayload>(TENANT_EXPORT_QUEUE, {
      connection: queueConn,
    });
    this.worker = new Worker<TenantExportJobPayload>(
      TENANT_EXPORT_QUEUE,
      async (job) => {
        await this.exports.runJob(job.data.jobId);
      },
      { connection: workerConn, concurrency: 1 },
    );
    this.log.log('tenant_export_queue_started');
  }

  private async stop(): Promise<void> {
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
