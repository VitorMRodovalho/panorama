/**
 * Dependency license gate.
 * Blocks pnpm dependencies with licences incompatible with AGPL-3.0-or-later.
 *
 * Placeholder implementation — swap for `license-checker` or equivalent in CI.
 * For now: read pnpm-lock.yaml and fail if a package declares a forbidden SPDX id.
 */

const FORBIDDEN_SPDX = new Set<string>([
  'SSPL-1.0',
  'Commons-Clause',
  'Parity-7.0.0',
]);

const ALLOWED_SPDX = new Set<string>([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'MPL-2.0',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
  'GPL-2.0-or-later',
  'GPL-3.0-or-later',
  'AGPL-3.0-or-later',
  'Unlicense',
]);

// eslint-disable-next-line no-console
console.log('license-check: stub — replace with license-checker invocation.');
console.log('Forbidden SPDX ids: ' + [...FORBIDDEN_SPDX].join(', '));
console.log('Allowed SPDX ids:   ' + [...ALLOWED_SPDX].join(', '));
