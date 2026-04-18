import { Injectable, Logger } from '@nestjs/common';
import { getIronSession, type SessionOptions } from 'iron-session';
import type { Request, Response } from 'express';
import { AuthConfigService } from './auth.config.js';
import type { OidcStateCookie, PanoramaSession } from './session.types.js';

/**
 * Thin wrapper around iron-session. Two cookies live on the response:
 *
 *   * `panorama_session` — long-lived post-authentication session
 *   * `panorama_oauth`   — short-lived state for an in-flight OIDC dance
 *
 * Both are encrypted + authenticated by the same 32-byte server secret.
 * Clients only see an opaque base64 blob.
 */
@Injectable()
export class SessionService {
  private readonly log = new Logger('SessionService');

  constructor(private readonly cfg: AuthConfigService) {}

  private sessionOptions(): SessionOptions {
    const { sessionSecret, sessionCookieName, sessionMaxAgeSeconds, isProduction } = this.cfg.config;
    return {
      password: sessionSecret,
      cookieName: sessionCookieName,
      ttl: sessionMaxAgeSeconds,
      cookieOptions: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax', // lax allows top-level nav after OIDC callback
        path: '/',
        maxAge: sessionMaxAgeSeconds,
      },
    };
  }

  private oauthStateOptions(): SessionOptions {
    const { sessionSecret, oauthStateCookieName, oauthStateMaxAgeSeconds, isProduction } =
      this.cfg.config;
    return {
      password: sessionSecret,
      cookieName: oauthStateCookieName,
      ttl: oauthStateMaxAgeSeconds,
      cookieOptions: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
        maxAge: oauthStateMaxAgeSeconds,
      },
    };
  }

  /** Read the session cookie, if present. Returns null when empty or expired. */
  async getSession(req: Request, res: Response): Promise<PanoramaSession | null> {
    const session = await getIronSession<Partial<PanoramaSession>>(req, res, this.sessionOptions());
    if (!session || !session.userId || !session.currentTenantId) return null;
    const age = Math.floor(Date.now() / 1000) - (session.issuedAt ?? 0);
    if (age > this.cfg.config.sessionMaxAgeSeconds) return null;
    return session as PanoramaSession;
  }

  /** Write the session cookie. Overwrites any prior value. */
  async setSession(req: Request, res: Response, payload: PanoramaSession): Promise<void> {
    const session = await getIronSession<PanoramaSession>(req, res, this.sessionOptions());
    Object.assign(session, payload, { issuedAt: Math.floor(Date.now() / 1000) });
    await session.save();
  }

  /** Clear the session cookie. Idempotent. */
  async destroySession(req: Request, res: Response): Promise<void> {
    const session = await getIronSession<PanoramaSession>(req, res, this.sessionOptions());
    session.destroy();
  }

  async getOauthState(req: Request, res: Response): Promise<OidcStateCookie | null> {
    const state = await getIronSession<Partial<OidcStateCookie>>(req, res, this.oauthStateOptions());
    if (!state || !state.state || !state.codeVerifier) return null;
    const age = Math.floor(Date.now() / 1000) - (state.issuedAt ?? 0);
    if (age > this.cfg.config.oauthStateMaxAgeSeconds) return null;
    return state as OidcStateCookie;
  }

  async setOauthState(req: Request, res: Response, payload: OidcStateCookie): Promise<void> {
    const state = await getIronSession<OidcStateCookie>(req, res, this.oauthStateOptions());
    Object.assign(state, payload, { issuedAt: Math.floor(Date.now() / 1000) });
    await state.save();
  }

  async destroyOauthState(req: Request, res: Response): Promise<void> {
    const state = await getIronSession<OidcStateCookie>(req, res, this.oauthStateOptions());
    state.destroy();
  }
}
