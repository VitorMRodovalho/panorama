import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Snipe-IT compatibility shim read service (ADR-0010 step 6).
 *
 * Each method shapes Panorama rows into the JSON subset that
 * SnipeScheduler-FleetManager/src/snipeit_client.php actually reads:
 *
 *   * `{ rows: [...], total: N }` for list endpoints
 *   * Nested `{ id, name }` relationship blocks for model / category /
 *     manufacturer references
 *   * `status_label` object for assets (Snipe-IT keeps status as a
 *     sub-entity; we synthesise it from our `AssetStatus` enum)
 *
 * The tenant scope is passed in from the PAT actor — not read from
 * ALS — because the PatAuthGuard establishes identity outside the
 * session-cookie context path, and the compat module keeps its
 * dependencies explicit rather than reaching into request-scoped
 * state it doesn't own.
 *
 * IDs are returned as strings (Panorama UUIDs). FleetManager's
 * `snipeit_client.php` PHPdoc types them as `int`; a migration to
 * Panorama shim requires relaxing that type. Documented in the
 * step-7 integration test header.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(raw)));
}

function clampOffset(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.trunc(raw);
}

/**
 * Map Panorama's AssetStatus enum to a Snipe-IT-shaped `status_label`
 * object. Snipe-IT distinguishes `deployable` (available),
 * `pending` (awaiting receipt), `archived` (retired), `undeployable`
 * (broken). We collapse to these four since the FleetManager client
 * branches only on `status_type`, never on the internal `id`.
 */
function statusLabelFor(status: string): {
  id: null;
  name: string;
  status_type: 'deployable' | 'pending' | 'archived' | 'undeployable';
} {
  switch (status) {
    case 'READY':
    case 'RESERVED':
      return { id: null, name: status, status_type: 'deployable' };
    case 'IN_USE':
      return { id: null, name: status, status_type: 'deployable' };
    case 'MAINTENANCE':
      return { id: null, name: status, status_type: 'undeployable' };
    case 'RETIRED':
      return { id: null, name: status, status_type: 'archived' };
    default:
      return { id: null, name: status, status_type: 'pending' };
  }
}

export interface SnipeitListParams {
  tenantId: string;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface SnipeitHardwareListParams extends SnipeitListParams {
  categoryId?: string;
  requestableOnly?: boolean;
}

export interface SnipeitModelsListParams extends SnipeitListParams {
  categoryId?: string;
}

@Injectable()
export class SnipeitCompatService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- hardware (assets) -------------------------------------------

  async listHardware(params: SnipeitHardwareListParams): Promise<{
    total: number;
    rows: unknown[];
  }> {
    const limit = clampLimit(params.limit);
    const offset = clampOffset(params.offset);

    const where: Prisma.AssetWhereInput = { archivedAt: null };
    if (params.search) {
      where.OR = [
        { tag: { contains: params.search, mode: 'insensitive' } },
        { name: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.requestableOnly) {
      where.bookable = true;
    }
    if (params.categoryId) {
      where.model = { categoryId: params.categoryId };
    }

    return this.prisma.runInTenant(params.tenantId, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.asset.count({ where }),
        tx.asset.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: {
            model: {
              include: {
                category: true,
                manufacturer: true,
              },
            },
          },
        }),
      ]);
      return { total, rows: rows.map((r) => this.shapeAsset(r)) };
    });
  }

  async getHardware(tenantId: string, id: string): Promise<unknown | null> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const row = await tx.asset.findUnique({
        where: { id },
        include: {
          model: {
            include: {
              category: true,
              manufacturer: true,
            },
          },
        },
      });
      if (!row) return null;
      return this.shapeAsset(row);
    });
  }

  private shapeAsset(r: {
    id: string;
    tag: string;
    name: string;
    serial: string | null;
    status: string;
    bookable: boolean;
    model: {
      id: string;
      name: string;
      category: { id: string; name: string } | null;
      manufacturer: { id: string; name: string } | null;
    } | null;
  }): unknown {
    return {
      id: r.id,
      name: r.name,
      asset_tag: r.tag,
      serial: r.serial,
      status_label: statusLabelFor(r.status),
      requestable: r.bookable,
      model: r.model ? { id: r.model.id, name: r.model.name } : null,
      category: r.model?.category
        ? { id: r.model.category.id, name: r.model.category.name }
        : null,
      manufacturer: r.model?.manufacturer
        ? { id: r.model.manufacturer.id, name: r.model.manufacturer.name }
        : null,
    };
  }

  // ---- users --------------------------------------------------------

  async listUsers(
    params: SnipeitListParams,
  ): Promise<{ total: number; rows: unknown[] }> {
    const limit = clampLimit(params.limit);
    const offset = clampOffset(params.offset);

    // Users are global; the tenant filter lives in tenant_memberships.
    // We list users who have an active membership in the actor's
    // tenant, so a PAT in tenant A can't read tenant B's user roster.
    return this.prisma.runInTenant(params.tenantId, async (tx) => {
      const base: Prisma.TenantMembershipWhereInput = {
        tenantId: params.tenantId,
        status: 'active',
        // ADR-0016 §1 — system actors are audit-attribution accounts
        // (no AuthIdentity, never log in). They MUST NOT appear in
        // any tenant-roster surface, since they're an implementation
        // detail not a real user.
        role: { not: 'system' },
      };
      if (params.search) {
        base.user = {
          OR: [
            { email: { contains: params.search, mode: 'insensitive' } },
            { displayName: { contains: params.search, mode: 'insensitive' } },
          ],
        };
      }
      const [total, memberships] = await Promise.all([
        tx.tenantMembership.count({ where: base }),
        tx.tenantMembership.findMany({
          where: base,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: { user: true },
        }),
      ]);
      return {
        total,
        rows: memberships.map((m) => this.shapeUser(m.user, m.isVip)),
      };
    });
  }

  async getUser(tenantId: string, userId: string): Promise<unknown | null> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: { user: true },
      });
      if (!membership) return null;
      return this.shapeUser(membership.user, membership.isVip);
    });
  }

  private shapeUser(
    u: {
      id: string;
      email: string;
      displayName: string;
      firstName: string | null;
      lastName: string | null;
    },
    isVip: boolean,
  ): unknown {
    return {
      id: u.id,
      email: u.email,
      username: u.email, // Snipe-IT returns username; our users log in by email
      first_name: u.firstName ?? null,
      last_name: u.lastName ?? null,
      name: u.displayName,
      vip: isVip,
    };
  }

  // ---- categories ---------------------------------------------------

  async listCategories(
    params: SnipeitListParams,
  ): Promise<{ total: number; rows: unknown[] }> {
    const limit = clampLimit(params.limit);
    const offset = clampOffset(params.offset);

    const where: Prisma.CategoryWhereInput = { tenantId: params.tenantId };
    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }
    return this.prisma.runInTenant(params.tenantId, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.category.count({ where }),
        tx.category.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { name: 'asc' },
        }),
      ]);
      return {
        total,
        rows: rows.map((c) => ({
          id: c.id,
          name: c.name,
          category_type: this.snipeCategoryType(c.kind),
        })),
      };
    });
  }

  private snipeCategoryType(kind: string): string {
    // Our CategoryKind is VEHICLE | EQUIPMENT | CONSUMABLE | etc. Snipe-IT
    // uses 'asset' | 'accessory' | 'consumable' | 'component' | 'license'.
    // VEHICLE + EQUIPMENT both map to 'asset' — the FleetManager client
    // only branches on literal 'asset', so the mapping is lossless for
    // the consumer.
    switch (kind) {
      case 'CONSUMABLE':
        return 'consumable';
      case 'LICENSE':
        return 'license';
      case 'COMPONENT':
        return 'component';
      case 'ACCESSORY':
        return 'accessory';
      default:
        return 'asset';
    }
  }

  // ---- models -------------------------------------------------------

  async listModels(
    params: SnipeitModelsListParams,
  ): Promise<{ total: number; rows: unknown[] }> {
    const limit = clampLimit(params.limit);
    const offset = clampOffset(params.offset);

    const where: Prisma.AssetModelWhereInput = { tenantId: params.tenantId };
    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }
    if (params.categoryId) {
      where.categoryId = params.categoryId;
    }
    return this.prisma.runInTenant(params.tenantId, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.assetModel.count({ where }),
        tx.assetModel.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: { name: 'asc' },
          include: {
            category: true,
            manufacturer: true,
            _count: { select: { assets: { where: { bookable: true, archivedAt: null } } } },
          },
        }),
      ]);
      return {
        total,
        rows: rows.map((m) => ({
          id: m.id,
          name: m.name,
          model_number: m.modelNumber,
          image: m.imageUrl ?? null,
          // `requestable` is per-model in Snipe-IT — we derive it as
          // "at least one bookable, non-archived asset currently exists
          // for this model". Good enough for the FleetManager
          // get_bookable_models path which filters on truthy.
          requestable: m._count.assets > 0,
          category: m.category ? { id: m.category.id, name: m.category.name } : null,
          manufacturer: m.manufacturer
            ? { id: m.manufacturer.id, name: m.manufacturer.name }
            : null,
        })),
      };
    });
  }

  async getModel(tenantId: string, id: string): Promise<unknown | null> {
    return this.prisma.runInTenant(tenantId, async (tx) => {
      const row = await tx.assetModel.findUnique({
        where: { id },
        include: {
          category: true,
          manufacturer: true,
          _count: { select: { assets: { where: { bookable: true, archivedAt: null } } } },
        },
      });
      if (!row || row.tenantId !== tenantId) return null;
      return {
        id: row.id,
        name: row.name,
        model_number: row.modelNumber,
        image: row.imageUrl ?? null,
        requestable: row._count.assets > 0,
        category: row.category ? { id: row.category.id, name: row.category.name } : null,
        manufacturer: row.manufacturer
          ? { id: row.manufacturer.id, name: row.manufacturer.name }
          : null,
      };
    });
  }
}
