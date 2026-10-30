import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSentryIfConfigured } from '../src/shared/observability/sentry.bootstrap.js';

/**
 * Pins the privacy contract of `initSentryIfConfigured` (ADR-0018 §2):
 * an opted-in Sentry must never carry headers, cookies, request bodies
 * or local variables. The guarantee rests on `defaultIntegrations:
 * false`, with every SDK 11 `dataCollection` category off behind it;
 * this suite asserts the EFFECT (what is installed, what the SDK
 * resolved, what an event carries), not the option literal, so an SDK
 * major that changes how defaults are resolved turns it red.
 *
 * The DSN points at a closed local port, so nothing leaves the process.
 */
const DSN = 'http://public@127.0.0.1:9/1';

/** Integrations the SDK installs by default and that would capture request data. */
const FORBIDDEN_INTEGRATIONS = [
  'RequestData',
  'Http',
  'NodeFetch',
  'LocalVariables',
  'Console',
  'ContextLines',
  'Modules',
  'Context',
];

/**
 * True when a resolved `dataCollection` value would collect something:
 * `true`, a non-empty list (`httpBodies`), a positive count
 * (`frameContextLines`), an `{ allow }` / `{ deny }` filter, or a nested
 * object with any such member.
 */
function collectsSomething(value: unknown): boolean {
  if (value === false || value === undefined || value === null) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    if ('allow' in value || 'deny' in value) return true;
    return Object.values(value).some(collectsSomething);
  }
  return true;
}

describe('initSentryIfConfigured — privacy contract', () => {
  afterEach(async () => {
    await Sentry.close(0);
    vi.unstubAllEnvs();
  });

  it('is a no-op without SENTRY_DSN', () => {
    vi.stubEnv('SENTRY_DSN', '');
    expect(initSentryIfConfigured()).toBe(false);
  });

  it('installs none of the request-capturing default integrations', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    expect(initSentryIfConfigured()).toBe(true);
    const client = Sentry.getClient();
    expect(client).toBeDefined();
    for (const name of FORBIDDEN_INTEGRATIONS) {
      expect(client?.getIntegrationByName(name), name).toBeUndefined();
    }
  });

  it('installs nothing beyond what the SDK forces (allowlist)', () => {
    // The denylist above only names integrations someone thought of;
    // this pins the whole resolved set. SDK 11 adds `SpanStreaming`
    // even with `defaultIntegrations: false`; with tracing off it has
    // nothing to send (see "records no spans").
    vi.stubEnv('SENTRY_DSN', DSN);
    initSentryIfConfigured();
    const names = (Sentry.getClient()?.getOptions().integrations ?? []).map((i) => i.name);
    expect(names).toEqual(['SpanStreaming']);
  });

  it('resolves every data-collection category to off', () => {
    // SDK 11 replaced `sendDefaultPii` with `dataCollection`, and an
    // unset category COLLECTS. This walks the SDK's resolved view, not
    // our literal, so a category a later SDK adds (and defaults on)
    // turns this red instead of shipping silently.
    vi.stubEnv('SENTRY_DSN', DSN);
    initSentryIfConfigured();
    const resolved = Sentry.getClient()?.getDataCollectionOptions();
    expect(resolved).toBeDefined();
    const collecting = Object.entries(resolved ?? {})
      .filter(([, value]) => collectsSomething(value))
      .map(([key]) => key);
    expect(collecting).toEqual([]);
  });

  it('records no spans', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    initSentryIfConfigured();
    const recording = Sentry.startSpan({ name: 'probe' }, (span) => span.isRecording());
    expect(recording).toBe(false);
  });

  it('sends an error event without request headers, cookies, body or IP', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    initSentryIfConfigured();

    const captured: Event[] = [];
    Sentry.getClient()?.on('beforeSendEvent', (event) => {
      captured.push(event);
    });

    // What the HTTP instrumentation would attach to the isolation scope
    // for an inbound request. With RequestData installed, it ends up in
    // `event.request`.
    Sentry.withIsolationScope((isolation) => {
      isolation.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: 'http://localhost:4000/auth/login',
          headers: { cookie: 'panorama_session=secret', authorization: 'Bearer secret' },
          data: '{"password":"secret"}',
        },
        ipAddress: '203.0.113.7',
      });
      Sentry.withScope((scope) => {
        scope.setUser({ id: 'user-1' });
        Sentry.captureException(new Error('boom'));
      });
    });
    await Sentry.flush(200);

    expect(captured).toHaveLength(1);
    const event = captured[0] as Event;
    expect(event.request).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(JSON.stringify(event)).not.toContain('203.0.113.7');
    expect(event.user).toEqual({ id: 'user-1' });
  });
});
