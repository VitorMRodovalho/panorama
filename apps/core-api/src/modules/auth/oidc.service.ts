import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { generators, Issuer, type Client } from 'openid-client';
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
  code: string;
  state: string;
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
 * Thin wrapper around `openid-client` (v5) that:
 *   * Discovers the IdP's metadata from its issuer URL on first use
 *   * Caches the resulting Client so subsequent calls don't re-discover
 *   * Implements PKCE + nonce for every flow (no implicit grant, no plain)
 *
 * Controllers call `start()` to get an authorise URL + the state/verifier
 * to stash in the OAuth-state cookie, then `callback()` with the code and
 * the state the cookie preserved.
 */
@Injectable()
export class OidcService {
  private readonly log = new Logger('OidcService');
  private readonly clientsCache = new Map<string, Promise<Client>>();

  constructor(private readonly cfg: AuthConfigService) {}

  private redirectUri(provider: string): string {
    return `${this.cfg.config.baseUrl}/auth/oidc/${provider}/callback`;
  }

  private async client(provider: 'google' | 'microsoft'): Promise<Client> {
    const cfg = this.cfg.config.providers[provider];
    if (!cfg) throw new Error(`OIDC provider "${provider}" not configured`);
    if (!this.clientsCache.has(provider)) {
      this.clientsCache.set(provider, this.buildClient(provider, cfg));
    }
    return this.clientsCache.get(provider)!;
  }

  private async buildClient(
    provider: 'google' | 'microsoft',
    cfg: OidcProviderConfig,
  ): Promise<Client> {
    const issuer = await Issuer.discover(cfg.issuer);
    this.log.log({ provider, issuer: issuer.metadata.issuer }, 'oidc_client_ready');
    return new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [this.redirectUri(provider)],
      response_types: ['code'],
    });
  }

  async start(params: OidcStartParams): Promise<OidcStartResult> {
    const client = await this.client(params.provider);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const providerCfg = this.cfg.config.providers[params.provider]!;

    const scopes = ['openid', 'email', 'profile', ...(providerCfg.extraScopes ?? [])];

    const url = client.authorizationUrl({
      scope: scopes.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(providerCfg.hostedDomainHint ? { hd: providerCfg.hostedDomainHint } : {}),
      ...(params.tenantHint ? { login_hint: params.tenantHint } : {}),
    });

    return { url, state, codeVerifier, nonce };
  }

  async callback(params: OidcCallbackParams): Promise<OidcUserInfo> {
    const client = await this.client(params.provider);
    let tokens;
    try {
      tokens = await client.callback(
        this.redirectUri(params.provider),
        { code: params.code, state: params.state },
        { state: params.expectedState, nonce: params.expectedNonce, code_verifier: params.codeVerifier },
      );
    } catch (err) {
      this.log.warn({ err: String(err), provider: params.provider }, 'oidc_callback_failed');
      throw new UnauthorizedException('oidc_exchange_failed');
    }

    const claims = tokens.claims();
    if (!claims.email) throw new UnauthorizedException('oidc_missing_email');
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
      email: String(claims.email).toLowerCase().trim(),
      firstName: (claims['given_name']) ?? null,
      lastName: (claims['family_name']) ?? null,
      displayName: (claims['name']) ?? null,
      emailVerified: claims['email_verified'] === true,
      hd,
      iss: typeof claims.iss === 'string' && claims.iss.length > 0 ? claims.iss : null,
    };
  }
}
