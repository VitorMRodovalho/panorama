import * as matchers from '@testing-library/jest-dom/matchers';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

// jest-dom matchers, registered without `@testing-library/jest-dom/vitest`.
// That entry's type augmentation (jest-dom 7.0.1) declares
// `Assertion<T>`, which no longer merges with Vitest 5's
// `Assertion<R, T>` (TS2428, hidden by `skipLibCheck`): the matchers then
// type-check with the received value as their return type instead of
// `void` / `Promise<void>`. Upstream: testing-library/jest-dom#738, fix in
// review as testing-library/jest-dom#742. The augmentation below has the
// Vitest 5 shape; once a jest-dom release ships it, go back to
// `import '@testing-library/jest-dom/vitest'` and delete this block.
expect.extend(matchers);

declare module 'vitest' {
  interface Assertion<R, T> extends TestingLibraryMatchers<any, R> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}

// React Testing Library's auto-cleanup only fires when an `afterEach`
// hook is registered globally. Vitest does NOT inject one when
// `globals: false`, so register it here. Without this every test's
// previous render leaks into the next via shared `document.body`.
afterEach(() => {
  cleanup();
});
