import { z } from 'zod';

export const MintPatSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1)).min(1).max(10),
  /** ISO 8601 timestamp. Null / absent = no expiration. */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type MintPatInput = z.infer<typeof MintPatSchema>;

export const RevokePatSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type RevokePatInput = z.infer<typeof RevokePatSchema>;

export const ListPatSchema = z.object({
  scope: z.enum(['mine', 'tenant']).default('mine'),
  includeRevoked: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListPatInput = z.infer<typeof ListPatSchema>;
