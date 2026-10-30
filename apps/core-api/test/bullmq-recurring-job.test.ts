import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRecurringJob, nextAlignedSlot } from '../src/shared/queue/bullmq.js';

/**
 * Unit coverage for the BullMQ 6 recurring-job helper, against a fake
 * queue. The real-Redis behaviour (a BullMQ 5 repeatable actually being
 * replaced) is in bullmq-recurring-job.e2e.test.ts.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface FakeSchedule {
  key: string;
  name: string;
}

function fakeQueue(schedules: FakeSchedule[] | Error) {
  const removeJobScheduler = vi.fn(async (_key: string) => true);
  const upsertJobScheduler = vi.fn(async () => ({}));
  const queue = {
    name: 'fake-queue',
    getJobSchedulers: vi.fn(async () => {
      if (schedules instanceof Error) throw schedules;
      return schedules;
    }),
    removeJobScheduler,
    upsertJobScheduler,
  };
  return { queue: queue as unknown as Queue, removeJobScheduler, upsertJobScheduler };
}

describe('nextAlignedSlot', () => {
  it('returns the next UTC midnight for a daily interval', () => {
    expect(nextAlignedSlot(DAY, Date.UTC(2026, 9, 30, 13, 45))).toBe(Date.UTC(2026, 9, 31));
  });

  it('returns the next top of the hour for an hourly interval', () => {
    expect(nextAlignedSlot(HOUR, Date.UTC(2026, 9, 30, 13, 45, 10))).toBe(Date.UTC(2026, 9, 30, 14));
  });

  it('moves to the following slot when called exactly on a boundary', () => {
    expect(nextAlignedSlot(DAY, Date.UTC(2026, 9, 30))).toBe(Date.UTC(2026, 9, 31));
  });
});

describe('ensureRecurringJob', () => {
  const log = new Logger('test');
  const spec = {
    schedulerId: 'probe-daily',
    jobName: 'sweep',
    everyMs: DAY,
    jobOptions: { removeOnComplete: true },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes another schedule producing the same job, keeps ours, then upserts aligned', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The shape BullMQ 5 stores a repeatable under: md5 of
    // `name:jobId:endDate:tz:every`.
    const legacyKey = createHash('md5').update(`sweep:probe-daily:::${DAY}`).digest('hex');
    const { queue, removeJobScheduler, upsertJobScheduler } = fakeQueue([
      { key: legacyKey, name: 'sweep' },
      { key: 'probe-daily', name: 'sweep' },
      { key: 'other-schedule', name: 'other-job' },
    ]);
    const before = nextAlignedSlot(DAY);

    await ensureRecurringJob(queue, spec, log);

    expect(removeJobScheduler.mock.calls).toEqual([[legacyKey]]);
    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, repeat, template] = upsertJobScheduler.mock.calls[0] as unknown as [
      string,
      { every: number; startDate: number },
      { name: string; data: unknown; opts: unknown },
    ];
    expect(id).toBe('probe-daily');
    expect(repeat.every).toBe(DAY);
    expect([before, nextAlignedSlot(DAY)]).toContain(repeat.startDate);
    expect(template).toEqual({ name: 'sweep', data: {}, opts: { removeOnComplete: true } });
  });

  it('still upserts when listing the schedules fails, and logs the failure', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { queue, removeJobScheduler, upsertJobScheduler } = fakeQueue(
      new Error('Legacy repeatable job metadata is not supported in BullMQ v6'),
    );

    await ensureRecurringJob(queue, spec, log);

    expect(removeJobScheduler).not.toHaveBeenCalled();
    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'fake-queue' }),
      'job_scheduler_list_failed',
    );
  });

  it('defaults the template options to none', async () => {
    const { queue, upsertJobScheduler } = fakeQueue([]);
    await ensureRecurringJob(queue, { schedulerId: 'h', jobName: 'sweep', everyMs: HOUR }, log);
    const template = (upsertJobScheduler.mock.calls[0] as unknown as unknown[])[2];
    expect(template).toEqual({ name: 'sweep', data: {}, opts: {} });
  });
});
