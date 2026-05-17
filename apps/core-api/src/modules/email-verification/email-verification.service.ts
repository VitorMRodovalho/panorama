import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PanoramaAuditAction } from '../audit/audit-actions.js';
import { EmailService } from '../email/email.service.js';
import { RateLimiter, type RateLimitDecision } from '../redis/rate-limiter.js';
import { EmailVerificationConfigService } from './email-verification.config.js';
import {
  renderVerificationEmail,
  type VerificationEmailContext,
} from './email-verification.templates.js';

/**
 * Email-verification domain service (ADR-0020 §3).
 *
 * Three responsibilities:
 *   1. `checkEmailCap` — fail-closed per-email rate limit. ADR §3
 *      caps DISPATCH ATTEMPTS at 3 per email per 24h (not pending
 *      tokens — already-consumed tokens still count toward the cap
 *      because the limit defends an INBOX from harassment, not a
 *      tenant from over-subscription). Backed by `RateLimiter`
 *      sliding window; trip emits `TenantVerificationThrottled` and
 *      caller refuses the signup.
 *   2. `mintAndDispatch` — generates a 256-bit token, persists its
 *      sha256 in `email_verifications`, dispatches the email
 *      synchronously via `EmailService`, and emits
 *      `TenantVerificationSent`. SMTP failure is logged but does
 *      NOT roll back the tenant (the caller redirects to the
 *      "check your inbox" page regardless; PR 2b would add a
 *      resend endpoint for stuck users).
 *   3. `consume` — POST /auth/verify entry. Looks up tokenHash,
 *      validates not-consumed + not-expired + matching tenant in
 *      pendingVerification state. Same transaction flips
 *      `Tenant.pendingVerification=false`, marks `consumedAt`, and
 *      emits `TenantVerified`. Failures funnel back to the
 *      controller for the timing-padded 400 envelope.
 *
 * All paths go through `prisma.runAsSuperAdmin`: the
 * `email_verifications` table has no GRANT to panorama_app, and the
 * verify endpoint is called from a logged-out browser (no tenant
 * context).
 */

const CAP_LIMIT = 3;
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const CAP_KEY_PREFIX = 'panorama:signup:verify-email:';

export type ConsumeResult =
  | { kind: 'ok'; tenantId: string }
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'already_consumed' }
  | { kind: 'tenant_already_verified' };

export interface MintAndDispatchInput {
  userId: string;
  tenantId: string;
  tenantDisplayName: string;
  /**
   * RFC 5322-asserted recipient email (preserves the IdP's
   * original casing — RFC 5321 §2.3.11 says the local-part is
   * case-sensitive, so SMTP `to:` MUST use the unmodified form to
   * avoid MX-side delivery failures).
   */
  email: string;
}

export interface MintAndDispatchOutput {
  dispatched: boolean;
  /** sha256(token) first-8 hex chars — for audit correlation. */
  tokenKeyPrefix: string;
  expiresAt: Date;
}

@Injectable()
export class EmailVerificationService {
  private readonly log = new Logger('EmailVerificationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: EmailService,
    private readonly limiter: RateLimiter,
    private readonly cfg: EmailVerificationConfigService,
  ) {}

  /**
   * Reserve a per-email dispatch slot. Caller must invoke BEFORE
   * `mintAndDispatch`; if `allowed === false`, caller emits
   * `TenantVerificationThrottled` and refuses the signup with the
   * standard timing-padded 400 envelope.
   *
   * Bucket key: sha256(emailLower) so the raw email never enters
   * Redis logs.
   */
  async checkEmailCap(email: string): Promise<RateLimitDecision> {
    return this.limiter.consume(
      CAP_KEY_PREFIX + hashEmail(normalizeEmail(email)),
      CAP_LIMIT,
      CAP_WINDOW_MS,
    );
  }

  async mintAndDispatch(input: MintAndDispatchInput): Promise<MintAndDispatchOutput> {
    const { plaintext, tokenHash } = this.generateToken();
    const expiresAt = new Date(Date.now() + this.cfg.config.ttlHours * 60 * 60 * 1000);
    // Defensive normalization at the service boundary — every caller
    // currently does this too, but pinning the contract here means a
    // future caller can't accidentally key the cap on a non-canonical
    // value or write a non-canonical row.
    const emailLower = normalizeEmail(input.email);
    const tokenKeyPrefix = tokenHash.slice(0, 8);

    await this.prisma.runAsSuperAdmin(
      async (tx) => {
        await tx.emailVerification.create({
          data: {
            userId: input.userId,
            tenantId: input.tenantId,
            emailLower,
            tokenHash,
            expiresAt,
          },
        });
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantVerificationSent,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.userId,
          metadata: {
            emailHash: hashEmail(emailLower),
            ttl: this.cfg.config.ttlHours * 60 * 60,
            tokenKeyPrefix,
          },
        });
      },
      { reason: `email-verification:mint:${input.tenantId}` },
    );

    let dispatched = true;
    try {
      const emailCtx: VerificationEmailContext = {
        recipientEmail: input.email,
        tenantDisplayName: input.tenantDisplayName,
        token: plaintext,
        verifyUrlBase: this.cfg.config.verifyUrlBase,
        expiresAt,
      };
      const rendered = renderVerificationEmail(emailCtx);
      // SMTP `to:` uses the IdP-asserted casing per RFC 5321 §2.3.11
      // (local-part is case-sensitive). Cap / DB / audit use the
      // lowercased form for cross-attempt correlation.
      await this.mail.send({
        to: input.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } catch (err) {
      dispatched = false;
      this.log.error({ err: String(err) }, 'verification_email_dispatch_failed');
      // The mint tx already committed (the row exists, the audit
      // says "Sent"). Emit a sibling `TenantVerificationDispatchFailed`
      // row so the audit trail is honest about which dispatches
      // actually reached the wire. Best-effort — failure to write
      // this audit row is logged but doesn't escalate.
      try {
        await this.audit.record({
          action: PanoramaAuditAction.TenantVerificationDispatchFailed,
          resourceType: 'tenant',
          resourceId: input.tenantId,
          tenantId: input.tenantId,
          actorUserId: input.userId,
          metadata: {
            emailHash: hashEmail(emailLower),
            tokenKeyPrefix,
            errKind: err instanceof Error ? err.name : 'Unknown',
          },
        });
      } catch (auditErr) {
        this.log.error(
          { err: String(auditErr) },
          'verification_dispatch_failed_audit_write_failed',
        );
      }
    }
    return { dispatched, tokenKeyPrefix, expiresAt };
  }

  /**
   * POST /auth/verify consume path. Atomic flip of:
   *   - `Tenant.pendingVerification = false`
   *   - `EmailVerification.consumedAt = now()`
   *
   * Returns a tagged union so the controller can emit the right
   * timing-padded 400 envelope without leaking the specific reason
   * to the client (audit row carries the SIEM-side detail).
   */
  async consume(token: string): Promise<ConsumeResult> {
    if (!token || typeof token !== 'string' || token.length === 0) {
      return { kind: 'missing' };
    }
    const tokenHash = hashToken(token);
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const row = await tx.emailVerification.findUnique({
          where: { tokenHash },
        });
        if (!row) return { kind: 'missing' } as const;
        if (row.consumedAt !== null) return { kind: 'already_consumed' } as const;
        if (row.expiresAt.getTime() <= Date.now()) return { kind: 'expired' } as const;

        const tenant = await tx.tenant.findUnique({
          where: { id: row.tenantId },
          select: { id: true, pendingVerification: true },
        });
        if (!tenant) return { kind: 'missing' } as const;
        if (!tenant.pendingVerification) {
          // The tenant was already flipped (via a sibling token or
          // an operator override). Treat the second consume as a
          // no-op: the user-facing outcome is the same.
          return { kind: 'tenant_already_verified' } as const;
        }

        await tx.emailVerification.update({
          where: { id: row.id },
          data: { consumedAt: new Date() },
        });
        await tx.tenant.update({
          where: { id: row.tenantId },
          data: { pendingVerification: false },
        });

        const elapsedMs = Date.now() - row.createdAt.getTime();
        await this.audit.recordWithin(tx, {
          action: PanoramaAuditAction.TenantVerified,
          resourceType: 'tenant',
          resourceId: row.tenantId,
          tenantId: row.tenantId,
          actorUserId: row.userId,
          metadata: {
            tokenKeyPrefix: row.tokenHash.slice(0, 8),
            elapsedMs,
          },
        });

        return { kind: 'ok' as const, tenantId: row.tenantId };
      },
      { reason: `email-verification:consume` },
    );
  }

  /**
   * Best-effort observability: write `TenantVerificationThrottled` when
   * the §3 cap trips. Cluster-wide event (the tenant might not exist
   * yet, e.g. the 4th signup attempt for a new email).
   */
  async recordThrottled(email: string): Promise<void> {
    try {
      await this.audit.record({
        action: PanoramaAuditAction.TenantVerificationThrottled,
        resourceType: 'tenant',
        resourceId: null,
        tenantId: null,
        actorUserId: null,
        metadata: {
          emailHash: hashEmail(normalizeEmail(email)),
        },
      });
    } catch (err) {
      this.log.error(
        { err: String(err) },
        'verification_throttled_audit_write_failed',
      );
    }
  }

  private generateToken(): { plaintext: string; tokenHash: string } {
    const plaintext = randomBytes(32).toString('base64url');
    return { plaintext, tokenHash: hashToken(plaintext) };
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function hashEmail(emailLower: string): string {
  return createHash('sha256').update(emailLower).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
