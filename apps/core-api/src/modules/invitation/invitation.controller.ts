import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CreateInvitationSchema,
  ListInvitationsSchema,
  AcceptInvitationSchema,
} from './invitation.dto.js';
import { InvitationService } from './invitation.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionService } from '../auth/session.service.js';
import type { PanoramaSession } from '../auth/session.types.js';

/**
 * REST surface for the invitation flow.
 *
 * Admin-facing (session required + tenant match):
 *   * POST   /invitations          — create
 *   * GET    /invitations          — list for ?tenantId=
 *   * POST   /invitations/:id/resend
 *   * POST   /invitations/:id/revoke
 *
 * Public / lightly-authenticated:
 *   * GET    /invitations/accept?t=<token>  — preview (safe, read-only)
 *   * POST   /invitations/accept?t=<token>  — finalise (requires session;
 *       rebuilds the session cookie to include the new membership)
 */
@Controller('invitations')
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  // ---------------------------------------------------------------------
  // Admin endpoints
  // ---------------------------------------------------------------------

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const session = this.requireAdmin(req, extractTenantIdFromBody(body));
    const parsed = CreateInvitationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');
    if (parsed.data.tenantId !== session.currentTenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }

    const created = await this.invitations.create({
      tenantId: parsed.data.tenantId,
      email: parsed.data.email,
      role: parsed.data.role,
      ...(parsed.data.ttlSeconds !== undefined ? { ttlSeconds: parsed.data.ttlSeconds } : {}),
      actorUserId: session.userId,
      actorIp: req.ip ?? null,
      actorUserAgent: req.headers['user-agent'] ?? null,
    });
    return created;
  }

  @Get()
  async list(
    @Query('tenantId') tenantId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = this.requireAdmin(req, tenantId);
    const parsed = ListInvitationsSchema.safeParse({ tenantId, status, limit });
    if (!parsed.success) throw new BadRequestException('invalid_query');
    if (parsed.data.tenantId !== session.currentTenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    const listParams: Parameters<InvitationService['list']>[0] = {
      tenantId: parsed.data.tenantId,
    };
    if (parsed.data.status !== undefined) listParams.status = parsed.data.status;
    if (parsed.data.limit !== undefined) listParams.limit = parsed.data.limit;
    const items = await this.invitations.list(listParams);
    return { items };
  }

  @Post(':id/resend')
  @HttpCode(200)
  async resend(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const session = requireSession(req);
    this.assertAdmin(session);
    const updated = await this.invitations.resend({
      invitationId: id,
      tenantId: session.currentTenantId,
      actorUserId: session.userId,
    });
    return updated;
  }

  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const session = requireSession(req);
    this.assertAdmin(session);
    await this.invitations.revoke({
      invitationId: id,
      tenantId: session.currentTenantId,
      actorUserId: session.userId,
    });
  }

  // ---------------------------------------------------------------------
  // Public acceptance endpoints
  // ---------------------------------------------------------------------

  @Get('accept')
  async previewAccept(
    @Query('t') token: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    const parsed = AcceptInvitationSchema.safeParse({ t: token });
    if (!parsed.success) throw new BadRequestException('invalid_token');

    const session = getRequestSession(req);
    const state = await this.invitations.previewAccept(
      parsed.data.t,
      session ? { userId: session.userId, email: session.email } : null,
    );
    return state;
  }

  @Post('accept')
  @HttpCode(200)
  async finalizeAccept(
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const parsed = AcceptInvitationSchema.safeParse({ t: token });
    if (!parsed.success) throw new BadRequestException('invalid_token');

    const session = getRequestSession(req);
    if (!session) {
      return { state: 'needs_login' };
    }

    const result = await this.invitations.finalizeAccept({
      token: parsed.data.t,
      sessionUserId: session.userId,
      sessionEmail: session.email,
    });

    if (result.state === 'accepted') {
      // Rebuild + re-emit the session cookie so the new membership is
      // visible to the web app on the next request without logging out.
      const refreshed = await this.auth.buildSessionForUser(session.userId, session.provider);
      const next: PanoramaSession = {
        ...refreshed,
        currentTenantId: result.tenantId,
        currentRole: result.role,
      };
      await this.sessions.setSession(req, res, next);
    }

    return result;
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private requireAdmin(req: Request, tenantIdHint: string | undefined): PanoramaSession {
    const session = requireSession(req);
    if (tenantIdHint && tenantIdHint !== session.currentTenantId) {
      throw new UnauthorizedException('tenant_mismatch');
    }
    this.assertAdmin(session);
    return session;
  }

  private assertAdmin(session: PanoramaSession): void {
    if (session.currentRole !== 'owner' && session.currentRole !== 'fleet_admin') {
      throw new UnauthorizedException('admin_role_required');
    }
  }
}

function requireSession(req: Request): PanoramaSession {
  const s = getRequestSession(req);
  if (!s) throw new UnauthorizedException('authentication_required');
  return s;
}

function extractTenantIdFromBody(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'tenantId' in body) {
    const v = (body as { tenantId: unknown }).tenantId;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}
