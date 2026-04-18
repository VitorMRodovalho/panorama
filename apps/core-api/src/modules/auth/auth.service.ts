import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import type { PanoramaSession, PanoramaSessionMembership } from './session.types.js';

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
   */
  async loginWithOidc(params: {
    provider: 'google' | 'microsoft';
    subject: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
  }): Promise<PanoramaSession> {
    const email = params.email.toLowerCase().trim();
    const displayName =
      params.displayName?.trim() ||
      [params.firstName, params.lastName].filter(Boolean).join(' ').trim() ||
      email;

    const userId = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        // Subject is IdP-unique; use it as the strongest key.
        const existing = await tx.authIdentity.findUnique({
          where: { provider_subject: { provider: params.provider, subject: params.subject } },
        });
        if (existing) {
          await tx.authIdentity.update({
            where: { id: existing.id },
            data: { lastUsedAt: new Date(), emailAtLink: email },
          });
          return existing.userId;
        }

        // Second chance: link this OIDC identity to an existing User with the same email.
        const byEmail = await tx.user.findUnique({ where: { email } });
        if (byEmail) {
          await tx.authIdentity.create({
            data: {
              userId: byEmail.id,
              provider: params.provider,
              subject: params.subject,
              emailAtLink: email,
              lastUsedAt: new Date(),
            },
          });
          return byEmail.id;
        }

        // Brand new — create the global User + the OIDC identity linking it.
        const created = await tx.user.create({
          data: {
            email,
            displayName,
            firstName: params.firstName ?? null,
            lastName: params.lastName ?? null,
          },
        });
        await tx.authIdentity.create({
          data: {
            userId: created.id,
            provider: params.provider,
            subject: params.subject,
            emailAtLink: email,
            lastUsedAt: new Date(),
          },
        });
        return created.id;
      },
      { reason: 'oidc find-or-create' },
    );

    return this.buildSessionForUser(userId, params.provider);
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
