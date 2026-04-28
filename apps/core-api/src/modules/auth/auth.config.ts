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
  /**
   * Trusted scheme://host origins for the CSRF Origin/Referer gate
   * (SEC-02 / #34). Lowercased and deduplicated. Always includes
   * `baseUrl` so a single-origin deploy works with no extra config;
   * `WEB_ORIGIN` adds split-origin entries (e.g. when web and api
   * live on different hosts).
   */
  csrf: {
    trustedOrigins: ReadonlySet<string>;
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
      // Throw in EVERY environment, not just production. The previous
      // dev-only fallback (`'dev-only-insecure-session-secret-replace-me-32b'`)
      // turned into deterministic session forgery on any non-production
      // environment carrying real tenant data — staging, UAT, even CI
      // when NODE_ENV happened to differ from "production". SEC-03 / #35.
      throw new Error(
        'SESSION_SECRET must be at least 32 characters. Generate with ' +
          '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"`',
      );
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
      const trusted = parseDomainList(
        process.env.OIDC_GOOGLE_TRUSTED_HD_DOMAINS,
        this.log,
      );
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

    const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:4000')
      .replace(/\/+$/, '')
      .toLowerCase();
    const csrfOrigins = new Set<string>([baseUrl]);
    for (const o of parseOriginList(process.env.WEB_ORIGIN)) {
      csrfOrigins.add(o);
    }

    this.config = {
      sessionSecret,
      sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'panorama_session',
      oauthStateCookieName: process.env.OAUTH_STATE_COOKIE_NAME ?? 'panorama_oauth',
      sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 7), // 7d
      oauthStateMaxAgeSeconds: 5 * 60, // 5 min
      baseUrl,
      isProduction,
      providers,
      csrf: { trustedOrigins: csrfOrigins },
    };
  }

  /**
   * Is a given provider configured?
   */
  hasProvider(name: 'google' | 'microsoft'): boolean {
    return !!this.config.providers[name]?.clientId;
  }
}

/**
 * DNS label syntax (RFC 1035 letter/digit/hyphen rules) — anchors
 * forbid wildcards, paths, ports, double dots, leading/trailing
 * hyphens. Permits multi-label domains (`acme.example`,
 * `foo.bar.example.com`) and IDN A-labels (`xn--tnq.xn--p1ai`),
 * which is correct because Workspace `hd` claims arrive in
 * punycode form.
 *
 * The regex alone does NOT reject all-digit labels: `127.0.0.1`
 * matches the multi-label shape. The companion `/[a-z]/` check
 * in `parseDomainList` excludes IP-literals while keeping mixed
 * digit/letter labels (`1foo.bar`).
 */
const DNS_LABEL_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Parse a comma-separated DNS-domain list (e.g.
 * `OIDC_GOOGLE_TRUSTED_HD_DOMAINS`). Lowercased + trimmed +
 * deduplicated. Entries that don't match `DNS_LABEL_RE` are
 * filtered out and logged at warn level (#89 / follow-up #28).
 *
 * Silent fail-closed for malformed entries was the prior behaviour
 * — correct direction (refuse logins) but the wrong signal
 * (operator chases the IdP side instead of finding a typo in their
 * env var). Logging at warn lets the boot trace surface the typo.
 *
 * Logger arg is optional so tests / callers without a logger can
 * still use the parser; in production the AuthConfigService
 * passes `this.log` so the warnings land in pino.
 */
function parseDomainList(raw: string | undefined, log?: Logger): string[] {
  if (!raw) return [];
  const accepted: string[] = [];
  for (const part of raw.split(',')) {
    const candidate = part.trim().toLowerCase();
    if (candidate.length === 0) continue;
    // DNS_LABEL_RE alone admits all-digit labels (e.g. `127.0.0.1` matches
    // the multi-label shape), so we require at least one letter to
    // reject IP literals while still accepting `acme.example` /
    // `1foo.bar`-style shapes.
    if (!DNS_LABEL_RE.test(candidate) || !/[a-z]/.test(candidate)) {
      log?.warn(
        { entry: candidate, source: 'OIDC_GOOGLE_TRUSTED_HD_DOMAINS' },
        'auth_config_invalid_domain_entry_ignored',
      );
      continue;
    }
    accepted.push(candidate);
  }
  return accepted;
}

/**
 * Parse `WEB_ORIGIN` (comma-separated scheme://host list). Lowercased,
 * trailing-slash-stripped, deduplicated. Mirrors `parseDomainList`'s
 * shape so the codebase stays consistent on env-list parsing.
 */
function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
}
