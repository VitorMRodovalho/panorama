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

/**
 * Tenant-data-export object-key shape (ADR-0020 §8).
 *
 *   ^tenants/{tenant-uuid}/exports/{job-uuid}\.json\.gz$
 *
 * One file per export job. Gzipped JSON instead of tar.gz because
 * the contents are a single document (a single
 * `{ tables: { table_name: [...] } }` object) and pulling in a tar
 * library adds dep weight for no structural win.
 */
export const TENANT_EXPORT_KEY_REGEX =
  /^tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/exports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.gz$/;

const UuidSchema = z.guid();

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

/**
 * Build the S3 key for a tenant-data-export job (ADR-0020 §8).
 * Same UUID-validation contract as inspectionPhotoKey.
 */
export function tenantExportKey(tenantId: string, jobId: string): string {
  UuidSchema.parse(tenantId);
  UuidSchema.parse(jobId);
  return `tenants/${tenantId}/exports/${jobId}.json.gz`;
}

/**
 * Validate a key against the union of accepted shapes (inspection
 * photo OR tenant export). `assertKeyForTenant` in
 * ObjectStorageService routes through this so new key shapes are
 * added in ONE place.
 */
export function validateObjectKeyShape(key: string): boolean {
  return INSPECTION_PHOTO_KEY_REGEX.test(key) || TENANT_EXPORT_KEY_REGEX.test(key);
}
