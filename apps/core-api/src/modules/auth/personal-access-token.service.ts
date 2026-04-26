import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PersonalAccessToken, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { RateLimiter } from '../redis/rate-limiter.js';

/**
 * Personal Access Token service (ADR-0010).
 *
 * Responsibilities:
 *   * `mint` — issue a new token to the session's user. Returns plaintext
 *     exactly once; server stores only sha256(plaintext) base64url.
 *   * `revoke` — soft-revoke by id (sets revokedAt). Owner or admin only.
 *   * `list` — the session user's own tokens (never exposes plaintext or
 *     hash).
 *   * `findByPlaintext` — hash lookup used by the PAT middleware (step 5
 *     of ADR-0010 execution). Exported here because the hashing contract
 *     lives with the service that writes the hash.
 *
 * Rate-limits live in this service so the Controller stays thin and the
 * service is the enforcement point even if we ever wire a second caller.
 * Fails closed on Redis outage per ADR-0008 invariant #4.
 */

export const PAT_PLAINTEXT_PREFIX = 'pnrm_pat_';
export const PAT_SCOPE_SNIPEIT_COMPAT_READ = 'snipeit.compat.read';

const PAT_ALLOWED_SCOPES = new Set<string>([PAT_SCOPE_SNIPEIT_COMPAT_READ]);

const ISSUE_LIMIT = 10;
const ISSUE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface MintPatParams {
  actor: { userId: string; tenantId: string };
  name: string;
  scopes: string[];
  expiresAt?: Date | null;
  /** Optional attribution columns — populated from the HTTP request. */
  createdByIp?: string | null;
  createdByUserAgent?: string | null;
  /**
   * When a super-admin mints on behalf of another user, `actor.userId`
   * goes to `issuerUserId` and the target (owner) is named here.
   * Defaults to `actor.userId` (self-mint, common path).
   */
  ownerUserId?: string;
}

export interface MintPatResult {
  token: PersonalAccessToken;
  /** Plaintext — return to the caller ONCE. Never persisted. */
  plaintext: string;
}

export interface RevokePatParams {
  actor: { userId: string; tenantId: string; role: string };
  tokenId: string;
  reason?: string;
}

export interface ListPatParams {
  actor: { userId: string; tenantId: string; role: string };
  scope: 'mine' | 'tenant';
  includeRevoked?: boolean;
  limit?: number;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);
function isAdmin(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

@Injectable()
export class PersonalAccessTokenService {
  private readonly log = new Logger('PersonalAccessTokenService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  // ---------------------------------------------------------------------
  // Mint
  // ---------------------------------------------------------------------

  async mint(params: MintPatParams): Promise<MintPatResult> {
    if (!params.name || params.name.trim().length === 0) {
      throw new BadRequestException('name_required');
    }
    if (params.name.length > 100) {
      throw new BadRequestException('name_too_long');
    }
    if (params.scopes.length === 0) {
      throw new BadRequestException('scopes_required');
    }
    for (const scope of params.scopes) {
      if (!PAT_ALLOWED_SCOPES.has(scope)) {
        throw new BadRequestException(`invalid_scope:${scope}`);
      }
    }
    if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expires_in_the_past');
    }

    // Issuance rate limit. Fails CLOSED per ADR-0010.
    const issueKey = `pat:issue:${params.actor.userId}:hour`;
    const decision = await this.rateLimiter.consume(issueKey, ISSUE_LIMIT, ISSUE_WINDOW_MS);
    if (!decision.allowed) {
      if (decision.reason === 'redis_unavailable') {
        throw new HttpException(
          { error: 'rate_limiter_unavailable', scope: 'pat_issue' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw new HttpException(
        {
          error: 'pat_issue_rate_limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ownerUserId = params.ownerUserId ?? params.actor.userId;
    const secret = randomBytes(32).toString('base64url');
    const plaintext = `${PAT_PLAINTEXT_PREFIX}${secret}`;
    const tokenHash = sha256Base64Url(plaintext);
    const tokenPrefix = `${PAT_PLAINTEXT_PREFIX}${secret.slice(0, 8)}`;

    try {
      const token = await this.prisma.runInTenant(
        params.actor.tenantId,
        async (tx) => {
          const created = await tx.personalAccessToken.create({
            data: {
              userId: ownerUserId,
              tenantId: params.actor.tenantId,
              issuerUserId: params.actor.userId,
              name: params.name.trim(),
              tokenHash,
              tokenPrefix,
              scopes: params.scopes,
              expiresAt: params.expiresAt ?? null,
              createdByIp: params.createdByIp ?? null,
              createdByUserAgent: params.createdByUserAgent ?? null,
            },
          });
          await this.audit.recordWithin(tx, {
            action: 'panorama.pat.created',
            resourceType: 'personal_access_token',
            resourceId: created.id,
            tenantId: created.tenantId,
            actorUserId: params.actor.userId,
            metadata: {
              tokenId: created.id,
              tokenPrefix: created.tokenPrefix,
              ownerUserId: created.userId,
              scopes: created.scopes,
              expiresAt: created.expiresAt?.toISOString() ?? null,
            },
          });
          return created;
        },
      );
      return { token, plaintext };
    } catch (err) {
      // The write failed — release the rate-limit slot so the operator
      // isn't taxed for a failure that wasn't theirs. Mirrors the
      // invitation-service pattern.
      await this.rateLimiter.release(issueKey, ISSUE_LIMIT, ISSUE_WINDOW_MS);
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------

  async revoke(params: RevokePatParams): Promise<PersonalAccessToken> {
    return this.prisma.runInTenant(
      params.actor.tenantId,
      async (tx) => {
        const existing = await tx.personalAccessToken.findUnique({
          where: { id: params.tokenId },
        });
        if (!existing || existing.tenantId !== params.actor.tenantId) {
          throw new NotFoundException('token_not_found');
        }
        if (existing.revokedAt !== null) return existing; // idempotent

        const isOwner = existing.userId === params.actor.userId;
        if (!isOwner && !isAdmin(params.actor.role)) {
          throw new ForbiddenException('not_allowed_to_revoke');
        }

        const updated = await tx.personalAccessToken.update({
          where: { id: params.tokenId },
          data: { revokedAt: new Date() },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.pat.revoked',
          resourceType: 'personal_access_token',
          resourceId: updated.id,
          tenantId: updated.tenantId,
          actorUserId: params.actor.userId,
          metadata: {
            tokenId: updated.id,
            tokenPrefix: updated.tokenPrefix,
            ownerUserId: updated.userId,
            reason: params.reason ?? null,
            byOwner: isOwner,
          },
        });
        return updated;
      },
    );
  }

  // ---------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------

  async list(params: ListPatParams): Promise<PersonalAccessToken[]> {
    if (params.scope === 'tenant' && !isAdmin(params.actor.role)) {
      throw new ForbiddenException('admin_role_required_for_tenant_scope');
    }
    const where: Prisma.PersonalAccessTokenWhereInput = {
      tenantId: params.actor.tenantId,
    };
    if (params.scope === 'mine') {
      where.userId = params.actor.userId;
    }
    if (!params.includeRevoked) {
      where.revokedAt = null;
    }
    return this.prisma.runInTenant(
      params.actor.tenantId,
      (tx) =>
        tx.personalAccessToken.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          take: params.limit ?? 50,
        }),
    );
  }

  // ---------------------------------------------------------------------
  // Lookup by plaintext — used by step 5 PatAuthGuard
  // ---------------------------------------------------------------------

  /**
   * Returns the (non-revoked, non-expired) row matching the caller-
   * supplied plaintext, or null. Caller MUST still re-check expiry +
   * membership status — this method only filters out unambiguously-
   * dead tokens.
   *
   * Lookup runs at runAsSuperAdmin because there is no tenant context
   * yet: the token IS what determines the tenant. The middleware
   * switches into runInTenant after resolving the actor.
   */
  async findByPlaintext(plaintext: string): Promise<PersonalAccessToken | null> {
    if (!plaintext.startsWith(PAT_PLAINTEXT_PREFIX)) return null;
    const hash = sha256Base64Url(plaintext);
    const row = await this.prisma.runAsSuperAdmin(
      (tx) =>
        tx.personalAccessToken.findUnique({
          where: { tokenHash: hash },
        }),
      { reason: 'pat:lookup' },
    );
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  // ---------------------------------------------------------------------
  // Response shaping
  // ---------------------------------------------------------------------

  /**
   * Allowlisted serialisation for API responses. Omits tokenHash so a
   * generic JSON serializer can't accidentally tee the pre-image.
   */
  publicShape(row: PersonalAccessToken): {
    id: string;
    userId: string;
    tenantId: string;
    issuerUserId: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    createdByIp: string | null;
    createdByUserAgent: string | null;
  } {
    return {
      id: row.id,
      userId: row.userId,
      tenantId: row.tenantId,
      issuerUserId: row.issuerUserId,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      createdByIp: row.createdByIp ?? null,
      createdByUserAgent: row.createdByUserAgent ?? null,
    };
  }
}

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}
