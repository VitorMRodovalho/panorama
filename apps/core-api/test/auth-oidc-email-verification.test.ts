import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { AuthConfigService } from '../src/modules/auth/auth.config.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import type { OidcUserInfo } from '../src/modules/auth/oidc.service.js';
import type { PasswordService } from '../src/modules/auth/password.service.js';
import type { PrismaService } from '../src/modules/prisma/prisma.service.js';

/**
 * Unit coverage for SEC-01 / #28 — OIDC login rejects unverified
 * emails, with a narrow Google Workspace `hd` override.
 *
 * The gate sits in AuthService.loginWithOidc before any DB write,
 * so a mock PrismaService + AuditService is enough — we observe
 * whether the call short-circuits to UnauthorizedException, whether
 * an audit row would be written with the correct reason, and (for
 * the hd-override path) whether the email-link branch is refused.
 */

const GOOGLE_ISSUER = 'https://accounts.google.com';

function makeUserInfo(overrides: Partial<OidcUserInfo> = {}): OidcUserInfo {
  return {
    subject: 'google-sub-alice',
    email: 'alice@acme.example',
    firstName: 'Alice',
    lastName: 'Driver',
    displayName: 'Alice Driver',
    emailVerified: false,
    hd: null,
    iss: GOOGLE_ISSUER,
    ...overrides,
  };
}

function makeService(envOverrides: Record<string, string | undefined> = {}) {
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
  vi.stubEnv('OIDC_GOOGLE_CLIENT_ID', 'fake-google-id');
  vi.stubEnv('OIDC_GOOGLE_CLIENT_SECRET', 'fake-google-secret');
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }

  const cfg = new AuthConfigService();
  const runAsSuperAdmin = vi.fn();
  const prisma = { runAsSuperAdmin } as unknown as PrismaService;
  const passwords = {} as unknown as PasswordService;
  const auditRecord = vi.fn();
  const audit = { record: auditRecord } as unknown as AuditService;
  const svc = new AuthService(prisma, passwords, cfg, audit);
  return { svc, runAsSuperAdmin, auditRecord };
}

function lastAuditEvent(auditRecord: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = auditRecord.mock.calls;
  if (calls.length === 0) throw new Error('auditRecord was not called');
  const last = calls[calls.length - 1];
  if (!last || last.length === 0) throw new Error('auditRecord called with no arguments');
  return last[0] as Record<string, unknown>;
}

function lastAuditMetadata(auditRecord: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const event = lastAuditEvent(auditRecord) as { metadata?: Record<string, unknown> };
  if (!event.metadata) throw new Error('audit event has no metadata');
  return event.metadata;
}

describe('AuthService.loginWithOidc — email_verified gate (#28)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses Google login when email_verified=false and no hd', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService();

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: false, hd: null })),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(lastAuditEvent(auditRecord)).toMatchObject({
      action: 'panorama.auth.oidc_refused',
      tenantId: null,
      actorUserId: null,
      metadata: expect.objectContaining({
        provider: 'google',
        reason: 'email_not_verified',
        emailDomain: 'acme.example',
      }),
    });
  });

  it('refuses Microsoft login when email_verified=false (no hd override available)', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_MICROSOFT_CLIENT_ID: 'fake-ms-id',
      OIDC_MICROSOFT_CLIENT_SECRET: 'fake-ms-secret',
    });

    await expect(
      svc.loginWithOidc(
        'microsoft',
        makeUserInfo({
          emailVerified: false,
          hd: null,
          iss: 'https://login.microsoftonline.com/common/v2.0',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'email_not_verified',
    });
  });

  it('refuses Google login with hd set but allowlist empty (default strict mode)', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService();

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: false, hd: 'acme.example' })),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'email_not_verified',
    });
  });

  it('refuses Google login with hd outside the configured allowlist', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example,beta.example',
    });

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'mallory@evil.example',
          emailVerified: false,
          hd: 'evil.example',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'hd_not_allowlisted',
    });
  });

  it('refuses when hd is allowlisted but iss is not the actual Google issuer (B1 defence-in-depth)', async () => {
    // Worked example: a developer copy-pastes OIDC_GOOGLE_CLIENT_ID
    // pointing at a non-Google IdP whose discovery doc has its own
    // issuer URL. provider='google' but the token actually came from
    // somewhere else; refusing on iss-mismatch keeps the override
    // honest.
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
    });

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'alice@acme.example',
          emailVerified: false,
          hd: 'acme.example',
          iss: 'https://accounts.google.com.evil.example',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'hd_iss_mismatch',
    });
  });

  it('refuses when hd is allowlisted but email domain does not match (anti-spoof)', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
    });

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'mallory@gmail.com',
          emailVerified: false,
          hd: 'acme.example',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'hd_email_mismatch',
    });
  });

  it('refuses when hd substring-matches a allowlisted domain (e.g. evilacme.example vs acme.example)', async () => {
    // Defence against "endsWith without @ separator" trickery:
    // `mallory@evilacme.example` doesn't end with `@acme.example`.
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
    });

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'mallory@evilacme.example',
          emailVerified: false,
          hd: 'evilacme.example',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'hd_not_allowlisted',
    });
  });

  it('refuses Microsoft even when hd happens to be allowlisted (override is Google-only)', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
      OIDC_MICROSOFT_CLIENT_ID: 'fake-ms-id',
      OIDC_MICROSOFT_CLIENT_SECRET: 'fake-ms-secret',
    });

    await expect(
      svc.loginWithOidc(
        'microsoft',
        makeUserInfo({
          emailVerified: false,
          hd: 'acme.example',
          iss: 'https://login.microsoftonline.com/common/v2.0',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(runAsSuperAdmin).not.toHaveBeenCalled();
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      reason: 'email_not_verified',
    });
  });

  it('proceeds when email_verified=true (strict-mode happy path)', async () => {
    const { svc, runAsSuperAdmin } = makeService();
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_gate'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: true, hd: null })),
    ).rejects.toThrow('stop_after_gate');
    expect(runAsSuperAdmin).toHaveBeenCalledOnce();
  });

  it('proceeds when email_verified=false but hd matches allowlist + email domain + iss', async () => {
    const { svc, runAsSuperAdmin } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example,beta.example',
    });
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_gate'));

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'alice@acme.example',
          emailVerified: false,
          hd: 'acme.example',
        }),
      ),
    ).rejects.toThrow('stop_after_gate');
    expect(runAsSuperAdmin).toHaveBeenCalledOnce();
  });

  it('allowlist comparison is case-insensitive on hd and configured domains', async () => {
    const { svc, runAsSuperAdmin } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'Acme.Example',
    });
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_gate'));

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'alice@acme.example',
          emailVerified: false,
          hd: 'ACME.EXAMPLE',
        }),
      ),
    ).rejects.toThrow('stop_after_gate');
    expect(runAsSuperAdmin).toHaveBeenCalledOnce();
  });

  it('audit metadata hashes the IdP subject (no PII leak)', async () => {
    const { svc, auditRecord } = makeService();

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          subject: 'google-sub-very-secret-12345',
          emailVerified: false,
          hd: null,
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    const meta = lastAuditMetadata(auditRecord);
    expect(meta.subjectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.subjectHash).not.toContain('google-sub-very-secret');
  });

  it('still throws UnauthorizedException when the audit write fails', async () => {
    // Defence-in-depth: an audit-infra outage must not silently
    // promote a refused login into a successful one. The refusal
    // throws regardless of whether the audit row landed.
    const { svc, auditRecord } = makeService();
    auditRecord.mockRejectedValueOnce(new Error('audit_db_unreachable'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: false, hd: null })),
    ).rejects.toThrow(UnauthorizedException);
    expect(auditRecord).toHaveBeenCalledOnce();
  });
});

describe('AuthService.loginWithOidc — hd-override account-link refusal (B3)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to link a Google identity to a pre-existing User under hd-override', async () => {
    // Threat: attacker controls a Google Workspace tenant for
    // acme.example. They sign in to Panorama with email
    // alice@acme.example. A prior Panorama account at that email
    // exists (created via password). Without this guard, we would
    // attach a Google identity to Alice's account, granting the
    // attacker permanent OIDC login as Alice.
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
    });

    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn(async () => ({ id: 'pre-existing-user-id', email: 'alice@acme.example' })),
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'alice@acme.example',
          emailVerified: false,
          hd: 'acme.example',
        }),
      ),
    ).rejects.toMatchObject({ message: 'oidc_account_link_requires_verified_email' });

    expect(auditRecord).toHaveBeenCalledOnce();
    expect(lastAuditEvent(auditRecord)).toMatchObject({
      action: 'panorama.auth.oidc_refused',
      metadata: expect.objectContaining({ reason: 'oidc_account_link_requires_verified_email' }),
    });
  });

  it('allows the link path under strict mode (email_verified=true)', async () => {
    const { svc, runAsSuperAdmin } = makeService();

    const create = vi.fn(async () => undefined);
    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => null),
          create,
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn(async () => ({ id: 'pre-existing-user-id', email: 'alice@acme.example' })),
          create: vi.fn(),
        },
      };
      return fn(tx);
    });
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_link'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: true })),
    ).rejects.toThrow('stop_after_link');
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('AuthService.loginWithOidc — success-path audit (#91)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits panorama.auth.oidc_login on new-user create (strict mode)', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService();
    // First runAsSuperAdmin = find-or-create resolution (returns ok+new_user).
    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({
            id: 'new-user-id-42',
            email: 'alice@acme.example',
            displayName: 'Alice Driver',
          })),
        },
      };
      return fn(tx);
    });
    // Second runAsSuperAdmin = buildSessionForUser; stop here so the
    // oidc_login audit emission is the last observable side effect.
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_login_audit'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: true })),
    ).rejects.toThrow('stop_after_login_audit');

    expect(auditRecord).toHaveBeenCalledOnce();
    expect(lastAuditEvent(auditRecord)).toMatchObject({
      action: 'panorama.auth.oidc_login',
      actorUserId: 'new-user-id-42',
      tenantId: null,
      resourceType: 'auth_identity',
    });
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      provider: 'google',
      pathTaken: 'new_user',
      viaHdOverride: false,
      emailDomain: 'acme.example',
    });
  });

  it('emits oidc_login with pathTaken=existing_identity on returning user', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService();
    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => ({
            id: 'existing-identity-id',
            userId: 'returning-user-id',
          })),
          create: vi.fn(),
          update: vi.fn(),
        },
        user: { findUnique: vi.fn(), create: vi.fn() },
      };
      return fn(tx);
    });
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_login_audit'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: true })),
    ).rejects.toThrow('stop_after_login_audit');

    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      pathTaken: 'existing_identity',
      viaHdOverride: false,
    });
  });

  it('emits oidc_login with viaHdOverride=true on hd-override new-user path', async () => {
    const { svc, runAsSuperAdmin, auditRecord } = makeService({
      OIDC_GOOGLE_TRUSTED_HD_DOMAINS: 'acme.example',
    });
    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({
            id: 'workspace-user-id',
            email: 'alice@acme.example',
            displayName: 'Alice Driver',
          })),
        },
      };
      return fn(tx);
    });
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_login_audit'));

    await expect(
      svc.loginWithOidc(
        'google',
        makeUserInfo({
          email: 'alice@acme.example',
          emailVerified: false,
          hd: 'acme.example',
        }),
      ),
    ).rejects.toThrow('stop_after_login_audit');

    expect(lastAuditEvent(auditRecord)).toMatchObject({
      action: 'panorama.auth.oidc_login',
      actorUserId: 'workspace-user-id',
    });
    expect(lastAuditMetadata(auditRecord)).toMatchObject({
      pathTaken: 'new_user',
      viaHdOverride: true,
      hd: 'acme.example',
    });
  });

  it('audit-write failure on success path does NOT mask the resolution', async () => {
    // Symmetric to the refusal handling: the user-create / identity-link
    // already committed in runAsSuperAdmin. Audit failure logs at error
    // but doesn't undo the auth.
    const { svc, runAsSuperAdmin, auditRecord } = makeService();
    runAsSuperAdmin.mockImplementationOnce(async (fn: any) => {
      const tx = {
        authIdentity: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
          update: vi.fn(),
        },
        user: {
          findUnique: vi.fn(async () => null),
          create: vi.fn(async () => ({
            id: 'audit-fail-user-id',
            email: 'alice@acme.example',
            displayName: 'Alice Driver',
          })),
        },
      };
      return fn(tx);
    });
    auditRecord.mockRejectedValueOnce(new Error('audit_db_unreachable'));
    runAsSuperAdmin.mockRejectedValueOnce(new Error('stop_after_login_audit'));

    await expect(
      svc.loginWithOidc('google', makeUserInfo({ emailVerified: true })),
    ).rejects.toThrow('stop_after_login_audit');
    // Confirms the buildSessionForUser path was reached (= audit
    // failure didn't short-circuit the flow).
    expect(auditRecord).toHaveBeenCalledOnce();
  });
});

describe('AuthConfigService — OIDC_GOOGLE_TRUSTED_HD_DOMAINS validation (#89)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    vi.stubEnv('OIDC_GOOGLE_CLIENT_ID', 'fake-google-id');
    vi.stubEnv('OIDC_GOOGLE_CLIENT_SECRET', 'fake-google-secret');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function trustedDomains(envValue: string | undefined): string[] {
    if (envValue === undefined) {
      vi.stubEnv('OIDC_GOOGLE_TRUSTED_HD_DOMAINS', '');
    } else {
      vi.stubEnv('OIDC_GOOGLE_TRUSTED_HD_DOMAINS', envValue);
    }
    const cfg = new AuthConfigService();
    return cfg.config.providers.google?.trustedHdDomains ?? [];
  }

  it('accepts valid multi-label domains (lowercased + trimmed)', () => {
    expect(trustedDomains('acme.example, beta.example, foo.bar.example.com')).toEqual([
      'acme.example',
      'beta.example',
      'foo.bar.example.com',
    ]);
  });

  it('lowercases mixed-case entries', () => {
    expect(trustedDomains('Acme.Example')).toEqual(['acme.example']);
  });

  it('rejects wildcard, path, port, IP, single-label, and empty entries', () => {
    // Each malformed entry filters out silently in the parsed list;
    // the warn log lands via the Logger (not asserted at unit level).
    // Surviving entries: only the valid one.
    expect(
      trustedDomains(
        '*.example, acme.example/foo, 127.0.0.1, localhost, acme.example, ' +
          ' , -bad.example, bad-.example',
      ),
    ).toEqual(['acme.example']);
  });

  it('rejects entries with double dots / leading dots', () => {
    expect(trustedDomains('..acme.example, .acme.example, acme..example')).toEqual([]);
  });

  it('returns empty when env var is absent', () => {
    expect(trustedDomains(undefined)).toEqual([]);
  });
});
