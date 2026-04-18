import { Controller, Get, Query, UnauthorizedException } from '@nestjs/common';
import { AssetService, type AssetListItem } from './asset.service.js';
import { currentTenantId } from '../tenant/tenant.context.js';

@Controller('assets')
export class AssetController {
  constructor(private readonly assets: AssetService) {}

  @Get()
  async list(
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ items: AssetListItem[]; total: number }> {
    // Belt + braces: Prisma RLS already blocks rows without a tenant,
    // but refusing to serve the request at the controller layer gives
    // the caller a clearer 401 than a confused empty result.
    if (!currentTenantId()) {
      throw new UnauthorizedException('Missing tenant context.');
    }

    const opts: { limit?: number; cursor?: string } = {};
    if (limitRaw) opts.limit = parseInt(limitRaw, 10);
    if (cursor) opts.cursor = cursor;
    const items = await this.assets.list(opts);
    return { items, total: items.length };
  }
}
