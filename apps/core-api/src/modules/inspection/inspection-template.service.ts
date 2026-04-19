/**
 * InspectionTemplateService (ADR-0012 §1 + §Execution-order step 7).
 *
 * --- LOAD-BEARING MODULE INVARIANT (mandatory-runInTenant) ---
 * Every method in this file routes Prisma writes through
 * `prisma.runInTenant(tenantId, ...)` so RLS applies on the
 * inspection-domain tables. `runAsSuperAdmin` is FORBIDDEN here —
 * the only allowed escape is `AuditService.record` (which itself
 * lives outside this module). A grep gate + this head comment is
 * the enforcement mechanism for 0.3; ESLint custom rule comes 0.4.
 * Reviewer: if you see `runAsSuperAdmin` or any `tx.$executeRawUnsafe`
 * in this file, BLOCK the diff.
 * --------------------------------------------------------------
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CategoryKind, InspectionItemType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateInspectionTemplateInput,
  ListInspectionTemplatesInput,
  UpdateInspectionTemplateInput,
} from './inspection-template.dto.js';

export interface InspectionTemplateActor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface InspectionTemplateItemRow {
  id: string;
  position: number;
  label: string;
  itemType: InspectionItemType;
  required: boolean;
  photoRequired: boolean;
  minValue: number | null;
  maxValue: number | null;
  helpText: string | null;
}

export interface InspectionTemplateRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  categoryKind: CategoryKind | null;
  categoryId: string | null;
  displayOrder: number;
  archivedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  items: InspectionTemplateItemRow[];
}

@Injectable()
export class InspectionTemplateService {
  private readonly log = new Logger('InspectionTemplateService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** runInTenant — admin write. Returns the row + items. */
  async create(
    actor: InspectionTemplateActor,
    input: CreateInspectionTemplateInput,
  ): Promise<InspectionTemplateRow> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      // categoryId path: confirm the Category lives in this tenant.
      // RLS already filters, but a 404 is friendlier than empty rows.
      if (input.categoryId) {
        await this.assertCategoryInTenant(tx, input.categoryId);
      }
      const template = await tx.inspectionTemplate.create({
        data: {
          tenantId: actor.tenantId,
          name: input.name,
          description: input.description ?? null,
          categoryKind: input.categoryKind ?? null,
          categoryId: input.categoryId ?? null,
          displayOrder: input.displayOrder,
          createdByUserId: actor.userId,
        },
      });
      const items = await this.replaceItems(tx, actor.tenantId, template.id, input.items);

      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.template.created',
        resourceType: 'inspection_template',
        resourceId: template.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          name: template.name,
          scope: template.categoryId
            ? { kind: 'categoryId', value: template.categoryId }
            : { kind: 'categoryKind', value: template.categoryKind },
          itemCount: items.length,
        },
      });
      return shapeTemplate(template, items);
    });
  }

  /**
   * runInTenant — admin write. Items are fully replaced if `items` is
   * provided. Snapshot-on-start (§2) preserves shape for in-progress
   * inspections; this PATCH only affects future inspections.
   */
  async update(
    actor: InspectionTemplateActor,
    templateId: string,
    input: UpdateInspectionTemplateInput,
  ): Promise<InspectionTemplateRow> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const existing = await tx.inspectionTemplate.findUnique({ where: { id: templateId } });
      if (!existing) throw new NotFoundException('inspection_template_not_found');
      // Belt: RLS already enforces tenant; this is the §5 layer-3 check.
      if (existing.tenantId !== actor.tenantId) throw new NotFoundException('inspection_template_not_found');
      if (existing.archivedAt) {
        // Surfacing a 409 instead of silently letting an admin patch
        // an archived row (which would re-surface it for new
        // inspections) — un-archive needs an explicit endpoint.
        throw new ConflictException('inspection_template_archived');
      }

      // Unchecked variant lets us set raw FK columns (categoryId)
      // without going through the relation `connect/disconnect` API
      // — clearer here than relation noise for a nullable FK.
      const data: Prisma.InspectionTemplateUncheckedUpdateInput = {};
      const changedFields: string[] = [];

      if (input.name !== undefined && input.name !== existing.name) {
        data.name = input.name;
        changedFields.push('name');
      }
      if (
        Object.prototype.hasOwnProperty.call(input, 'description') &&
        (input.description ?? null) !== existing.description
      ) {
        data.description = input.description ?? null;
        changedFields.push('description');
      }
      if (input.displayOrder !== undefined && input.displayOrder !== existing.displayOrder) {
        data.displayOrder = input.displayOrder;
        changedFields.push('displayOrder');
      }
      const touchedKind = Object.prototype.hasOwnProperty.call(input, 'categoryKind');
      const touchedId = Object.prototype.hasOwnProperty.call(input, 'categoryId');
      if (touchedKind || touchedId) {
        // Either both touched (XOR validated by Zod) or one touched +
        // existing implicitly the OTHER. We still re-set both so the
        // CHECK constraint sees a consistent (kind, id) pair.
        const nextKind = touchedKind ? (input.categoryKind ?? null) : existing.categoryKind;
        const nextId = touchedId ? (input.categoryId ?? null) : existing.categoryId;
        const hasKind = nextKind !== null;
        const hasId = nextId !== null;
        if (hasKind === hasId) {
          throw new BadRequestException('category_scope_must_be_kind_xor_id');
        }
        if (nextId) {
          await this.assertCategoryInTenant(tx, nextId);
        }
        data.categoryKind = nextKind;
        data.categoryId = nextId;
        changedFields.push('scope');
      }

      if (Object.keys(data).length > 0) {
        await tx.inspectionTemplate.update({ where: { id: templateId }, data });
      }

      let items: InspectionTemplateItemRow[];
      if (input.items) {
        items = await this.replaceItems(tx, actor.tenantId, templateId, input.items);
        changedFields.push('items');
      } else {
        items = await this.loadItems(tx, templateId);
      }

      const updated = await tx.inspectionTemplate.findUniqueOrThrow({
        where: { id: templateId },
      });

      if (changedFields.length > 0) {
        await this.audit.recordWithin(tx, {
          action: 'panorama.inspection.template.updated',
          resourceType: 'inspection_template',
          resourceId: templateId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { changedFields, itemCount: items.length },
        });
      }
      return shapeTemplate(updated, items);
    });
  }

  /** runInTenant — admin write. Soft-archive; existing inspections unaffected. */
  async archive(actor: InspectionTemplateActor, templateId: string): Promise<void> {
    await this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const existing = await tx.inspectionTemplate.findUnique({ where: { id: templateId } });
      if (!existing) throw new NotFoundException('inspection_template_not_found');
      if (existing.tenantId !== actor.tenantId) throw new NotFoundException('inspection_template_not_found');
      if (existing.archivedAt) {
        // Idempotent: archiving an already-archived template is a no-op
        // — return without writing or auditing.
        return;
      }
      await tx.inspectionTemplate.update({
        where: { id: templateId },
        data: { archivedAt: new Date() },
      });
      await this.audit.recordWithin(tx, {
        action: 'panorama.inspection.template.archived',
        resourceType: 'inspection_template',
        resourceId: templateId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { name: existing.name },
      });
    });
  }

  /** runInTenant — read. Single template + items. */
  async get(
    actor: InspectionTemplateActor,
    templateId: string,
  ): Promise<InspectionTemplateRow> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const t = await tx.inspectionTemplate.findUnique({ where: { id: templateId } });
      if (!t || t.tenantId !== actor.tenantId) {
        throw new NotFoundException('inspection_template_not_found');
      }
      const items = await this.loadItems(tx, templateId);
      return shapeTemplate(t, items);
    });
  }

  /**
   * runInTenant — read. Filters by asset (resolves to category +
   * categoryKind) or categoryKind directly. Excludes archived by
   * default; admin pages pass `includeArchived=true`.
   */
  async list(
    actor: InspectionTemplateActor,
    input: ListInspectionTemplatesInput,
  ): Promise<InspectionTemplateRow[]> {
    return this.prisma.runInTenant(actor.tenantId, async (tx) => {
      const where: Prisma.InspectionTemplateWhereInput = { tenantId: actor.tenantId };
      if (!input.includeArchived) where.archivedAt = null;

      if (input.assetId) {
        const asset = await tx.asset.findUnique({
          where: { id: input.assetId },
          select: {
            tenantId: true,
            model: { select: { category: { select: { id: true, kind: true } } } },
          },
        });
        if (!asset || asset.tenantId !== actor.tenantId) {
          throw new NotFoundException('asset_not_found');
        }
        const categoryId = asset.model?.category?.id ?? null;
        const categoryKind = asset.model?.category?.kind ?? null;
        // Match templates scoped to this category OR to this kind.
        // Launcher resolution (§1: categoryId beats categoryKind when
        // both apply) is performed by the caller / web sort, since
        // returning both lets the UI surface the override visibly.
        const orClauses: Prisma.InspectionTemplateWhereInput[] = [];
        if (categoryId) orClauses.push({ categoryId });
        if (categoryKind) orClauses.push({ categoryKind });
        if (orClauses.length === 0) {
          // Asset has no category — no template can match by scope.
          return [];
        }
        where.OR = orClauses;
      } else if (input.categoryKind) {
        where.categoryKind = input.categoryKind;
      }

      const rows = await tx.inspectionTemplate.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        take: input.limit,
        include: {
          items: { orderBy: { position: 'asc' } },
        },
      });
      return rows.map((r) =>
        shapeTemplate(
          r,
          r.items.map((i) => shapeItem(i)),
        ),
      );
    });
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private async assertCategoryInTenant(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ): Promise<void> {
    const cat = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!cat) throw new NotFoundException('category_not_found');
  }

  /**
   * Replace items in one tx. Position is auto-assigned by array order
   * — clients submit a list, server assigns 0..N-1. Avoids the need
   * to reason about sparse / out-of-order positions in PATCH inputs.
   */
  private async replaceItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateId: string,
    items: CreateInspectionTemplateInput['items'],
  ): Promise<InspectionTemplateItemRow[]> {
    await tx.inspectionTemplateItem.deleteMany({ where: { templateId } });
    if (items.length === 0) return [];
    const data = items.map((it, idx) => ({
      tenantId,
      templateId,
      position: idx,
      label: it.label,
      itemType: it.itemType,
      required: it.required,
      photoRequired: it.photoRequired,
      minValue: it.minValue ?? null,
      maxValue: it.maxValue ?? null,
      helpText: it.helpText ?? null,
    }));
    await tx.inspectionTemplateItem.createMany({ data });
    return this.loadItems(tx, templateId);
  }

  private async loadItems(
    tx: Prisma.TransactionClient,
    templateId: string,
  ): Promise<InspectionTemplateItemRow[]> {
    const rows = await tx.inspectionTemplateItem.findMany({
      where: { templateId },
      orderBy: { position: 'asc' },
    });
    return rows.map(shapeItem);
  }
}

function shapeTemplate(
  t: {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    categoryKind: CategoryKind | null;
    categoryId: string | null;
    displayOrder: number;
    archivedAt: Date | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  },
  items: InspectionTemplateItemRow[],
): InspectionTemplateRow {
  return {
    id: t.id,
    tenantId: t.tenantId,
    name: t.name,
    description: t.description,
    categoryKind: t.categoryKind,
    categoryId: t.categoryId,
    displayOrder: t.displayOrder,
    archivedAt: t.archivedAt,
    createdByUserId: t.createdByUserId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    items,
  };
}

function shapeItem(i: {
  id: string;
  position: number;
  label: string;
  itemType: InspectionItemType;
  required: boolean;
  photoRequired: boolean;
  minValue: number | null;
  maxValue: number | null;
  helpText: string | null;
}): InspectionTemplateItemRow {
  return {
    id: i.id,
    position: i.position,
    label: i.label,
    itemType: i.itemType,
    required: i.required,
    photoRequired: i.photoRequired,
    minValue: i.minValue,
    maxValue: i.maxValue,
    helpText: i.helpText,
  };
}
