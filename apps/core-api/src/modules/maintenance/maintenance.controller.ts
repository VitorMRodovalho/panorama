import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { MaintenanceService, type MaintenanceContext } from './maintenance.service.js';
import {
  ListTicketsSchema,
  OpenTicketSchema,
  UpdateStatusSchema,
} from './maintenance.dto.js';
import { getRequestSession } from '../auth/session.middleware.js';

@Controller('maintenances')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = OpenTicketSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const created = await this.maintenance.openTicket(actor, parsed.data);
    return this.shape(created);
  }

  @Get()
  async list(
    @Query() query: Record<string, string>,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = ListTicketsSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_query');
    }
    const params: Parameters<MaintenanceService['list']>[0] = { actor };
    if (parsed.data.status !== undefined) params.status = parsed.data.status;
    if (parsed.data.assetId !== undefined) params.assetId = parsed.data.assetId;
    if (parsed.data.assigneeUserId !== undefined) {
      params.assigneeUserId = parsed.data.assigneeUserId;
    }
    if (parsed.data.limit !== undefined) params.limit = parsed.data.limit;
    if (parsed.data.cursor !== undefined) params.cursor = parsed.data.cursor;
    const { items, nextCursor } = await this.maintenance.list(params);
    return { items: items.map((r) => this.shape(r)), nextCursor };
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const row = await this.maintenance.getById(actor, id);
    return this.shape(row);
  }

  @Patch(':id/status')
  @HttpCode(200)
  async updateStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<unknown> {
    const actor = this.actorFromSession(req);
    const parsed = UpdateStatusSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid_body');
    }
    const updated = await this.maintenance.updateStatus(actor, id, parsed.data);
    return this.shape(updated);
  }

  private actorFromSession(req: Request): MaintenanceContext {
    const session = getRequestSession(req);
    if (!session) throw new UnauthorizedException('authentication_required');
    return {
      tenantId: session.currentTenantId,
      userId: session.userId,
      role: session.currentRole,
    };
  }

  /**
   * REST projection of an AssetMaintenance row.
   *
   * Note: `notes` and `completionNote` are stored HTML-escaped at write
   * (security-reviewer blocker #3 in ADR-0016). Consumers receive the
   * escaped form over REST. Web layer renders as text node / React JSX
   * (auto-escaped) — never via dangerouslySetInnerHTML. Non-browser
   * integrations should treat these as opaque strings.
   */
  private shape(r: {
    id: string;
    tenantId: string;
    assetId: string;
    maintenanceType: string;
    title: string;
    status: string;
    severity: string | null;
    triggeringReservationId: string | null;
    triggeringInspectionId: string | null;
    assigneeUserId: string | null;
    startedAt: Date;
    supplierName: string | null;
    mileageAtService: number | null;
    expectedReturnAt: Date | null;
    nextServiceMileage: number | null;
    nextServiceDate: Date | null;
    cost: unknown;
    isWarranty: boolean;
    notes: string | null;
    completedAt: Date | null;
    completedByUserId: string | null;
    completionNote: string | null;
    createdAt: Date;
    createdByUserId: string;
  }): unknown {
    return {
      id: r.id,
      tenantId: r.tenantId,
      assetId: r.assetId,
      maintenanceType: r.maintenanceType,
      title: r.title,
      status: r.status,
      severity: r.severity,
      triggeringReservationId: r.triggeringReservationId,
      triggeringInspectionId: r.triggeringInspectionId,
      assigneeUserId: r.assigneeUserId,
      startedAt: r.startedAt.toISOString(),
      supplierName: r.supplierName,
      mileageAtService: r.mileageAtService,
      expectedReturnAt: r.expectedReturnAt ? r.expectedReturnAt.toISOString() : null,
      nextServiceMileage: r.nextServiceMileage,
      nextServiceDate: r.nextServiceDate ? r.nextServiceDate.toISOString() : null,
      cost: r.cost === null ? null : (r.cost as { toString(): string }).toString(),
      isWarranty: r.isWarranty,
      notes: r.notes,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      completedByUserId: r.completedByUserId,
      completionNote: r.completionNote,
      createdAt: r.createdAt.toISOString(),
      createdByUserId: r.createdByUserId,
    };
  }
}
