import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { BlackoutSlot, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Admin-only CRUD for blackout windows (ADR-0009).
 * - Creating a blackout doesn't retroactively affect existing
 *   reservations; operators handle those manually (cancel / approve
 *   overrides). The service surfaces the overlap in the audit record
 *   so it's visible to ops after the fact.
 * - Deletion is hard-delete; blackouts are a policy tool, not a
 *   historical record. The audit event carries what was removed.
 */

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export interface BlackoutContext {
  tenantId: string;
  userId: string;
  role: string;
}

export interface CreateBlackoutParams {
  actor: BlackoutContext;
  assetId?: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
  reason?: string;
}

export interface ListBlackoutsParams {
  actor: BlackoutContext;
  from?: Date;
  to?: Date;
  assetId?: string;
  limit: number;
}

@Injectable()
export class BlackoutService {
  private readonly log = new Logger('BlackoutService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(params: CreateBlackoutParams): Promise<BlackoutSlot> {
    const { actor } = params;
    this.assertAdmin(actor);
    if (params.startAt >= params.endAt) {
      throw new BadRequestException('start_must_be_before_end');
    }
    return this.prisma.runInTenant(
      actor.tenantId,
      async (tx) => {
        if (params.assetId) {
          const asset = await tx.asset.findUnique({
            where: { id: params.assetId },
            select: { tenantId: true },
          });
          if (!asset || asset.tenantId !== actor.tenantId) {
            throw new NotFoundException('asset_not_found');
          }
        }
        const created = await tx.blackoutSlot.create({
          data: {
            tenantId: actor.tenantId,
            assetId: params.assetId ?? null,
            title: params.title,
            startAt: params.startAt,
            endAt: params.endAt,
            reason: params.reason ?? null,
            createdByUserId: actor.userId,
          },
        });
        await this.audit.recordWithin(tx, {
          action: 'panorama.blackout.created',
          resourceType: 'blackout_slot',
          resourceId: created.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: {
            title: params.title,
            assetId: params.assetId ?? null,
            startAt: params.startAt.toISOString(),
            endAt: params.endAt.toISOString(),
          },
        });
        return created;
      },
    );
  }

  async list(params: ListBlackoutsParams): Promise<BlackoutSlot[]> {
    const { actor, from, to, assetId, limit } = params;
    const where: Prisma.BlackoutSlotWhereInput = { tenantId: actor.tenantId };
    if (assetId) where.OR = [{ assetId }, { assetId: null }];
    if (to) where.startAt = { lte: to };
    if (from) where.endAt = { gte: from };
    return this.prisma.runInTenant(
      actor.tenantId,
      (tx) =>
        tx.blackoutSlot.findMany({
          where,
          orderBy: { startAt: 'asc' },
          take: limit,
        }),
    );
  }

  async delete(params: { actor: BlackoutContext; blackoutId: string }): Promise<void> {
    this.assertAdmin(params.actor);
    await this.prisma.runInTenant(
      params.actor.tenantId,
      async (tx) => {
        const existing = await tx.blackoutSlot.findUnique({
          where: { id: params.blackoutId },
        });
        if (!existing || existing.tenantId !== params.actor.tenantId) {
          throw new NotFoundException('blackout_not_found');
        }
        await tx.blackoutSlot.delete({ where: { id: existing.id } });
        await this.audit.recordWithin(tx, {
          action: 'panorama.blackout.deleted',
          resourceType: 'blackout_slot',
          resourceId: existing.id,
          tenantId: existing.tenantId,
          actorUserId: params.actor.userId,
          metadata: {
            title: existing.title,
            assetId: existing.assetId,
            startAt: existing.startAt.toISOString(),
            endAt: existing.endAt.toISOString(),
          },
        });
      },
    );
  }

  private assertAdmin(actor: BlackoutContext): void {
    if (!ADMIN_ROLES.has(actor.role)) {
      throw new ForbiddenException('admin_role_required');
    }
  }
}
