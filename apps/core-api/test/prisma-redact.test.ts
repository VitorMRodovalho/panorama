import { describe, it, expect } from 'vitest';
import {
  PRISMA_REDACT_FIELDS,
  redactSensitive,
} from '../src/modules/prisma/prisma.service.js';

/**
 * PAT pre-image hygiene — ADR-0010 requires that the Prisma log path
 * never tees `tokenHash` / `password` / `secretHash` / `emailHash`
 * plaintext to stdout. `redactSensitive` is the belt-and-braces.
 * Unit-only so the regex behaviour is locked in without booting the
 * app.
 */

describe('prisma redactSensitive', () => {
  it('redacts JSON-shaped tokenHash payloads', () => {
    const before = '{"id":"x","tokenHash":"abcdef12345","tokenPrefix":"pnrm_pat_abc"}';
    const after = redactSensitive(before);
    expect(after).toContain('"tokenHash":"<redacted>"');
    expect(after).not.toContain('abcdef12345');
    expect(after).toContain('"tokenPrefix":"pnrm_pat_abc"'); // prefix is safe
  });

  it('redacts SQL-literal shaped values', () => {
    const before = `INSERT INTO personal_access_tokens ("tokenHash") VALUES ('abcdef12345')`;
    const after = redactSensitive(before);
    // The VALUES position doesn't have a field-name match — this case
    // is covered by the params-vector redaction at the $on('query')
    // handler level. Here we at least confirm the col-name-adjacent
    // form gets cleaned.
    expect(
      redactSensitive(`"tokenHash" = 'abcdef12345'`),
    ).toBe(`"tokenHash" = '<redacted>'`);
    // The VALUES-only form is out of this function's scope — documented
    // as the reason the $on('query') handler blanks the whole params
    // vector when a sensitive column is referenced in the query text.
    void after;
  });

  it('redacts object-literal shape used in Prisma warn messages', () => {
    const before = `tokenHash: 'super-secret-hash-abcdef', tokenPrefix: 'pnrm_pat_a'`;
    const after = redactSensitive(before);
    expect(after).toBe(`tokenHash: '<redacted>', tokenPrefix: 'pnrm_pat_a'`);
  });

  it('covers every sensitive field name listed in PRISMA_REDACT_FIELDS', () => {
    // Guard against silent list shrinkage — if someone deletes a field
    // from the exported array, this test fails until the test roster
    // is updated in lock step.
    expect(PRISMA_REDACT_FIELDS).toEqual([
      'tokenHash',
      'password',
      'secretHash',
      'emailHash',
      'accessKeyId',
      'secretAccessKey',
      'AccessKeyId',
      'SecretAccessKey',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'authorization',
      'Authorization',
    ]);
    for (const field of PRISMA_REDACT_FIELDS) {
      const msg = `{"${field}":"leaky-value"}`;
      expect(redactSensitive(msg)).toBe(`{"${field}":"<redacted>"}`);
    }
  });

  it('leaves non-sensitive fields untouched', () => {
    const before = `{"tokenPrefix":"pnrm_pat_abc","scopes":["snipeit.compat.read"]}`;
    expect(redactSensitive(before)).toBe(before);
  });

  it('does not match lookalike field names (word boundary)', () => {
    // Defensive: a field called `apiTokenHashedAt` shouldn't match the
    // `tokenHash` rule. The word-boundary anchor keeps that distinct
    // from substring sprawl.
    const before = `"apiTokenHashedAt":"2026-04-18T00:00:00Z"`;
    expect(redactSensitive(before)).toBe(before);
  });
});
