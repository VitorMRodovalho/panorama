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
// ADR-0015 v2 — PrismaService.runAsSuperAdmin needs the privileged
// URL. e2e tests set DATABASE_URL to the panorama_app role; the
// privileged URL points at panorama_super_admin (whose dev-stack
// password is `panorama` per infra/docker/postgres-init.sql). The
// PrismaService boot-time guard refuses identical URLs, so this
// default differs from the app URL e2e files set.
if (!process.env['DATABASE_PRIVILEGED_URL']) {
  const host = process.env['PG_HOST'] ?? 'localhost';
  const port = process.env['PG_PORT'] ?? '5432';
  const db = process.env['PG_DB'] ?? 'panorama';
  process.env['DATABASE_PRIVILEGED_URL'] =
    `postgres://panorama_super_admin:panorama@${host}:${port}/${db}?schema=public`;
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
