import { z } from 'zod';

// Placeholder shared types. Real DTOs land as modules are built.
// Keep Zod schemas + inferred types co-located so frontend and backend share one source.

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const TenantIdSchema = UuidSchema.brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantIdSchema>;

export const UserIdSchema = UuidSchema.brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

export const ISODateStringSchema = z.string().datetime({ offset: true });
export type ISODateString = z.infer<typeof ISODateStringSchema>;

export const LocaleSchema = z.enum(['en', 'pt-br', 'es']);
export type Locale = z.infer<typeof LocaleSchema>;
