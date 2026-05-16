/**
 * Resolve the `trust proxy` hop count from TRUST_PROXY_HOPS env.
 *
 * Express's `app.set('trust proxy', n)` reads the Nth-from-the-right
 * value in `X-Forwarded-For` as `req.ip`. ADR-0020 §4 makes this
 * contract explicit because the self-serve signup endpoint's per-IP
 * throttler bucket cannot be defended if hop count is wrong:
 *
 *   - Too low: req.ip resolves to an internal proxy, all traffic
 *     buckets to one IP (fail-united).
 *   - Too high: req.ip resolves to whatever the upstream client sent
 *     in X-Forwarded-For, which a remote attacker controls (forged
 *     identities).
 *
 * Default `1` matches the hosted instance topology (Fly edge → app).
 * Self-hosters running behind extra layers (CDN + LB + app) MUST set
 * TRUST_PROXY_HOPS explicitly — see secrets-inventory.md.
 *
 * Invalid values (non-integer, negative) fail-fast at bootstrap.
 * `0` is permitted (development mode, no proxy in front).
 */
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') {
    return 1;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
