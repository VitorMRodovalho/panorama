import { Injectable, Logger } from '@nestjs/common';

/**
 * Auth-related configuration derived from env. Read once at boot so the
 * rest of the module doesn't keep poking process.env.
 */

export interface OidcProviderConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  /** Extra scopes beyond `openid email profile`. */
  extraScopes?: string[];
  /** For Google Workspace / Microsoft Entra single-tenant hints. */
  hostedDomainHint?: string;
  /**
   * Google Workspace `hd` claim values (lowercased domains) we trust to
   * stand in for `email_verified=true`. Workspace admins prove domain
   * ownership out-of-band, so the IdP issuing an `hd` claim is itself
   * the verification signal — independent of the per-account
   * `email_verified` flag, which Workspace doesn't always set.
   *
   * Empty (default) means the gate is strict: any login with
   * `email_verified !== true` is refused. Only meaningful for the
   * `google` provider; ignored elsewhere.
   */
  trustedHdDomains?: string[];
}

export interface AuthConfig {
  sessionSecret: string;
  sessionCookieName: string;
  oauthStateCookieName: string;
  sessionMaxAgeSeconds: number;
  oauthStateMaxAgeSeconds: number;
  /** Panorama's public base URL for computing OIDC redirect_uri. */
  baseUrl: string;
  isProduction: boolean;
  providers: {
    google?: OidcProviderConfig;
    microsoft?: OidcProviderConfig;
  };
}

@Injectable()
export class AuthConfigService {
  private readonly log = new Logger('AuthConfig');
  readonly config: AuthConfig;

  constructor() {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const isProduction = nodeEnv === 'production';

    const sessionSecret = process.env.SESSION_SECRET ?? '';
    if (sessionSecret.length < 32) {
      const msg =
        'SESSION_SECRET must be at least 32 characters. Generate with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"`';
      if (isProduction) throw new Error(msg);
      this.log.warn({ secretLength: sessionSecret.length }, msg);
    }

    const providers: AuthConfig['providers'] = {};
    if (process.env.OIDC_GOOGLE_CLIENT_ID) {
      const google: OidcProviderConfig = {
        clientId: process.env.OIDC_GOOGLE_CLIENT_ID,
        clientSecret: process.env.OIDC_GOOGLE_CLIENT_SECRET ?? '',
        issuer: 'https://accounts.google.com',
        extraScopes: [],
      };
      if (process.env.OIDC_GOOGLE_HOSTED_DOMAIN) {
        google.hostedDomainHint = process.env.OIDC_GOOGLE_HOSTED_DOMAIN;
      }
      const trusted = parseDomainList(process.env.OIDC_GOOGLE_TRUSTED_HD_DOMAINS);
      if (trusted.length > 0) {
        google.trustedHdDomains = trusted;
      }
      providers.google = google;
    }
    if (process.env.OIDC_MICROSOFT_CLIENT_ID) {
      providers.microsoft = {
        clientId: process.env.OIDC_MICROSOFT_CLIENT_ID,
        clientSecret: process.env.OIDC_MICROSOFT_CLIENT_SECRET ?? '',
        issuer: `https://login.microsoftonline.com/${
          process.env.OIDC_MICROSOFT_TENANT ?? 'common'
        }/v2.0`,
        extraScopes: [],
      };
    }

    this.config = {
      sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-replace-me-32b',
      sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'panorama_session',
      oauthStateCookieName: process.env.OAUTH_STATE_COOKIE_NAME ?? 'panorama_oauth',
      sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 7), // 7d
      oauthStateMaxAgeSeconds: 5 * 60, // 5 min
      baseUrl: (process.env.APP_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
      isProduction,
      providers,
    };
  }

  /**
   * Is a given provider configured?
   */
  hasProvider(name: 'google' | 'microsoft'): boolean {
    return !!this.config.providers[name]?.clientId;
  }
}

function parseDomainList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}
