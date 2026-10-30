import 'reflect-metadata';
import type { Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfigService } from '../src/modules/auth/auth.config.js';
import { SessionService } from '../src/modules/auth/session.service.js';
import type { PanoramaSession } from '../src/modules/auth/session.types.js';

/**
 * SessionService over iron-session's Node adapter, without Nest or a
 * database: Express-shaped `req.headers.cookie` in, `Set-Cookie` out.
 * Covers the round trip, fail-closed reads of a damaged cookie, and the
 * `onUnsealError` reason that iron-session 9 exposes.
 */

const config = {
  sessionPassword: { 1: 'a'.repeat(32), 2: 'b'.repeat(32) },
  sessionCookieName: 'panorama_session',
  oauthStateCookieName: 'panorama_oauth',
  sessionMaxAgeSeconds: 3600,
  oauthStateMaxAgeSeconds: 600,
  isProduction: false,
};
const service = new SessionService({ config } as unknown as AuthConfigService);

function fakeRes(): Response & { cookies(): string[] } {
  const headers = new Map<string, string[]>();
  return {
    headersSent: false,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    setHeader: (name: string, value: string[]) => headers.set(name.toLowerCase(), value),
    cookies: () => headers.get('set-cookie') ?? [],
  } as unknown as Response & { cookies(): string[] };
}

function reqWithCookie(cookie: string | undefined): Request {
  return { headers: cookie ? { cookie } : {} } as unknown as Request;
}

/** `name=value` from the first `Set-Cookie` written for `name`. */
function cookiePair(res: { cookies(): string[] }, name: string): string {
  const header = res.cookies().find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`no Set-Cookie for ${name}`);
  return header.split(';')[0] ?? '';
}

const session: PanoramaSession = {
  userId: 'u-1',
  email: 'user@example.test',
  displayName: 'User',
  currentTenantId: 't-1',
  currentRole: 'owner',
  isVip: false,
  memberships: [],
  issuedAt: 0,
  provider: 'password',
};

describe('SessionService (iron-session Node adapter)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a session through Set-Cookie and Cookie', async () => {
    const res = fakeRes();
    await service.setSession(reqWithCookie(undefined), res, session);
    const pair = cookiePair(res, 'panorama_session');

    const read = await service.getSession(reqWithCookie(pair), fakeRes());
    expect(read?.userId).toBe('u-1');
    expect(read?.currentTenantId).toBe('t-1');
  });

  it('returns no session for a tampered cookie and reports it as invalid', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const res = fakeRes();
    await service.setSession(reqWithCookie(undefined), res, session);
    const pair = cookiePair(res, 'panorama_session');
    const tampered = `${pair.slice(0, -4)}AAAA`;

    expect(await service.getSession(reqWithCookie(tampered), fakeRes())).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { cookieName: 'panorama_session', reason: 'invalid' },
      'session_cookie_unseal_failed',
    );
  });

  it('reads no session when there is no cookie, without reporting an error', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await service.getSession(reqWithCookie(undefined), fakeRes())).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears the cookie on destroy', async () => {
    const res = fakeRes();
    await service.setSession(reqWithCookie(undefined), res, session);
    const pair = cookiePair(res, 'panorama_session');

    const out = fakeRes();
    await service.destroySession(reqWithCookie(pair), out);
    expect(cookiePair(out, 'panorama_session')).toBe('panorama_session=');
  });
});
