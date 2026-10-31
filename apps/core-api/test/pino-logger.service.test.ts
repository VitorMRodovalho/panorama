import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import pino from 'pino';
import { PinoLoggerService } from '../src/shared/observability/pino-logger.service.js';

/**
 * #337: services log through `new Logger('<Context>')`, which appends
 * the context after the caller's arguments. An object-first call,
 * `log.warn({ err }, 'event_name')`, therefore reaches PinoLoggerService
 * as `warn({ err }, 'event_name', '<Context>')`. Before the fix the event
 * name was dropped (warn/log/debug) or written as `stack` (error).
 *
 * The tests go through Nest's Logger, as the services do, and read the
 * JSON lines pino writes.
 */

function capture(): { service: PinoLoggerService; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      done();
    },
  });
  const service = new PinoLoggerService(pino({ level: 'trace' }, sink));
  return {
    service,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function logThroughNest(fn: (log: Logger) => void): Record<string, unknown> {
  const { service, records } = capture();
  Logger.overrideLogger(service);
  fn(new Logger('ProbeCtx'));
  const out = records();
  expect(out).toHaveLength(1);
  return out[0] ?? {};
}

describe('PinoLoggerService through Nest Logger (#337)', () => {
  it('object first: the event name becomes msg (warn)', () => {
    const r = logThroughNest((log) => log.warn({ k: 1 }, 'probe_event_object_first'));
    expect(r).toMatchObject({ level: 40, msg: 'probe_event_object_first', context: 'ProbeCtx', k: 1 });
  });

  it('object first at error level: the event name becomes msg, not stack', () => {
    const r = logThroughNest((log) => log.error({ err: 'boom' }, 'probe_event_error'));
    expect(r).toMatchObject({ level: 50, msg: 'probe_event_error', context: 'ProbeCtx', err: 'boom' });
    expect(r).not.toHaveProperty('stack');
  });

  it('object only: no msg, context kept', () => {
    const r = logThroughNest((log) => log.log({ k: 2 }));
    expect(r).toMatchObject({ level: 30, context: 'ProbeCtx', k: 2 });
    expect(r).not.toHaveProperty('msg');
  });

  it('string first (control): msg and context, unchanged', () => {
    const r = logThroughNest((log) => log.warn('probe_event_string_first'));
    expect(r).toMatchObject({ level: 40, msg: 'probe_event_string_first', context: 'ProbeCtx' });
  });

  it('string and stack at error level (control): msg, stack and context, unchanged', () => {
    const r = logThroughNest((log) => log.error('probe_failed', 'Error: x\n    at probe'));
    expect(r).toMatchObject({
      level: 50,
      msg: 'probe_failed',
      stack: 'Error: x\n    at probe',
      context: 'ProbeCtx',
    });
  });

  it('Error instance (control): err serialised, msg is its message', () => {
    const r = logThroughNest((log) => log.error(new Error('probe_error_instance')));
    expect(r).toMatchObject({ level: 50, msg: 'probe_error_instance', context: 'ProbeCtx' });
    expect(r['err']).toMatchObject({ message: 'probe_error_instance' });
  });
});
