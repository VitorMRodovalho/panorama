import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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

/**
 * Read-only summary endpoint for the "single-Owner warning" banner
 * that lives in the web app. Any member of the tenant can see it —
 * transparency about who owns the tenant they belong to is fine, and
 * the admin UI uses it to nudge a single Owner into inviting a
 * second. Lives on a separate controller path so it isn't lumped
 * under Owner-only authorisation.
 */
@Controller('tenants/:tenantId')
export class TenantOwnershipController {
  constructor(private readonly tenants: TenantAdminService) {}

  @Get('ownership-summary')
  async summary(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<{ tenantId: string; activeOwners: number; isSpof: boolean }> {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    if (session.currentTenantId !== tenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    const activeOwners = await this.tenants.countActiveOwners(tenantId);
    return { tenantId, activeOwners, isSpof: activeOwners <= 1 };
  }
}

/**
 * Tenant settings (Round 4 PR5 / #48). Owner-only for writes; admin
 * (owner / fleet_admin) reads are permitted because the settings UI
 * surfaces the current state inside the admin shell and a fleet_admin
 * may want to read-only inspect before recommending the Owner flip.
 *
 * Lives on a dedicated controller path so the Owner-only authz check
 * doesn't accidentally cover read-eligible endpoints in the same
 * controller (mirrors the OwnershipController pattern above).
 */
const UpdateSettingsSchema = z
  .object({
    autoOpenMaintenanceFromInspection: z.boolean().optional(),
  })
  .refine((v) => v.autoOpenMaintenanceFromInspection !== undefined, {
    message: 'at_least_one_field_required',
  });

const ADMIN_READ_ROLES = new Set(['owner', 'fleet_admin']);

@Controller('tenants/:tenantId/settings')
export class TenantSettingsController {
  constructor(private readonly tenants: TenantAdminService) {}

  @Get()
  async get(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireAdminRead(req, tenantId);
    void session;
    return this.tenants.getSettings(tenantId);
  }

  @Patch()
  @HttpCode(200)
  async update(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const parsed = UpdateSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    return this.tenants.updateSettings({
      tenantId,
      ...(parsed.data.autoOpenMaintenanceFromInspection !== undefined
        ? {
            autoOpenMaintenanceFromInspection:
              parsed.data.autoOpenMaintenanceFromInspection,
          }
        : {}),
      actorUserId: session.userId,
    });
  }

  private requireAdminRead(req: Request, tenantId: string): PanoramaSession {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    if (session.currentTenantId !== tenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    if (!ADMIN_READ_ROLES.has(session.currentRole)) {
      throw new UnauthorizedException('admin_role_required');
    }
    return session;
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
