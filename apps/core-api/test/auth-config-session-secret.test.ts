import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealData, unsealData } from 'iron-session';
import { AuthConfigService } from '../src/modules/auth/auth.config.js';

/**
 * Regression coverage for SEC-03 / #35 — the dev-only session-secret
 * fallback (`'dev-only-insecure-session-secret-replace-me-32b'`) used
 * to land in `config.sessionSecret` for any non-production environment
 * when `SESSION_SECRET` was unset or too short. That meant staging,
 * UAT, and CI environments carrying real tenant data ended up
 * signing sessions with a value committed in source — full session
 * forgery on those environments.
 *
 * Now: the constructor throws in every environment, no fallback in
 * the resolved config.
 */
describe('AuthConfigService — SESSION_SECRET enforcement (#35)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when SESSION_SECRET is unset, even outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_SECRET', '');

    expect(() => new AuthConfigService()).toThrow(/SESSION_SECRET must be at least 32/);
  });

  it('throws when SESSION_SECRET is shorter than 32 chars in staging', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('SESSION_SECRET', 'too-short');

    expect(() => new AuthConfigService()).toThrow(/SESSION_SECRET/);
  });

  it('throws in production with no SESSION_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');

    expect(() => new AuthConfigService()).toThrow(/SESSION_SECRET/);
  });

  it('does NOT silently install the legacy dev fallback string', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));

    const cfg = new AuthConfigService();
    expect(cfg.config.sessionSecret).toBe('a'.repeat(32));
    expect(cfg.config.sessionSecret).not.toContain('dev-only-insecure');
  });

  it('accepts a valid 32-char secret', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));

    expect(() => new AuthConfigService()).not.toThrow();
  });

  it('accepts a longer secret', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(64));

    const cfg = new AuthConfigService();
    expect(cfg.config.sessionSecret).toBe('b'.repeat(64));
    expect(cfg.config.isProduction).toBe(true);
  });
});

/**
 * Round 5 PR3 — SESSION_SECRET_PREVIOUS rotation primitive
 * (`docs/runbooks/secrets-rotation.md`). iron-session's `Password`
 * type accepts either a string or `{ id: secret }`. AuthConfig builds
 * the rotation-ready value once at boot so SessionService is a dumb
 * consumer.
 */
describe('AuthConfigService — SESSION_SECRET_PREVIOUS rotation', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes sessionPassword as a string when no rotation is active', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));

    const cfg = new AuthConfigService();
    expect(cfg.config.sessionSecretPrevious).toBeUndefined();
    expect(cfg.config.sessionPassword).toBe('a'.repeat(32));
  });

  it('exposes sessionPassword as { 1: previous, 2: primary } when rotation is active', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', 'a'.repeat(32));

    const cfg = new AuthConfigService();
    expect(cfg.config.sessionSecretPrevious).toBe('a'.repeat(32));
    expect(cfg.config.sessionPassword).toEqual({ 1: 'a'.repeat(32), 2: 'b'.repeat(32) });
  });

  it('throws when SESSION_SECRET_PREVIOUS is shorter than 32 chars (boot, not first request)', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', 'too-short');

    expect(() => new AuthConfigService()).toThrow(
      /SESSION_SECRET_PREVIOUS must be at least 32/,
    );
  });

  it('throws when SESSION_SECRET_PREVIOUS equals SESSION_SECRET (operator forgot to rotate)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'c'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', 'c'.repeat(32));

    expect(() => new AuthConfigService()).toThrow(
      /SESSION_SECRET_PREVIOUS must be a different value/,
    );
  });

  it('throws when SESSION_SECRET_PREVIOUS is set but SESSION_SECRET is empty (orphan)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('SESSION_SECRET_PREVIOUS', 'a'.repeat(32));

    // Primary check runs first; the orphan failure mode surfaces as
    // the standard "SESSION_SECRET must be at least 32" boot throw.
    expect(() => new AuthConfigService()).toThrow(
      /SESSION_SECRET must be at least 32/,
    );
  });

  it('treats SESSION_SECRET_PREVIOUS="" as unset (no rotation, no orphan throw)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', '');

    const cfg = new AuthConfigService();
    expect(cfg.config.sessionSecretPrevious).toBeUndefined();
    expect(cfg.config.sessionPassword).toBe('a'.repeat(32));
  });

  it('decrypts pre-rotation cookies once the previous key is registered (flip-then-drop)', async () => {
    // T0 — primary='a'... single-key. Seal a session blob.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    const t0 = new AuthConfigService();
    const t0Sealed = await sealData(
      { userId: 'u-1', tenantId: 't-1' },
      { password: t0.config.sessionPassword },
    );

    // T1 — rotation starts. New primary='b'..., previous='a'...
    // The "flip" step of flip-then-drop.
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', 'a'.repeat(32));
    const t1 = new AuthConfigService();

    // The whole point of the rotation primitive: existing cookies
    // continue to decrypt under the rotation-active config.
    const t0Reread = await unsealData<{ userId: string; tenantId: string }>(
      t0Sealed,
      { password: t1.config.sessionPassword },
    );
    expect(t0Reread).toEqual({ userId: 'u-1', tenantId: 't-1' });

    // New cookies issued during the rotation are sealed under the
    // primary (iron-session picks the highest-numbered key — id 2).
    const t1Sealed = await sealData(
      { userId: 'u-2', tenantId: 't-2' },
      { password: t1.config.sessionPassword },
    );
    const t1Reread = await unsealData<{ userId: string; tenantId: string }>(
      t1Sealed,
      { password: t1.config.sessionPassword },
    );
    expect(t1Reread).toEqual({ userId: 'u-2', tenantId: 't-2' });
  });

  // See docs/runbooks/secrets-rotation.md Step 3 — the wait is the
  // operator-visible contract that prevents this lockout in practice.
  it('locks out pre-drop cookies once the previous key is cleared (must wait sessionMaxAge before drop)', async () => {
    // Seal a cookie at T0 (single-key).
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    const t0 = new AuthConfigService();
    const t0Sealed = await sealData(
      { userId: 'u-1', tenantId: 't-1' },
      { password: t0.config.sessionPassword },
    );

    // Operator skips the wait and clears PREVIOUS while T0 cookies
    // are still valid. (The runbook tells them not to.) Switch to
    // a brand-new primary so the previous key is genuinely gone.
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(32));
    vi.stubEnv('SESSION_SECRET_PREVIOUS', '');
    const dropped = new AuthConfigService();

    // T0 cookies were sealed under 'a'...; nothing in the new config
    // can decrypt them. iron-session's unsealData swallows
    // "Cannot find password" and returns `{}` rather than throwing —
    // SessionService treats an empty object as "no session". The
    // runbook documents this: wait at least SESSION_MAX_AGE_SECONDS
    // before clearing PREVIOUS so live cookies expire first.
    const reread = await unsealData<{ userId?: string; tenantId?: string }>(
      t0Sealed,
      { password: dropped.config.sessionPassword },
    );
    expect(reread).toEqual({});
  });
});
