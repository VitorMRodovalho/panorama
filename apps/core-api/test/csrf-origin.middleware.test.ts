import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CsrfOriginMiddleware } from '../src/modules/auth/csrf-origin.middleware.js';
import type { AuthConfigService } from '../src/modules/auth/auth.config.js';

/**
 * SEC-02 / #34 layered CSRF gate. Verifies the Origin/Referer rules:
 *   1. Safe methods (GET/HEAD/OPTIONS) skip the check entirely
 *   2. POST/PUT/PATCH/DELETE with no Origin AND no Referer → allow
 *      (server-to-server fetch path; SameSite + cookie auth still apply)
 *   3. Origin matches a trusted entry → allow
 *   4. Origin mismatches → 403
 *   5. Origin absent + Referer scheme://host matches → allow
 *   6. Origin absent + Referer scheme://host mismatches → 403
 *   7. Malformed Referer (no Origin) → 403 (fail-closed)
 *   8. Multi-origin allowlist via WEB_ORIGIN env var → all entries pass
 */

const BASE_URL = 'http://localhost:4000';

function makeReq(opts: {
  method?: string;
  origin?: string | undefined;
  referer?: string | undefined;
  path?: string;
}): Request {
  const headers: Record<string, string | undefined> = {};
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  if (opts.referer !== undefined) headers['referer'] = opts.referer;
  return {
    method: opts.method ?? 'POST',
    path: opts.path ?? '/auth/login',
    headers,
  } as unknown as Request;
}

const noopRes = {} as Response;

/**
 * Build a typed AuthConfigService stub. The middleware now consumes
 * the parsed-and-deduped origin set from `cfg.config.csrf.trustedOrigins`
 * (the env-parsing lives in auth.config.ts), so the test fixture
 * mirrors that shape directly. Each entry should be lowercase +
 * trailing-slash-stripped to match the real parser.
 */
function makeMiddleware(extraOrigins: string[] = []): CsrfOriginMiddleware {
  const trustedOrigins = new Set<string>([
    BASE_URL,
    ...extraOrigins.map((o) => o.replace(/\/+$/, '').toLowerCase()),
  ]);
  const cfg = {
    config: { baseUrl: BASE_URL, csrf: { trustedOrigins } },
  } as unknown as AuthConfigService;
  return new CsrfOriginMiddleware(cfg);
}

describe('CsrfOriginMiddleware — safe methods', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('skips %s', (method) => {
    const mw = makeMiddleware();
    let nextCalled = false;
    mw.use(makeReq({ method, origin: 'http://evil.com' }), noopRes, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

describe('CsrfOriginMiddleware — origin allowlist', () => {
  let mw: CsrfOriginMiddleware;

  beforeEach(() => {
    mw = makeMiddleware(['http://localhost:3000']);
  });

  it('allows when both Origin and Referer are absent (server-to-server)', () => {
    let nextCalled = false;
    mw.use(makeReq({ method: 'POST' }), noopRes, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('allows when Origin matches the WEB_ORIGIN entry', () => {
    let nextCalled = false;
    mw.use(
      makeReq({ method: 'POST', origin: 'http://localhost:3000' }),
      noopRes,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it('allows when Origin matches the auth baseUrl entry', () => {
    let nextCalled = false;
    mw.use(makeReq({ method: 'POST', origin: BASE_URL }), noopRes, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('rejects when Origin matches none of the trusted entries', () => {
    expect(() =>
      mw.use(
        makeReq({ method: 'POST', origin: 'http://evil.com' }),
        noopRes,
        () => {
          throw new Error('should not be called');
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects when Origin is wrong even if Referer is right (Origin wins)', () => {
    // Modern browsers always send Origin on POST; if Origin is wrong,
    // we don't fall back to Referer to "rescue" a cross-origin request.
    expect(() =>
      mw.use(
        makeReq({
          method: 'POST',
          origin: 'http://evil.com',
          referer: 'http://localhost:3000/login',
        }),
        noopRes,
        () => {
          throw new Error('should not be called');
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it('falls back to Referer when Origin is missing', () => {
    let nextCalled = false;
    mw.use(
      makeReq({
        method: 'POST',
        referer: 'http://localhost:3000/some/path?q=1',
      }),
      noopRes,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it('rejects when Referer is from a different origin', () => {
    expect(() =>
      mw.use(
        makeReq({
          method: 'POST',
          referer: 'http://evil.com/login',
        }),
        noopRes,
        () => {
          throw new Error('should not be called');
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects fail-closed when Referer is malformed and Origin is absent', () => {
    expect(() =>
      mw.use(
        makeReq({
          method: 'POST',
          referer: 'not-a-url',
        }),
        noopRes,
        () => {
          throw new Error('should not be called');
        },
      ),
    ).toThrow(ForbiddenException);
  });
});

describe('CsrfOriginMiddleware — multi-origin allowlist', () => {
  it('accepts every entry from a multi-origin trusted set', () => {
    const mw = makeMiddleware([
      'http://localhost:3000',
      'https://staging.example.com',
      'https://prod.example.com',
    ]);
    for (const allowed of [
      'http://localhost:3000',
      'https://staging.example.com',
      'https://prod.example.com',
      BASE_URL,
    ]) {
      let nextCalled = false;
      mw.use(
        makeReq({ method: 'POST', origin: allowed }),
        noopRes,
        () => {
          nextCalled = true;
        },
      );
      expect(nextCalled, `should allow ${allowed}`).toBe(true);
    }
  });

  it('matches case-insensitively (browsers normalise lowercase, but be paranoid)', () => {
    const mw = makeMiddleware(['https://Prod.Example.Com']);
    let nextCalled = false;
    mw.use(
      makeReq({ method: 'POST', origin: 'HTTPS://prod.example.com' }),
      noopRes,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it('rejects fail-closed when Origin shows up as a duplicate header', () => {
    // RFC 6454 mandates exactly one Origin per request. A proxy
    // concatenating duplicates would create a `[trusted, evil.com]`
    // bypass if we picked `[0]` permissively. Fail-closed instead.
    const mw = makeMiddleware(['http://localhost:3000']);
    const req = {
      method: 'POST',
      path: '/auth/login',
      headers: { origin: ['http://localhost:3000', 'http://evil.com'] },
    } as unknown as Request;
    expect(() =>
      mw.use(req, noopRes, () => {
        throw new Error('should not be called');
      }),
    ).toThrow(ForbiddenException);
  });

  it('treats an empty Origin array as absent (server-to-server allowed)', () => {
    const mw = makeMiddleware(['http://localhost:3000']);
    const req = {
      method: 'POST',
      path: '/auth/login',
      headers: { origin: [] as string[] },
    } as unknown as Request;
    let nextCalled = false;
    mw.use(req, noopRes, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
