import { Prisma } from '../../generated/prisma/client.js';

/**
 * The unique constraint a `P2002` error reports.
 *
 * Prisma 7 raises database errors through the driver adapter, and a
 * `P2002` no longer carries Prisma 6's `meta.target`. The violated
 * constraint is in `meta.driverAdapterError.cause.constraint` instead,
 * as `{ index: '<constraint name>' }` when Postgres names it (also for
 * a unique INDEX, partial ones included) or `{ fields: [...] }` when
 * only the key columns are known (parsed from the error DETAIL).
 *
 * Returns `undefined` for anything that is not a P2002 or when the
 * constraint is not reported.
 */
export interface UniqueViolation {
  index?: string;
  fields?: string[];
}

export function uniqueViolationOf(err: unknown): UniqueViolation | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return undefined;
  }
  const constraint = (
    err.meta as
      | { driverAdapterError?: { cause?: { constraint?: unknown } } }
      | undefined
  )?.driverAdapterError?.cause?.constraint;
  if (!constraint || typeof constraint !== 'object') return undefined;
  const out: UniqueViolation = {};
  const { index, fields } = constraint as { index?: unknown; fields?: unknown };
  if (typeof index === 'string') out.index = index;
  if (Array.isArray(fields)) out.fields = fields.map((f) => String(f));
  return out.index !== undefined || out.fields !== undefined ? out : undefined;
}
