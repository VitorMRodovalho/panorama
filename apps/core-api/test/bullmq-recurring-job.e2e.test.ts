import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Queue as QueueV5 } from 'bullmq-v5';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BULLMQ_REDIS_PROTOCOL,
  ensureRecurringJob,
  nextAlignedSlot,
} from '../src/shared/queue/bullmq.js';

/**
 * Upgrade path for the four recurring sweeps, against real Redis.
 *
 * Before BullMQ 6 they were legacy repeatable jobs:
 * `queue.add('sweep', {}, { jobId, repeat: { every } })`. That state is
 * written here with BullMQ 5 itself (the `bullmq-v5` alias, test-only)
 * exactly as the old services wrote it, then `ensureRecurringJob` runs
 * on BullMQ 6 the way the services now do at boot.
 *
 * The legacy entry must be gone (else both fire every period), exactly
 * one Job Scheduler must remain, still aligned to the slot the legacy
 * job used, and a second boot must change nothing.
 *
 * Hard requires: Redis (the dev stack / CI service).
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
const DAY = 24 * 60 * 60 * 1000;

function v5Connection(url: string): { host: string; port: number; db: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), db: Number(u.pathname.slice(1) || 0) };
}

describe('BullMQ 5 repeatable -> BullMQ 6 Job Scheduler (Redis)', () => {
  const log = new Logger('bullmq-recurring-job-e2e');
  const queueName = `recurring-job-e2e-${process.pid}-${Date.now()}`;
  let conn: Redis;
  let queue: Queue;

  beforeAll(() => {
    conn = new Redis(REDIS_URL, { maxRetriesPerRequest: null, protocol: BULLMQ_REDIS_PROTOCOL });
    queue = new Queue(queueName, { connection: conn });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await conn.quit();
  });

  it('replaces a BullMQ 5 repeatable with one aligned scheduler, and a reboot changes nothing', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // 1. Legacy state, written by BullMQ 5 the way the old services did.
    const legacy = new QueueV5(queueName, { connection: v5Connection(REDIS_URL) });
    await legacy.add(
      'sweep',
      {},
      { jobId: 'probe-daily', repeat: { every: DAY }, removeOnComplete: true, removeOnFail: 10 },
    );
    const legacyEntries = await legacy.getRepeatableJobs();
    await legacy.close();

    // Control: the state this test claims to migrate really exists.
    expect(legacyEntries).toHaveLength(1);
    const legacyKey = legacyEntries[0]?.key ?? '';
    expect(legacyKey).not.toBe('probe-daily');
    expect(legacyEntries[0]?.next).toBe(nextAlignedSlot(DAY, (legacyEntries[0]?.next ?? 0) - 1));
    expect(await queue.getDelayedCount()).toBe(1);

    // 2. Boot on BullMQ 6.
    const spec = {
      schedulerId: 'probe-daily',
      jobName: 'sweep',
      everyMs: DAY,
      jobOptions: { removeOnComplete: true, removeOnFail: 10 },
    };
    await ensureRecurringJob(queue, spec, log);

    const schedules = await queue.getJobSchedulers();
    expect(schedules.map((s) => s.key)).toEqual(['probe-daily']);
    const next = schedules[0]?.next;
    expect(schedules[0]?.every).toBe(DAY);
    expect(next).toBe(legacyEntries[0]?.next);
    const delayed = await queue.getDelayed();
    expect(delayed.map((j) => j.id)).toEqual([`repeat:probe-daily:${next}`]);
    expect(delayed[0]?.name).toBe('sweep');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ removedKey: legacyKey, schedulerId: 'probe-daily' }),
      'superseded_job_schedule_removed',
    );

    // 3. Reboot: same call, same single schedule, same next run.
    warn.mockClear();
    await ensureRecurringJob(queue, spec, log);
    const again = await queue.getJobSchedulers();
    expect(again.map((s) => [s.key, s.next])).toEqual([['probe-daily', next]]);
    expect(await queue.getDelayedCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a schedule that produces a different job alone', async () => {
    await queue.upsertJobScheduler('other-schedule', { every: DAY }, { name: 'other-job' });

    await ensureRecurringJob(
      queue,
      { schedulerId: 'probe-daily', jobName: 'sweep', everyMs: DAY },
      log,
    );

    const keys = (await queue.getJobSchedulers()).map((s) => s.key).sort();
    expect(keys).toEqual(['other-schedule', 'probe-daily']);
  });
});
