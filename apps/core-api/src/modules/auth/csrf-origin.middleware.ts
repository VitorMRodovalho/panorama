import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthConfigService } from './auth.config.js';

/**
 * Defense-in-depth CSRF gate via `Origin` / `Referer` header validation.
 * Layered with `SameSite=Lax` cookies (set in session.service.ts) and
 * the existing helmet defaults.
 *
 * `SameSite=Lax` already blocks the dominant CSRF vector (cross-site
 * form POST without top-level navigation); this middleware closes the
 * residual gaps:
 *
 *   * Browsers with partial / legacy SameSite support
 *   * Same-site cross-origin (subdomain attacks)
 *   * Top-level navigations whose target is a state-changing endpoint
 *
 * Rules:
 *
 *   * GET / HEAD / OPTIONS — always allowed. State-changing methods
 *     (POST / PUT / PATCH / DELETE) go through the check.
 *   * If `Origin` header is present, it MUST match the configured
 *     `WEB_ORIGIN` (comma-separated allowlist, defaulting to the
 *     auth base URL). Mismatch → 403 + warn audit log.
 *   * If `Origin` is absent BUT `Referer` is present, the
 *     scheme://host of `Referer` MUST be in the allowlist.
 *   * If both are absent — typical for server-to-server fetches that
 *     this codebase performs (Next.js server actions → core-api),
 *     allow but log at debug. Server-side calls cannot impersonate a
 *     user without the HttpOnly session cookie, so the SameSite +
 *     auth chain still applies.
 *
 * SEC-02 / #34: documented as the doc-vs-code gap. Full double-submit
 * cookie + header pattern is a future M effort if the threat model
 * grows; this layer matches modern browser semantics and is the
 * pragmatic 80% under a single-session-cookie design.
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  private readonly log = new Logger('CsrfOriginMiddleware');
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(cfg: AuthConfigService) {
    const fromEnv = (process.env.WEB_ORIGIN ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/\/+$/, ''));
    const fromBase = cfg.config.baseUrl.replace(/\/+$/, '');
    const all = new Set<string>([fromBase, ...fromEnv]);
    this.trustedOrigins = all;
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    const origin = headerValue(req.headers['origin']);
    const referer = headerValue(req.headers['referer']);

    if (!origin && !referer) {
      // Server-to-server fetches (e.g. apps/web's server actions
      // forwarding a user request to core-api) typically omit both.
      // SameSite=Lax + the encrypted session cookie still gate the
      // user-impersonation path — the attacker would need the
      // HttpOnly cookie to forge a server-side call, which they can't
      // get cross-origin.
      this.log.debug(
        { method, path: req.path },
        'csrf_no_origin_or_referer',
      );
      return next();
    }

    const candidate = origin ?? deriveOriginFromReferer(referer);
    if (candidate === null) {
      // Malformed Referer with no Origin; Cisco-style proxies
      // sometimes mangle it. Refuse rather than fail-open.
      this.log.warn(
        { method, path: req.path, referer },
        'csrf_referer_unparseable',
      );
      throw new ForbiddenException('csrf_origin_mismatch');
    }
    if (!this.trustedOrigins.has(candidate)) {
      this.log.warn(
        {
          method,
          path: req.path,
          origin,
          referer,
          candidate,
          trustedCount: this.trustedOrigins.size,
        },
        'csrf_origin_mismatch',
      );
      throw new ForbiddenException('csrf_origin_mismatch');
    }

    next();
  }
}

function headerValue(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function deriveOriginFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
