import { z } from 'zod';

export const CreateReservationSchema = z
  .object({
    assetId: z.string().uuid().nullable().optional(),
    onBehalfUserId: z.string().uuid().optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    purpose: z.string().max(2000).optional(),
  })
  .refine((v) => new Date(v.startAt) < new Date(v.endAt), {
    message: 'start_must_be_before_end',
    path: ['endAt'],
  });
export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

export const CreateBasketSchema = z
  .object({
    assetIds: z.array(z.string().uuid()).min(1).max(20),
    onBehalfUserId: z.string().uuid().optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    purpose: z.string().max(2000).optional(),
  })
  .refine((v) => new Date(v.startAt) < new Date(v.endAt), {
    message: 'start_must_be_before_end',
    path: ['endAt'],
  })
  .refine((v) => new Set(v.assetIds).size === v.assetIds.length, {
    message: 'duplicate_asset_ids',
    path: ['assetIds'],
  });
export type CreateBasketInput = z.infer<typeof CreateBasketSchema>;

export const ListReservationsSchema = z.object({
  scope: z.enum(['mine', 'tenant']).default('mine'),
  status: z
    .enum(['open', 'pending', 'approved', 'rejected', 'cancelled', 'all'])
    .default('open'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReservationsInput = z.infer<typeof ListReservationsSchema>;

export const CancelReservationSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const ApprovalDecisionSchema = z.object({
  note: z.string().max(500).optional(),
});

// Rejection requires a non-empty note. Persona finding OPS-01 (#33):
// requesters need to know *why* a reservation was rejected — without
// the note they have to walk to dispatch to ask. Server-side enforcement
// is the real safety net (the web modal also validates client-side).
// Using explicit error messages so all invalid shapes (missing field,
// wrong type, blank string) surface the same `note_required` code that
// the web layer maps to a user-facing string.
export const RejectionDecisionSchema = z.object({
  note: z
    .string({ required_error: 'note_required', invalid_type_error: 'note_required' })
    .trim()
    .min(1, 'note_required')
    .max(500),
});

export const BasketBatchDecisionSchema = z.object({
  note: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
});
export type BasketBatchDecisionInput = z.infer<typeof BasketBatchDecisionSchema>;

// Basket-level rejection mirrors the single-reservation rule: requesters
// in a multi-asset basket get the same "why" surface as solo bookings.
export const BasketBatchRejectionSchema = z.object({
  note: z
    .string({ required_error: 'note_required', invalid_type_error: 'note_required' })
    .trim()
    .min(1, 'note_required')
    .max(500),
});

// Mileage is REQUIRED on checkout. OPS-02 (#32): DOT 49 CFR requires
// odometer readings on every trip, and ADR-0016's PM-due cron depends
// on Asset.lastReadMileage, which is populated from these fields. An
// optional mileage column was the silent bug that broke the entire
// maintenance scheduling chain.
export const CheckoutSchema = z.object({
  mileage: z
    .number({ required_error: 'mileage_required', invalid_type_error: 'mileage_required' })
    .int()
    .nonnegative('mileage_required'),
  condition: z.string().max(2000).optional(),
});
export type CheckoutInput = z.infer<typeof CheckoutSchema>;

// Mileage is REQUIRED on check-in too. The check-in mileage is what
// gets written to Asset.lastReadMileage (per OPS-02 / DATA-01) — the
// PM-due cron depends on it being a real number, not NULL.
export const CheckinSchema = z.object({
  mileage: z
    .number({ required_error: 'mileage_required', invalid_type_error: 'mileage_required' })
    .int()
    .nonnegative('mileage_required'),
  condition: z.string().max(2000).optional(),
  damageFlag: z.boolean().optional(),
  damageNote: z.string().max(2000).optional(),
});
export type CheckinInput = z.infer<typeof CheckinSchema>;

export const CreateBlackoutSchema = z
  .object({
    assetId: z.string().uuid().nullable().optional(),
    title: z.string().min(1).max(200),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    reason: z.string().max(2000).optional(),
  })
  .refine((v) => new Date(v.startAt) < new Date(v.endAt), {
    message: 'start_must_be_before_end',
    path: ['endAt'],
  });
export type CreateBlackoutInput = z.infer<typeof CreateBlackoutSchema>;

export const ListBlackoutsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  assetId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListBlackoutsInput = z.infer<typeof ListBlackoutsSchema>;
