import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
