import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApprovalDecisionSchema,
  CancelReservationSchema,
  CreateBlackoutSchema,
  CreateReservationSchema,
  ListBlackoutsSchema,
  ListReservationsSchema,
} from './reservation.dto.js';
import {
  ReservationService,
  type ReservationContext,
} from './reservation.service.js';
import { BlackoutService } from './blackout.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';

@Controller('reservations')
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = CreateReservationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const created = await this.reservations.create({
      actor,
      assetId: parsed.data.assetId ?? null,
      ...(parsed.data.onBehalfUserId ? { onBehalfUserId: parsed.data.onBehalfUserId } : {}),
      startAt: new Date(parsed.data.startAt),
      endAt: new Date(parsed.data.endAt),
      ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
    });
    return this.shape(created);
  }

  @Get()
  async list(
    @Query('scope') scope: string | undefined,
    @Query('status') status: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ListReservationsSchema.safeParse({
      scope,
      status,
      from,
      to,
      limit,
    });
    if (!parsed.success) throw new BadRequestException('invalid_query');

    const listParams: Parameters<ReservationService['list']>[0] = {
      actor,
      scope: parsed.data.scope,
      status: parsed.data.status,
      limit: parsed.data.limit,
    };
    if (parsed.data.from) listParams.from = new Date(parsed.data.from);
    if (parsed.data.to) listParams.to = new Date(parsed.data.to);
    const items = await this.reservations.list(listParams);
    return { items: items.map((r) => this.shape(r)) };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = CancelReservationSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid_body');
    const cancelParams: Parameters<ReservationService['cancel']>[0] = {
      actor,
      reservationId: id,
    };
    if (parsed.data.reason) cancelParams.reason = parsed.data.reason;
    const updated = await this.reservations.cancel(cancelParams);
    return this.shape(updated);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ApprovalDecisionSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid_body');
    const approveParams: Parameters<ReservationService['approve']>[0] = {
      actor,
      reservationId: id,
    };
    if (parsed.data.note) approveParams.note = parsed.data.note;
    const updated = await this.reservations.approve(approveParams);
    return this.shape(updated);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ApprovalDecisionSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('invalid_body');
    const rejectParams: Parameters<ReservationService['reject']>[0] = {
      actor,
      reservationId: id,
    };
    if (parsed.data.note) rejectParams.note = parsed.data.note;
    const updated = await this.reservations.reject(rejectParams);
    return this.shape(updated);
  }

  private shape(r: {
    id: string;
    tenantId: string;
    assetId: string | null;
    requesterUserId: string;
    onBehalfUserId: string | null;
    startAt: Date;
    endAt: Date;
    purpose: string | null;
    approvalStatus: string;
    lifecycleStatus: string;
    approverUserId: string | null;
    approvedAt: Date | null;
    approvalNote: string | null;
    cancelledAt: Date | null;
    cancelledByUserId: string | null;
    cancelReason: string | null;
    createdAt: Date;
  }): unknown {
    return {
      id: r.id,
      tenantId: r.tenantId,
      assetId: r.assetId,
      requesterUserId: r.requesterUserId,
      onBehalfUserId: r.onBehalfUserId,
      startAt: r.startAt,
      endAt: r.endAt,
      purpose: r.purpose,
      approvalStatus: r.approvalStatus,
      lifecycleStatus: r.lifecycleStatus,
      approverUserId: r.approverUserId,
      approvedAt: r.approvedAt,
      approvalNote: r.approvalNote,
      cancelledAt: r.cancelledAt,
      cancelledByUserId: r.cancelledByUserId,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt,
    };
  }

  private actorFromSession(req: Request): ReservationContext {
    const session = requireSession(req);
    return {
      tenantId: session.currentTenantId,
      userId: session.userId,
      role: session.currentRole,
      isVip: session.isVip,
    };
  }
}

@Controller('blackouts')
export class BlackoutController {
  constructor(private readonly blackouts: BlackoutService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const session = requireSession(req);
    const parsed = CreateBlackoutSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invalid_body');

    const createParams: Parameters<BlackoutService['create']>[0] = {
      actor: { tenantId: session.currentTenantId, userId: session.userId, role: session.currentRole },
      title: parsed.data.title,
      startAt: new Date(parsed.data.startAt),
      endAt: new Date(parsed.data.endAt),
    };
    if (parsed.data.assetId !== undefined) {
      createParams.assetId = parsed.data.assetId;
    }
    if (parsed.data.reason) createParams.reason = parsed.data.reason;
    const created = await this.blackouts.create(createParams);
    return this.shape(created);
  }

  @Get()
  async list(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('assetId') assetId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<unknown> {
    const session = requireSession(req);
    const parsed = ListBlackoutsSchema.safeParse({ from, to, assetId, limit });
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const listParams: Parameters<BlackoutService['list']>[0] = {
      actor: { tenantId: session.currentTenantId, userId: session.userId, role: session.currentRole },
      limit: parsed.data.limit,
    };
    if (parsed.data.from) listParams.from = new Date(parsed.data.from);
    if (parsed.data.to) listParams.to = new Date(parsed.data.to);
    if (parsed.data.assetId) listParams.assetId = parsed.data.assetId;
    const items = await this.blackouts.list(listParams);
    return { items: items.map((b) => this.shape(b)) };
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const session = requireSession(req);
    await this.blackouts.delete({
      actor: { tenantId: session.currentTenantId, userId: session.userId, role: session.currentRole },
      blackoutId: id,
    });
  }

  private shape(b: {
    id: string;
    tenantId: string;
    assetId: string | null;
    title: string;
    startAt: Date;
    endAt: Date;
    reason: string | null;
    createdByUserId: string;
    createdAt: Date;
  }): unknown {
    return {
      id: b.id,
      tenantId: b.tenantId,
      assetId: b.assetId,
      title: b.title,
      startAt: b.startAt,
      endAt: b.endAt,
      reason: b.reason,
      createdByUserId: b.createdByUserId,
      createdAt: b.createdAt,
    };
  }
}

function requireSession(req: Request): PanoramaSession {
  const s = getRequestSession(req);
  if (!s) throw new UnauthorizedException('authentication_required');
  return s;
}

// Kept so deliberately-unused imports don't silently rot during refactors.
export { ForbiddenException, NotFoundException };
