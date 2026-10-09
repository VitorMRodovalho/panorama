import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSentryIfConfigured } from '../src/shared/observability/sentry.bootstrap.js';

/**
 * Pins the privacy contract of `initSentryIfConfigured` (ADR-0018 §2):
 * an opted-in Sentry must never carry headers, cookies, request bodies
 * or local variables. The guarantee rests on `defaultIntegrations:
 * false`; this suite asserts the EFFECT (what is installed, what an
 * event carries), not the option literal, so an SDK major that changes
 * how defaults are resolved turns it red.
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
    expect(client?.getOptions().sendDefaultPii).toBe(false);
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
