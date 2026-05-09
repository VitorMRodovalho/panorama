import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
// `openid-client` is ESM-only since v6 (no CJS export). Static `import`
// from our compiled CJS module would fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`
// at runtime. Dynamic import works in CJS via Node's interop and resolves
// to the ESM exports lazily; cached after first use. The type-only static
// import below uses `with { 'resolution-mode': 'import' }` so TS resolves
// the types as if from an ESM context (required because the surrounding
// file is CJS but openid-client ships ESM-only `.d.ts`).
// Same shape as photo-pipeline's `file-type` shim landed in #163.
import type {
  authorizationCodeGrant as authorizationCodeGrantType,
  buildAuthorizationUrl as buildAuthorizationUrlType,
  calculatePKCECodeChallenge as calculatePKCECodeChallengeType,
  Configuration,
  discovery as discoveryType,
  randomNonce as randomNonceType,
  randomPKCECodeVerifier as randomPKCECodeVerifierType,
  randomState as randomStateType,
} from 'openid-client' with { 'resolution-mode': 'import' };

interface OidcModule {
  authorizationCodeGrant: typeof authorizationCodeGrantType;
  buildAuthorizationUrl: typeof buildAuthorizationUrlType;
  calculatePKCECodeChallenge: typeof calculatePKCECodeChallengeType;
  discovery: typeof discoveryType;
  randomNonce: typeof randomNonceType;
  randomPKCECodeVerifier: typeof randomPKCECodeVerifierType;
  randomState: typeof randomStateType;
}

let oidcModule: OidcModule | undefined;
async function loadOidc(): Promise<OidcModule> {
  if (!oidcModule) {
    const mod = await import('openid-client');
    oidcModule = {
      authorizationCodeGrant: mod.authorizationCodeGrant,
      buildAuthorizationUrl: mod.buildAuthorizationUrl,
      calculatePKCECodeChallenge: mod.calculatePKCECodeChallenge,
      discovery: mod.discovery,
      randomNonce: mod.randomNonce,
      randomPKCECodeVerifier: mod.randomPKCECodeVerifier,
      randomState: mod.randomState,
    };
  }
  return oidcModule;
}
import { AuthConfigService, type OidcProviderConfig } from './auth.config.js';

export interface OidcStartParams {
  provider: 'google' | 'microsoft';
  redirectTo: string;
  tenantHint?: string;
}

export interface OidcStartResult {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface OidcCallbackParams {
  provider: 'google' | 'microsoft';
  /**
   * Absolute URL of the inbound callback request the IdP redirected
   * the browser to (path + full query string), so openid-client v6
   * can extract `code`, `state`, AND — importantly — `iss`
   * (RFC 9207 Authorization Server Issuer Identifier) and
   * `error`/`error_description` if the IdP sends them. The previous
   * implementation reconstructed the URL from configured redirectUri +
   * code + state alone, which dropped `iss` and made mix-up attacks
   * harder to detect.
   *
   * Controller composes this from `req.originalUrl` joined to the
   * configured `baseUrl` (NOT raw `req.headers.host` — that's
   * attacker-shaped without `app.set('trust proxy', ...)` configured).
   */
  callbackUrl: string;
  expectedState: string;
  codeVerifier: string;
  expectedNonce: string;
}

export interface OidcUserInfo {
  subject: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  emailVerified: boolean;
  /**
   * Google Workspace `hd` (hosted domain) claim, lowercased. Set by
   * Google only for Workspace accounts where the admin has proven
   * domain ownership; absent for consumer @gmail.com and for non-Google
   * providers. Used by AuthService to allow a workspace-domain
   * exception to the `email_verified` gate.
   */
  hd: string | null;
  /**
   * ID-token `iss` claim. Used to pin the hd-override to actual Google.
   * NULL only if a token somehow arrives without an `iss` claim — a
   * spec violation (RFC 7519). The gate refuses such tokens; the
   * NULL is preserved here so the audit metadata isn't poisoned with
   * the literal string `"undefined"`.
   */
  iss: string | null;
}

/**
 * Thin wrapper around `openid-client` (v6) that:
 *   * Discovers the IdP's metadata from its issuer URL on first use
 *   * Caches the resulting Configuration so subsequent calls don't re-discover
 *   * Implements PKCE + nonce for every flow (no implicit grant, no plain)
 *
 * Controllers call `start()` to get an authorise URL + the state/verifier
 * to stash in the OAuth-state cookie, then `callback()` with the code and
 * the state the cookie preserved.
 */
@Injectable()
export class OidcService {
  private readonly log = new Logger('OidcService');
  private readonly configCache = new Map<string, Promise<Configuration>>();

  constructor(private readonly cfg: AuthConfigService) {}

  private redirectUri(provider: string): string {
    return `${this.cfg.config.baseUrl}/auth/oidc/${provider}/callback`;
  }

  private async config(provider: 'google' | 'microsoft'): Promise<Configuration> {
    const cfg = this.cfg.config.providers[provider];
    if (!cfg) throw new Error(`OIDC provider "${provider}" not configured`);
    if (!this.configCache.has(provider)) {
      this.configCache.set(provider, this.buildConfig(provider, cfg));
    }
    return this.configCache.get(provider)!;
  }

  private async buildConfig(
    provider: 'google' | 'microsoft',
    cfg: OidcProviderConfig,
  ): Promise<Configuration> {
    const { discovery } = await loadOidc();
    const config = await discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret);
    this.log.log(
      { provider, issuer: config.serverMetadata().issuer },
      'oidc_client_ready',
    );
    return config;
  }

  async start(params: OidcStartParams): Promise<OidcStartResult> {
    const {
      buildAuthorizationUrl,
      calculatePKCECodeChallenge,
      randomNonce,
      randomPKCECodeVerifier,
      randomState,
    } = await loadOidc();

    const config = await this.config(params.provider);
    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const providerCfg = this.cfg.config.providers[params.provider]!;

    const scopes = ['openid', 'email', 'profile', ...(providerCfg.extraScopes ?? [])];

    const url = buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(params.provider),
      scope: scopes.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(providerCfg.hostedDomainHint ? { hd: providerCfg.hostedDomainHint } : {}),
      ...(params.tenantHint ? { login_hint: params.tenantHint } : {}),
    });

    return { url: url.href, state, codeVerifier, nonce };
  }

  async callback(params: OidcCallbackParams): Promise<OidcUserInfo> {
    // Defence-in-depth at the service boundary. Controller already does
    // a `stored.state !== state` cookie comparison, but `expectedState`
    // is typed `string` and an empty string would silently pass through
    // to v6 — which would then validate against the literal empty state
    // and accept any `?state=` value the IdP returns. Same for the URL
    // (cheap parse-or-throw guard).
    if (typeof params.expectedState !== 'string' || params.expectedState.length === 0) {
      throw new UnauthorizedException('oidc_state_invalid');
    }
    if (typeof params.callbackUrl !== 'string' || params.callbackUrl.length === 0) {
      throw new UnauthorizedException('oidc_invalid_callback_url');
    }
    let currentUrl: URL;
    try {
      currentUrl = new URL(params.callbackUrl);
    } catch {
      throw new UnauthorizedException('oidc_invalid_callback_url');
    }

    const { authorizationCodeGrant } = await loadOidc();
    const config = await this.config(params.provider);

    let tokens;
    try {
      tokens = await authorizationCodeGrant(config, currentUrl, {
        expectedState: params.expectedState,
        expectedNonce: params.expectedNonce,
        pkceCodeVerifier: params.codeVerifier,
      });
    } catch (err) {
      // openid-client v6 sometimes embeds the auth-response URL in
      // error messages — including `code=...` (single-use, short-lived,
      // PII-adjacent) and `state=...`. Redact those before they hit
      // the log aggregator. Keep err.name + redacted .message for
      // diagnosis without leaking the auth code.
      const errMsg = err instanceof Error ? err.message : String(err);
      const sanitized = errMsg
        .replace(/([?&])code=[^&\s]+/g, '$1code=REDACTED')
        .replace(/([?&])state=[^&\s]+/g, '$1state=REDACTED')
        // Strip ANSI control + DEL bytes — pino encodes JSON safely,
        // but downstream sinks (Grafana panels, Slack relays) sometimes
        // render `err_msg` raw, which is an injection surface if an IdP
        // ever returns a URL fragment with `[31m` etc.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '');
      this.log.warn(
        {
          err_name: err instanceof Error ? err.name : 'Unknown',
          err_msg: sanitized,
          provider: params.provider,
        },
        'oidc_callback_failed',
      );
      throw new UnauthorizedException('oidc_exchange_failed');
    }

    const claims = tokens.claims();
    if (!claims) throw new UnauthorizedException('oidc_missing_id_token');
    // `email` claim is `JsonValue | undefined` in v6's type. Narrow to a
    // non-empty string explicitly — anything else (number, array, object)
    // means the IdP is misconfigured and we'd otherwise stringify garbage.
    const rawEmail = claims['email'];
    if (typeof rawEmail !== 'string' || rawEmail.length === 0) {
      throw new UnauthorizedException('oidc_missing_email');
    }
    // `sub` is mandatory per RFC 7519. If it's missing or non-string,
    // the (provider, subject) tuple we use as the strongest identity
    // key would degrade to `(provider, 'undefined')` and start
    // colliding across upstream IdP misconfigurations. Refuse loudly.
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new UnauthorizedException('oidc_missing_subject');
    }

    const rawHd = claims['hd'];
    const hd =
      typeof rawHd === 'string' && rawHd.trim().length > 0
        ? rawHd.trim().toLowerCase()
        : null;

    return {
      subject: claims.sub,
      email: rawEmail.toLowerCase().trim(),
      firstName: typeof claims['given_name'] === 'string' ? claims['given_name'] : null,
      lastName: typeof claims['family_name'] === 'string' ? claims['family_name'] : null,
      displayName: typeof claims['name'] === 'string' ? claims['name'] : null,
      emailVerified: claims['email_verified'] === true,
      hd,
      iss: typeof claims.iss === 'string' && claims.iss.length > 0 ? claims.iss : null,
    };
  }
}
