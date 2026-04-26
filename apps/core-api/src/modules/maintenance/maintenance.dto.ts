import { z } from 'zod';

/**
 * Snipe-IT compat enum + the ADR-0016 free-form extension types.
 * Daily audit query (`panorama.maintenance.type_drift_detected`)
 * surfaces rows with types outside this list — keep it tight.
 */
export const MAINTENANCE_TYPE_ALLOWLIST = [
  'Maintenance',
  'Repair',
  'PAT Test',
  'Upgrade',
  'Hardware Support',
  'Software Support',
  'Inspection',
  'Tire',
  'Calibration',
] as const;

export type MaintenanceTypeName = (typeof MAINTENANCE_TYPE_ALLOWLIST)[number];

export const OpenTicketSchema = z.object({
  assetId: z.string().uuid(),
  maintenanceType: z.enum(MAINTENANCE_TYPE_ALLOWLIST),
  title: z.string().trim().min(3, 'title_too_short').max(200),
  severity: z.string().trim().max(40).optional(),
  triggeringReservationId: z.string().uuid().optional(),
  triggeringInspectionId: z.string().uuid().optional(),
  assigneeUserId: z.string().uuid().optional(),
  supplierName: z.string().trim().max(200).optional(),
  mileageAtService: z.number().int().nonnegative().optional(),
  expectedReturnAt: z.string().datetime().optional(),
  cost: z.number().nonnegative().optional(),
  isWarranty: z.boolean().optional(),
  notes: z.string().max(8000).optional(),
});
export type OpenTicketInput = z.infer<typeof OpenTicketSchema>;

export const ListTicketsSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  assetId: z.string().uuid().optional(),
  assigneeUserId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().uuid().optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsSchema>;

/**
 * The status PATCH supports the four transitions the ADR-0016 §2 state
 * machine allows in the MVP slice (reopen + within-window are 0.4):
 *  - OPEN          → IN_PROGRESS
 *  - OPEN          → COMPLETED   (skipping IN_PROGRESS is allowed)
 *  - IN_PROGRESS   → COMPLETED
 *  - OPEN | IN_PROGRESS → CANCELLED
 *
 * Completion fields are accepted only when transitioning to COMPLETED;
 * the service rejects them otherwise so callers can't drift state.
 */
export const UpdateStatusSchema = z
  .object({
    status: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
    completionNote: z.string().max(8000).optional(),
    nextServiceMileage: z.number().int().nonnegative().optional(),
    nextServiceDate: z.string().datetime().optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;
