import { describe, expect, it } from 'vitest';
import { resolveTrustProxyHops } from '../src/bootstrap/trust-proxy-hops.js';

describe('resolveTrustProxyHops', () => {
  it('defaults to 1 when TRUST_PROXY_HOPS is unset', () => {
    expect(resolveTrustProxyHops({})).toBe(1);
  });

  it('defaults to 1 when TRUST_PROXY_HOPS is empty string', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(1);
  });

  it('parses a positive integer', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '5' })).toBe(5);
  });

  it('permits 0 (development, no proxy)', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
  });

  it('rejects negative integers (no such thing as -1 hops)', () => {
    expect(() =>
      resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' }),
    ).toThrowError(/non-negative integer/);
  });

  it('rejects non-integer numerics (decimal hop counts are meaningless)', () => {
    expect(() =>
      resolveTrustProxyHops({ TRUST_PROXY_HOPS: '1.5' }),
    ).toThrowError(/non-negative integer/);
  });

  it('rejects non-numeric strings (silent NaN would mis-configure Express)', () => {
    expect(() =>
      resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'loopback' }),
    ).toThrowError(/non-negative integer/);
    expect(() =>
      resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'true' }),
    ).toThrowError(/non-negative integer/);
  });
});
