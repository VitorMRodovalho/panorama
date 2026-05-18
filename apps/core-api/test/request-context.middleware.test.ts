import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextMiddleware } from '../src/shared/observability/request-context.middleware.js';
import { currentContext, currentRequestId } from '../src/modules/tenant/tenant.context.js';

/**
 * ADR-0018 §3 — request-id propagation contract.
 *
 * These unit tests cover the validator + ALS-write behaviour without
 * booting a Nest app. The companion observability-smoke.e2e.test.ts
 * covers the HTTP-stack ordering invariant (RequestContext registers
 * BEFORE Csrf + Session per AppModule.configure()).
 */

function makeReq(headerValue?: string | string[]): Request {
  const headers: Record<string, string | string[]> = {};
  if (headerValue !== undefined) headers['x-request-id'] = headerValue;
  return { headers } as unknown as Request;
}

function makeRes(): Response {
  const captured: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      captured[name.toLowerCase()] = value;
    },
    _captured: captured,
  } as unknown as Response & { _captured: Record<string, string> };
  return res;
}

describe('RequestContextMiddleware — inbound header validation', () => {
  it('honors a valid x-request-id (alphanumeric)', () => {
    const mw = new RequestContextMiddleware();
    const req = makeReq('abc123_DEF-456');
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).toBe('abc123_DEF-456');
    expect((res as unknown as { _captured: Record<string, string> })._captured['x-request-id']).toBe(
      'abc123_DEF-456',
    );
  });

  it('rejects an x-request-id containing CRLF (log-injection guard)', () => {
    const mw = new RequestContextMiddleware();
    const malicious = 'abc\r\nLevel: critical\r\nmsg: fake';
    const req = makeReq(malicious);
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).not.toBe(malicious);
    expect(observed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
    expect((res as unknown as { _captured: Record<string, string> })._captured['x-request-id']).toBe(
      observed,
    );
  });

  it('rejects an x-request-id longer than 128 chars (DoS guard)', () => {
    const mw = new RequestContextMiddleware();
    const tooLong = 'a'.repeat(129);
    const req = makeReq(tooLong);
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).not.toBe(tooLong);
    expect(observed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
  });

  it('rejects an x-request-id with special chars (charset guard)', () => {
    const mw = new RequestContextMiddleware();
    const req = makeReq('abc/../etc/passwd');
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).not.toBe('abc/../etc/passwd');
    expect(observed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
  });

  it('generates a fresh nanoid when no inbound header is present', () => {
    const mw = new RequestContextMiddleware();
    const req = makeReq();
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
  });

  it('treats a multi-value header as missing (express duplicates → array)', () => {
    const mw = new RequestContextMiddleware();
    const req = makeReq(['a', 'b']);
    const res = makeRes();
    let observed: string | null | undefined;
    mw.use(req, res, (() => {
      observed = currentRequestId();
    }) as NextFunction);
    expect(observed).toMatch(/^req_[A-Za-z0-9_-]{17}$/);
  });
});

describe('TenantContext — ALS empty-frame default', () => {
  it('returns null fields outside any runInContext frame (boot, cron)', () => {
    const ctx = currentContext();
    expect(ctx.tenantId).toBeNull();
    expect(ctx.userId).toBeNull();
    expect(ctx.actorEmail).toBeNull();
    expect(ctx.requestId).toBeNull();
  });

  it('currentRequestId helper returns null outside a frame', () => {
    expect(currentRequestId()).toBeNull();
  });
});
