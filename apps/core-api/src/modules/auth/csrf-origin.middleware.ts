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
 *   * If `Origin` is present, it MUST match the configured trusted
 *     origin set (auth `baseUrl` + comma-separated `WEB_ORIGIN`).
 *     Mismatch → 403 + warn log.
 *   * If `Origin` is absent BUT `Referer` is present, the
 *     scheme://host of `Referer` MUST be in the allowlist.
 *   * If both are absent — typical for server-to-server fetches that
 *     this codebase performs (Next.js server actions → core-api) —
 *     allow but log at debug. SameSite=Lax stops the session cookie
 *     from riding along on a cross-site browser fetch, so the blast
 *     radius for "no headers AND somehow has the cookie" is bounded
 *     by an attacker who already has the user's HttpOnly cookie
 *     (out-of-scope of CSRF defense).
 *
 *   * `Origin` shows up as a `string[]` only via misconfigured
 *     ingress / proxies that concatenate duplicate headers. RFC 6454
 *     mandates exactly one `Origin` per request, so we fail-closed
 *     on duplicates rather than picking one and creating a bypass
 *     for `[trusted, evil.com]`-style spoofs.
 *
 * SEC-02 / #34: documented as the doc-vs-code gap. Full double-submit
 * cookie + header pattern is a future M effort if the threat model
 * grows; this layer matches modern browser semantics (every Chromium /
 * WebKit / Gecko release since 2021 sends `Origin` on cross-origin
 * POST/PUT/DELETE) and is the pragmatic 80% under a single-session-
 * cookie design.
 *
 * Trusted-origin set is built once at module init; rotation requires
 * a redeploy (documented in SECURITY.md / .env.example).
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  private readonly log = new Logger('CsrfOriginMiddleware');
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(cfg: AuthConfigService) {
    this.trustedOrigins = cfg.config.csrf.trustedOrigins;
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    const origin = singleHeaderValue(req.headers['origin']);
    const referer = singleHeaderValue(req.headers['referer']);

    if (origin === DUPLICATE || referer === DUPLICATE) {
      // RFC 6454 mandates exactly one Origin per request. Duplicate
      // Origin / Referer headers signal an ingress that concatenates
      // —  picking `[0]` permissively would create a `[trusted, evil]`
      // spoof bypass. Fail-closed instead.
      this.log.warn(
        {
          method,
          path: req.path,
          rawOrigin: req.headers['origin'],
          rawReferer: req.headers['referer'],
        },
        'csrf_header_duplicate',
      );
      throw new ForbiddenException('csrf_origin_mismatch');
    }

    if (!origin && !referer) {
      this.log.debug(
        { method, path: req.path },
        'csrf_no_origin_or_referer',
      );
      return next();
    }

    const candidate =
      (origin ?? deriveOriginFromReferer(referer))?.toLowerCase() ?? null;
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

const DUPLICATE = Symbol('duplicate');
type HeaderResult = string | null | typeof DUPLICATE;

function singleHeaderValue(raw: string | string[] | undefined): HeaderResult {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    if (raw.length > 1) return DUPLICATE;
    return raw[0] ?? null;
  }
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
