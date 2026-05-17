import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RateLimiter, type RateLimitDecision } from '../redis/rate-limiter.js';
import { subnetKey } from '../../shared/throttler/subnet-key.js';

/**
 * Three-bucket signup rate limiter (ADR-0020 §4).
 *
 * | Bucket   | Limit  | Window | Key shape                       | Defeats |
 * |----------|--------|--------|---------------------------------|---------|
 * | ip       | 5      | 1h     | `signup:ip:${ip}`               | Loud single-source flooders |
 * | subnet   | 50     | 24h    | `signup:subnet:${subnetKey(ip)}`| Residential proxy pools (~$10/mo for 1000s of IPs clustering in /24s) |
 * | oidc_sub | 3      | 24h    | `signup:oidc:${hash(iss:sub)}`  | A single Google/Microsoft account cycling proxies |
 *
 * Why service-level instead of @nestjs/throttler named buckets:
 * `ThrottlerGuard` v6 iterates every named throttler on every route
 * and uses a per-(class, handler, name) key. The named bucket
 * `signupIp: 5/hour` would therefore enforce 5/hour ON EVERY OTHER
 * ROUTE (each as its own key) — capping `/auth/login` at 5/hour,
 * `/reservations` at 5/hour, and so on. The only way to opt out
 * is `@SkipThrottle({signupIp: true, signupSubnet: true})` on every
 * non-signup controller, which is brittle and easy to forget.
 *
 * Service-level lets us:
 *   1. Restrict the buckets to the signup endpoints by construction
 *      (no rogue route inherits them).
 *   2. Emit the §6 `AuthSignupRateLimitTripped` audit row with the
 *      exact `bucket` ('ip' | 'subnet' | 'oidc_sub') that fired —
 *      `ThrottlerGuard` throws an exception that doesn't carry that
 *      label cleanly.
 *   3. Compose the timing-padded 400 envelope (§5) in one place
 *      rather than overriding `throwThrottlingException`.
 *
 * All three buckets share `RateLimiter`'s fail-closed semantics: a
 * Redis outage returns `{ allowed: false, reason: 'redis_unavailable' }`
 * and the controller treats it as a refusal. Spec by §4: every
 * bucket trip rejects the request; downgraded availability does not
 * downgrade rate-limit enforcement.
 *
 * Bucket 3 (`oidc_sub`) is intentionally consumed AFTER id_token
 * validation in the callback, because `iss` and `sub` aren't known
 * at request entry. The first two are consumed on the initiate
 * endpoint, before the OIDC redirect.
 */

const IP_PREFIX = 'panorama:signup:ip:';
const IP_LIMIT = 5;
const IP_WINDOW_MS = 60 * 60 * 1000;

const SUBNET_PREFIX = 'panorama:signup:subnet:';
const SUBNET_LIMIT = 50;
const SUBNET_WINDOW_MS = 24 * 60 * 60 * 1000;

const OIDC_PREFIX = 'panorama:signup:oidc:';
const OIDC_LIMIT = 3;
const OIDC_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SignupBucket = 'ip' | 'subnet' | 'oidc_sub';

@Injectable()
export class SignupRateLimits {
  constructor(private readonly limiter: RateLimiter) {}

  consumeIp(ip: string | null | undefined): Promise<RateLimitDecision> {
    return this.limiter.consume(IP_PREFIX + (ip ?? 'unknown'), IP_LIMIT, IP_WINDOW_MS);
  }

  consumeSubnet(ip: string | null | undefined): Promise<RateLimitDecision> {
    return this.limiter.consume(
      SUBNET_PREFIX + subnetKey(ip ?? ''),
      SUBNET_LIMIT,
      SUBNET_WINDOW_MS,
    );
  }

  consumeOidcSub(iss: string, sub: string): Promise<RateLimitDecision> {
    return this.limiter.consume(
      OIDC_PREFIX + hashIssSub(iss, sub),
      OIDC_LIMIT,
      OIDC_WINDOW_MS,
    );
  }
}

function hashIssSub(iss: string, sub: string): string {
  return createHash('sha256').update(`${iss}:${sub}`).digest('hex');
}
