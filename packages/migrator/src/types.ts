import { z } from 'zod';

/**
 * Minimal types for the Snipe-IT entities we care about during migration.
 * Kept permissive — Snipe-IT's API payloads include many fields we ignore,
 * and the schema varies slightly between versions.
 */

export const SnipeItUserSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  email: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  activated: z.boolean().nullable().optional(),
  vip: z.boolean().nullable().optional(),
  company: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  groups: z
    .object({
      rows: z.array(z.object({ id: z.number().int(), name: z.string() })).optional(),
    })
    .nullable()
    .optional(),
});
export type SnipeItUser = z.infer<typeof SnipeItUserSchema>;

export const SnipeItAssetSchema = z.object({
  id: z.number().int(),
  asset_tag: z.string(),
  name: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  status_label: z
    .object({ id: z.number().int().nullable(), name: z.string().nullable() })
    .nullable()
    .optional(),
  model: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  category: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  manufacturer: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  company: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  rtd_location: z
    .object({ id: z.number().int(), name: z.string().nullable() })
    .nullable()
    .optional(),
  assigned_to: z.unknown().nullable().optional(),
  custom_fields: z.record(z.unknown()).nullable().optional(),
});
export type SnipeItAsset = z.infer<typeof SnipeItAssetSchema>;

export const PaginatedResponseSchema = z.object({
  total: z.number().int(),
  rows: z.array(z.unknown()),
});

export const InventoryReportSchema = z.object({
  snipeitUrl: z.string().url(),
  generatedAt: z.string().datetime({ offset: true }),
  counts: z.record(z.number().int()),
  flags: z.object({
    duplicateEmails: z.array(z.string()),
    unknownStatusLabels: z.array(z.string()),
    multiCompanyEnabled: z.boolean(),
    assetsWithNullCompany: z.number().int(),
  }),
});
export type InventoryReport = z.infer<typeof InventoryReportSchema>;
