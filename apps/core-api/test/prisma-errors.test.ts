import { describe, it, expect } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { uniqueViolationOf } from '../src/modules/prisma/prisma-errors.js';

/**
 * DB-free shape checks for `uniqueViolationOf`. The real-Postgres
 * counterpart is prisma-unique-violation.integration.test.ts.
 */

function knownError(code: string, meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('test', { code, clientVersion: 'test', meta });
}

describe('uniqueViolationOf', () => {
  it('reads the constraint name reported by the pg adapter', () => {
    const err = knownError('P2002', {
      driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'x_key' } } },
    });
    expect(uniqueViolationOf(err)).toEqual({ index: 'x_key' });
  });

  it('reads the key columns when only those are reported', () => {
    const err = knownError('P2002', {
      driverAdapterError: { cause: { constraint: { fields: ['tenantId', 'email'] } } },
    });
    expect(uniqueViolationOf(err)).toEqual({ fields: ['tenantId', 'email'] });
  });

  it('ignores the Prisma 6 meta.target shape', () => {
    expect(uniqueViolationOf(knownError('P2002', { target: ['tenantId', 'email'] }))).toBeUndefined();
  });

  it('ignores other error codes and non-Prisma errors', () => {
    const meta = { driverAdapterError: { cause: { constraint: { index: 'x_key' } } } };
    expect(uniqueViolationOf(knownError('P2003', meta))).toBeUndefined();
    expect(uniqueViolationOf(Object.assign(new Error('x'), { code: 'P2002', meta }))).toBeUndefined();
  });
});
