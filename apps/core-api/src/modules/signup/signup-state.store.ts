import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../redis/redis.service.js';

/**
 * Server-side one-time-use signup state record (ADR-0020 §1a).
 *
 * Login OIDC state lives in an encrypted cookie (iron-session). Signup
 * state is Redis-backed — and intentionally so: the CSRF surface on a
 * signup callback is wider than on a login callback (it binds the IdP
 * response to a tenant-creation transaction, not to an existing
 * session), and a leaked SESSION_SECRET would forge a cookie-only
 * state. A Redis-backed record forces the breach surface up to "DB +
 * Redis simultaneously," a meaningfully higher bar.
 *
 * The Redis key is a 32-byte URL-safe random; the `state=` parameter
 * sent to the IdP is exactly that key, so a callback lookup is
 * one round-trip.
 *
 * Consume is one-shot via Lua + `DEL` — the same key cannot be
 * replayed against a second callback. Reasons (`missing`, `expired`,
 * `wrong_purpose`) are returned as a tagged union so the controller
 * can emit the §1a `AuthSignupOidcStateMismatch` audit row with the
 * `reason` field correctly distinguished. Session-attached is checked
 * at the controller (because it depends on `getRequestSession`),
 * not here.
 */

export type SignupCtaSource = 'hosted_button' | 'selfhost_button' | 'direct_url';

export interface SignupStateRecord {
  purpose: 'signup';
  provider: 'google' | 'microsoft';
  redirectTo: string;
  ctaSource: SignupCtaSource;
  /** sha256(userAgent) hex — bot-pattern detection without persisting raw UA. */
  userAgentHash: string | null;
  /** PKCE code_verifier minted at initiate. */
  codeVerifier: string;
  /** OIDC nonce minted at initiate. */
  nonce: string;
  /** Unix epoch seconds. */
  createdAt: number;
}

export type StateConsumeResult =
  | { kind: 'ok'; record: SignupStateRecord }
  | { kind: 'missing' }
  | { kind: 'wrong_purpose' };

const KEY_PREFIX = 'panorama:signup:state:';
const TTL_SECONDS = 5 * 60;

@Injectable()
export class SignupStateStore {
  private readonly log = new Logger('SignupStateStore');

  constructor(private readonly redis: RedisService) {}

  /**
   * Generate a fresh URL-safe state key. The caller passes this same
   * key to `OidcService.start({ state })` (so the `?state=` query
   * param matches) AND to `set(key, record)` (so the callback
   * lookup is deterministic). Split from `set` because the
   * openid-client `start` call must learn the key BEFORE we have
   * the PKCE verifier + nonce to persist — a single-shot mint would
   * have to placeholder-write and overwrite, which leaks bookkeeping
   * into the controller.
   *
   * 32 random bytes encoded as URL-safe base64; collision is
   * negligible.
   */
  generateKey(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Persist a signup state record under the given key, 5min TTL.
   * Used by the controller after it has obtained the PKCE verifier
   * + nonce from `OidcService.start`. Overwriting an existing key
   * is OK — keys are 32 random bytes and the only legitimate
   * overwrite would be the controller's own happy path.
   */
  async set(key: string, record: Omit<SignupStateRecord, 'createdAt'>): Promise<void> {
    const payload: SignupStateRecord = {
      ...record,
      createdAt: Math.floor(Date.now() / 1000),
    };
    await this.redis.client.set(KEY_PREFIX + key, JSON.stringify(payload), 'EX', TTL_SECONDS);
  }

  /**
   * Consume a state key. Returns the record on success and deletes
   * the key in the same Redis round-trip (atomic via GETDEL). A
   * second consume on the same key returns `kind: 'missing'`.
   *
   * Unparseable Redis payloads are treated as `missing` rather than
   * thrown — the operational signal is captured in the
   * `AuthSignupOidcStateMismatch` audit row the controller emits.
   *
   * `purpose !== 'signup'` is the confused-deputy defense: a login-
   * flow state record that somehow ended up at the signup callback
   * (or vice versa) MUST be refused. We never write non-signup
   * records to this prefix, so this branch only fires on malicious
   * cross-flow replay attempts; emit the SIEM signal and discard.
   */
  async consume(key: string): Promise<StateConsumeResult> {
    if (!key || typeof key !== 'string' || key.length === 0) {
      return { kind: 'missing' };
    }
    let raw: string | null = null;
    try {
      raw = await this.redis.client.getdel(KEY_PREFIX + key);
    } catch (err) {
      this.log.warn({ err: String(err) }, 'signup_state_consume_redis_error');
      return { kind: 'missing' };
    }
    if (raw === null) return { kind: 'missing' };
    let parsed: SignupStateRecord;
    try {
      parsed = JSON.parse(raw) as SignupStateRecord;
    } catch (err) {
      this.log.warn({ err: String(err) }, 'signup_state_consume_parse_error');
      return { kind: 'missing' };
    }
    if (parsed.purpose !== 'signup') {
      return { kind: 'wrong_purpose' };
    }
    return { kind: 'ok', record: parsed };
  }
}
