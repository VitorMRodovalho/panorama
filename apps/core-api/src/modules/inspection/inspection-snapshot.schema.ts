/**
 * `Inspection.templateSnapshot` shape (ADR-0012 §2).
 *
 * The snapshot is the immutable copy of the template at start time —
 * frozen by a BEFORE UPDATE trigger + service-layer Zod + two CHECK
 * constraints + the snapshot-item-id integrity trigger. This file is
 * the Zod source of truth that the service uses on every write.
 *
 * Item `id` is the live `inspection_template_items.id` at snapshot
 * moment, copied through. UUIDs are unique forever, so reusing the
 * value as the snapshot's anchor is safe — `InspectionResponse.snapshotItemId`
 * references this `id`, the integrity trigger validates against it.
 */
import { z } from 'zod';

export const InspectionItemTypeEnum = z.enum(['BOOLEAN', 'TEXT', 'NUMBER', 'PHOTO']);

export const InspectionSnapshotItemSchema = z
  .object({
    id: z.string().uuid(),
    position: z.number().int().min(0).max(10_000),
    label: z.string().min(1).max(200),
    itemType: InspectionItemTypeEnum,
    required: z.boolean(),
    photoRequired: z.boolean(),
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    helpText: z.string().max(1000).nullable(),
  })
  .strict();
export type InspectionSnapshotItem = z.infer<typeof InspectionSnapshotItemSchema>;

export const InspectionSnapshotSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).nullable(),
    /** ISO of the template's updatedAt at snapshot time. */
    templateVersionAt: z.string().datetime(),
    items: z
      .array(InspectionSnapshotItemSchema)
      .min(1, 'snapshot_items_min_1')
      .max(50, 'snapshot_items_max_50'),
  })
  .strict()
  .refine(
    (s) => {
      // Item IDs must be unique within the snapshot — the integrity
      // trigger only validates that snapshotItemId APPEARS in the
      // items[*].id set; duplicate IDs would let two responses
      // diverge under the same anchor.
      const ids = new Set<string>();
      for (const it of s.items) {
        if (ids.has(it.id)) return false;
        ids.add(it.id);
      }
      return true;
    },
    { message: 'duplicate_snapshot_item_ids', path: ['items'] },
  );
export type InspectionSnapshot = z.infer<typeof InspectionSnapshotSchema>;
