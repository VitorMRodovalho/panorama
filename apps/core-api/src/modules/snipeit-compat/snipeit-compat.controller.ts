import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PatAuthGuard } from './pat-auth.guard.js';
import { RequireScope, ScopeGuard } from './scope.guard.js';
import { SnipeitCompatService } from './snipeit-compat.service.js';

const SCOPE_READ = 'snipeit.compat.read';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
});
const HardwareListQuerySchema = ListQuerySchema.extend({
  category_id: z.string().uuid().optional(),
  requestable: z
    .string()
    .optional()
    .transform((v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : undefined)),
});
const ModelsListQuerySchema = ListQuerySchema.extend({
  category_id: z.string().uuid().optional(),
});

/**
 * Snipe-IT compatibility shim controllers.
 *
 * Mounted at `/api/v1` — every route authenticates via
 * `Authorization: Bearer pnrm_pat_<...>` (ADR-0010). Session cookies
 * are ignored here; the `PatAuthGuard` rejects them at the boundary.
 *
 * The `whoami` route is a diagnostic — it lets a FleetManager
 * operator validate their token + prefix + tenant binding without
 * consulting the DB directly. Other routes (hardware, users,
 * categories, models) land in step 6.
 */
@Controller('api/v1')
@UseGuards(PatAuthGuard, ScopeGuard)
export class SnipeitCompatController {
  constructor(private readonly svc: SnipeitCompatService) {}

  private patActor(req: Request): { userId: string; tenantId: string; scopes: string[]; tokenId: string } {
    const actor = req.actor;
    if (!actor || actor.kind !== 'pat') {
      // PatAuthGuard populates this; if we reach here without it,
      // guard order is broken — fail loudly, not silently.
      throw new BadRequestException('actor_missing');
    }
    return actor;
  }

  @Get('whoami')
  @RequireScope(SCOPE_READ)
  whoami(@Req() req: Request): unknown {
    const actor = this.patActor(req);
    return {
      kind: 'pat',
      userId: actor.userId,
      tenantId: actor.tenantId,
      scopes: actor.scopes,
      tokenId: actor.tokenId,
    };
  }

  // ---- hardware (assets) -----------------------------------------

  @Get('hardware')
  @RequireScope(SCOPE_READ)
  async listHardware(@Query() query: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const parsed = HardwareListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const p: Parameters<SnipeitCompatService['listHardware']>[0] = {
      tenantId: actor.tenantId,
    };
    if (parsed.data.limit !== undefined) p.limit = parsed.data.limit;
    if (parsed.data.offset !== undefined) p.offset = parsed.data.offset;
    if (parsed.data.search) p.search = parsed.data.search;
    if (parsed.data.category_id) p.categoryId = parsed.data.category_id;
    if (parsed.data.requestable !== undefined) p.requestableOnly = parsed.data.requestable;
    return this.svc.listHardware(p);
  }

  @Get('hardware/:id')
  @RequireScope(SCOPE_READ)
  async getHardware(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const row = await this.svc.getHardware(actor.tenantId, id);
    if (!row) throw new NotFoundException('asset_not_found');
    return row;
  }

  // ---- users -----------------------------------------------------

  @Get('users')
  @RequireScope(SCOPE_READ)
  async listUsers(@Query() query: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const parsed = ListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const p: Parameters<SnipeitCompatService['listUsers']>[0] = {
      tenantId: actor.tenantId,
    };
    if (parsed.data.limit !== undefined) p.limit = parsed.data.limit;
    if (parsed.data.offset !== undefined) p.offset = parsed.data.offset;
    if (parsed.data.search) p.search = parsed.data.search;
    return this.svc.listUsers(p);
  }

  @Get('users/:id')
  @RequireScope(SCOPE_READ)
  async getUser(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const row = await this.svc.getUser(actor.tenantId, id);
    if (!row) throw new NotFoundException('user_not_found');
    return row;
  }

  // ---- categories ------------------------------------------------

  @Get('categories')
  @RequireScope(SCOPE_READ)
  async listCategories(@Query() query: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const parsed = ListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const p: Parameters<SnipeitCompatService['listCategories']>[0] = {
      tenantId: actor.tenantId,
    };
    if (parsed.data.limit !== undefined) p.limit = parsed.data.limit;
    if (parsed.data.offset !== undefined) p.offset = parsed.data.offset;
    if (parsed.data.search) p.search = parsed.data.search;
    return this.svc.listCategories(p);
  }

  // ---- models ----------------------------------------------------

  @Get('models')
  @RequireScope(SCOPE_READ)
  async listModels(@Query() query: unknown, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const parsed = ModelsListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('invalid_query');
    const p: Parameters<SnipeitCompatService['listModels']>[0] = {
      tenantId: actor.tenantId,
    };
    if (parsed.data.limit !== undefined) p.limit = parsed.data.limit;
    if (parsed.data.offset !== undefined) p.offset = parsed.data.offset;
    if (parsed.data.search) p.search = parsed.data.search;
    if (parsed.data.category_id) p.categoryId = parsed.data.category_id;
    return this.svc.listModels(p);
  }

  @Get('models/:id')
  @RequireScope(SCOPE_READ)
  async getModel(@Param('id') id: string, @Req() req: Request): Promise<unknown> {
    const actor = this.patActor(req);
    const row = await this.svc.getModel(actor.tenantId, id);
    if (!row) throw new NotFoundException('model_not_found');
    return row;
  }
}
