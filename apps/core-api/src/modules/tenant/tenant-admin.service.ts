import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantMembership, type Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PatMembershipCache } from '../auth/pat-membership-cache.service.js';

/**
 * Service-layer enforcement of ADR-0007's Tenant Owner invariants.
 *
 * Responsibilities:
 *   1. Atomic tenant creation that ALSO seeds the creator's Owner
 *      membership — the ADR's rule 2 ("creator = first Owner").
 *   2. Role + status transitions on existing memberships with nice
 *      error surfaces (409 last-owner-can't-demote instead of a raw
 *      Postgres exception).
 *   3. Super-admin break-glass path (`nominateOwner`) — upserts an
 *      Owner membership + writes a `panorama.tenant.ownership_restored`
 *      audit row. The operator identity + reason are both required.
 *
 * The Postgres trigger in migration 0005 is the final backstop. Even
 * a privileged client (psql session, forgotten guard) cannot violate
 * the invariant at the DB layer. This service provides the friendly
 * user-facing surface; the trigger keeps it honest.
 */

export const ALLOWED_MEMBERSHIP_ROLES = [
  'owner',
  'fleet_admin',
  'fleet_staff',
  'driver',
] as const;
export type MembershipRole = (typeof ALLOWED_MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export interface CreateTenantWithOwnerParams {
  slug: string;
  name: string;
  displayName: string;
  locale?: string;
  timezone?: string;
  allowedEmailDomains?: string[];
  ownerUserId: string;
  /** Who triggered the creation — populated in the audit row. */
  actorUserId?: string | null;
}

export interface UpdateMembershipParams {
  tenantId: string;
  membershipId: string;
  role?: MembershipRole;
  status?: MembershipStatus;
  actorUserId: string;
}

export interface NominateOwnerParams {
  tenantSlug: string;
  email: string;
  reason: string;
  operatorEmail: string;
}

@Injectable()
export class TenantAdminService {
  private readonly log = new Logger('TenantAdminService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly patCache: PatMembershipCache,
  ) {}

  // ---------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------

  async createTenantWithOwner(params: CreateTenantWithOwnerParams): Promise<{
    tenant: Tenant;
    ownerMembership: TenantMembership;
  }> {
    return this.prisma.runAsSuperAdmin(
      async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: params.ownerUserId },
          select: { id: true },
        });
        if (!user) throw new NotFoundException('owner_user_not_found');

        // ADR-0016 §1 — every tenant carries a system user used as
        // the audit actor for auto-suggested maintenance tickets.
        // No AuthIdentity row, never logs in. The slug is salted with
        // a random suffix so two tenants with conflicting slugs (rare
        // but possible across re-creates) don't collide on email.
        const systemUser = await tx.user.create({
          data: {
            email: `system+${params.slug}-${Date.now()}@panorama.invalid`,
            displayName: `${params.slug} System`,
            status: 'ACTIVE',
          },
        });
        const tenantData: Prisma.TenantUncheckedCreateInput = {
          slug: params.slug,
          name: params.name,
          displayName: params.displayName,
          locale: params.locale ?? 'en',
          timezone: params.timezone ?? 'UTC',
          allowedEmailDomains: params.allowedEmailDomains ?? [],
          systemActorUserId: systemUser.id,
        };
        const tenant = await tx.tenant.create({ data: tenantData });
        await tx.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId: systemUser.id,
            role: 'system',
            status: 'active',
          },
        });

        const ownerMembership = await tx.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId: params.ownerUserId,
            role: 'owner',
            status: 'active',
            acceptedAt: new Date(),
          },
        });

        await this.audit.recordWithin(tx, {
          action: 'panorama.tenant.created',
          resourceType: 'tenant',
          resourceId: tenant.id,
          tenantId: tenant.id,
          actorUserId: params.actorUserId ?? params.ownerUserId,
          metadata: {
            slug: tenant.slug,
            ownerUserId: params.ownerUserId,
            ownerMembershipId: ownerMembership.id,
          },
        });

        return { tenant, ownerMembership };
      },
      { reason: `tenant:createWithOwner:${params.slug}` },
    );
  }

  // ---------------------------------------------------------------------
  // Membership updates (promote / demote / suspend / reactivate)
  // ---------------------------------------------------------------------

  async updateMembership(params: UpdateMembershipParams): Promise<TenantMembership> {
    if (!params.role && !params.status) {
      throw new BadRequestException('nothing_to_update');
    }
    if (params.role && !ALLOWED_MEMBERSHIP_ROLES.includes(params.role)) {
      throw new BadRequestException(`invalid_role:${params.role}`);
    }
    if (params.status && !MEMBERSHIP_STATUSES.includes(params.status)) {
      throw new BadRequestException(`invalid_status:${params.status}`);
    }

    const result = await this.prisma.runInTenant(
      params.tenantId,
      async (tx) => {
        const existing = await tx.tenantMembership.findUnique({
          where: { id: params.membershipId },
        });
        if (!existing || existing.tenantId !== params.tenantId) {
          throw new NotFoundException('membership_not_found');
        }

        const nextRole = params.role ?? (existing.role as MembershipRole);
        const nextStatus = params.status ?? (existing.status as MembershipStatus);

        // ADR-0007 rule 8: Owner cannot be suspended. Force the caller
        // to demote first (two explicit intents instead of one
        // ambiguous "put this Owner in the penalty box").
        if (existing.role === 'owner' && params.status === 'suspended') {
          throw new BadRequestException('owner_cannot_be_suspended_demote_first');
        }

        try {
          const updated = await tx.tenantMembership.update({
            where: { id: existing.id },
            data: { role: nextRole, status: nextStatus },
          });

          if (
            existing.role !== nextRole ||
            existing.status !== nextStatus
          ) {
            await this.audit.recordWithin(tx, {
              action: this.auditActionForTransition(existing, { role: nextRole, status: nextStatus }),
              resourceType: 'tenant_membership',
              resourceId: existing.id,
              tenantId: existing.tenantId,
              actorUserId: params.actorUserId,
              metadata: {
                userId: existing.userId,
                previousRole: existing.role,
                previousStatus: existing.status,
                role: nextRole,
                status: nextStatus,
              },
            });
          }
          return updated;
        } catch (err) {
          if (this.isOwnerInvariantViolation(err)) {
            throw new ConflictException('last_owner_must_remain_active');
          }
          throw err;
        }
      },
    );
    // ADR-0010 explicit invalidation — a status/role change must be
    // visible to PatAuthGuard on the next call, not 30s from now.
    await this.patCache.invalidate(result.userId, result.tenantId);
    return result;
  }

  /**
   * Delete a membership — also guarded by the DB trigger for the
   * last-owner case. Kept as a tiny helper so controllers don't
   * reach into tenantMembership directly.
   */
  async deleteMembership(params: {
    tenantId: string;
    membershipId: string;
    actorUserId: string;
  }): Promise<void> {
    const deleted = await this.prisma.runInTenant(
      params.tenantId,
      async (tx) => {
        const existing = await tx.tenantMembership.findUnique({
          where: { id: params.membershipId },
        });
        if (!existing || existing.tenantId !== params.tenantId) {
          throw new NotFoundException('membership_not_found');
        }
        try {
          await tx.tenantMembership.delete({ where: { id: existing.id } });
          await this.audit.recordWithin(tx, {
            action: 'panorama.tenant.membership_deleted',
            resourceType: 'tenant_membership',
            resourceId: existing.id,
            tenantId: existing.tenantId,
            actorUserId: params.actorUserId,
            metadata: {
              userId: existing.userId,
              role: existing.role,
              status: existing.status,
            },
          });
          return existing;
        } catch (err) {
          if (this.isOwnerInvariantViolation(err)) {
            throw new ConflictException('last_owner_must_remain_active');
          }
          throw err;
        }
      },
    );
    // Post-commit cache invalidation (ADR-0010).
    await this.patCache.invalidate(deleted.userId, deleted.tenantId);
  }

  // ---------------------------------------------------------------------
  // Super-admin break-glass (ADR-0007 rule 7)
  // ---------------------------------------------------------------------

  async nominateOwner(params: NominateOwnerParams): Promise<{
    membership: TenantMembership;
    created: boolean;
  }> {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new BadRequestException('reason_required');
    }

    const outcome = await this.prisma.runAsSuperAdmin(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { slug: params.tenantSlug } });
        if (!tenant) throw new NotFoundException('tenant_not_found');

        const email = params.email.toLowerCase().trim();
        const user = await tx.user.findUnique({ where: { email } });
        if (!user) throw new NotFoundException('user_not_found');

        const existing = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        });

        let created = false;
        let membership: TenantMembership;
        if (existing) {
          membership = await tx.tenantMembership.update({
            where: { id: existing.id },
            data: { role: 'owner', status: 'active', acceptedAt: new Date() },
          });
        } else {
          membership = await tx.tenantMembership.create({
            data: {
              tenantId: tenant.id,
              userId: user.id,
              role: 'owner',
              status: 'active',
              acceptedAt: new Date(),
            },
          });
          created = true;
        }

        await this.audit.recordWithin(tx, {
          action: 'panorama.tenant.ownership_restored',
          resourceType: 'tenant',
          resourceId: tenant.id,
          tenantId: tenant.id,
          actorUserId: user.id,
          metadata: {
            operatorEmail: params.operatorEmail,
            reason: params.reason.trim(),
            targetEmail: email,
            membershipId: membership.id,
            previouslyExisted: !created,
            previousRole: existing?.role ?? null,
            previousStatus: existing?.status ?? null,
          },
        });

        return { membership, created };
      },
      { reason: `tenant:nominateOwner:${params.tenantSlug}` },
    );
    // ADR-0010 explicit invalidation — both the update and create
    // paths above change membership.status/role so a cached PAT
    // decision for this (userId, tenantId) must be discarded.
    await this.patCache.invalidate(outcome.membership.userId, outcome.membership.tenantId);
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  async countActiveOwners(tenantId: string): Promise<number> {
    return this.prisma.runInTenant(
      tenantId,
      (tx) =>
        tx.tenantMembership.count({
          where: { tenantId, role: 'owner', status: 'active' },
        }),
    );
  }

  private auditActionForTransition(
    existing: TenantMembership,
    next: { role: MembershipRole; status: MembershipStatus },
  ): string {
    if (existing.role !== 'owner' && next.role === 'owner') {
      return 'panorama.tenant.owner_promoted';
    }
    if (existing.role === 'owner' && next.role !== 'owner') {
      return 'panorama.tenant.owner_demoted';
    }
    if (existing.status !== next.status) {
      return `panorama.tenant.membership_${next.status}`;
    }
    return 'panorama.tenant.membership_updated';
  }

  private isOwnerInvariantViolation(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const meta = err.meta?.['message'];
      const msg = typeof meta === 'string' ? meta : String(err.message ?? '');
      return msg.includes('TENANT_MUST_HAVE_AT_LEAST_ONE_OWNER');
    }
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      return String(err.message).includes('TENANT_MUST_HAVE_AT_LEAST_ONE_OWNER');
    }
    if (err instanceof Error) {
      return err.message.includes('TENANT_MUST_HAVE_AT_LEAST_ONE_OWNER');
    }
    return false;
  }
}

// Silence unused import lints on Nest exception types referenced only in comments.
export { ForbiddenException };
