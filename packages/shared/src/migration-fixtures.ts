import { z } from 'zod';

/**
 * Canonical fixture format exchanged between @panorama/migrator (producer)
 * and the core-api's ImportService (consumer).
 *
 * Every fixture row carries `source` + `sourceId` so the importer can:
 *   * Resolve foreign-key-by-source-id across entity types (category →
 *     model → asset)
 *   * Be **idempotent** across reruns by keying off
 *     (source, entity, sourceId) in the import_identity_map table
 *
 * Shape choice: flat JSON arrays, one file per entity type, plus a
 * manifest.json that the importer reads first to validate preconditions
 * (schema version, counts, provenance). Flat JSON is human-reviewable in
 * dry-run mode and doesn't need a custom parser.
 */

export const FIXTURE_SCHEMA_VERSION = 1 as const;

export const FixtureSourceSchema = z.enum(['snipeit', 'fleetmanager', 'servicenow', 'manual']);
export type FixtureSource = z.infer<typeof FixtureSourceSchema>;

export const ManifestSchema = z.object({
  schemaVersion: z.literal(FIXTURE_SCHEMA_VERSION),
  source: FixtureSourceSchema,
  sourceUrl: z.string().url().nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  counts: z.record(z.number().int().nonnegative()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Global (non-tenant) entities
// ---------------------------------------------------------------------------

export const TenantFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-lowercase'),
  name: z.string().min(1),
  displayName: z.string().min(1),
  locale: z.string().default('en'),
  timezone: z.string().default('UTC'),
});
export type TenantFixture = z.infer<typeof TenantFixtureSchema>;

export const UserFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  displayName: z.string().min(1),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
});
export type UserFixture = z.infer<typeof UserFixtureSchema>;

export const TenantMembershipFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceUserId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  role: z.enum(['super_admin', 'fleet_admin', 'fleet_staff', 'driver']).default('driver'),
  isVip: z.boolean().default(false),
});
export type TenantMembershipFixture = z.infer<typeof TenantMembershipFixtureSchema>;

// ---------------------------------------------------------------------------
// Tenant-owned catalog
// ---------------------------------------------------------------------------

export const CategoryFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['HARDWARE', 'LICENSE', 'ACCESSORY', 'CONSUMABLE', 'COMPONENT', 'VEHICLE', 'OTHER'])
    .default('OTHER'),
});
export type CategoryFixture = z.infer<typeof CategoryFixtureSchema>;

export const ManufacturerFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().nullable().optional(),
  supportEmail: z.string().email().nullable().optional(),
  supportPhone: z.string().nullable().optional(),
});
export type ManufacturerFixture = z.infer<typeof ManufacturerFixtureSchema>;

export const AssetModelFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  sourceCategoryId: z.string().min(1),
  sourceManufacturerId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  modelNumber: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
});
export type AssetModelFixture = z.infer<typeof AssetModelFixtureSchema>;

export const AssetFixtureSchema = z.object({
  source: FixtureSourceSchema,
  sourceId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  sourceModelId: z.string().min(1),
  tag: z.string().min(1),
  name: z.string().min(1),
  serial: z.string().nullable().optional(),
  status: z.enum(['READY', 'IN_USE', 'RESERVED', 'MAINTENANCE', 'RETIRED']).default('READY'),
  bookable: z.boolean().default(false),
  customFields: z.record(z.unknown()).default({}),
});
export type AssetFixture = z.infer<typeof AssetFixtureSchema>;

// ---------------------------------------------------------------------------
// File layout constants — the importer discovers files by these names
// ---------------------------------------------------------------------------

export const FIXTURE_FILES = {
  manifest: 'manifest.json',
  tenants: 'tenants.json',
  users: 'users.json',
  tenantMemberships: 'tenant-memberships.json',
  categories: 'categories.json',
  manufacturers: 'manufacturers.json',
  assetModels: 'asset-models.json',
  assets: 'assets.json',
} as const;

export type FixtureFileName = (typeof FIXTURE_FILES)[keyof typeof FIXTURE_FILES];

/**
 * Order in which entities must be imported so foreign keys resolve.
 * Tenants first (everything references them). Users are global; memberships
 * link the two. Catalog ordering: category → manufacturer → model → asset.
 */
export const IMPORT_ORDER: readonly Exclude<keyof typeof FIXTURE_FILES, 'manifest'>[] = [
  'tenants',
  'users',
  'tenantMemberships',
  'categories',
  'manufacturers',
  'assetModels',
  'assets',
] as const;
