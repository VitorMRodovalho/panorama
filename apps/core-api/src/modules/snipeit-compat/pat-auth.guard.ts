import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PersonalAccessToken } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PatMembershipCache } from '../auth/pat-membership-cache.service.js';
import { PersonalAccessTokenService } from '../auth/personal-access-token.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateLimiter } from '../redis/rate-limiter.js';

/**
 * PAT authentication guard — ADR-0010.
 *
 * Exclusive auth surface for SnipeitCompatModule. Session cookies
 * attached to a request reaching this guard are a caller
 * misconfiguration and generate 401 `pat_required`, never a silent
 * downgrade. The guard:
 *
 *   1. Enforces `Authorization: Bearer pnrm_pat_<...>` shape (401
 *      `pat_required` if absent / wrong prefix).
 *   2. Hashes the plaintext, looks up the (non-revoked, non-expired)
 *      row (401 `invalid_token` otherwise + audit
 *      `panorama.pat.rejected`).
 *   3. Re-checks the owner's `TenantMembership.status === 'active'`,
 *      cached in Redis 30 s. Cache miss or DB blip fails CLOSED with
 *      503 `membership_check_failed` (ADR-0008 invariant #4).
 *   4. Runs three Redis rate limits (per-token burst 60/min,
 *      per-token sustained 300/hour, per-tenant 10 000/hour). All
 *      fail closed.
 *   5. On first ever use of a token, writes `lastUsedAt` synchronously
 *      and emits `panorama.pat.used_first`. Subsequent calls update
 *      async (fire-and-forget inside a follow-up tick). If the last
 *      use was ≥30 days ago, also emits `panorama.pat.used_after_dormant`.
 *   6. Populates `req.actor = { kind: 'pat', userId, tenantId, scopes,
 *      tokenId }`; downstream scope guard reads from there.
 *
 * PatAuthGuard does NOT check scopes. That's the ScopeGuard's job —
 * split so controllers can declare the required scope per-endpoint
 * and the auth layer stays focused on identity.
 */

const PAT_BEARER_PREFIX = 'Bearer ';
const PAT_PLAINTEXT_PREFIX = 'pnrm_pat_';

const DORMANT_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const TOKEN_BURST_LIMIT = 60;
const TOKEN_BURST_WINDOW_MS = 60_000;
const TOKEN_SUSTAINED_LIMIT = 300;
const TOKEN_SUSTAINED_WINDOW_MS = 60 * 60 * 1000;
const TENANT_LIMIT = 10_000;
const TENANT_WINDOW_MS = 60 * 60 * 1000;

export interface PatActor {
  kind: 'pat';
  userId: string;
  tenantId: string;
  scopes: string[];
  tokenId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: PatActor | { kind: 'session' };
    }
  }
}

@Injectable()
export class PatAuthGuard implements CanActivate {
  private readonly log = new Logger('PatAuthGuard');

  constructor(
    private readonly pats: PersonalAccessTokenService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly membershipCache: PatMembershipCache,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const plaintext = this.extractBearer(req);

    if (plaintext === null) {
      throw this.unauthorized('pat_required');
    }

    const token = await this.pats.findByPlaintext(plaintext);
    if (!token) {
      await this.emitRejected(null, 'invalid_token', {
        tokenPrefix: this.prefixFor(plaintext),
      });
      throw this.unauthorized('invalid_token');
    }

    const memberStatus = await this.checkMembership(token);
    if (memberStatus !== 'active') {
      await this.emitRejected(token, memberStatus, {
        tokenId: token.id,
        tokenPrefix: token.tokenPrefix,
        userId: token.userId,
        tenantId: token.tenantId,
      });
      if (memberStatus === 'membership_check_failed') {
        throw new HttpException(
          { error: 'membership_check_failed' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw this.unauthorized(
        memberStatus === 'suspended' ? 'user_suspended' : 'not_a_member',
      );
    }

    await this.enforceRateLimits(token);
    await this.updateLastUsedAndEmit(token);

    req.actor = {
      kind: 'pat',
      userId: token.userId,
      tenantId: token.tenantId,
      scopes: token.scopes,
      tokenId: token.id,
    };

    return true;
  }

  // ---- helpers -------------------------------------------------------

  private extractBearer(req: Request): string | null {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith(PAT_BEARER_PREFIX)) {
      return null;
    }
    const plaintext = header.slice(PAT_BEARER_PREFIX.length).trim();
    if (!plaintext.startsWith(PAT_PLAINTEXT_PREFIX)) return null;
    return plaintext;
  }

  private prefixFor(plaintext: string): string {
    const secret = plaintext.slice(PAT_PLAINTEXT_PREFIX.length, PAT_PLAINTEXT_PREFIX.length + 8);
    return `${PAT_PLAINTEXT_PREFIX}${secret}`;
  }

  private async checkMembership(
    token: PersonalAccessToken,
  ): Promise<'active' | 'suspended' | 'not_a_member' | 'membership_check_failed'> {
    const cached = await this.membershipCache.get(token.userId, token.tenantId);
    if (cached === 'unavailable') return 'membership_check_failed';
    if (cached !== null) return cached;

    try {
      const row = await this.prisma.runInTenant(
        token.tenantId,
        (tx) =>
          tx.tenantMembership.findUnique({
            where: {
              tenantId_userId: { tenantId: token.tenantId, userId: token.userId },
            },
            select: { status: true },
          }),
      );
      const status: 'active' | 'suspended' | 'not_a_member' = !row
        ? 'not_a_member'
        : row.status === 'active'
          ? 'active'
          : 'suspended';
      // Best-effort cache write; on failure we accept the next call
      // hitting the DB again.
      void this.membershipCache.set(token.userId, token.tenantId, status);
      return status;
    } catch (err) {
      this.log.warn({ err: String(err) }, 'membership_db_lookup_failed');
      return 'membership_check_failed';
    }
  }

  private async enforceRateLimits(token: PersonalAccessToken): Promise<void> {
    const burstKey = `pat:token:${token.id}:min`;
    const sustainedKey = `pat:token:${token.id}:hour`;
    const tenantKey = `pat:tenant:${token.tenantId}:hour`;

    const burst = await this.rateLimiter.consume(
      burstKey,
      TOKEN_BURST_LIMIT,
      TOKEN_BURST_WINDOW_MS,
    );
    if (!burst.allowed) {
      throw this.rateLimitException(burst, 'pat_token_burst');
    }

    const sustained = await this.rateLimiter.consume(
      sustainedKey,
      TOKEN_SUSTAINED_LIMIT,
      TOKEN_SUSTAINED_WINDOW_MS,
    );
    if (!sustained.allowed) {
      await this.rateLimiter.release(burstKey, TOKEN_BURST_LIMIT, TOKEN_BURST_WINDOW_MS);
      throw this.rateLimitException(sustained, 'pat_token_hourly');
    }

    const tenant = await this.rateLimiter.consume(tenantKey, TENANT_LIMIT, TENANT_WINDOW_MS);
    if (!tenant.allowed) {
      await this.rateLimiter.release(burstKey, TOKEN_BURST_LIMIT, TOKEN_BURST_WINDOW_MS);
      await this.rateLimiter.release(
        sustainedKey,
        TOKEN_SUSTAINED_LIMIT,
        TOKEN_SUSTAINED_WINDOW_MS,
      );
      throw this.rateLimitException(tenant, 'pat_tenant_hourly');
    }
  }

  private async updateLastUsedAndEmit(token: PersonalAccessToken): Promise<void> {
    const now = new Date();
    const isFirstUse = token.lastUsedAt === null;
    const isDormantReuse =
      token.lastUsedAt !== null &&
      now.getTime() - token.lastUsedAt.getTime() >= DORMANT_THRESHOLD_MS;

    if (isFirstUse || isDormantReuse) {
      // Synchronous write + audit so the admin-visible "first used"
      // / "woken up from dormant" signal is never lost on a crash.
      await this.prisma.runInTenant(
        token.tenantId,
        async (tx) => {
          await tx.personalAccessToken.update({
            where: { id: token.id },
            data: { lastUsedAt: now },
          });
          await this.audit.recordWithin(tx, {
            action: isFirstUse
              ? 'panorama.pat.used_first'
              : 'panorama.pat.used_after_dormant',
            resourceType: 'personal_access_token',
            resourceId: token.id,
            tenantId: token.tenantId,
            actorUserId: token.userId,
            metadata: {
              tokenId: token.id,
              tokenPrefix: token.tokenPrefix,
              previousLastUsedAt: token.lastUsedAt?.toISOString() ?? null,
            },
          });
        },
      );
    } else {
      // Hot path — fire-and-forget timestamp refresh. A dropped
      // update just leaves lastUsedAt stale; rate-limiter metrics
      // are the audit source of truth per ADR-0010.
      this.prisma
        .runInTenant(token.tenantId, (tx) =>
          tx.personalAccessToken.update({
            where: { id: token.id },
            data: { lastUsedAt: now },
          }),
        )
        .catch((err) =>
          this.log.warn({ err: String(err), tokenId: token.id }, 'pat_last_used_async_failed'),
        );
    }
  }

  private async emitRejected(
    token: PersonalAccessToken | null,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.record({
        action: 'panorama.pat.rejected',
        resourceType: 'personal_access_token',
        resourceId: token?.id ?? null,
        tenantId: token?.tenantId ?? null,
        actorUserId: null,
        metadata: { reason, ...metadata },
      });
    } catch (err) {
      this.log.warn({ err: String(err), reason }, 'pat_rejected_audit_failed');
    }
  }

  private unauthorized(error: string): HttpException {
    return new HttpException({ error }, HttpStatus.UNAUTHORIZED);
  }

  private rateLimitException(
    decision: { reason?: string; retryAfterSeconds: number },
    scope: string,
  ): HttpException {
    if (decision.reason === 'redis_unavailable') {
      return new HttpException(
        { error: 'rate_limiter_unavailable', scope },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return new HttpException(
      { error: 'rate_limited', scope, retryAfterSeconds: decision.retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
