/**
 * Object-storage key helpers (ADR-0012 §3).
 *
 * Centralised so a service cannot hand-craft a key. Pairs with the
 * DB CHECK on `inspection_photos.storageKey`:
 *
 *   ^tenants/{uuid}/inspections/{uuid}/photos/{uuid}\.jpg$
 *
 * Changes to the layout MUST update the CHECK constraint in the
 * same commit. A round-trip test in `object-storage.keys.test.ts`
 * validates that every key produced here passes the regex.
 */
import { z } from 'zod';

export const INSPECTION_PHOTO_KEY_REGEX =
  /^tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/inspections\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

const UuidSchema = z.string().uuid();

/**
 * Build the S3 key for a photo. Every argument is runtime-validated
 * as a UUID — this prevents a path-traversal-shaped string from
 * sneaking in via a service bug.
 */
export function inspectionPhotoKey(
  tenantId: string,
  inspectionId: string,
  photoId: string,
): string {
  UuidSchema.parse(tenantId);
  UuidSchema.parse(inspectionId);
  UuidSchema.parse(photoId);
  return `tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}.jpg`;
}

/**
 * Extract tenantId from a well-formed inspection photo key.
 * Returns null if the key doesn't match the expected shape.
 */
export function tenantIdFromInspectionPhotoKey(key: string): string | null {
  const match = key.match(INSPECTION_PHOTO_KEY_REGEX);
  if (!match) return null;
  // Layout: tenants/{tenantId}/...
  return key.split('/', 2)[1] ?? null;
}
