/**
 * CLI entry for the readiness probe, used by CI to wait for object
 * storage before the suite starts. Exit 0 = ready, 1 = not ready.
 *   pnpm exec tsx test/_s3-ready.cli.ts
 */
import './_setup.js';
import { objectStorageProblem } from './_s3-ready.js';

void objectStorageProblem().then((problem) => {
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log('object storage ready');
});
