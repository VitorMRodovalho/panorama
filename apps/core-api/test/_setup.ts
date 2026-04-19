/**
 * Vitest setup — runs before any test file imports.
 *
 * Sets default env vars that gated modules (e.g. InspectionModule via
 * `FEATURE_INSPECTIONS`, ObjectStorageModule + PhotoPipelineModule
 * paired with it) need at module-load time. Running this in
 * `setupFiles` is critical: ESM hoisting moves test-file imports
 * above any `process.env` assignment that lives inside the test
 * body, so a per-file beforeAll cannot toggle a module-load
 * conditional.
 *
 * Defaults are conservative — they only turn ON things tests assume
 * are wired. CI / shell can override any of them by exporting before
 * `pnpm test`.
 */

if (!process.env['FEATURE_INSPECTIONS']) {
  process.env['FEATURE_INSPECTIONS'] = 'true';
}
if (!process.env['SESSION_SECRET']) {
  process.env['SESSION_SECRET'] = 'a'.repeat(32);
}
// MinIO dev defaults — ObjectStorageModule's loader requires these
// at boot. Tests don't actually hit S3 at this layer, but the module
// still parses the config eagerly.
if (!process.env['S3_ENDPOINT']) process.env['S3_ENDPOINT'] = 'http://localhost:9000';
if (!process.env['S3_BUCKET_PHOTOS']) process.env['S3_BUCKET_PHOTOS'] = 'panorama-photos';
if (!process.env['S3_ACCESS_KEY']) process.env['S3_ACCESS_KEY'] = 'minioadmin';
if (!process.env['S3_SECRET_KEY']) process.env['S3_SECRET_KEY'] = 'minioadmin';
if (!process.env['S3_FORCE_PATH_STYLE']) process.env['S3_FORCE_PATH_STYLE'] = 'true';
if (!process.env['S3_ALLOW_PRIVATE_ENDPOINT']) {
  process.env['S3_ALLOW_PRIVATE_ENDPOINT'] = 'true';
}
