/**
 * Lifecycle DTOs for the inspection HTTP surface
 * (ADR-0012 §Execution-order step 7b).
 *
 * Photo upload (POST :id/photos) lives in `inspection-photo.dto.ts`
 * (step 7c). Template CRUD lives in `inspection-template.dto.ts`.
 */
import { z } from 'zod';

export const StartInspectionSchema = z
  .object({
    assetId: z.string().uuid(),
    /** Optional reservation tether — pre-trip from the reservation page. */
    reservationId: z.string().uuid().nullable().optional(),
    /** Optional explicit template — when omitted, server resolves by category. */
    templateId: z.string().uuid().optional(),
  })
  .strict();
export type StartInspectionInput = z.infer<typeof StartInspectionSchema>;

export const RespondSchema = z
  .object({
    /** Anchor in the inspection's templateSnapshot.items[*].id. */
    snapshotItemId: z.string().uuid(),
    booleanValue: z.boolean().nullable().optional(),
    textValue: z.string().max(2000).nullable().optional(),
    numberValue: z.number().nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type RespondInput = z.infer<typeof RespondSchema>;

export const RespondBatchSchema = z.object({
  responses: z.array(RespondSchema).min(1).max(50),
});
export type RespondBatchInput = z.infer<typeof RespondBatchSchema>;

export const CompleteInspectionSchema = z
  .object({
    outcome: z.enum(['PASS', 'FAIL', 'NEEDS_MAINTENANCE']),
    summaryNote: z.string().max(500).optional(),
  })
  .strict();
export type CompleteInspectionInput = z.infer<typeof CompleteInspectionSchema>;

export const ReviewInspectionSchema = z
  .object({
    /** Reviewer note — appendable post-review via `reviewNote` patch. */
    reviewNote: z.string().max(2000).optional(),
  })
  .strict();
export type ReviewInspectionInput = z.infer<typeof ReviewInspectionSchema>;

export const ReviewNoteUpdateSchema = z
  .object({
    reviewNote: z.string().max(2000),
  })
  .strict();
export type ReviewNoteUpdateInput = z.infer<typeof ReviewNoteUpdateSchema>;

export const CancelInspectionSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CancelInspectionInput = z.infer<typeof CancelInspectionSchema>;

export const ListInspectionsSchema = z.object({
  /** mine = startedByUserId == ctx.userId; tenant = all visible by RLS. */
  scope: z.enum(['mine', 'tenant']).default('mine'),
  status: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'all']).default('all'),
  outcome: z.enum(['PASS', 'FAIL', 'NEEDS_MAINTENANCE', 'all']).default('all'),
  /** Admin review queue: unreviewed COMPLETED rows only. */
  needsReview: z.coerce.boolean().default(false),
  assetId: z.string().uuid().optional(),
  reservationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListInspectionsInput = z.infer<typeof ListInspectionsSchema>;
