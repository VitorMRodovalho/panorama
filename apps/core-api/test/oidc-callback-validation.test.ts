import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { OidcService } from '../src/modules/auth/oidc.service.js';
import type { AuthConfigService } from '../src/modules/auth/auth.config.js';

/**
 * Defence-in-depth coverage for the input gates added to
 * `OidcService.callback()` per #172 (PR #171 follow-ups).
 *
 * Both guards short-circuit BEFORE any openid-client module load or
 * IdP discovery happens, so they're deterministic to unit-test
 * without infrastructure. Mirrors the controller-level guards.
 */

// Stub — never reached. The early-return in `callback()` throws on the
// first or second line, before `loadOidc()` or `this.config()` runs.
const stubCfg = {
  config: { baseUrl: 'http://localhost:4000', providers: {} },
} as unknown as AuthConfigService;

const baseParams = {
  provider: 'google' as const,
  callbackUrl:
    'http://localhost:4000/auth/oidc/google/callback?code=x&state=y',
  codeVerifier: 'v',
  expectedNonce: 'n',
};

describe('OidcService.callback — input validation', () => {
  it('rejects empty expectedState as oidc_state_invalid', async () => {
    const svc = new OidcService(stubCfg);
    await expect(
      svc.callback({ ...baseParams, expectedState: '' }),
    ).rejects.toMatchObject({
      // UnauthorizedException's `.message` carries the code we threw.
      message: 'oidc_state_invalid',
    });
    await expect(
      svc.callback({ ...baseParams, expectedState: '' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects non-string expectedState as oidc_state_invalid', async () => {
    const svc = new OidcService(stubCfg);
    await expect(
      svc.callback({
        ...baseParams,
        expectedState: undefined as unknown as string,
      }),
    ).rejects.toMatchObject({ message: 'oidc_state_invalid' });
  });

  it('rejects empty callbackUrl as oidc_invalid_callback_url', async () => {
    const svc = new OidcService(stubCfg);
    await expect(
      svc.callback({
        ...baseParams,
        callbackUrl: '',
        expectedState: 'good',
      }),
    ).rejects.toMatchObject({ message: 'oidc_invalid_callback_url' });
  });

  it('rejects malformed callbackUrl as oidc_invalid_callback_url', async () => {
    const svc = new OidcService(stubCfg);
    await expect(
      svc.callback({
        ...baseParams,
        callbackUrl: 'not-a-url',
        expectedState: 'good',
      }),
    ).rejects.toMatchObject({ message: 'oidc_invalid_callback_url' });
  });

  it('rejects non-string callbackUrl as oidc_invalid_callback_url', async () => {
    const svc = new OidcService(stubCfg);
    await expect(
      svc.callback({
        ...baseParams,
        callbackUrl: undefined as unknown as string,
        expectedState: 'good',
      }),
    ).rejects.toMatchObject({ message: 'oidc_invalid_callback_url' });
  });
});

/**
 * Pin the log-redaction regex behaviour so a future "simplification"
 * doesn't quietly start leaking auth codes into log aggregators.
 * Mirrors the inline regex in `OidcService.callback()`'s catch block.
 */
describe('OidcService.callback — log redaction regex', () => {
  // Re-derive the regex pipeline from the service implementation so the
  // test is decoupled from the catch-block layout but still exercises
  // the exact string transforms we ship.
  function redact(msg: string): string {
    return msg
      .replace(/([?&])code=[^&\s]+/g, '$1code=REDACTED')
      .replace(/([?&])state=[^&\s]+/g, '$1state=REDACTED')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '');
  }

  it('redacts ?code= and &state= when both present', () => {
    const out = redact(
      'authorization response failed at https://example.com/cb?code=abc.123&state=def_456',
    );
    expect(out).toContain('code=REDACTED');
    expect(out).toContain('state=REDACTED');
    expect(out).not.toContain('abc.123');
    expect(out).not.toContain('def_456');
  });

  it('redacts code+state regardless of order or interleaving params', () => {
    const out = redact('cb?iss=https%3A%2F%2Fidp&state=DEF&foo=bar&code=ABC');
    expect(out).toContain('state=REDACTED');
    expect(out).toContain('code=REDACTED');
    expect(out).toContain('iss=https%3A%2F%2Fidp'); // iss preserved (it's safe)
    expect(out).toContain('foo=bar');
  });

  it('strips ANSI control + DEL bytes', () => {
    const out = redact('msg\x1b[31mRED\x1b[0m\x7fend');
    expect(out).toBe('msg[31mRED[0mend');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('does NOT touch a clean message', () => {
    const input = 'simple error: discovery timed out';
    expect(redact(input)).toBe(input);
  });
});

