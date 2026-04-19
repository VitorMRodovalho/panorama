import { Module } from '@nestjs/common';
import { PhotoPipeline } from './photo-pipeline.service.js';
import { PhotoUploadRateLimiter } from './photo-upload-rate-limiter.js';

/**
 * PhotoPipelineModule (ADR-0012 §4) — sanitise stage + per-user/tenant
 * upload caps. Pure-CPU + Redis-backed; no DB or S3 directly. The
 * RedisModule is `@Global` so no explicit import is needed for the
 * limiter wrapper to receive `RateLimiter`.
 *
 * Loaded at boot only when `FEATURE_INSPECTIONS` is on (gated in
 * `app.module.ts` alongside `ObjectStorageModule`).
 */
@Module({
  providers: [PhotoPipeline, PhotoUploadRateLimiter],
  exports: [PhotoPipeline, PhotoUploadRateLimiter],
})
export class PhotoPipelineModule {}
