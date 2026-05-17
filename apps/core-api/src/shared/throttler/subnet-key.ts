/**
 * Subnet-aware IP keying for throttler buckets (ADR-0020 §4 second
 * bucket: `50 / IPv4-/24 or IPv6-/64 / day`).
 *
 * Residential proxy networks rotate IPs per request inside their
 * pool, but the pool itself clusters in /24 (IPv4) or /64 (IPv6)
 * ranges. Bucketing by full IP gives an attacker ~1000s of slots
 * for ~$10/month; bucketing by subnet caps the abuse meaningfully
 * without punishing legitimate users behind shared CGNAT egress.
 *
 * `req.ip` for IPv6 may arrive as the IPv6-mapped IPv4 form
 * (`::ffff:1.2.3.4`); we normalize to plain IPv4 so the IPv4 /24
 * mask applies. Invalid/missing input collapses to a single
 * `'unknown'` bucket — fail-closed (all unparsed traffic shares one
 * slot rather than each unparsed string getting its own).
 */
/**
 * Strip the `::ffff:` IPv6-mapped IPv4 prefix so the same client IP
 * maps to a single rate-limit bucket regardless of how Express
 * resolved `req.ip` at this hop. Dual-stack deployments occasionally
 * surface the same address as `1.2.3.4` on one ingress path and
 * `::ffff:1.2.3.4` on another (e.g., Fly's IPv6 edge front of an
 * IPv4-only origin); leaving the prefix in place doubles the per-IP
 * budget for that one client (security-reviewer follow-up concern #6
 * from PR #212).
 *
 * Non-mapped inputs pass through verbatim — this helper does NOT
 * canonicalise general IPv6 (zone stripping, leading-zero collapse,
 * `::` placement) because those normalisations belong in `subnetKey`
 * which derives a /64 prefix anyway. The narrow scope here matches
 * the security-reviewer's concern and keeps the IPv6 surface
 * behaviour-identical to the previous code path.
 *
 * Missing / empty input collapses to `'unknown'` — same fail-closed
 * shape `subnetKey` uses, so a misconfigured proxy doesn't mint
 * unique bucket slots per garbage value.
 */
export function normalizeIpForBucket(ip: string | undefined | null): string {
  if (ip === undefined || ip === null || ip === '') return 'unknown';
  const v4Mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return v4Mapped ? v4Mapped[1]! : ip;
}

export function subnetKey(ip: string | undefined | null): string {
  if (ip === undefined || ip === null || ip === '') {
    return 'unknown';
  }

  const v4Mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const candidate = v4Mapped ? v4Mapped[1]! : ip;

  const v4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) {
    const [, a, b, c] = v4;
    const octets = [a, b, c].map((octet) => Number(octet));
    if (octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return `v4:${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
    }
    return 'unknown';
  }

  if (ip.includes(':')) {
    const v6 = expandIPv6Prefix(ip);
    if (v6 !== null) {
      return `v6:${v6}::/64`;
    }
  }

  return 'unknown';
}

/**
 * Returns the first 4 hextets of an IPv6 address (the /64 prefix),
 * joined with `:` and unpadded, or null if the input is not a
 * parseable IPv6 address. Does not implement full RFC 4291
 * normalization; only what's needed to derive a stable /64 bucket
 * key. Inputs with zone IDs (e.g., `fe80::1%eth0`) have the zone
 * stripped before parsing.
 */
function expandIPv6Prefix(ip: string): string | null {
  const withoutZone = ip.split('%')[0]!;
  if (!/^[0-9a-fA-F:]+$/.test(withoutZone)) {
    return null;
  }
  const doubleColonCount = (withoutZone.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) {
    return null;
  }

  let head: string[];
  let tail: string[];
  if (doubleColonCount === 1) {
    const [headStr, tailStr] = withoutZone.split('::');
    head = headStr === '' ? [] : headStr!.split(':');
    tail = tailStr === '' ? [] : tailStr!.split(':');
  } else {
    head = withoutZone.split(':');
    tail = [];
  }

  const totalGiven = head.length + tail.length;
  if (totalGiven > 8) return null;
  const missing = 8 - totalGiven;
  const expanded = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (expanded.length !== 8) return null;
  if (!expanded.every((h) => /^[0-9a-fA-F]{1,4}$/.test(h))) return null;

  const prefix64 = expanded.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, ''));
  return prefix64.join(':');
}
