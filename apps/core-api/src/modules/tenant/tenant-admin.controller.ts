import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  TenantAdminService,
  ALLOWED_MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
} from './tenant-admin.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';

/**
 * Minimal admin surface for tenant memberships — ADR-0007 unblocks
 * promote / demote / suspend without waiting on the larger admin UI
 * planned for 0.3. Owner-only by design.
 *
 * Scoped under /tenants/:tenantId/memberships so URL parsing makes
 * cross-tenant modifications impossible to express even with a
 * malformed client.
 */
const UpdateMembershipSchema = z
  .object({
    role: z.enum(ALLOWED_MEMBERSHIP_ROLES).optional(),
    status: z.enum(MEMBERSHIP_STATUSES).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'at_least_one_field_required',
  });

@Controller('tenants/:tenantId/memberships')
export class TenantAdminController {
  constructor(private readonly tenants: TenantAdminService) {}

  @Patch(':membershipId')
  @HttpCode(200)
  async update(
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const parsed = UpdateMembershipSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const updated = await this.tenants.updateMembership({
      tenantId,
      membershipId,
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      actorUserId: session.userId,
    });
    return {
      id: updated.id,
      tenantId: updated.tenantId,
      userId: updated.userId,
      role: updated.role,
      status: updated.status,
      updatedAt: updated.updatedAt,
    };
  }

  @Delete(':membershipId')
  @HttpCode(204)
  async delete(
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Req() req: Request,
  ): Promise<void> {
    const session = this.requireOwner(req, tenantId);
    await this.tenants.deleteMembership({
      tenantId,
      membershipId,
      actorUserId: session.userId,
    });
  }

  private requireOwner(req: Request, tenantId: string): PanoramaSession {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    if (session.currentTenantId !== tenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    if (session.currentRole !== 'owner') {
      throw new UnauthorizedException('owner_role_required');
    }
    return session;
  }
}
