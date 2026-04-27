import { z } from 'zod';

/**
 * Event-type → Zod schema registry (ADR-0011 §Payload schema).
 *
 * `enqueueWithin` rejects any eventType not present here — a typo at
 * the emit site fails fast with `unknown_event_type:<...>` instead
 * of dispatching an unstructured payload nothing knows how to
 * handle.
 *
 * Shape rules:
 *   * Only IDs + enum strings + ISO datetimes + small free-text
 *     fields. No plaintext tokens, passwords, secrets — the
 *     redaction sweep in NotificationService runs regardless, but
 *     schemas should be written as if redaction didn't exist.
 *   * If a handler needs a lookup (user email, reservation
 *     details), the payload carries the UUID and the handler
 *     fetches via Prisma. Minimises payload size + keeps data
 *     fresh at dispatch time.
 */
export const NOTIFICATION_PAYLOAD_SCHEMAS = {
  'panorama.reservation.approved': z
    .object({
      reservationId: z.string().uuid(),
      assetId: z.string().uuid().nullable(),
      requesterUserId: z.string().uuid(),
      approverUserId: z.string().uuid(),
      startAt: z.string().datetime(),
      endAt: z.string().datetime(),
      note: z.string().max(500).optional(),
    })
    .strict(),

  'panorama.reservation.rejected': z
    .object({
      reservationId: z.string().uuid(),
      assetId: z.string().uuid().nullable(),
      requesterUserId: z.string().uuid(),
      approverUserId: z.string().uuid(),
      startAt: z.string().datetime(),
      endAt: z.string().datetime(),
      note: z.string().max(500).optional(),
    })
    .strict(),

  // ADR-0012 §11. Emitted by InspectionService.complete; the
  // InspectionOutcomeEmailChannel filters in-handler for FAIL /
  // NEEDS_MAINTENANCE so PASS events still flow through the bus
  // (audit + future subscribers) without firing email.
  'panorama.inspection.completed': z
    .object({
      inspectionId: z.string().uuid(),
      assetId: z.string().uuid(),
      reservationId: z.string().uuid().nullable(),
      startedByUserId: z.string().uuid(),
      outcome: z.enum(['PASS', 'FAIL', 'NEEDS_MAINTENANCE']),
      photoCount: z.number().int().min(0).max(50),
      responseCount: z.number().int().min(0).max(100),
      summaryNote: z.string().max(500).optional(),
    })
    .strict(),

  // ADR-0016 §5 dominant trigger path (~70% of auto-suggested tickets per
  // persona-fleet-ops analysis). Emitted by ReservationService.checkIn
  // when `damageFlag === true`. The MaintenanceTicketSubscriber consumes
  // it to open a draft ticket, gated by `tenant.autoOpenMaintenanceFromInspection`.
  // Wave 1 ARCH-15 / #40: this event was specced in the ADR but never
  // emitted until the auto-suggest slice landed.
  'panorama.reservation.checked_in_with_damage': z
    .object({
      reservationId: z.string().uuid(),
      assetId: z.string().uuid(),
      requesterUserId: z.string().uuid(),
      checkedInByUserId: z.string().uuid(),
      checkedInAt: z.string().datetime(),
      mileageIn: z.number().int().nonnegative(),
      // Free-text driver note describing the damage — bounded so payload
      // stays small + fits in the maintenance ticket's `notes` field
      // when the subscriber HTML-escapes it at write.
      damageNote: z.string().max(500).optional(),
    })
    .strict(),
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_PAYLOAD_SCHEMAS;

export function isRegisteredEventType(type: string): type is NotificationEventType {
  return Object.hasOwn(NOTIFICATION_PAYLOAD_SCHEMAS, type);
}
