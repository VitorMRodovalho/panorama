import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentTenantId } from '../tenant/tenant.context.js';

export interface AssetListItem {
  id: string;
  tag: string;
  name: string;
  status: string;
  bookable: boolean;
  modelName: string | null;
  categoryName: string | null;
}

@Injectable()
export class AssetService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: { limit?: number; cursor?: string } = {}): Promise<AssetListItem[]> {
    const tenantId = currentTenantId();
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const rows = await tx.asset.findMany({
        take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          model: { include: { category: true } },
        },
      });
      return rows.map<AssetListItem>((r) => ({
        id: r.id,
        tag: r.tag,
        name: r.name,
        status: r.status,
        bookable: r.bookable,
        modelName: r.model?.name ?? null,
        categoryName: r.model?.category?.name ?? null,
      }));
    });
  }
}
