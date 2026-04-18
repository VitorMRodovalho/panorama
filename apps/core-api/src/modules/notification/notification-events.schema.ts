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
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_PAYLOAD_SCHEMAS;

export function isRegisteredEventType(type: string): type is NotificationEventType {
  return Object.hasOwn(NOTIFICATION_PAYLOAD_SCHEMAS, type);
}
