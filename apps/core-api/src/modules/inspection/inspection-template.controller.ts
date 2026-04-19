import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import {
  CreateInspectionTemplateSchema,
  ListInspectionTemplatesSchema,
  UpdateInspectionTemplateSchema,
} from './inspection-template.dto.js';
import {
  InspectionTemplateService,
  type InspectionTemplateActor,
  type InspectionTemplateRow,
} from './inspection-template.service.js';
import { getRequestSession } from '../auth/session.middleware.js';
import type { PanoramaSession } from '../auth/session.types.js';

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

/**
 * Inspection-template HTTP surface (ADR-0012 §Execution-order step 7).
 *
 * Auth model:
 *   - GET endpoints: any authenticated tenant member (drivers need
 *     the launcher list).
 *   - POST/PATCH/DELETE: owner | fleet_admin only.
 *
 * Tenant isolation: actor.tenantId = session.currentTenantId; service
 * runs every Prisma call through `runInTenant` so the row never
 * crosses tenants regardless of the URL parameter the caller sends.
 */
@Controller('inspection-templates')
export class InspectionTemplateController {
  constructor(private readonly templates: InspectionTemplateService) {}

  @Get()
  async list(
    @Query('assetId') assetId: string | undefined,
    @Query('categoryKind') categoryKind: string | undefined,
    @Query('includeArchived') includeArchived: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: InspectionTemplateRow[] }> {
    const actor = this.actorFromSession(req);
    const parsed = ListInspectionTemplatesSchema.safeParse({
      assetId,
      categoryKind,
      includeArchived,
      limit,
    });
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const items = await this.templates.list(actor, parsed.data);
    return { items };
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<InspectionTemplateRow> {
    const actor = this.actorFromSession(req);
    return this.templates.get(actor, id);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<InspectionTemplateRow> {
    const actor = this.actorFromSession(req);
    this.assertAdmin(actor.role);
    const parsed = CreateInspectionTemplateSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new BadRequestException(first?.message ?? 'invalid_body');
    }
    return this.templates.create(actor, parsed.data);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<InspectionTemplateRow> {
    const actor = this.actorFromSession(req);
    this.assertAdmin(actor.role);
    const parsed = UpdateInspectionTemplateSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new BadRequestException(first?.message ?? 'invalid_body');
    }
    return this.templates.update(actor, id, parsed.data);
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const actor = this.actorFromSession(req);
    this.assertAdmin(actor.role);
    await this.templates.archive(actor, id);
  }

  private actorFromSession(req: Request): InspectionTemplateActor {
    const session = requireSession(req);
    return {
      tenantId: session.currentTenantId,
      userId: session.userId,
      role: session.currentRole,
    };
  }

  private assertAdmin(role: string): void {
    if (!ADMIN_ROLES.has(role)) {
      throw new ForbiddenException('admin_role_required');
    }
  }
}

function requireSession(req: Request): PanoramaSession {
  const s = getRequestSession(req);
  if (!s) throw new UnauthorizedException('authentication_required');
  return s;
}
