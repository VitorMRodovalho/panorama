import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library's auto-cleanup only fires when an `afterEach`
// hook is registered globally. Vitest does NOT inject one when
// `globals: false`, so register it here. Without this every test's
// previous render leaks into the next via shared `document.body`.
afterEach(() => {
  cleanup();
});
