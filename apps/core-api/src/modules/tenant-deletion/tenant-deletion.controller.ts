import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';
import { TenantDeletionService } from './tenant-deletion.service.js';

/**
 * ADR-0020 §7 — tenant-deletion endpoints. Four routes under
 * `/tenants/:tenantId/...`, all Owner-only:
 *
 *   - POST /delete-request — Owner initiates; email fans out to ALL
 *     active Owners with a one-time confirmation token.
 *   - POST /delete-confirm — any Owner of the same tenant consumes
 *     the token; sets `Tenant.deletionScheduledAt = T+coolOffDays`.
 *   - POST /delete-cancel — any Owner cancels during the cool-off.
 *     Idempotent.
 *   - POST /delete-veto — peer Owner cancels with the distinct
 *     audit signal `TenantDeleteVeto(vetoSource=peer_owner)`. The
 *     vetoing Owner MUST NOT be the original requester
 *     (self-veto is just a cancel; routing through veto would
 *     pollute the SIEM signal).
 *
 * Auth contract:
 *   - Caller session present (logged-in).
 *   - `session.currentTenantId === :tenantId` (URL prevents
 *     cross-tenant by construction; we re-check here so a
 *     misrouted client still fails-closed).
 *   - `session.currentRole === 'owner'`.
 *
 * NOT covered in PR 3: platform-maintainer veto (admin console
 * surface). The hosted instance's maintainer can today only
 * cancel a tenant-deletion via direct DB UPDATE; future-PR work
 * adds an authenticated admin path with `vetoSource=platform_maintainer`.
 */

const ConfirmBodySchema = z.object({
  token: z.string().min(1).max(1024),
});

@Controller('tenants/:tenantId')
export class TenantDeletionController {
  private readonly log = new Logger('TenantDeletionController');

  constructor(private readonly deletion: TenantDeletionService) {}

  @Post('delete-request')
  @HttpCode(200)
  async request(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const result = await this.deletion.request({
      tenantId,
      requestedByUserId: session.userId,
    });
    if (result.kind === 'already_scheduled') {
      throw new ConflictException('deletion_already_scheduled');
    }
    if (result.kind === 'duplicate_request') {
      // Either the tenant is gone or an unconsumed token already
      // exists. From the caller's POV the operationally-correct
      // surface is the same — there is already a request in flight.
      throw new ConflictException('deletion_request_already_pending');
    }
    return {
      ok: true,
      tokenKeyPrefix: result.tokenKeyPrefix,
      ownerCount: result.ownerCount,
    };
  }

  @Post('delete-confirm')
  @HttpCode(200)
  async confirm(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const parsed = ConfirmBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const result = await this.deletion.confirm({
      tenantId,
      actorUserId: session.userId,
      token: parsed.data.token,
    });
    switch (result.kind) {
      case 'ok':
        return { ok: true, scheduledAt: result.scheduledAt.toISOString() };
      case 'missing':
      case 'expired':
      case 'already_consumed':
      case 'tenant_mismatch':
        // All four surface as the same client-facing error so an
        // attacker cannot enumerate token state. Operator triage
        // uses the per-result log line + (future) audit signal.
        this.log.warn({ tenantId, reason: result.kind }, 'delete_confirm_failed');
        throw new NotFoundException('verification_failed');
      case 'tenant_already_scheduled':
        // Race A — the cancel side already won (or another confirm
        // path beat us). Idempotent surface: return the current
        // state so the caller can re-read.
        throw new ConflictException('deletion_already_scheduled');
    }
  }

  @Post('delete-cancel')
  @HttpCode(200)
  async cancel(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const result = await this.deletion.cancel({
      tenantId,
      actorUserId: session.userId,
    });
    return {
      ok: true,
      previouslyScheduledAt:
        result.kind === 'ok'
          ? result.previouslyScheduledAt.toISOString()
          : null,
    };
  }

  @Post('delete-veto')
  @HttpCode(200)
  async veto(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireOwner(req, tenantId);
    const result = await this.deletion.veto({
      tenantId,
      actorUserId: session.userId,
    });
    if (result.kind === 'requester_self_veto_refused') {
      throw new ForbiddenException('requester_must_cancel_not_veto');
    }
    return {
      ok: true,
      previouslyScheduledAt:
        result.kind === 'ok'
          ? result.previouslyScheduledAt.toISOString()
          : null,
    };
  }

  private requireOwner(req: Request, tenantId: string): PanoramaSession {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    if (session.currentTenantId !== tenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    if (session.currentRole !== 'owner') {
      throw new ForbiddenException('owner_role_required');
    }
    return session;
  }
}
