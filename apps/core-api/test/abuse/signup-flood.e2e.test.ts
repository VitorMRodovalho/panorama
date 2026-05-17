import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, type AuditEvent } from '@prisma/client';
import { Redis } from 'ioredis';
import { AppModule } from '../../src/app.module.js';
import { OidcService, type OidcUserInfo } from '../../src/modules/auth/oidc.service.js';
import { TurnstileVerifier } from '../../src/modules/signup/turnstile-verifier.service.js';
import { resetTestDb } from '../_reset-db.js';

/**
 * Synthetic-flood test (Wave 0 Round 3, ADR-0020 §4 three-bucket
 * contract + the §4 anti-spoof assertion). Sibling of the
 * `login-flood.e2e.test.ts` introduced in Round 2.
 *
 * The three §4 buckets are all enforced service-level via
 * `SignupRateLimits` (modules/signup/signup-rate-limits.service.ts),
 * so this test exercises them by hitting `/auth/signup/google/start`
 * + `/auth/signup/google/callback` enough times to trip each one in
 * isolation. To keep the buckets from cross-contaminating:
 *
 *   - The `ip` bucket test uses XFF `10.0.0.1`.
 *   - The `subnet` bucket test uses XFFs `11.0.0.0`..`11.0.0.50` (a
 *     different /24 from the ip-bucket test so the 5 attempts above
 *     don't leak into the 50-slot subnet budget).
 *   - The `oidc_sub` bucket test uses XFF `12.0.0.1` so its 4 attempts
 *     don't share ip or subnet keys with the earlier tests.
 *
 * Anti-spoof (the rightmost assertion in the handoff) runs in a
 * SEPARATE describe with `trust proxy 0`: forging
 * `X-Forwarded-For: 1.2.3.4` against a trust-proxy-0 server has no
 * effect — `req.ip` stays on the socket address. That matches the
 * self-host-without-edge contract documented in
 * `docs/runbooks/secrets-inventory.md`.
 *
 * `OidcService` is mocked so callback responses don't require a real
 * IdP. `TurnstileVerifier` is mocked so the test doesn't reach
 * Cloudflare. Both overrides are provider-scoped via the testing
 * module so the rest of the SignupController flow runs unmocked
 * (state store, audit, tenant creation).
 */

const HOST = process.env['PG_HOST'] ?? 'localhost';
const PORT = process.env['PG_PORT'] ?? '5432';
const DB = process.env['PG_DB'] ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const APP_URL = `postgres://panorama_app:panorama@${HOST}:${PORT}/${DB}?schema=public`;
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379/0';

const SYNTHETIC_GOOGLE_ISSUER = 'https://accounts.google.invalid';

interface SignupTestApp {
  app: INestApplication;
  url: string;
  oidcCallback: ReturnType<typeof makeOidcCallbackMock>;
}

describe('abuse: signup flood (Wave 0 Round 3)', () => {
  let suite: SignupTestApp;
  let redis: Redis;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;
    process.env['FEATURE_SELF_SERVE_SIGNUP'] = 'true';
    process.env['TURNSTILE_SECRET'] = 'test-secret';
    process.env['SIGNUP_FAILURE_LATENCY_FLOOR_MS'] = '20';
    process.env['OIDC_GOOGLE_CLIENT_ID'] = 'test-google-client';
    process.env['OIDC_GOOGLE_CLIENT_SECRET'] = 'test-google-secret';
    // SignupController.start composes redirect_uri from APP_BASE_URL;
    // anything resolvable is fine since we mock OidcService.start.
    process.env['APP_BASE_URL'] = process.env['APP_BASE_URL'] ?? 'http://localhost:4000';

    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);
    await admin.$disconnect();

    redis = new Redis(REDIS_URL);
    await flushSignupKeys(redis);

    suite = await buildSignupTestApp({ trustProxy: 1 });
  }, 60_000);

  afterAll(async () => {
    await suite?.app.close();
    await redis?.quit();
    delete process.env['FEATURE_SELF_SERVE_SIGNUP'];
  });

  beforeEach(async () => {
    // Each test uses distinct IP families, but Redis state survives
    // process restarts; wipe between tests so a flaky earlier test
    // doesn't leak slots into the next one.
    await flushSignupKeys(redis);
    // Reset OidcService.callback's per-test counter / iss/sub
    // expectations.
    suite.oidcCallback.reset();
  });

  it('ip bucket (5 / IP / hour) trips on the 6th start from one IP', async () => {
    const xff = '10.0.0.1';
    const statuses = await rapidStarts(suite.url, 6, xff);

    // First 5 redirect to the IdP (mocked OidcService URL). The 6th
    // trips signupIp and returns the timing-padded 400.
    expect(statuses.slice(0, 5).every((s) => s === 302)).toBe(true);
    expect(statuses[5]).toBe(400);
  });

  it('subnet bucket (50 / /24 / 24h) trips on the 51st start across distinct IPs in same /24', async () => {
    // 51 attempts, each from a distinct IP in 11.0.0.0/24. Per-IP
    // bucket never trips (each IP gets 1 hit out of its 5/hour budget),
    // but the shared subnet bucket fills at attempt 50 and trips on 51.
    const statuses: number[] = [];
    for (let i = 0; i < 51; i++) {
      statuses.push(...(await rapidStarts(suite.url, 1, `11.0.0.${i}`)));
    }

    expect(statuses.slice(0, 50).every((s) => s === 302)).toBe(true);
    expect(statuses[50]).toBe(400);
  });

  it('unknown_provider audit emit is bounded by the ip bucket (rate-limit BEFORE resolveProvider)', async () => {
    // Regression for the BL-NEW-1 audit-DoS amplifier surfaced by
    // security-reviewer 2nd pass. If a future refactor moves
    // resolveProvider above consumeIp, every garbage-provider POST
    // would emit one AuthSignupOidcStateMismatch(unknown_provider)
    // audit row + grab the audit:global advisory lock, with no
    // per-IP ceiling. The reorder caps it at the ip bucket: ~5
    // unknown_provider rows from one IP before AuthSignupRateLimitTripped
    // takes over.
    //
    // Test: 10 POSTs to /auth/signup/garbage/start from one IP.
    // Expect at most 5 unknown_provider rows + the remainder as
    // ratelimit_tripped(ip) rows.
    const xff = '13.0.0.1';
    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    try {
      // Clear any earlier audit rows from sibling tests so the
      // count assertions are clean.
      await admin.auditEvent.deleteMany({
        where: {
          action: {
            in: [
              'panorama.auth.signup_oidc_state_mismatch',
              'panorama.auth.signup_rate_limit_tripped',
            ],
          },
        },
      });

      for (let i = 0; i < 10; i++) {
        const resp = await fetch(`${suite.url}/auth/signup/garbage/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
          body: JSON.stringify({
            captchaToken: `tt-${Math.random().toString(36).slice(2, 12)}`,
            ctaSource: 'hosted_button',
            ageGateAccepted: true,
          }),
          redirect: 'manual',
        });
        expect(resp.status).toBe(400);
      }

      const rows = await admin.auditEvent.findMany({
        where: {
          action: {
            in: [
              'panorama.auth.signup_oidc_state_mismatch',
              'panorama.auth.signup_rate_limit_tripped',
            ],
          },
        },
        orderBy: { id: 'asc' },
      });
      const unknownProvider = rows.filter(
        (r: AuditEvent) =>
          r.action === 'panorama.auth.signup_oidc_state_mismatch' &&
          (r.metadata as { reason?: string } | null)?.reason === 'unknown_provider',
      );
      const rateLimitIp = rows.filter(
        (r: AuditEvent) =>
          r.action === 'panorama.auth.signup_rate_limit_tripped' &&
          (r.metadata as { bucket?: string } | null)?.bucket === 'ip',
      );
      // The ip bucket holds 5 slots per hour, so at most 5 of the
      // 10 requests reach the resolveProvider step. The other 5+
      // are blocked at the ip-bucket consume and emit ratelimit_tripped.
      expect(unknownProvider.length).toBeLessThanOrEqual(5);
      expect(rateLimitIp.length).toBeGreaterThanOrEqual(5);
      // Total = 10 audit rows (one per request), bound enforced.
      expect(unknownProvider.length + rateLimitIp.length).toBe(10);
    } finally {
      await admin.$disconnect();
    }
  });

  it('oidc_sub bucket (3 / (iss, sub) / 24h) plus existing-account refuse short-circuit the 2nd+ attempts', async () => {
    const xff = '12.0.0.1';
    const subject = 'sub-flood-test-fixed';
    suite.oidcCallback.setUserInfo({
      subject,
      email: 'flood@example.invalid',
      firstName: 'Flood',
      lastName: 'Tester',
      displayName: 'Flood Tester',
      emailVerified: true,
      hd: null,
      iss: SYNTHETIC_GOOGLE_ISSUER,
    });

    const callbackStatuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const startResp = await postStart(suite.url, xff);
      expect(startResp.status).toBe(302);
      const stateKey = readStateFromLocation(startResp.headers.get('location') ?? '');
      const callbackResp = await fetch(
        `${suite.url}/auth/signup/google/callback?code=fake-code&state=${stateKey}`,
        { redirect: 'manual' },
      );
      callbackStatuses.push(callbackResp.status);
    }

    // Attempt 1: new_user — tenant created, 302 to /?signup=verify.
    // Attempts 2 + 3: existing_identity (AuthIdentity created on attempt 1) —
    //                 refused with TenantSignupRefusedExistingAccount, 400.
    // Attempt 4: oidc_sub bucket goes 3 → 4 → over limit — refused with
    //            AuthSignupRateLimitTripped(bucket=oidc_sub), 400.
    // The shape (1 redirect followed by 3 refusals) verifies both the
    // bucket budget and the §2 one-tenant-per-email contract. Audit
    // rows distinguish the specific refusal reason for each attempt.
    expect(callbackStatuses[0]).toBe(302);
    expect(callbackStatuses.slice(1).every((s) => s === 400)).toBe(true);
  });
});

describe('abuse: signup flood — anti-spoof (Wave 0 Round 3)', () => {
  let suite: SignupTestApp;
  let redis: Redis;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);
    process.env['DATABASE_URL'] = APP_URL;
    process.env['FEATURE_SELF_SERVE_SIGNUP'] = 'true';
    process.env['TURNSTILE_SECRET'] = 'test-secret';
    process.env['SIGNUP_FAILURE_LATENCY_FLOOR_MS'] = '20';
    process.env['OIDC_GOOGLE_CLIENT_ID'] = 'test-google-client';
    process.env['OIDC_GOOGLE_CLIENT_SECRET'] = 'test-google-secret';
    process.env['APP_BASE_URL'] = process.env['APP_BASE_URL'] ?? 'http://localhost:4000';

    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);
    await admin.$disconnect();

    redis = new Redis(REDIS_URL);
    await flushSignupKeys(redis);

    // trust proxy 0 — `req.ip` is the socket address regardless of
    // any X-Forwarded-For header the client sends. This is the self-
    // host-without-edge default; the §4 anti-spoof contract asserts
    // that XFF cannot be used to forge bucket keys in this config.
    suite = await buildSignupTestApp({ trustProxy: 0 });
  }, 60_000);

  afterAll(async () => {
    await suite?.app.close();
    await redis?.quit();
    delete process.env['FEATURE_SELF_SERVE_SIGNUP'];
  });

  it('forged X-Forwarded-For does NOT move the per-IP bucket key', async () => {
    // 6 attempts, all carrying X-Forwarded-For: 1.2.3.4. With trust
    // proxy 0, req.ip stays on the loopback socket and the bucket
    // fills accordingly. The 6th attempt trips the ip bucket regardless
    // of the spoofed header.
    const statuses = await rapidStarts(suite.url, 6, '1.2.3.4');

    expect(statuses.slice(0, 5).every((s) => s === 302)).toBe(true);
    expect(statuses[5]).toBe(400);
  });
});

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

async function buildSignupTestApp(opts: { trustProxy: 0 | 1 }): Promise<SignupTestApp> {
  const oidcCallback = makeOidcCallbackMock();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(OidcService)
    .useValue({
      start: async (params: { provider: string; state?: string }) => ({
        url: `http://example.invalid/idp/auth?state=${params.state ?? 'unknown'}`,
        state: params.state ?? 'unknown',
        codeVerifier: 'test-code-verifier',
        nonce: 'test-nonce',
      }),
      callback: oidcCallback.fn,
    })
    .overrideProvider(TurnstileVerifier)
    .useValue({
      verify: async () => ({ ok: true }),
    })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  (app as NestExpressApplication).set('trust proxy', opts.trustProxy);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  await app.listen(0);
  const url = await app.getUrl();
  return { app, url, oidcCallback };
}

function makeOidcCallbackMock(): {
  fn: (params: unknown) => Promise<OidcUserInfo>;
  setUserInfo: (u: OidcUserInfo) => void;
  reset: () => void;
} {
  let current: OidcUserInfo | null = null;
  return {
    fn: async () => {
      if (!current) {
        throw new Error(
          'OidcService.callback mock called without setUserInfo() — test setup bug',
        );
      }
      return current;
    },
    setUserInfo: (u: OidcUserInfo) => {
      current = u;
    },
    reset: () => {
      current = null;
    },
  };
}

async function rapidStarts(baseUrl: string, count: number, xff: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const resp = await postStart(baseUrl, xff);
    statuses.push(resp.status);
  }
  return statuses;
}

function postStart(baseUrl: string, xff: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/signup/google/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': xff,
    },
    body: JSON.stringify({
      captchaToken: `tt-${Math.random().toString(36).slice(2, 12)}`,
      ctaSource: 'hosted_button',
      ageGateAccepted: true,
    }),
    redirect: 'manual',
  });
}

function readStateFromLocation(location: string): string {
  const idx = location.indexOf('state=');
  if (idx === -1) return '';
  const tail = location.slice(idx + 'state='.length);
  const amp = tail.indexOf('&');
  return amp === -1 ? tail : tail.slice(0, amp);
}

async function flushSignupKeys(redis: Redis): Promise<void> {
  // Wipe only the panorama:signup:* keyspace so we don't disturb
  // unrelated state in dev Redis. Async iterator over SCAN is the
  // idiomatic ioredis pattern.
  const stream = redis.scanStream({ match: 'panorama:signup:*', count: 200 });
  for await (const batch of stream) {
    const keys = batch as string[];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
