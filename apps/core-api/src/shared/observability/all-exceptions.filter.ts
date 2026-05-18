import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { currentContext } from '../../modules/tenant/tenant.context.js';

/**
 * Global exception filter per ADR-0018 §3 + persona-fleet-ops pre-impl
 * blocker (2026-05-17).
 *
 * Two responsibilities:
 *   1. Add `ref` (the request-id) to every JSON error response so an
 *      end user pasting "ref: <id>" to support correlates to one
 *      request in 30 seconds instead of grep-by-minute archaeology.
 *   2. Forward unhandled 5xx-class exceptions to Sentry (when opted in
 *      via SENTRY_DSN) with a TIGHTLY-SCOPED context — `tenantId`,
 *      `userId`, `requestId`, path, method. NEVER req.body, NEVER
 *      req.headers (would leak Authorization / Cookie / password).
 *      `actorEmail` from the ALS is intentionally omitted (PII; LGPD).
 *
 * 4xx errors are passed through with `ref` but NOT sent to Sentry —
 * user-input errors dominate the volume on a public preview and would
 * burn the free-tier 5K events/month allowance (ADR-0018 Consequences
 * "Negative"). Operators can opt 4xx into Sentry via a future ADR
 * amendment if a real signal-to-noise question emerges.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const { requestId } = currentContext();
    if (!requestId) {
      // requestId being null inside an exception filter means
      // RequestContextMiddleware didn't fire — a regression in the
      // module-ordering invariant. Surface it loud so CI catches it.
      this.log.warn('request_context_missing_in_filter', 'AllExceptionsFilter');
    }
    const ref = requestId ?? 'unknown';

    let body: Record<string, unknown>;
    if (exception instanceof HttpException) {
      const exResponse = exception.getResponse();
      if (typeof exResponse === 'string') {
        body = { statusCode: status, message: exResponse };
      } else if (exResponse && typeof exResponse === 'object') {
        body = { statusCode: status, ...(exResponse as Record<string, unknown>) };
      } else {
        body = { statusCode: status, message: exception.message };
      }
    } else {
      body = { statusCode: status, message: 'Internal server error' };
    }
    // Set after spread so a malicious HttpException response that
    // includes its own `ref` key cannot override the trustworthy one.
    body['ref'] = ref;

    if (status >= 500) {
      this.captureToSentry(exception, req);
      this.log.error(
        exception instanceof Error ? exception.stack ?? exception.message : String(exception),
        'AllExceptionsFilter',
      );
    }

    if (res.headersSent) {
      // Controller already started streaming before throwing
      // (e.g., a Prisma error mid-CSV export). We cannot rewrite
      // headers; terminate the socket deterministically so the
      // client doesn't hang on a half-written response. Per
      // tech-lead per-PR scan 2026-05-17.
      res.end();
      return;
    }
    res.status(status).json(body);
  }

  private captureToSentry(exception: unknown, req: Request): void {
    if (!process.env['SENTRY_DSN']) return;

    const { tenantId, userId, requestId } = currentContext();

    Sentry.withScope((scope) => {
      scope.setTag('requestId', requestId ?? 'unknown');
      if (tenantId) scope.setTag('tenantId', tenantId);
      if (userId) scope.setUser({ id: userId });
      scope.setExtra('path', req.path);
      scope.setExtra('method', req.method);

      if (exception instanceof Error) {
        Sentry.captureException(exception);
      } else {
        Sentry.captureMessage(String(exception), 'error');
      }
    });
  }
}
