import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfigService } from './auth.config.js';
import type { OidcUserInfo } from './oidc.service.js';
import { PasswordService } from './password.service.js';
import type { PanoramaSession, PanoramaSessionMembership } from './session.types.js';

const GOOGLE_ISSUER = 'https://accounts.google.com';

type OidcGateOutcome =
  | { ok: true; viaHdOverride: boolean }
  | {
      ok: false;
      reason:
        | 'email_not_verified'
        | 'hd_not_allowlisted'
        | 'hd_iss_mismatch'
        | 'hd_email_mismatch';
    };

export interface LoginOutcome {
  session: PanoramaSession;
  passwordNeedsRehash: boolean;
}

/**
 * Orchestrates authentication: verify credentials, resolve memberships,
 * build the SessionPayload that goes into the cookie.
 *
 * Cross-cutting concerns kept here (not in the controller) so OIDC
 * callbacks reuse the same `establishSession()` helper without
 * re-implementing membership hydration.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly cfg: AuthConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Email+password login. Never discloses whether the email exists:
   * every failure path throws the same UnauthorizedException.
   */
  async loginWithPassword(rawEmail: string, password: string): Promise<LoginOutcome> {
    const email = rawEmail.toLowerCase().trim();
    if (!email || !password) throw new UnauthorizedException('invalid_credentials');

    const { identity, user } = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const id = await tx.authIdentity.findUnique({
          where: { provider_subject: { provider: 'password', subject: email } },
          include: { user: true },
        });
        return { identity: id, user: id?.user ?? null };
      },
      { reason: 'password login identity lookup' },
    );

    const ok = identity && user ? await this.passwords.verify(identity.secretHash, password) : false;
    if (!identity || !user || !ok) {
      // Constant-ish work — still run a verify against a throwaway hash
      // when the identity didn't exist, to blunt email-enumeration timing.
      if (!identity) {
        await this.passwords.verify(
          '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
            '/ZC8l9ckA3dPnYcXVT4E+sLFXLyOF7QkePE0a4Tj8S8',
          password,
        );
      }
      throw new UnauthorizedException('invalid_credentials');
    }

    const needsRehash = this.passwords.needsRehash(identity.secretHash ?? '');
    const session = await this.buildSessionForUser(user.id, 'password');

    await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.authIdentity.update({
          where: { id: identity.id },
          data: { lastUsedAt: new Date() },
        }),
      { reason: 'password login lastUsedAt' },
    );

    return { session, passwordNeedsRehash: needsRehash };
  }

  /**
   * Find-or-create a User by OIDC subject + provider, then establish a
   * session. Memberships are resolved to whatever the user already has;
   * just-in-time tenant assignment by email domain lands in a later step
   * (0.3) together with the invitation UI.
   *
   * Refuses login when the IdP did not assert `email_verified=true`
   * (SEC-01 / #28). One narrow exception: a Google Workspace `hd`
   * claim that matches `OIDC_GOOGLE_TRUSTED_HD_DOMAINS` AND the
   * email's own domain AND the actual Google issuer — Workspace admin
   * verification stands in for the per-account verified bit, which
   * Google Workspace doesn't always set.
   *
   * Under the hd-override path, the legacy "link this OIDC identity to
   * a pre-existing User with the same email" branch is refused: the
   * Workspace admin proved domain ownership, not control of an
   * already-existing local account. Linking would let an attacker who
   * controls a Workspace tenant for `acme.example` graft a Google
   * identity onto a victim's prior password-account at the same email.
   */
  async loginWithOidc(
    provider: 'google' | 'microsoft',
    userInfo: OidcUserInfo,
    context: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<PanoramaSession> {
    const email = userInfo.email.toLowerCase().trim();
    const gate = this.evaluateOidcGate(provider, userInfo, email);
    if (!gate.ok) {
      await this.recordOidcRefusal(provider, userInfo, email, gate.reason, context);
      this.log.warn(
        {
          provider,
          reason: gate.reason,
          subjectHash: hashSubject(provider, userInfo.subject),
          emailDomain: emailDomain(email),
          hd: userInfo.hd,
        },
        'oidc_login_refused',
      );
      throw new UnauthorizedException(gate.reason);
    }

    const allowEmailLink = !gate.viaHdOverride;
    const displayName =
      userInfo.displayName?.trim() ||
      [userInfo.firstName, userInfo.lastName].filter(Boolean).join(' ').trim() ||
      email;

    // Sentinel pattern (`{ kind: 'ok' | 'refused' }`) instead of throwing
    // inside the closure: the audit row for a refusal must commit in
    // its own transaction (recordOidcRefusal -> AuditService.record),
    // not interleave with this find-or-create. Throwing inside
    // runAsSuperAdmin would either roll the audit back with the
    // refusal or split the refusal across two contexts. Returning a
    // sentinel keeps the gate decision contiguous and the audit
    // emission happens exactly once, after the closure has cleanly
    // exited with no writes.
    //
    // `pathTaken` captures which of the three resolution branches
    // fired — the post-success audit (#91) carries it so tenant
    // admins can see whether a Workspace-override login linked to an
    // existing identity, linked by email, or created a new user.
    const resolution = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        // Subject is IdP-unique; use it as the strongest key.
        const existing = await tx.authIdentity.findUnique({
          where: { provider_subject: { provider, subject: userInfo.subject } },
        });
        if (existing) {
          await tx.authIdentity.update({
            where: { id: existing.id },
            data: { lastUsedAt: new Date(), emailAtLink: email },
          });
          return {
            kind: 'ok' as const,
            userId: existing.userId,
            pathTaken: 'existing_identity' as const,
          };
        }

        // Second chance: link this OIDC identity to an existing User with
        // the same email. Refused under the hd-override path: the
        // Workspace admin proved domain ownership, not control of an
        // already-existing local account; linking would graft this OIDC
        // identity onto whatever (password, prior OIDC) account had
        // claimed the email first.
        const byEmail = await tx.user.findUnique({ where: { email } });
        if (byEmail) {
          if (!allowEmailLink) {
            return { kind: 'refused' as const };
          }
          await tx.authIdentity.create({
            data: {
              userId: byEmail.id,
              provider,
              subject: userInfo.subject,
              emailAtLink: email,
              lastUsedAt: new Date(),
            },
          });
          return {
            kind: 'ok' as const,
            userId: byEmail.id,
            pathTaken: 'email_link' as const,
          };
        }

        // Brand new — create the global User + the OIDC identity linking it.
        const created = await tx.user.create({
          data: {
            email,
            displayName,
            firstName: userInfo.firstName ?? null,
            lastName: userInfo.lastName ?? null,
          },
        });
        await tx.authIdentity.create({
          data: {
            userId: created.id,
            provider,
            subject: userInfo.subject,
            emailAtLink: email,
            lastUsedAt: new Date(),
          },
        });
        return {
          kind: 'ok' as const,
          userId: created.id,
          pathTaken: 'new_user' as const,
        };
      },
      { reason: 'oidc find-or-create' },
    );

    if (resolution.kind === 'refused') {
      const reason = 'oidc_account_link_requires_verified_email' as const;
      await this.recordOidcRefusal(provider, userInfo, email, reason, context);
      this.log.warn(
        {
          provider,
          reason,
          subjectHash: hashSubject(provider, userInfo.subject),
          emailDomain: emailDomain(email),
          hd: userInfo.hd,
        },
        'oidc_login_refused_account_link',
      );
      throw new UnauthorizedException(reason);
    }

    // #91 — symmetric success-path audit. Tenant admins want to see
    // who actually authenticated via the trusted-`hd` override path,
    // not just who got refused. The audit row commits in its own
    // tx after the identity tx already committed, so a crash between
    // the two leaves the identity write without an audit row — the
    // dispatcher's eventual DEAD-letter audit + the
    // `oidc_login_audit_write_failed` log are the operator-visible
    // backstops.
    await this.recordOidcLogin(
      provider,
      userInfo,
      email,
      resolution.userId,
      resolution.pathTaken,
      gate.viaHdOverride,
      context,
    );

    return this.buildSessionForUser(resolution.userId, provider);
  }

  private evaluateOidcGate(
    provider: 'google' | 'microsoft',
    userInfo: OidcUserInfo,
    normalisedEmail: string,
  ): OidcGateOutcome {
    if (userInfo.emailVerified) return { ok: true, viaHdOverride: false };

    if (provider !== 'google' || !userInfo.hd) {
      return { ok: false, reason: 'email_not_verified' };
    }
    const trusted = this.cfg.config.providers.google?.trustedHdDomains ?? [];
    if (trusted.length === 0) {
      return { ok: false, reason: 'email_not_verified' };
    }
    const hd = userInfo.hd.toLowerCase();
    if (!trusted.includes(hd)) {
      return { ok: false, reason: 'hd_not_allowlisted' };
    }
    if (userInfo.iss !== GOOGLE_ISSUER) {
      // Defence-in-depth against a misconfigured provider entry whose
      // `provider` slot says "google" but discovers a different issuer.
      return { ok: false, reason: 'hd_iss_mismatch' };
    }
    if (!normalisedEmail.endsWith(`@${hd}`)) {
      return { ok: false, reason: 'hd_email_mismatch' };
    }
    return { ok: true, viaHdOverride: true };
  }

  private async recordOidcRefusal(
    provider: 'google' | 'microsoft',
    userInfo: OidcUserInfo,
    normalisedEmail: string,
    reason:
      | 'email_not_verified'
      | 'hd_not_allowlisted'
      | 'hd_iss_mismatch'
      | 'hd_email_mismatch'
      | 'oidc_account_link_requires_verified_email',
    context: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<void> {
    // `record()` (its own transaction) rather than `recordWithin(tx)`:
    // refusal writes nothing else, so there is no domain row to
    // commit-with. The audit-co-transaction rule applies to state
    // transitions on tenant data, not to pre-tenant cluster events.
    try {
      await this.audit.record({
        action: PanoramaAuditAction.AuthOidcRefused,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        metadata: {
          provider,
          reason,
          emailDomain: emailDomain(normalisedEmail),
          hd: userInfo.hd,
          subjectHash: hashSubject(provider, userInfo.subject),
          iss: userInfo.iss,
        },
      });
    } catch (err) {
      // Audit-log failure must not mask the auth refusal — the throw
      // happens immediately after this call. Log loudly so the gap is
      // detectable.
      this.log.error({ err: String(err) }, 'oidc_refusal_audit_write_failed');
    }
  }

  /**
   * #91 — symmetric success-path audit for OIDC logins. Same shape
   * as `recordOidcRefusal` (cluster-wide, own-transaction, audit-
   * write failure does not block the auth chain) so the two surfaces
   * read consistently in the audit log.
   *
   * `actorUserId` is populated post-resolution because we know the
   * userId at this point — the refusal sibling can't because the
   * refusal happens BEFORE user resolution.
   */
  private async recordOidcLogin(
    provider: 'google' | 'microsoft',
    userInfo: OidcUserInfo,
    normalisedEmail: string,
    userId: string,
    pathTaken: 'existing_identity' | 'email_link' | 'new_user',
    viaHdOverride: boolean,
    context: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<void> {
    try {
      await this.audit.record({
        action: PanoramaAuditAction.AuthOidcLogin,
        resourceType: 'auth_identity',
        resourceId: null,
        tenantId: null,
        actorUserId: userId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        metadata: {
          provider,
          pathTaken,
          viaHdOverride,
          emailDomain: emailDomain(normalisedEmail),
          hd: userInfo.hd,
          subjectHash: hashSubject(provider, userInfo.subject),
          iss: userInfo.iss,
        },
      });
    } catch (err) {
      // Symmetric to refusal handling: audit-log failure logs error
      // but does not block the auth flow — the user-create / identity-
      // link writes already committed in the prior runAsSuperAdmin tx.
      this.log.error({ err: String(err) }, 'oidc_login_audit_write_failed');
    }
  }

  /**
   * Build a PanoramaSession from a userId. Fails if the user has no
   * active memberships — auth without a tenant isn't useful in Panorama
   * and prevents later code paths from handling a null tenantId.
   */
  async buildSessionForUser(userId: string, provider: string): Promise<PanoramaSession> {
    const result = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) return null;
        const memberships = await tx.tenantMembership.findMany({
          where: { userId, status: 'active' },
          include: { tenant: true },
          orderBy: { createdAt: 'asc' },
        });
        return { user, memberships };
      },
      { reason: 'session build' },
    );

    if (!result || !result.user) throw new UnauthorizedException('user_not_found');
    if (result.memberships.length === 0) {
      // An account with no active tenant is effectively a pending invitation
      // state. We refuse the session; the web layer should surface a
      // "waiting for an admin to invite you" view.
      throw new UnauthorizedException('no_tenant_memberships');
    }

    const shaped: PanoramaSessionMembership[] = result.memberships.map((m) => ({
      tenantId: m.tenantId,
      tenantSlug: m.tenant.slug,
      tenantDisplayName: m.tenant.displayName,
      tenantLocale: m.tenant.locale,
      role: m.role,
      isVip: m.isVip,
    }));
    const primary = shaped[0]!;

    return {
      userId: result.user.id,
      email: result.user.email,
      displayName: result.user.displayName,
      currentTenantId: primary.tenantId,
      currentRole: primary.role,
      isVip: primary.isVip,
      memberships: shaped,
      issuedAt: Math.floor(Date.now() / 1000),
      provider,
    };
  }

  /**
   * Rehash a password identity using current parameters. Idempotent.
   */
  async rehashPassword(email: string, plaintext: string): Promise<void> {
    const newHash = await this.passwords.hash(plaintext);
    await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.authIdentity.updateMany({
          where: { provider: 'password', subject: email.toLowerCase().trim() },
          data: { secretHash: newHash },
        }),
      { reason: 'password rehash' },
    );
  }

  /**
   * Switch the current session to a different tenant the user is a member of.
   * Refuses if the user is not a member or the membership isn't active.
   */
  switchTenant(current: PanoramaSession, tenantId: string): PanoramaSession {
    const match = current.memberships.find((m) => m.tenantId === tenantId);
    if (!match) {
      throw new UnauthorizedException('not_a_member_of_this_tenant');
    }
    return {
      ...current,
      currentTenantId: match.tenantId,
      currentRole: match.role,
      isVip: match.isVip,
      issuedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Admin helper — seed a password identity for an existing user. Used by
   * the seed script and dev tooling. Refuses to silently overwrite an
   * existing hash unless `overwrite: true`.
   */
  async setPasswordForUser(
    userId: string,
    plaintext: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<void> {
    const hash = await this.passwords.hash(plaintext);
    await this.prisma.runAsSuperAdmin(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error(`user ${userId} not found`);
      const existing = await tx.authIdentity.findUnique({
        where: { provider_subject: { provider: 'password', subject: user.email } },
      });
      if (existing && !opts.overwrite) {
        throw new Error('password already set for this user (use { overwrite: true })');
      }
      if (existing) {
        await tx.authIdentity.update({
          where: { id: existing.id },
          data: { secretHash: hash, emailAtLink: user.email, lastUsedAt: new Date() },
        });
      } else {
        const data: Prisma.AuthIdentityUncheckedCreateInput = {
          userId,
          provider: 'password',
          subject: user.email,
          emailAtLink: user.email,
          secretHash: hash,
        };
        await tx.authIdentity.create({ data });
      }
    }, { reason: 'setPasswordForUser' });
  }
}

function hashSubject(provider: string, subject: string): string {
  // Truncated SHA-256 — enough entropy to correlate refusals across
  // log lines without exposing the IdP-stable user ID itself.
  return createHash('sha256').update(`${provider}:${subject}`).digest('hex').slice(0, 16);
}

function emailDomain(normalisedEmail: string): string | null {
  const at = normalisedEmail.lastIndexOf('@');
  if (at < 0 || at === normalisedEmail.length - 1) return null;
  return normalisedEmail.slice(at + 1);
}
