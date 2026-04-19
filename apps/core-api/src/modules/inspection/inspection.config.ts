/**
 * Per-tenant inspection policy (ADR-0012 §1, Tenant.inspectionConfig).
 *
 * The column is `Tenant.inspectionConfig: Json?`. Cluster defaults
 * land here so the rest of the module reads through one helper —
 * `null` Tenant.inspectionConfig is the fast path; partial overrides
 * merge with defaults; bad shape rejects at write time.
 *
 * Per the ADR, `requireInspectionBeforeCheckout` is NOT inside this
 * shape (separate column; v3 fix to avoid the dual-write footgun).
 */
import { z } from 'zod';

export const InspectionTenantConfigSchema = z
  .object({
    /** Hard cap on photos per inspection. Pipeline + UI enforce. */
    maxPhotosPerInspection: z.number().int().min(1).max(100).default(20),
    /** Multer-level cap. 25 MB ceiling matches infra ingress 11 MB + buffer. */
    maxPhotoBytes: z
      .number()
      .int()
      .min(1)
      .max(25_000_000)
      .default(10_485_760),
    /** Sharp resize ceiling (longest edge). Read by PhotoPipeline override. */
    maxPhotoDimension: z.number().int().min(512).max(4096).default(2048),
    /** Resume / stale window (hours). §9 lifecycle. */
    staleInProgressHours: z.number().int().min(1).max(168).default(24),
    /** Pre-checkout PASS window (minutes). §8 reservation tether. */
    preCheckoutInspectionMaxAgeMinutes: z
      .number()
      .int()
      .min(30)
      .max(1440)
      .default(240),
  })
  .strict();

export type InspectionTenantConfig = z.infer<typeof InspectionTenantConfigSchema>;

/**
 * Read defaults via parsing an empty object — keeps the source of
 * truth in one place (the Zod default values above).
 */
export const INSPECTION_TENANT_CONFIG_DEFAULTS: InspectionTenantConfig =
  InspectionTenantConfigSchema.parse({});

/**
 * Merge stored partial config with defaults. Tolerates null / missing /
 * extra-junk shapes by falling back to defaults (a corrupt JSON blob
 * shouldn't take inspection writes down — surface via audit on next
 * admin write).
 */
export function parseInspectionTenantConfig(raw: unknown): InspectionTenantConfig {
  if (raw === null || raw === undefined) return INSPECTION_TENANT_CONFIG_DEFAULTS;
  if (typeof raw !== 'object') return INSPECTION_TENANT_CONFIG_DEFAULTS;
  const result = InspectionTenantConfigSchema.safeParse({
    ...INSPECTION_TENANT_CONFIG_DEFAULTS,
    ...(raw as Record<string, unknown>),
  });
  return result.success ? result.data : INSPECTION_TENANT_CONFIG_DEFAULTS;
}

/**
 * Write-side validator — rejects bad shapes loudly. Called from the
 * tenant-admin update path when an operator changes the JSON blob.
 * Returns the canonical (defaults-merged) shape on success.
 */
export function validateInspectionTenantConfigForWrite(
  raw: unknown,
): InspectionTenantConfig {
  return InspectionTenantConfigSchema.parse({
    ...INSPECTION_TENANT_CONFIG_DEFAULTS,
    ...(raw as Record<string, unknown>),
  });
}

/**
 * Per ADR §10 the photo-retention floor is 30 days; default 425 d
 * (DOT 49 CFR §396.3 14-mo + 2-mo buffer). Helper kept here so the
 * service / cron / template surface all read one definition.
 */
export const INSPECTION_PHOTO_RETENTION_DEFAULT_DAYS = 425;
export const INSPECTION_PHOTO_RETENTION_FLOOR_DAYS = 30;
export function effectiveRetentionDays(stored: number | null): number {
  if (stored === null) return INSPECTION_PHOTO_RETENTION_DEFAULT_DAYS;
  return Math.max(INSPECTION_PHOTO_RETENTION_FLOOR_DAYS, stored);
}
