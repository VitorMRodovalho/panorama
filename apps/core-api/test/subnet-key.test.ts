import { describe, expect, it } from 'vitest';
import { normalizeIpForBucket, subnetKey } from '../src/shared/throttler/subnet-key.js';

describe('subnetKey — IPv4', () => {
  it('keys distinct IPs in same /24 to the same bucket', () => {
    expect(subnetKey('203.0.113.5')).toBe('v4:203.0.113.0/24');
    expect(subnetKey('203.0.113.250')).toBe('v4:203.0.113.0/24');
    expect(subnetKey('203.0.113.5')).toBe(subnetKey('203.0.113.99'));
  });

  it('keys distinct /24 ranges to different buckets', () => {
    expect(subnetKey('203.0.113.5')).not.toBe(subnetKey('203.0.114.5'));
    expect(subnetKey('10.0.0.1')).not.toBe(subnetKey('10.0.1.1'));
  });

  it('rejects malformed IPv4 (octets > 255) as unknown', () => {
    expect(subnetKey('999.0.0.1')).toBe('unknown');
    expect(subnetKey('256.256.256.256')).toBe('unknown');
  });

  it('treats loopback as its own bucket (still useful for dev isolation)', () => {
    expect(subnetKey('127.0.0.1')).toBe('v4:127.0.0.0/24');
  });
});

describe('subnetKey — IPv6', () => {
  it('keys distinct addresses in same /64 to the same bucket', () => {
    expect(subnetKey('2001:db8:1234:5678::1')).toBe(
      subnetKey('2001:db8:1234:5678::ffff'),
    );
  });

  it('keys distinct /64 ranges to different buckets', () => {
    expect(subnetKey('2001:db8:1234:5678::1')).not.toBe(
      subnetKey('2001:db8:1234:9999::1'),
    );
  });

  it('handles fully-expanded form', () => {
    expect(
      subnetKey('2001:0db8:1234:5678:0000:0000:0000:0001'),
    ).toBe('v6:2001:db8:1234:5678::/64');
  });

  it('handles :: at the end', () => {
    expect(subnetKey('2001:db8:1234:5678::')).toBe('v6:2001:db8:1234:5678::/64');
  });

  it('handles :: at the start', () => {
    expect(subnetKey('::1')).toBe('v6:0:0:0:0::/64');
  });

  it('strips zone ID', () => {
    expect(subnetKey('fe80::1%eth0')).toBe('v6:fe80:0:0:0::/64');
  });

  it('rejects too-many double-colons', () => {
    expect(subnetKey('2001::db8::1')).toBe('unknown');
  });

  it('rejects too-many hextets', () => {
    expect(subnetKey('1:2:3:4:5:6:7:8:9')).toBe('unknown');
  });

  it('rejects non-hex characters', () => {
    expect(subnetKey('2001:zzzz::1')).toBe('unknown');
  });
});

describe('subnetKey — IPv6-mapped IPv4', () => {
  it('normalizes ::ffff:1.2.3.4 to its IPv4 /24 bucket', () => {
    expect(subnetKey('::ffff:203.0.113.5')).toBe('v4:203.0.113.0/24');
    expect(subnetKey('::ffff:203.0.113.5')).toBe(subnetKey('203.0.113.250'));
  });

  it('is case-insensitive on the ::ffff: prefix', () => {
    expect(subnetKey('::FFFF:203.0.113.5')).toBe('v4:203.0.113.0/24');
  });
});

describe('subnetKey — edge cases', () => {
  it('returns unknown for undefined / null / empty', () => {
    expect(subnetKey(undefined)).toBe('unknown');
    expect(subnetKey(null)).toBe('unknown');
    expect(subnetKey('')).toBe('unknown');
  });

  it('returns unknown for garbage strings', () => {
    expect(subnetKey('not-an-ip')).toBe('unknown');
    expect(subnetKey('1.2.3')).toBe('unknown');
  });

  it('collapses all unknown inputs to ONE shared bucket (fail-closed)', () => {
    expect(subnetKey('garbage1')).toBe(subnetKey('garbage2'));
    expect(subnetKey('garbage1')).toBe(subnetKey(undefined));
  });
});

describe('normalizeIpForBucket', () => {
  it('strips the ::ffff: prefix so v4-mapped and raw v4 share a bucket', () => {
    expect(normalizeIpForBucket('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpForBucket('::ffff:1.2.3.4')).toBe(normalizeIpForBucket('1.2.3.4'));
  });

  it('is case-insensitive on the ::ffff: prefix', () => {
    expect(normalizeIpForBucket('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });

  it('passes raw IPv4 through verbatim', () => {
    expect(normalizeIpForBucket('203.0.113.5')).toBe('203.0.113.5');
  });

  it('passes raw IPv6 through verbatim (no general canonicalization)', () => {
    // The helper intentionally does NOT canonicalize general IPv6
    // shapes — that responsibility lives in subnetKey which derives
    // a /64 prefix. consumeIp's per-IP key keeps the raw form so
    // distinct IPv6 hosts don't collide on truncation.
    expect(normalizeIpForBucket('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIpForBucket('::1')).toBe('::1');
  });

  it('collapses missing / empty to unknown (fail-closed)', () => {
    expect(normalizeIpForBucket(undefined)).toBe('unknown');
    expect(normalizeIpForBucket(null)).toBe('unknown');
    expect(normalizeIpForBucket('')).toBe('unknown');
  });
});
