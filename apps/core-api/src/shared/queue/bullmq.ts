import type { Logger } from '@nestjs/common';
import type { JobSchedulerTemplateOptions, Queue } from 'bullmq';

/**
 * Shared BullMQ plumbing for the in-process sweeps and queues.
 *
 * --- Redis wire protocol ---------------------------------------------
 * ioredis 6 negotiates RESP3 by default. BullMQ 6 (6.5.x) is developed
 * and tested against ioredis 5.11 over RESP2, and under RESP3 a Lua
 * `false` reply decodes to `0` instead of `null` even with ioredis'
 * RESP2-compatible "legacy" reply mapping, a shape BullMQ's own suite
 * never sees. Every connection handed to BullMQ therefore keeps the v5
 * wire protocol, the opt-out the ioredis v5 -> v6 upgrade guide
 * documents. Revisit once BullMQ tests against ioredis 6.
 */
export const BULLMQ_REDIS_PROTOCOL = 2 as const;

/**
 * A recurring job owned by one dedicated queue.
 *
 * `schedulerId` is the stable identity of the schedule: BullMQ derives
 * every produced job id from it (`repeat:<schedulerId>:<millis>`) and
 * `upsertJobScheduler` keys on it, so a restart or a second replica
 * updates the one schedule instead of adding another.
 */
export interface RecurringJobSpec {
  schedulerId: string;
  jobName: string;
  everyMs: number;
  /** Template options copied onto every produced job. */
  jobOptions?: JobSchedulerTemplateOptions;
}

/**
 * The next multiple of `everyMs` since the epoch: the same arithmetic as
 * BullMQ 5's `every` repeat strategy (`Math.floor(now / every) * every +
 * every`). Used as the scheduler's `startDate` so a daily schedule keeps
 * firing at 00:00 UTC and an hourly one at the top of the hour, as the
 * legacy repeatable jobs did. Without it a new Job Scheduler fires
 * immediately and then every `everyMs` from deploy time.
 */
export function nextAlignedSlot(everyMs: number, nowMs: number = Date.now()): number {
  return Math.floor(nowMs / everyMs) * everyMs + everyMs;
}

/**
 * Create or update the recurring job, after removing any other schedule
 * in the same queue that produces the same job name.
 *
 * BullMQ 6 removed legacy repeatable jobs (`queue.add(..., { repeat })`).
 * A deployment upgraded from BullMQ 5 still holds the old repeatable in
 * the queue's `repeat` set under an md5-hashed key, with its next
 * iteration waiting as a delayed job. Left alone, it would keep firing
 * next to the new scheduler (two runs per period). BullMQ's migration
 * guide prescribes "remove the legacy repeatable-job configurations
 * from Redis" with `removeRepeatableByKey`, which v6 no longer has.
 * For keys written by BullMQ >= 5.x (hash keys without `:`),
 * `removeJobScheduler(key)` runs the same Redis operations as the v5
 * call's hashed-key branch: drop the pending `repeat:<key>:<millis>`
 * delayed job, ZREM the key, DEL its metadata hash.
 *
 * Only entries that produce `jobName` are touched, so the queue may host
 * other schedules under other job names.
 */
export async function ensureRecurringJob(
  queue: Queue,
  spec: RecurringJobSpec,
  log: Logger,
): Promise<void> {
  await removeSupersededSchedules(queue, spec, log);
  await queue.upsertJobScheduler(
    spec.schedulerId,
    { every: spec.everyMs, startDate: nextAlignedSlot(spec.everyMs) },
    { name: spec.jobName, data: {}, opts: spec.jobOptions ?? {} },
  );
}

async function removeSupersededSchedules(
  queue: Queue,
  spec: RecurringJobSpec,
  log: Logger,
): Promise<void> {
  let schedules: Awaited<ReturnType<Queue['getJobSchedulers']>>;
  try {
    schedules = await queue.getJobSchedulers();
  } catch (err) {
    // BullMQ 6 throws on a pre-hash legacy key (`name:id:endDate:tz:every`).
    // This codebase never wrote one (it started on BullMQ 5.74, which
    // hashes keys), so this is an operator-visible anomaly, not a boot
    // failure: the upsert below still runs.
    log.error({ queue: queue.name, err: String(err) }, 'job_scheduler_list_failed');
    return;
  }
  for (const schedule of schedules) {
    if (schedule.key === spec.schedulerId || schedule.name !== spec.jobName) continue;
    await queue.removeJobScheduler(schedule.key);
    log.warn(
      { queue: queue.name, removedKey: schedule.key, schedulerId: spec.schedulerId },
      'superseded_job_schedule_removed',
    );
  }
}
