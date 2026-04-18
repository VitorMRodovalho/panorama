import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfigService } from './auth.config.js';

export interface DiscoveryResult {
  /** Providers the caller should see, in display order. */
  providers: Array<'password' | 'google' | 'microsoft'>;
  /** If the email's domain is claimed by exactly one tenant, the tenant's
   * displayName is returned here so the UI can show "You'll sign in to Acme". */
  tenantHint: { id: string; slug: string; displayName: string } | null;
}

/**
 * Home-Realm Discovery: given an email, decide which auth providers to
 * offer. The logic prefers specificity:
 *
 *   1. If a tenant claims the email's domain AND that tenant has an
 *      OIDC provider wired (enterprise feature in a later release), we
 *      route straight to that provider.
 *   2. If Google OIDC is configured AND the domain looks like a Google
 *      Workspace (`hd` hint present or `@gmail.com`), offer google.
 *   3. If Microsoft OIDC is configured AND the domain is `@outlook.com`
 *      / `@hotmail.com` / `@live.com` / any non-gmail, offer microsoft.
 *   4. Always offer `password` as fallback unless the tenant has
 *      disabled it (feature flag lands in 0.3).
 *
 * The endpoint never reveals whether an email exists — callers should
 * see the same shape regardless.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AuthConfigService,
  ) {}

  async discover(email: string): Promise<DiscoveryResult> {
    const normalized = email.toLowerCase().trim();
    const domain = normalized.includes('@') ? normalized.split('@')[1] ?? '' : '';

    // Tenant domain match — super-admin scope since tenants table needs RLS bypass.
    let tenantHint: DiscoveryResult['tenantHint'] = null;
    if (domain) {
      const tenants = await this.prisma.runAsSuperAdmin(
        (tx) =>
          tx.tenant.findMany({
            where: { allowedEmailDomains: { has: domain } },
            select: { id: true, slug: true, displayName: true },
            take: 2,
          }),
        { reason: 'auth discovery' },
      );
      if (tenants.length === 1) {
        tenantHint = tenants[0] ?? null;
      }
    }

    const providers: DiscoveryResult['providers'] = [];

    // Corporate: if a tenant claims the domain, we'd prefer their wired
    // IdP here (deferred to enterprise — today we just offer whatever
    // global OIDC providers exist).
    if (this.cfg.hasProvider('google') && looksLikeGoogleDomain(domain)) {
      providers.push('google');
    }
    if (this.cfg.hasProvider('microsoft') && looksLikeMicrosoftDomain(domain)) {
      providers.push('microsoft');
    }
    // Both IdPs support any email domain via Workspace / Entra federation;
    // if neither heuristic matched, still surface any configured provider
    // so small-org users can self-serve with their account of choice.
    if (!providers.length) {
      if (this.cfg.hasProvider('google')) providers.push('google');
      if (this.cfg.hasProvider('microsoft')) providers.push('microsoft');
    }
    providers.push('password');

    return { providers, tenantHint };
  }
}

function looksLikeGoogleDomain(domain: string): boolean {
  return domain === 'gmail.com' || domain === 'googlemail.com';
}

function looksLikeMicrosoftDomain(domain: string): boolean {
  return (
    domain === 'outlook.com' ||
    domain === 'hotmail.com' ||
    domain === 'live.com' ||
    domain === 'msn.com'
  );
}
