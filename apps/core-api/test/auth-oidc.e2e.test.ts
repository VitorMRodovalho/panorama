import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK, type KeyObject, SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';

// IMPORTANT: env vars MUST be set before any module that reads them
// loads. AppModule's transitive imports (AuthConfigService) read
// process.env at module-construction time, which happens during
// `Test.createTestingModule({ imports: [AppModule] }).compile()`.
const STUB_PORT = 4321;
const STUB_ISSUER = `http://localhost:${STUB_PORT}`;
const TEST_EMAIL = 'oidc-e2e@example.com';
const CLIENT_ID = 'test-client-id';

process.env.OIDC_GOOGLE_ISSUER = STUB_ISSUER;
process.env.OIDC_GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.OIDC_GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.OIDC_ALLOW_INSECURE_ISSUER = 'true';
process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:4000';

// AppModule import must come AFTER the env writes above. The
// `import/order` rule isn't configured in this project, so no
// suppression needed; this comment exists so future readers don't
// "fix" the import grouping.
import { AppModule } from '../src/app.module.js';
import { resetTestDb } from './_reset-db.js';
import { createTenantForTest } from './_create-tenant.js';

/**
 * #92 — End-to-end OIDC integration test driving the controller through
 * the openid-client v6 happy path against an in-process stub IdP. Closes
 * the long-standing "OIDC NOT verified end-to-end" caveat from PRs
 * #171 (v6 migration) and #183 (v6 hardening).
 *
 * Topology:
 *   test process ──fetch──→ Nest core-api ──HTTP──→ stub IdP (in-process)
 *
 * The stub speaks just enough OpenID Connect Discovery + Authorization
 * Code Flow + JWKS to satisfy v6's validation. ID-token is RS256-signed
 * with a freshly-generated keypair; the public JWK is served at /jwks.
 */

const HOST = process.env.PG_HOST ?? 'localhost';
const PORT = process.env.PG_PORT ?? '5432';
const DB = process.env.PG_DB ?? 'panorama';
const ADMIN_URL = `postgres://panorama_super_admin:panorama@${HOST}:${PORT}/${DB}?schema=public`;

interface CodeRecord {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
}

function base64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}

describe('OIDC end-to-end (stubbed Google IdP) — #92', () => {
  let app: INestApplication;
  let url: string;
  let admin: PrismaClient;
  let stub: http.Server;
  let tenantId: string;
  let userId: string;
  // jose exports KeyObject (Node) as the runtime type returned by
  // generateKeyPair on Node. Avoids depending on the DOM `CryptoKey`
  // global which @types/node doesn't declare.
  let signingKey: KeyObject;
  let publicJwk: JWK;
  const KID = 'stub-key-1';

  // (code) → captured PKCE / nonce / redirectUri at /authorize, consumed
  // at /token.
  const codeStore = new Map<string, CodeRecord>();

  beforeAll(async () => {
    // 1. Generate RSA keypair for id_token signing.
    const { publicKey, privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    signingKey = privateKey;
    publicJwk = { ...(await exportJWK(publicKey)), kid: KID, use: 'sig', alg: 'RS256' };

    // 2. Stand up the stub IdP.
    stub = http.createServer((req, res) => {
      void (async () => {
        try {
          const reqUrl = new URL(req.url ?? '/', STUB_ISSUER);

          if (reqUrl.pathname === '/.well-known/openid-configuration') {
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                issuer: STUB_ISSUER,
                authorization_endpoint: `${STUB_ISSUER}/authorize`,
                token_endpoint: `${STUB_ISSUER}/token`,
                userinfo_endpoint: `${STUB_ISSUER}/userinfo`,
                jwks_uri: `${STUB_ISSUER}/jwks`,
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['RS256'],
                code_challenge_methods_supported: ['S256'],
              }),
            );
            return;
          }

          if (reqUrl.pathname === '/jwks') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ keys: [publicJwk] }));
            return;
          }

          if (reqUrl.pathname === '/authorize') {
            const params = reqUrl.searchParams;
            const state = params.get('state');
            const codeChallenge = params.get('code_challenge');
            const redirectUri = params.get('redirect_uri');
            if (!state || !codeChallenge || !redirectUri) {
              res.statusCode = 400;
              res.end('missing required authorize params');
              return;
            }
            const code = `code-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            codeStore.set(code, {
              codeChallenge,
              nonce: params.get('nonce') ?? '',
              redirectUri,
            });
            const back = new URL(redirectUri);
            back.searchParams.set('code', code);
            back.searchParams.set('state', state);
            // RFC 9207 — Authorization Server Issuer Identifier.
            back.searchParams.set('iss', STUB_ISSUER);
            res.statusCode = 302;
            res.setHeader('location', back.href);
            res.end();
            return;
          }

          if (reqUrl.pathname === '/token' && req.method === 'POST') {
            const body = await readBody(req);
            const params = new URLSearchParams(body);
            const code = params.get('code') ?? '';
            const codeVerifier = params.get('code_verifier') ?? '';
            const stored = codeStore.get(code);
            if (!stored) {
              res.statusCode = 400;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown code' }));
              return;
            }
            // Verify PKCE — S256 = base64url(sha256(code_verifier)).
            const expected = base64urlSha256(codeVerifier);
            if (expected !== stored.codeChallenge) {
              res.statusCode = 400;
              res.setHeader('content-type', 'application/json');
              res.end(
                JSON.stringify({ error: 'invalid_grant', error_description: 'pkce mismatch' }),
              );
              return;
            }
            // Single-use code.
            codeStore.delete(code);
            // Build a properly-signed id_token. Includes the nonce
            // captured at /authorize so v6's expectedNonce check passes.
            const idToken = await new SignJWT({
              email: TEST_EMAIL,
              email_verified: true,
              given_name: 'E2E',
              family_name: 'Tester',
              name: 'E2E Tester',
              nonce: stored.nonce,
            })
              .setProtectedHeader({ alg: 'RS256', kid: KID })
              .setIssuer(STUB_ISSUER)
              .setSubject('e2e-test-user-001')
              .setAudience(CLIENT_ID)
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(signingKey);
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                access_token: 'fake-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                id_token: idToken,
              }),
            );
            return;
          }

          res.statusCode = 404;
          res.end();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      })();
    });
    await new Promise<void>((resolve) => stub.listen(STUB_PORT, resolve));

    // 3. Reset DB + seed tenant + user (whose email matches the stub's
    //    id_token claim — so loginWithOidc takes the email-link path).
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await resetTestDb(admin);
    const tenant = await createTenantForTest(admin, {
      slug: 'oidc-e2e',
      name: 'OIDC E2E',
      displayName: 'OIDC E2E',
      allowedEmailDomains: ['example.com'],
    });
    tenantId = tenant.id;
    const user = await admin.user.create({
      data: { email: TEST_EMAIL, displayName: 'Pre-seeded', status: 'ACTIVE' },
    });
    userId = user.id;
    await admin.tenantMembership.create({
      data: { userId, tenantId, role: 'member', status: 'active' },
    });

    // 4. Boot the Nest app.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await admin?.$disconnect();
    await app?.close();
    if (stub) {
      await new Promise<void>((resolve, reject) =>
        stub.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }, 30_000);

  it('full happy path — /start → /authorize → /callback → /me', async () => {
    // Step 1 — /start. App generates state+nonce+PKCE, stashes in cookie,
    // redirects to the stub IdP's /authorize.
    const startRes = await fetch(`${url}/auth/oidc/google/start`, { redirect: 'manual' });
    expect(startRes.status).toBe(302);
    const oauthCookie = extractCookie(startRes);
    expect(oauthCookie).toBeTruthy();

    const authUrl = new URL(startRes.headers.get('location')!);
    expect(authUrl.origin).toBe(STUB_ISSUER);
    expect(authUrl.pathname).toBe('/authorize');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')?.length).toBeGreaterThan(0);
    expect(authUrl.searchParams.get('nonce')?.length).toBeGreaterThan(0);
    expect(authUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get('scope')).toContain('openid');

    // Step 2 — simulate user "logging in" at the IdP. Hit /authorize
    // directly; stub returns 302 to the app's callback URL with code.
    const idpRes = await fetch(authUrl.href, { redirect: 'manual' });
    expect(idpRes.status).toBe(302);
    const callbackBack = new URL(idpRes.headers.get('location')!);
    expect(callbackBack.pathname).toBe('/auth/oidc/google/callback');
    expect(callbackBack.searchParams.get('code')?.length).toBeGreaterThan(0);
    expect(callbackBack.searchParams.get('iss')).toBe(STUB_ISSUER);

    // Step 3 — /callback with the IdP's code+state+iss. Cookie carries
    // the OAuth state so v6 can validate state+nonce+pkce.
    const callbackRes = await fetch(
      `${url}/auth/oidc/google/callback?${callbackBack.searchParams.toString()}`,
      {
        headers: { cookie: oauthCookie! },
        redirect: 'manual',
      },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/');
    const sessionCookie = extractCookie(callbackRes);
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toMatch(/panorama_session=/);

    // Step 4 — /auth/me with the freshly-issued session cookie.
    const meRes = await fetch(`${url}/auth/me`, { headers: { cookie: sessionCookie! } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      userId: string;
      email: string;
      provider: string;
      currentTenantId: string;
      currentRole: string;
    };
    expect(me.userId).toBe(userId);
    expect(me.email).toBe(TEST_EMAIL);
    expect(me.provider).toBe('google');
    expect(me.currentTenantId).toBe(tenantId);
    expect(me.currentRole).toBe('member');

    // Step 5 — confirm the new AuthIdentity row was created with the
    // IdP's `sub` as the lookup key (per #187: subject = sub for OIDC,
    // NOT the email).
    const identity = await admin.authIdentity.findFirst({
      where: { userId, provider: 'google' },
    });
    expect(identity).toBeTruthy();
    expect(identity?.subject).toBe('e2e-test-user-001');
    expect(identity?.emailAtLink).toBe(TEST_EMAIL);
  }, 30_000);
});
