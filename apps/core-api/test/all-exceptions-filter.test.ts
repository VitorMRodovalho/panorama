import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AllExceptionsFilter } from '../src/shared/observability/all-exceptions.filter.js';
import { runInContext } from '../src/modules/tenant/tenant.context.js';

/**
 * Unit coverage for AllExceptionsFilter branches that observability-
 * smoke.e2e.test.ts can't easily reach without test-only routes:
 *
 * - 500 (unknown error) path — populates `ref`, returns generic
 *   `Internal server error` body, does NOT leak the exception message
 * - 4xx HttpException path — preserves message; adds `ref` AFTER
 *   spread so an HttpException carrying its own `ref` key cannot
 *   override the trustworthy value
 * - `res.headersSent === true` path — does NOT attempt to write
 *   headers; calls res.end() so the client doesn't hang
 * - `requestId === null` (RequestContextMiddleware regression) —
 *   surfaces a warn log + `ref: unknown` in the body
 */

interface CapturedResponse {
  status: number | null;
  body: unknown;
  ended: boolean;
}

function makeArgumentsHost(opts: {
  headersSent?: boolean;
  path?: string;
  method?: string;
}): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: null, body: null, ended: false };
  const res = {
    headersSent: opts.headersSent ?? false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    end() {
      captured.ended = true;
    },
  } as unknown as Response;
  const req = {
    path: opts.path ?? '/test',
    method: opts.method ?? 'GET',
  } as Request;

  const host = {
    switchToHttp: () => ({
      getResponse: <T = Response>() => res as unknown as T,
      getRequest: <T = Request>() => req as unknown as T,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  it('returns 500 + generic message + ref for unknown errors', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = makeArgumentsHost({});

    runInContext(
      { tenantId: null, userId: null, actorEmail: null, requestId: 'req_test_abc' },
      () => filter.catch(new Error('database connection refused'), host),
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = captured.body as Record<string, unknown>;
    expect(body['statusCode']).toBe(500);
    expect(body['message']).toBe('Internal server error');
    expect(body['message']).not.toContain('database');
    expect(body['ref']).toBe('req_test_abc');
  });

  it('preserves HttpException response shape and adds ref', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = makeArgumentsHost({});

    runInContext(
      { tenantId: null, userId: null, actorEmail: null, requestId: 'req_test_xyz' },
      () => filter.catch(new BadRequestException('invalid_body'), host),
    );

    expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
    const body = captured.body as Record<string, unknown>;
    expect(body['statusCode']).toBe(400);
    expect(body['message']).toBe('invalid_body');
    expect(body['ref']).toBe('req_test_xyz');
  });

  it('refuses to let an HttpException override the ref field', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = makeArgumentsHost({});

    runInContext(
      { tenantId: null, userId: null, actorEmail: null, requestId: 'req_real_id' },
      () =>
        filter.catch(
          new HttpException(
            { message: 'attempt', ref: 'attacker-supplied-id' },
            HttpStatus.CONFLICT,
          ),
          host,
        ),
    );

    const body = captured.body as Record<string, unknown>;
    expect(body['ref']).toBe('req_real_id');
    expect(body['ref']).not.toBe('attacker-supplied-id');
  });

  it('calls res.end() instead of writing headers when headersSent=true', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = makeArgumentsHost({ headersSent: true });

    runInContext(
      { tenantId: null, userId: null, actorEmail: null, requestId: 'req_streamed' },
      () => filter.catch(new Error('mid-stream-failure'), host),
    );

    expect(captured.ended).toBe(true);
    expect(captured.status).toBeNull();
    expect(captured.body).toBeNull();
  });

  it('emits ref=unknown + warns when requestId is null (middleware regression)', () => {
    const filter = new AllExceptionsFilter();
    const internalLog = (filter as unknown as { log: { warn: (...a: unknown[]) => void } }).log;
    const warnSpy = vi.spyOn(internalLog, 'warn');
    const { host, captured } = makeArgumentsHost({});

    // No requestId in the ALS frame.
    runInContext(
      { tenantId: null, userId: null, actorEmail: null, requestId: null },
      () => filter.catch(new Error('regression'), host),
    );

    const body = captured.body as Record<string, unknown>;
    expect(body['ref']).toBe('unknown');
    expect(warnSpy).toHaveBeenCalled();
  });
});
