import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runInContext, type TenantContext } from '../tenant/tenant.context.js';
import { SessionService } from './session.service.js';
import type { PanoramaSession } from './session.types.js';

/** Typed accessor for the session attached by SessionMiddleware. */
export function getRequestSession(req: unknown): PanoramaSession | null {
  const s = (req as { panoramaSession?: PanoramaSession | null }).panoramaSession;
  return s ?? null;
}

/**
 * Reads the encrypted iron-session cookie on every request, validates it,
 * binds the resulting tenant + user identity to the AsyncLocalStorage
 * context so PrismaService and controllers can see it.
 *
 * Superseded the header-based TenantMiddleware from 0.1. The header path
 * is gone — production runs exclusively off the cookie. Tests that need
 * a specific tenant context log in via the real auth flow (or seed a
 * session directly via SessionService in a TestingModule).
 *
 * Session is attached via plain property assignment (no `declare module`
 * augmentation) so consumers use `getRequestSession(req)` and keep type
 * safety without touching express-serve-static-core at the type level.
 */
/**
 * Literal prefix of a Personal Access Token (ADR-0010). A request
 * carrying this in its Authorization header is a compat-shim caller —
 * native controllers under AuthModule / ReservationModule / etc.
 * MUST NOT silently fall back to session auth when a PAT is present.
 * We suppress the session entirely so native endpoints return 401
 * (the intended failure mode for a PAT hitting a non-/api/v1 path).
 */
const PAT_BEARER_PREFIX = 'Bearer pnrm_pat_';

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  private readonly log = new Logger('SessionMiddleware');

  constructor(private readonly sessions: SessionService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    let session: PanoramaSession | null = null;

    // PAT-bearing request: no session. The PatAuthGuard under
    // SnipeitCompatModule owns authentication for these. If the caller
    // hits /reservations with a PAT (wrong surface), they get 401 —
    // by design, not by accident.
    const authHeader = req.headers['authorization'];
    const hasPatBearer = typeof authHeader === 'string' && authHeader.startsWith(PAT_BEARER_PREFIX);

    if (!hasPatBearer) {
      try {
        session = await this.sessions.getSession(req, res);
      } catch (err) {
        // Malformed cookie / secret mismatch / decrypt failure — treat as
        // unauthenticated. Never leak why to the client.
        this.log.warn({ err: String(err) }, 'session_decode_failed');
        session = null;
      }
    }

    (req as Request & { panoramaSession?: PanoramaSession | null }).panoramaSession = session;

    const ctx: TenantContext = {
      tenantId: session?.currentTenantId ?? null,
      userId: session?.userId ?? null,
      actorEmail: session?.email ?? null,
    };

    runInContext(ctx, () => next());
  }
}
