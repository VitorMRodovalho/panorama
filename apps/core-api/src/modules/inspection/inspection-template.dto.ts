/**
 * Zod request schemas for the inspection-template surface
 * (ADR-0012 §1 + §Execution-order step 7). Validated at the
 * controller layer; service receives already-narrowed types.
 *
 * `categoryKind` XOR `categoryId` is the load-bearing scope rule —
 * enforced here at the request layer AND by a CHECK constraint at
 * the DB. Belt + braces.
 */
import { z } from 'zod';

export const InspectionItemTypeSchema = z.enum(['BOOLEAN', 'TEXT', 'NUMBER', 'PHOTO']);
export const CategoryKindSchema = z.enum([
  'HARDWARE',
  'LICENSE',
  'ACCESSORY',
  'CONSUMABLE',
  'COMPONENT',
  'VEHICLE',
  'OTHER',
]);

export const InspectionTemplateItemInputSchema = z
  .object({
    label: z.string().min(1).max(200),
    itemType: InspectionItemTypeSchema,
    required: z.boolean().default(false),
    photoRequired: z.boolean().default(false),
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    helpText: z.string().max(1000).nullable().optional(),
  })
  .strict()
  .refine(
    (it) =>
      // BOOLEAN / TEXT / PHOTO must not carry numeric bounds.
      it.itemType === 'NUMBER' || (it.minValue == null && it.maxValue == null),
    { message: 'numeric_bounds_only_for_NUMBER', path: ['minValue'] },
  )
  .refine(
    (it) =>
      it.minValue == null || it.maxValue == null || it.minValue <= it.maxValue,
    { message: 'minValue_must_be_le_maxValue', path: ['maxValue'] },
  );

export type InspectionTemplateItemInput = z.infer<
  typeof InspectionTemplateItemInputSchema
>;

const TemplateScopeRefine = (v: { categoryKind?: unknown; categoryId?: unknown }) => {
  // The CHECK constraint reads "exactly one set". We mirror it with a
  // strict XOR — an admin mis-setting both gets a clean 400 instead
  // of a Postgres CHECK error message that leaks the constraint name.
  const hasKind = v.categoryKind !== undefined && v.categoryKind !== null;
  const hasId = v.categoryId !== undefined && v.categoryId !== null;
  return hasKind !== hasId;
};

export const CreateInspectionTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).nullable().optional(),
    categoryKind: CategoryKindSchema.nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).default(0),
    items: z
      .array(InspectionTemplateItemInputSchema)
      .min(1, 'items_min_1')
      .max(50, 'items_max_50'),
  })
  .strict()
  .refine(TemplateScopeRefine, {
    message: 'category_scope_must_be_kind_xor_id',
    path: ['categoryKind'],
  });
export type CreateInspectionTemplateInput = z.infer<
  typeof CreateInspectionTemplateSchema
>;

export const UpdateInspectionTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    categoryKind: CategoryKindSchema.nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
    /**
     * When provided, items are FULLY REPLACED inside one transaction
     * (deleteMany + createMany). Snapshot-on-start (§2) means existing
     * inspections keep their old item shape; only new inspections see
     * the new items. Caller passes the complete desired array.
     */
    items: z
      .array(InspectionTemplateItemInputSchema)
      .min(1, 'items_min_1')
      .max(50, 'items_max_50')
      .optional(),
  })
  .strict()
  .refine(
    (v) => {
      // Scope is optional on PATCH; if either field is present (even
      // as null) we re-validate the XOR. If neither is touched, leave
      // the existing scope alone.
      const touchedKind = Object.prototype.hasOwnProperty.call(v, 'categoryKind');
      const touchedId = Object.prototype.hasOwnProperty.call(v, 'categoryId');
      if (!touchedKind && !touchedId) return true;
      return TemplateScopeRefine(v);
    },
    { message: 'category_scope_must_be_kind_xor_id', path: ['categoryKind'] },
  );
export type UpdateInspectionTemplateInput = z.infer<
  typeof UpdateInspectionTemplateSchema
>;

export const ListInspectionTemplatesSchema = z.object({
  /** Filter to templates that match this asset's category (resolved server-side). */
  assetId: z.string().uuid().optional(),
  /** Filter by category kind directly — admin browsing. */
  categoryKind: CategoryKindSchema.optional(),
  /** Include archived templates in the result (admin view). */
  includeArchived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListInspectionTemplatesInput = z.infer<
  typeof ListInspectionTemplatesSchema
>;
