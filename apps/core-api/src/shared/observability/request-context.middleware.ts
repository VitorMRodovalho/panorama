import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { customAlphabet } from 'nanoid';
import { runInContext, type TenantContext } from '../../modules/tenant/tenant.context.js';

/**
 * Request-id propagation per ADR-0018 §3.
 *
 * Registered FIRST in AppModule.configure() — before CsrfOriginMiddleware
 * and SessionMiddleware (auth.module.ts). This ordering is load-bearing:
 *
 *   1. Every response (incl. CSRF-rejected 403s and unauthenticated
 *      probes) carries `x-request-id` so an end user pasting the value
 *      to support correlates immediately.
 *   2. SessionMiddleware's nested runInContext call inherits the
 *      requestId from the frame this middleware creates (see
 *      session.middleware.ts spread of currentContext()).
 *   3. pino's mixin reads the same TenantContext store and tags every
 *      log line emitted inside the request with the request-id.
 *
 * Inbound `x-request-id` from the caller is honored ONLY if it matches a
 * strict charset (URL-safe alphabet, 1-128 chars). Invalid values are
 * silently replaced with a freshly generated id — never rejected with a
 * 400 (avoids handing a probe surface to a hostile client and keeps the
 * downstream behaviour stable). The charset rejects CR/LF, so a log-
 * aggregator parser that splits on `\n` (Logtail, Datadog) cannot be
 * tricked into mid-line injection via this header.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Same alphabet as the validation regex so generated ids always survive
// their own round-trip through validate(). The `req_` prefix makes the
// id readable over a radio at 5:30am — an ops manager hearing
// "ref: req underscore eight chars" can sanity-check before searching
// (per persona-fleet-ops per-PR scan 2026-05-17). 17 random chars at
// 64-char alphabet ≈ 102 bits of entropy, still effectively
// collision-free at preview scale.
const generateRandomSuffix = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', 17);

function generateId(): string {
  return `req_${generateRandomSuffix()}`;
}

function resolveRequestId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === 'string' && ID_PATTERN.test(headerValue)) {
    return headerValue;
  }
  return generateId();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    res.setHeader('x-request-id', requestId);

    const ctx: TenantContext = {
      tenantId: null,
      userId: null,
      actorEmail: null,
      requestId,
    };

    void runInContext(ctx, () => {
      next();
    });
  }
}
