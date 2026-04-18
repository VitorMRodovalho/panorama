import { z } from 'zod';

/**
 * Zod schemas for the `/invitations/*` endpoints. Kept thin so the
 * controller stays readable; the service does its own domain validation
 * (role allowlist, TTL bounds, email-match at acceptance) because those
 * rules need access to config + DB state the zod layer can't see.
 */

export const CreateInvitationSchema = z.object({
  tenantId: z.string().uuid(),
  email: z
    .string()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase().trim()),
  role: z.string().min(1).max(32),
  ttlSeconds: z.number().int().positive().optional(),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

export const ListInvitationsSchema = z.object({
  tenantId: z.string().uuid(),
  status: z.enum(['open', 'accepted', 'revoked', 'expired', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListInvitationsInput = z.infer<typeof ListInvitationsSchema>;

export const AcceptInvitationSchema = z.object({
  t: z.string().min(43).max(64),
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;
