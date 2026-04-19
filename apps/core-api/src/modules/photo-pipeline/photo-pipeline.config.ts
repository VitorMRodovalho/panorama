/**
 * Photo-pipeline config (ADR-0012 §4) — sharp encoder + sniff knobs.
 *
 * Read once at module construction; per-tenant overrides ride on top
 * via `Tenant.inspectionConfig.maxPhotoDimension` and live in the
 * caller (`InspectionService`), not here. This module owns ONLY the
 * cluster-wide defaults + safety caps.
 */
import { z } from 'zod';

export interface PhotoPipelineConfig {
  /** Default longest-edge resize target in pixels. ADR default 2048. */
  maxPhotoDimension: number;
  /**
   * Sharp/libvips decompression-bomb cap. Inputs over this many
   * pixels are refused before any pixel buffer is allocated.
   * ADR default 24_000_000 (≈ 6000×4000, well above any phone camera).
   */
  limitInputPixels: number;
  /** JPEG encoder quality. ADR default 85. */
  jpegQuality: number;
}

const ConfigSchema = z.object({
  PHOTO_MAX_DIMENSION: z.string().default('2048'),
  PHOTO_LIMIT_INPUT_PIXELS: z.string().default('24000000'),
  PHOTO_JPEG_QUALITY: z.string().default('85'),
});

export function loadPhotoPipelineConfig(env: NodeJS.ProcessEnv): PhotoPipelineConfig {
  const parsed = ConfigSchema.parse(env);
  const maxPhotoDimension = Number.parseInt(parsed.PHOTO_MAX_DIMENSION, 10);
  const limitInputPixels = Number.parseInt(parsed.PHOTO_LIMIT_INPUT_PIXELS, 10);
  const jpegQuality = Number.parseInt(parsed.PHOTO_JPEG_QUALITY, 10);

  if (!Number.isFinite(maxPhotoDimension) || maxPhotoDimension < 64 || maxPhotoDimension > 8192) {
    throw new Error(`PHOTO_MAX_DIMENSION must be 64..8192 (got ${parsed.PHOTO_MAX_DIMENSION})`);
  }
  if (
    !Number.isFinite(limitInputPixels) ||
    limitInputPixels < 1_000_000 ||
    limitInputPixels > 200_000_000
  ) {
    // Upper bound stops an operator typo (`2400000000` instead of
    // `24000000`) from silently disabling decompression-bomb defense.
    throw new Error(
      `PHOTO_LIMIT_INPUT_PIXELS must be 1_000_000..200_000_000 (got ${parsed.PHOTO_LIMIT_INPUT_PIXELS})`,
    );
  }
  if (!Number.isFinite(jpegQuality) || jpegQuality < 1 || jpegQuality > 100) {
    throw new Error(`PHOTO_JPEG_QUALITY must be 1..100 (got ${parsed.PHOTO_JPEG_QUALITY})`);
  }

  return { maxPhotoDimension, limitInputPixels, jpegQuality };
}

export const ACCEPTED_INPUT_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
