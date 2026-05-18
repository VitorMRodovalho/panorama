import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/shared/observability/all-exceptions.filter.js';

/**
 * Observability smoke per ADR-0018 §"Implementation notes" step 2.
 *
 * ADR-0018 Consequences "Negative" mandates this test:
 *
 *   "The RequestContextMiddleware MUST be registered before
 *    SessionMiddleware; future module reorganization can break this
 *    invariant. Documented in middleware-order comment + asserted by
 *    an e2e smoke test."
 *
 * What this test proves end-to-end:
 *   1. A valid inbound `x-request-id` is honored and echoed in the
 *      response header (caller-driven correlation works).
 *   2. An invalid inbound `x-request-id` (CRLF / wrong charset) is
 *      silently replaced with a fresh nanoid (log-injection guard).
 *   3. A request without an inbound header gets a fresh nanoid.
 *   4. The global AllExceptionsFilter adds `ref` to JSON error bodies
 *      AND that `ref` matches the response's `x-request-id` — which is
 *      only possible if RequestContextMiddleware's ALS frame is intact
 *      when the filter runs AFTER all the other middlewares (Csrf,
 *      Session). This is the ordering invariant ADR-0018 calls out.
 *
 * Dev-stack assumption: matches the community-smoke pattern — DB and
 * Redis must be reachable because AppModule boots the full graph. The
 * test uses GET /health (cheap SELECT 1) so the rest of the dev stack
 * (MinIO, MailHog) doesn't need to be up.
 */

describe('observability — request-id propagation (ADR-0018)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = process.env['SESSION_SECRET'] ?? 'a'.repeat(32);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('honors a valid inbound x-request-id and echoes it in the response header', async () => {
    const sent = 'caller-correlation-id-abc_123';
    const res = await fetch(`${url}/health`, {
      headers: { 'x-request-id': sent },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(sent);
  });

  it('replaces an invalid inbound x-request-id (wrong charset) with a fresh nanoid', async () => {
    // CRLF coverage is in the unit test — fetch()'s own Headers
    // implementation rejects CR/LF before they hit the wire, so we
    // exercise a fetch-valid-but-regex-invalid value here (path
    // traversal, suspicious slashes).
    const malicious = 'abc/../etc/passwd';
    const res = await fetch(`${url}/health`, {
      headers: { 'x-request-id': malicious },
    });
    expect(res.status).toBe(200);
    const echoed = res.headers.get('x-request-id');
    expect(echoed).not.toBe(malicious);
    expect(echoed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
  });

  it('generates a fresh nanoid when no inbound x-request-id is present', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it('attaches `ref` (matching x-request-id header) to a 400 JSON error body', async () => {
    // POST /auth/login with empty body → LoginSchema.safeParse fails →
    // BadRequestException → AllExceptionsFilter adds ref to the body.
    // This proves the ALS frame from RequestContextMiddleware is still
    // intact when the filter runs (i.e., middleware order survived the
    // full pipeline: RequestContext → Csrf → Session → controller →
    // exception → filter).
    const sent = 'walk-the-pipeline-xyz_42';
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': sent },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe(sent);
    const body = (await res.json()) as { ref?: string };
    expect(body.ref).toBe(sent);
  });

  it('attaches `ref` to error bodies even when no inbound x-request-id is given', async () => {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const echoed = res.headers.get('x-request-id');
    expect(echoed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
    const body = (await res.json()) as { ref?: string };
    expect(body.ref).toBe(echoed);
  });
});
