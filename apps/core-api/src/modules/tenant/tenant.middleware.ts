import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runInContext, type TenantContext } from './tenant.context.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads tenant + user identifiers off the incoming request and binds them
 * to an AsyncLocalStorage context that downstream code (PrismaService in
 * particular) can read without threading the values through every
 * function signature.
 *
 * 0.1 scaffold: pulls `X-Tenant-Id` / `X-User-Id` / `X-Actor-Email` from
 * headers. 0.2 will replace this with reading the iron-session cookie
 * (see AuthModule) and will delete the header paths.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly log = new Logger('TenantMiddleware');

  use(req: Request, _res: Response, next: NextFunction): void {
    const ctx = this.extractContext(req);
    runInContext(ctx, () => next());
  }

  private extractContext(req: Request): TenantContext {
    const rawTenant = this.headerValue(req, 'x-tenant-id');
    const rawUser = this.headerValue(req, 'x-user-id');
    const rawEmail = this.headerValue(req, 'x-actor-email');

    const tenantId = rawTenant && UUID_RE.test(rawTenant) ? rawTenant.toLowerCase() : null;
    const userId = rawUser && UUID_RE.test(rawUser) ? rawUser.toLowerCase() : null;
    const actorEmail = rawEmail ? rawEmail.toLowerCase() : null;

    if (rawTenant && !tenantId) {
      this.log.warn({ raw: rawTenant }, 'invalid X-Tenant-Id header (expected UUID)');
    }
    if (rawUser && !userId) {
      this.log.warn({ raw: rawUser }, 'invalid X-User-Id header (expected UUID)');
    }

    return { tenantId, userId, actorEmail };
  }

  private headerValue(req: Request, name: string): string | null {
    const raw = req.headers[name];
    if (Array.isArray(raw)) return raw[0] ?? null;
    if (typeof raw === 'string') return raw.trim() || null;
    return null;
  }
}
