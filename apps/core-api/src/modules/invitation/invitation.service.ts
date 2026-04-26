import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimiter, type RateLimitDecision } from '../redis/rate-limiter.js';
import { InvitationConfigService } from './invitation.config.js';
import { INVITATION_QUEUE, type InvitationQueuePort } from './invitation.queue.js';

/**
 * Invitation domain service (ADR-0008).
 *
 * End-to-end responsibilities:
 *   * Admin creates an invitation for an email + role in a tenant
 *   * Service validates role, TTL, per-admin / per-tenant rate limits
 *   * Service generates a 256-bit random token, stores its sha256, and
 *     hands the plaintext back ONCE so the email worker can inline it
 *     into the acceptance URL
 *   * Partial unique index guarantees at most one OPEN invitation per
 *     (tenant, email) — service surfaces the collision as 409
 *   * All state transitions (create / resend / revoke / accept / expire)
 *     emit `panorama.invitation.*` audit events
 *
 * Important invariants:
 *   * Plaintext tokens never touch the DB.
 *   * Audit writes share the transaction with their domain write — we
 *     either persist both or neither.
 *   * Rate limiting fails CLOSED: if Redis is unreachable, creation is
 *     refused with 503. A temporary cap to zero beats an uncapped blast.
 */

export interface InvitationCreatedView {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  expiresAt: Date;
  /** Full URL with the plaintext token — surfaced ONCE on create/resend. */
  acceptUrl: string;
  /** Plaintext token; never persisted. Returned so the admin UI can copy it. */
  token: string;
}

export interface InvitationListItemView {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  emailQueuedAt: Date | null;
  emailSentAt: Date | null;
  emailBouncedAt: Date | null;
  emailLastError: string | null;
  invitedByUserId: string;
}

export type InvitationStatus = 'open' | 'accepted' | 'revoked' | 'expired';

export type AcceptancePreview =
  | {
      state: 'ready';
      invitationId: string;
      tenantId: string;
      tenantDisplayName: string;
      email: string;
      role: string;
      inviterDisplayName: string;
      expiresAt: Date;
    }
  | { state: 'needs_login'; email: string; tenantDisplayName: string; inviterDisplayName: string }
  | {
      state: 'email_mismatch';
      invitationEmail: string;
      sessionEmail: string;
      tenantDisplayName: string;
    }
  | { state: 'invalid'; reason: 'not_found' | 'expired' | 'revoked' | 'already_accepted' };

export type AcceptanceResult =
  | {
      state: 'accepted';
      invitationId: string;
      tenantId: string;
      membershipId: string;
      role: string;
    }
  | {
      state: 'email_mismatch';
      invitationEmail: string;
      sessionEmail: string;
    }
  | {
      state: 'invalid';
      reason: 'not_found' | 'expired' | 'revoked' | 'already_accepted';
    }
  | { state: 'needs_login'; email: string };

export interface CreateInvitationParams {
  tenantId: string;
  email: string;
  role: string;
  ttlSeconds?: number;
  actorUserId: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}

export interface ResendInvitationParams {
  invitationId: string;
  tenantId: string;
  actorUserId: string;
}

export interface RevokeInvitationParams {
  invitationId: string;
  tenantId: string;
  actorUserId: string;
}

export interface FinalizeAcceptParams {
  token: string;
  sessionUserId: string;
  sessionEmail: string;
}

export interface ListInvitationsParams {
  tenantId: string;
  status?: InvitationStatus | 'all';
  limit?: number;
}

@Injectable()
export class InvitationService {
  private readonly log = new Logger('InvitationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
    private readonly cfg: InvitationConfigService,
    @Inject(INVITATION_QUEUE) private readonly queue: InvitationQueuePort,
  ) {}

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  async create(params: CreateInvitationParams): Promise<InvitationCreatedView> {
    const role = params.role.trim();
    if (!this.cfg.allowedRoles.includes(role)) {
      throw new BadRequestException(`invalid_role:${role}`);
    }

    // Rate limits: fail closed if Redis is unavailable.
    const adminKey = `inv:admin:${params.actorUserId}:hour`;
    const tenantKey = `inv:tenant:${params.tenantId}:day`;
    const adminDecision = await this.rateLimiter.consume(
      adminKey,
      this.cfg.adminHourlyLimit,
      this.cfg.adminWindowMs,
    );
    this.rejectIfLimited(adminDecision, 'admin_hourly');
    const tenantDecision = await this.rateLimiter.consume(
      tenantKey,
      this.cfg.tenantDailyLimit,
      this.cfg.tenantWindowMs,
    );
    if (!tenantDecision.allowed) {
      // Give back the admin slot we just consumed so the admin isn't
      // double-taxed for a tenant-level cap.
      await this.rateLimiter.release(adminKey, this.cfg.adminHourlyLimit, this.cfg.adminWindowMs);
      this.rejectIfLimited(tenantDecision, 'tenant_daily');
    }

    const ttl = this.resolveTtl(params.ttlSeconds);
    const normalizedEmail = params.email.toLowerCase().trim();

    try {
      const result = await this.prisma.runInTenant(
        params.tenantId,
        async (tx) => {
          const tenant = await tx.tenant.findUnique({
            where: { id: params.tenantId },
            select: {
              id: true,
              slug: true,
              displayName: true,
              invitationTtlSeconds: true,
            },
          });
          if (!tenant) throw new NotFoundException('tenant_not_found');

          const finalTtl = params.ttlSeconds ? ttl : tenant.invitationTtlSeconds;
          if (finalTtl < this.cfg.minTtlSeconds || finalTtl > this.cfg.maxTtlSeconds) {
            throw new BadRequestException(
              `ttl_out_of_bounds:${this.cfg.minTtlSeconds}..${this.cfg.maxTtlSeconds}`,
            );
          }
          const expiresAt = new Date(Date.now() + finalTtl * 1000);

          // Open-invitation pre-check. The DB has a partial unique
          // index `invitations_one_open_per_tenant_email` with the
          // predicate `acceptedAt IS NULL AND revokedAt IS NULL`
          // (no expiry clause — expired-but-not-swept rows still
          // occupy the slot until the hourly sweep runs). Under
          // runInTenant + FORCE RLS Prisma's P2002 error loses the
          // constraint name (`meta.target = '(not available)'`),
          // so the post-fail catch can't translate the violation
          // to a clean 409. Explicit pre-check makes the conflict
          // detection deterministic. The predicate must match the
          // index EXACTLY — including the absence of the expiry
          // clause — so an expired row also surfaces as 409, not 500.
          // There remains a millisecond-race window where two
          // concurrent creates both pass the pre-check and the
          // second one's INSERT raises P2002 — that path is still
          // translated by isOpenInvitationCollision.
          const openMatch = await tx.invitation.findFirst({
            where: {
              tenantId: tenant.id,
              email: normalizedEmail,
              acceptedAt: null,
              revokedAt: null,
            },
            select: { id: true },
          });
          if (openMatch) {
            throw new ConflictException('open_invitation_exists');
          }

          const targetUser = await tx.user.findUnique({
            where: { email: normalizedEmail },
            select: { id: true },
          });

          const { plaintext, tokenHash } = this.generateToken();
          const now = new Date();

          const created = await tx.invitation.create({
            data: {
              tenantId: tenant.id,
              email: normalizedEmail,
              role,
              tokenHash,
              ...(targetUser ? { targetUserId: targetUser.id } : {}),
              invitedByUserId: params.actorUserId,
              expiresAt,
              emailQueuedAt: now,
            },
          });

          await this.audit.recordWithin(tx, {
            action: 'panorama.invitation.created',
            resourceType: 'invitation',
            resourceId: created.id,
            tenantId: tenant.id,
            actorUserId: params.actorUserId,
            ipAddress: params.actorIp ?? null,
            userAgent: params.actorUserAgent ?? null,
            metadata: {
              email: normalizedEmail,
              role,
              expiresAt: expiresAt.toISOString(),
              ttlSeconds: finalTtl,
            },
          });

          return { created, plaintext, tenant };
        },
      );

      // Post-commit enqueue. Plaintext token travels in the payload —
      // see InvitationQueuePort for the trust-zone rationale. A lost
      // enqueue is fine: the maintenance cron rescues invitations
      // where emailQueuedAt is set but the email was never sent by
      // rotating the token + re-enqueuing.
      this.queue
        .enqueueDelivery(result.created.id, result.created.tenantId, result.plaintext)
        .catch((err: unknown) => {
          this.log.warn(
            { invitationId: result.created.id, err: String(err) },
            'enqueue_delivery_failed',
          );
        });

      return {
        id: result.created.id,
        tenantId: result.created.tenantId,
        email: result.created.email,
        role: result.created.role,
        expiresAt: result.created.expiresAt,
        token: result.plaintext,
        acceptUrl: this.buildAcceptUrl(result.plaintext),
      };
    } catch (err) {
      if (this.isOpenInvitationCollision(err)) {
        throw new ConflictException('open_invitation_exists');
      }
      // Refund rate limit slots on DB failure so a transient blip
      // doesn't burn quota for nothing.
      await this.rateLimiter.release(adminKey, this.cfg.adminHourlyLimit, this.cfg.adminWindowMs);
      await this.rateLimiter.release(tenantKey, this.cfg.tenantDailyLimit, this.cfg.tenantWindowMs);
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Resend — rotate token, reset email state, re-emit
  // ---------------------------------------------------------------------

  async resend(params: ResendInvitationParams): Promise<InvitationCreatedView> {
    const result = await this.prisma.runInTenant(
      params.tenantId,
      async (tx) => {
        const existing = await tx.invitation.findUnique({
          where: { id: params.invitationId },
        });
        if (!existing) throw new NotFoundException('invitation_not_found');
        if (existing.tenantId !== params.tenantId) throw new NotFoundException('invitation_not_found');
        if (existing.acceptedAt) throw new BadRequestException('already_accepted');
        if (existing.revokedAt) throw new BadRequestException('already_revoked');

        const { plaintext, tokenHash } = this.generateToken();
        const now = new Date();
        const updated = await tx.invitation.update({
          where: { id: existing.id },
          data: {
            tokenHash,
            emailQueuedAt: now,
            emailSentAt: null,
            emailBouncedAt: null,
            emailAttempts: 0,
            emailLastError: null,
          },
        });

        await this.audit.recordWithin(tx, {
          action: 'panorama.invitation.resent',
          resourceType: 'invitation',
          resourceId: existing.id,
          tenantId: existing.tenantId,
          actorUserId: params.actorUserId,
          metadata: { email: existing.email, role: existing.role },
        });

        return { updated, plaintext };
      },
    );

    this.queue
      .enqueueDelivery(result.updated.id, result.updated.tenantId, result.plaintext)
      .catch((err: unknown) => {
        this.log.warn(
          { invitationId: result.updated.id, err: String(err) },
          'enqueue_resend_failed',
        );
      });

    return {
      id: result.updated.id,
      tenantId: result.updated.tenantId,
      email: result.updated.email,
      role: result.updated.role,
      expiresAt: result.updated.expiresAt,
      token: result.plaintext,
      acceptUrl: this.buildAcceptUrl(result.plaintext),
    };
  }

  // ---------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------

  async revoke(params: RevokeInvitationParams): Promise<void> {
    await this.prisma.runInTenant(
      params.tenantId,
      async (tx) => {
        const existing = await tx.invitation.findUnique({
          where: { id: params.invitationId },
        });
        if (!existing || existing.tenantId !== params.tenantId) {
          throw new NotFoundException('invitation_not_found');
        }
        if (existing.acceptedAt) throw new BadRequestException('already_accepted');
        if (existing.revokedAt) return; // idempotent

        await tx.invitation.update({
          where: { id: existing.id },
          data: { revokedAt: new Date(), revokedByUserId: params.actorUserId },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.invitation.revoked',
          resourceType: 'invitation',
          resourceId: existing.id,
          tenantId: existing.tenantId,
          actorUserId: params.actorUserId,
          metadata: { email: existing.email, role: existing.role },
        });
      },
    );
  }

  // ---------------------------------------------------------------------
  // Preview (GET /invitations/accept) — safe, read-only
  // ---------------------------------------------------------------------

  async previewAccept(
    token: string,
    session: { userId: string; email: string } | null,
  ): Promise<AcceptancePreview> {
    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.invitation.findUnique({
          where: { tokenHash },
          include: {
            tenant: { select: { id: true, slug: true, displayName: true } },
            invitedBy: { select: { id: true, displayName: true, email: true } },
          },
        }),
      { reason: 'invitation:preview' },
    );
    if (!invitation) return { state: 'invalid', reason: 'not_found' };
    if (invitation.revokedAt) return { state: 'invalid', reason: 'revoked' };
    if (invitation.acceptedAt) return { state: 'invalid', reason: 'already_accepted' };
    if (invitation.expiresAt.getTime() <= Date.now()) {
      return { state: 'invalid', reason: 'expired' };
    }

    if (!session) {
      return {
        state: 'needs_login',
        email: invitation.email,
        tenantDisplayName: invitation.tenant.displayName,
        inviterDisplayName: invitation.invitedBy.displayName,
      };
    }

    if (session.email.toLowerCase().trim() !== invitation.email.toLowerCase().trim()) {
      return {
        state: 'email_mismatch',
        invitationEmail: invitation.email,
        sessionEmail: session.email,
        tenantDisplayName: invitation.tenant.displayName,
      };
    }

    return {
      state: 'ready',
      invitationId: invitation.id,
      tenantId: invitation.tenant.id,
      tenantDisplayName: invitation.tenant.displayName,
      email: invitation.email,
      role: invitation.role,
      inviterDisplayName: invitation.invitedBy.displayName,
      expiresAt: invitation.expiresAt,
    };
  }

  // ---------------------------------------------------------------------
  // Finalize (POST /invitations/accept) — state-changing
  // ---------------------------------------------------------------------

  async finalizeAccept(params: FinalizeAcceptParams): Promise<AcceptanceResult> {
    const tokenHash = this.hashToken(params.token);

    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const invitation = await tx.invitation.findUnique({
          where: { tokenHash },
          include: { tenant: { select: { id: true } } },
        });
        if (!invitation) return { state: 'invalid', reason: 'not_found' };
        if (invitation.revokedAt) return { state: 'invalid', reason: 'revoked' };
        if (invitation.acceptedAt) return { state: 'invalid', reason: 'already_accepted' };
        if (invitation.expiresAt.getTime() <= Date.now()) {
          return { state: 'invalid', reason: 'expired' };
        }

        if (
          params.sessionEmail.toLowerCase().trim() !==
          invitation.email.toLowerCase().trim()
        ) {
          return {
            state: 'email_mismatch',
            invitationEmail: invitation.email,
            sessionEmail: params.sessionEmail,
          };
        }

        // Conditional UPDATE guards against the double-click race:
        // at most one tx with the same tokenHash can flip acceptedAt
        // from NULL to a value. Postgres's row-level lock + the
        // WHERE clause's acceptedAt IS NULL does the real work.
        const { count } = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            acceptedAt: null,
            revokedAt: null,
          },
          data: {
            acceptedAt: new Date(),
            acceptedByUserId: params.sessionUserId,
          },
        });
        if (count === 0) {
          return { state: 'invalid', reason: 'already_accepted' };
        }

        const membership = await tx.tenantMembership.upsert({
          where: {
            tenantId_userId: {
              tenantId: invitation.tenantId,
              userId: params.sessionUserId,
            },
          },
          create: {
            tenantId: invitation.tenantId,
            userId: params.sessionUserId,
            role: invitation.role,
            status: 'active',
            invitedByUserId: invitation.invitedByUserId,
            invitedAt: invitation.createdAt,
            acceptedAt: new Date(),
          },
          update: {
            status: 'active',
            role: invitation.role,
            acceptedAt: new Date(),
          },
        });

        await this.audit.recordWithin(tx, {
          action: 'panorama.invitation.accepted',
          resourceType: 'invitation',
          resourceId: invitation.id,
          tenantId: invitation.tenantId,
          actorUserId: params.sessionUserId,
          metadata: {
            email: invitation.email,
            role: invitation.role,
            membershipId: membership.id,
          },
        });

        return {
          state: 'accepted',
          invitationId: invitation.id,
          tenantId: invitation.tenantId,
          membershipId: membership.id,
          role: invitation.role,
        };
      },
      { reason: 'invitation:finalize' },
    );
  }

  // ---------------------------------------------------------------------
  // List (admin UI)
  // ---------------------------------------------------------------------

  async list(params: ListInvitationsParams): Promise<InvitationListItemView[]> {
    const rows = await this.prisma.runInTenant(
      params.tenantId,
      (tx) =>
        tx.invitation.findMany({
          where: { tenantId: params.tenantId },
          orderBy: { createdAt: 'desc' },
          take: params.limit ?? 100,
        }),
    );
    const filtered = rows.filter((r) => this.matchStatus(r, params.status));
    return filtered.map((r) => this.toListItem(r));
  }

  // ---------------------------------------------------------------------
  // Post-email-send callbacks (used by the BullMQ worker)
  // ---------------------------------------------------------------------

  /**
   * Worker callback. `tenantId` is threaded through the BullMQ payload
   * (#115) so this runs under `runInTenant` instead of an unscoped
   * privileged write.
   */
  async markEmailSent(invitationId: string, tenantId: string): Promise<void> {
    await this.prisma.runInTenant(tenantId, async (tx) => {
      const existing = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!existing || existing.tenantId !== tenantId) return;
      await tx.invitation.update({
        where: { id: invitationId },
        data: { emailSentAt: new Date(), emailLastError: null },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.invitation.email_sent',
        resourceType: 'invitation',
        resourceId: invitationId,
        tenantId,
        metadata: { email: existing.email },
      });
    });
  }

  /** Worker callback — see markEmailSent re: tenantId threading. */
  async markEmailFailed(
    invitationId: string,
    tenantId: string,
    error: string,
    terminal: boolean,
  ): Promise<void> {
    await this.prisma.runInTenant(tenantId, async (tx) => {
      const existing = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!existing || existing.tenantId !== tenantId) return;
      await tx.invitation.update({
        where: { id: invitationId },
        data: {
          emailAttempts: { increment: 1 },
          emailLastError: error.slice(0, 500),
          ...(terminal ? { emailBouncedAt: new Date() } : {}),
        },
      });
      await this.audit.recordWithin(tx, {
        action: terminal
          ? 'panorama.invitation.email_bounced'
          : 'panorama.invitation.email_failed',
        resourceType: 'invitation',
        resourceId: invitationId,
        tenantId,
        metadata: { email: existing.email, error: error.slice(0, 500) },
      });
    });
  }

  /**
   * Rotate the token + reset email delivery state on an invitation the
   * maintenance cron has identified as stuck (enqueue lost between tx
   * commit and BullMQ). Returns the new plaintext token so the worker
   * can re-enqueue the delivery job with a fresh payload.
   *
   * Unlike `resend`, this is system-initiated — no admin actor exists.
   * The audit row uses `actorUserId=null` and `action=resent` with
   * metadata reason=`rescue`.
   *
   * `tenantId` comes from the rescue scan (cluster-wide read) so the
   * write itself runs under `runInTenant` (#115).
   */
  async rotateTokenForRescue(
    invitationId: string,
    tenantId: string,
  ): Promise<{ plaintext: string } | null> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const existing = await tx.invitation.findUnique({ where: { id: invitationId } });
      if (!existing || existing.tenantId !== tenantId) return null;
      if (existing.acceptedAt || existing.revokedAt) return null;
      if (existing.expiresAt.getTime() <= Date.now()) return null;

      const { plaintext, tokenHash } = this.generateToken();
      await tx.invitation.update({
        where: { id: invitationId },
        data: {
          tokenHash,
          emailQueuedAt: new Date(),
          emailSentAt: null,
          emailBouncedAt: null,
          emailAttempts: 0,
          emailLastError: null,
        },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.invitation.resent',
        resourceType: 'invitation',
        resourceId: invitationId,
        tenantId,
        actorUserId: null,
        metadata: { email: existing.email, reason: 'rescue' },
      });
      return { plaintext };
    });
  }

  async sweepExpired(): Promise<number> {
    const now = new Date();
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const toExpire = await tx.invitation.findMany({
          where: {
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { lt: now },
            // Haven't emitted an expiry audit yet (detected via updatedAt
            // equal to createdAt). Simpler: use a sentinel flag in metadata;
            // since schema doesn't have one, we rely on updatedAt != now
            // as the watermark — the worker runs every hour, so picking
            // up each row once is good enough.
          },
          select: { id: true, tenantId: true, email: true, role: true },
        });
        for (const row of toExpire) {
          // Touch the row so downstream `updatedAt`-watchers see the state flip.
          await tx.invitation.update({
            where: { id: row.id },
            data: { updatedAt: new Date() },
          });
          await this.audit.recordWithin(tx, {
            action: 'panorama.invitation.expired',
            resourceType: 'invitation',
            resourceId: row.id,
            tenantId: row.tenantId,
            metadata: { email: row.email, role: row.role },
          });
        }
        return toExpire.length;
      },
      { reason: 'invitation:sweepExpired' },
    );
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private generateToken(): { plaintext: string; tokenHash: string } {
    const bytes = randomBytes(32);
    const plaintext = bytes.toString('base64url');
    const tokenHash = this.hashToken(plaintext);
    return { plaintext, tokenHash };
  }

  private hashToken(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('base64url');
  }

  private buildAcceptUrl(token: string): string {
    return `${this.cfg.acceptBaseUrl}?t=${encodeURIComponent(token)}`;
  }

  private resolveTtl(requested: number | undefined): number {
    if (requested === undefined) return this.cfg.defaultTtlSeconds;
    return requested;
  }

  /**
   * Prisma's P2002 for `invitations_one_open_per_tenant_email` surfaces
   * as `meta.target = ['tenantId', 'email']` — the partial-unique index
   * is invisible to Prisma's error-shaping. We infer the collision from
   * the column tuple + the `invitations` model so other unique keys
   * (e.g. a future secondary index) don't false-match.
   */
  private isOpenInvitationCollision(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (err.code !== 'P2002') return false;
    const target = (err.meta as { target?: unknown } | undefined)?.target;
    if (typeof target === 'string') {
      return target.includes('invitations_one_open_per_tenant_email');
    }
    if (Array.isArray(target)) {
      const cols = target.map((t) => String(t));
      if (cols.some((c) => c.includes('invitations_one_open_per_tenant_email'))) return true;
      const set = new Set(cols.map((c) => c.toLowerCase()));
      return set.has('tenantid') && set.has('email');
    }
    return false;
  }

  private rejectIfLimited(decision: RateLimitDecision, label: string): void {
    if (decision.allowed) return;
    if (decision.reason === 'redis_unavailable') {
      // ADR-0008 fail-closed on limiter outage.
      throw new HttpException(
        { error: 'rate_limiter_unavailable', scope: label },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw new HttpException(
      {
        error: 'rate_limited',
        scope: label,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private matchStatus(
    row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
    filter: ListInvitationsParams['status'],
  ): boolean {
    if (!filter || filter === 'all') return true;
    const status = this.classify(row);
    return status === filter;
  }

  private classify(row: {
    acceptedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): InvitationStatus {
    if (row.acceptedAt) return 'accepted';
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt.getTime() <= Date.now()) return 'expired';
    return 'open';
  }

  private toListItem(row: {
    id: string;
    tenantId: string;
    email: string;
    role: string;
    expiresAt: Date;
    createdAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    emailQueuedAt: Date | null;
    emailSentAt: Date | null;
    emailBouncedAt: Date | null;
    emailLastError: string | null;
    invitedByUserId: string;
  }): InvitationListItemView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      role: row.role,
      status: this.classify(row),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt,
      revokedAt: row.revokedAt,
      emailQueuedAt: row.emailQueuedAt,
      emailSentAt: row.emailSentAt,
      emailBouncedAt: row.emailBouncedAt,
      emailLastError: row.emailLastError,
      invitedByUserId: row.invitedByUserId,
    };
  }
}
