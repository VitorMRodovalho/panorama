import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import exifr from 'exifr';
import {
  ACCEPTED_INPUT_MIME,
  type PhotoPipelineConfig,
  loadPhotoPipelineConfig,
} from './photo-pipeline.config.js';
import {
  PhotoPipelineError,
  PhotoTooLargePixelsError,
  PhotoUnsupportedTypeError,
  wrapSharpError,
} from './photo-pipeline.errors.js';

/**
 * PhotoPipeline (ADR-0012 §4) — server-side sanitise stage that
 * transforms an untrusted client upload into a clean JPEG before any
 * S3 PUT or DB row is written.
 *
 * Steps performed:
 *
 *   1. magic-byte sniff via `file-type` — reject anything outside the
 *      ADR's allow-list (jpeg/png/webp/heic/heif). Defeats polyglots
 *      that shimmer one MIME at the extension level.
 *   2. EXIF breadcrumb — `sharp.metadata()` lists field NAMES (values
 *      never read) for the audit trail. `exifr` extracts
 *      `DateTimeOriginal` independently; isolated from libvips memory
 *      so a malformed-EXIF input can't reach pixel decode.
 *   3. sanitise — sharp `.rotate().resize().jpeg()`. Default behaviour
 *      since 0.33 strips EXIF / ICC / XMP / IPTC; the calls
 *      `keepExif/keepIccProfile/keepMetadata` are opt-IN and take NO
 *      argument (the ADR's `(false)` signature is a doc bug — the
 *      effect is the same: don't call them and the output is clean).
 *      The exiftool round-trip in `photo-pipeline.test.ts` is the
 *      load-bearing CI guard against a future sharp upgrade silently
 *      changing the default.
 *   4. SHA-256 over the sanitised buffer — used for S3 PutObject
 *      `ChecksumSHA256` and stored on the row for tenant-local dedup.
 *
 * The pipeline is pure — no S3, no DB. The caller (`InspectionService`)
 * does the IO.
 */
export interface PhotoSanitiseInput {
  buffer: Buffer;
  /** Per-tenant override of `cfg.maxPhotoDimension`; falls back if absent. */
  maxDimensionOverride?: number;
}

export interface PhotoSanitiseResult {
  /** The re-encoded JPEG bytes ready for S3 PUT. */
  sanitisedBuffer: Buffer;
  /** Always `image/jpeg` (sharp re-encodes regardless of input). */
  contentType: 'image/jpeg';
  width: number;
  height: number;
  sizeBytes: number;
  /** Hex digest of `sanitisedBuffer`. */
  sha256: string;
  /**
   * `DateTimeOriginal` from input EXIF if present + parseable. Phones
   * occasionally lie or omit; null on any failure (best-effort).
   */
  capturedAt: Date | null;
  /**
   * True iff the input carried any EXIF / ICC / XMP block that the
   * sanitise step removed. Used in the audit row's `exifStripped`.
   */
  exifStripped: boolean;
  /**
   * Field NAMES (not values) detected on the input. Bounded by the
   * sharp metadata surface, so cardinality is small. For audit only.
   */
  inputMetadataFields: string[];
  /** Sniffed MIME of the original input (audit / debugging). */
  sourceMime: string;
}

@Injectable()
export class PhotoPipeline {
  private readonly log = new Logger('PhotoPipeline');
  private readonly cfg: PhotoPipelineConfig;

  // `@Optional()` — under Nest DI no provider for `PhotoPipelineConfig`
  // is registered, so the param resolves to `undefined` and the
  // constructor falls back to env. Direct `new PhotoPipeline(cfg)` in
  // unit tests passes a literal cfg (the env path is bypassed).
  constructor(@Optional() cfg?: PhotoPipelineConfig) {
    this.cfg = cfg ?? loadPhotoPipelineConfig(process.env);
  }

  /** Read-only view of the encoder defaults — exposed for tests + audit. */
  get config(): Readonly<PhotoPipelineConfig> {
    return this.cfg;
  }

  /**
   * Run the full sanitise pipeline. Throws `PhotoPipelineError`
   * subclasses on any failure — the caller maps them to HTTP codes:
   *
   * - `PhotoUnsupportedTypeError`  → 415 unsupported_media_type
   * - `PhotoTooLargePixelsError`   → 400 photo_too_large_pixels
   * - `PhotoProcessingError`       → 400 photo_processing_failed
   */
  async process(input: PhotoSanitiseInput): Promise<PhotoSanitiseResult> {
    const { buffer } = input;
    if (!buffer || buffer.length === 0) {
      throw new PhotoUnsupportedTypeError('empty_buffer');
    }

    const sniff = await fileTypeFromBuffer(buffer);
    if (!sniff) {
      throw new PhotoUnsupportedTypeError('unknown');
    }
    if (!ACCEPTED_INPUT_MIME.has(sniff.mime)) {
      throw new PhotoUnsupportedTypeError(sniff.mime);
    }

    const sharpInputOpts: sharp.SharpOptions = {
      limitInputPixels: this.cfg.limitInputPixels,
      sequentialRead: true,
    };

    let inputMetadataFields: string[] = [];
    try {
      const md = await sharp(buffer, sharpInputOpts).metadata();
      // Pre-flight pixel check — sharp only enforces `limitInputPixels`
      // at decode time; failing fast here gives a clean error class
      // and avoids decoding a multi-gigabyte raster.
      if (md.width && md.height) {
        const px = md.width * md.height;
        if (px > this.cfg.limitInputPixels) {
          throw new PhotoTooLargePixelsError(px, this.cfg.limitInputPixels);
        }
      }
      inputMetadataFields = collectMetadataFieldNames(md);
    } catch (err) {
      throw wrapSharpError(err, this.cfg.limitInputPixels);
    }

    const capturedAt = await tryReadCapturedAt(buffer);

    const maxDim =
      input.maxDimensionOverride ?? this.cfg.maxPhotoDimension;

    let sanitised: Buffer;
    let outWidth: number;
    let outHeight: number;
    try {
      // NOTE on the deliberate API choice: sharp 0.33+ strips EXIF /
      // ICC / XMP / IPTC by default. The methods `.keepExif()`,
      // `.keepIccProfile()`, `.keepMetadata()` are opt-IN (no boolean
      // arg). Calling them — even with `(false)` as the ADR text
      // suggests — actually ENABLES the keep flag. The correct way to
      // strip is to NOT call them. The exiftool round-trip test pins
      // this guarantee for future sharp upgrades.
      const result = await sharp(buffer, sharpInputOpts)
        .rotate()
        .resize({
          width: maxDim,
          height: maxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: this.cfg.jpegQuality, mozjpeg: false })
        .toBuffer({ resolveWithObject: true });
      sanitised = result.data;
      outWidth = result.info.width;
      outHeight = result.info.height;
    } catch (err) {
      throw wrapSharpError(err, this.cfg.limitInputPixels);
    }

    const sha256 = createHash('sha256').update(sanitised).digest('hex');

    return {
      sanitisedBuffer: sanitised,
      contentType: 'image/jpeg',
      width: outWidth,
      height: outHeight,
      sizeBytes: sanitised.length,
      sha256,
      capturedAt,
      exifStripped: inputMetadataFields.length > 0,
      inputMetadataFields,
      sourceMime: sniff.mime,
    };
  }
}

/**
 * Translate a sharp Metadata blob into a flat list of field NAMES
 * present on the input. Values are intentionally never read into the
 * audit trail to avoid leaking EXIF GPS / device serial / owner name.
 *
 * Inversion-safe enumeration: any sharp-Metadata key not in the known
 * pixel-property set is treated as "metadata present" so a future
 * sharp release surfacing a new container block (e.g. C2PA, CICP)
 * doesn't silently get reported as `exifStripped=false`.
 */
const KNOWN_PIXEL_PROPERTIES = new Set<string>([
  'format',
  'formatMagick',
  'size',
  'width',
  'height',
  'space',
  'channels',
  'depth',
  'density',
  'chromaSubsampling',
  'isProgressive',
  'paletteBitDepth',
  'pages',
  'pageHeight',
  'loop',
  'delay',
  'pagePrimary',
  'levels',
  'subifds',
  'background',
  'compression',
  'resolutionUnit',
  'hasProfile',
  'hasAlpha',
  'isPalette',
  'bitsPerSample',
]);

function collectMetadataFieldNames(md: sharp.Metadata): string[] {
  const names = new Set<string>();
  // Explicit named slots first — keeps the audit row's vocabulary
  // stable across sharp upgrades for the load-bearing forensic
  // breadcrumbs (exif/icc/iptc/xmp/tifftagPhotoshop).
  if (md.exif && md.exif.length > 0) names.add('exif');
  if (md.icc && md.icc.length > 0) names.add('icc');
  if (md.iptc && md.iptc.length > 0) names.add('iptc');
  if (md.xmp && md.xmp.length > 0) names.add('xmp');
  if (md.tifftagPhotoshop && md.tifftagPhotoshop.length > 0) {
    names.add('tifftagPhotoshop');
  }
  if (md.orientation && md.orientation !== 1) names.add('orientation');
  // Catch-all: anything sharp surfaces that isn't a pixel-only
  // property is treated as a metadata block. Forces `exifStripped=true`
  // when an unknown future block ships through.
  for (const [key, value] of Object.entries(md)) {
    if (KNOWN_PIXEL_PROPERTIES.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (Buffer.isBuffer(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Buffer.isBuffer(value) && Object.keys(value).length === 0) continue;
    names.add(`unknown:${key}`);
  }
  return [...names];
}

/**
 * Pure-JS EXIF read for `DateTimeOriginal`. Wrapped wholesale because
 * exifr can throw on malformed EXIF (the very inputs this pipeline
 * exists to handle); a parse failure simply means no `capturedAt`.
 *
 * `firstChunkSize: 65536` bounds parser CPU on adversarial inputs —
 * EXIF segments live in the JPEG APP1 marker (right at the start) and
 * HEIC metadata items are also small + early; 64 KB is plenty for any
 * legitimate camera output.
 */
async function tryReadCapturedAt(buffer: Buffer): Promise<Date | null> {
  try {
    const tags = (await exifr.parse(buffer, {
      pick: ['DateTimeOriginal', 'CreateDate'],
      // Bounds CPU on adversarial inputs — EXIF blocks live in the
      // JPEG APP1 marker (right at start) and HEIC metadata items
      // are also small + early. 64 KB is comfortably above any
      // legitimate camera EXIF segment.
      firstChunkSize: 65536,
      chunkLimit: 1,
    })) as { DateTimeOriginal?: Date; CreateDate?: Date } | undefined;
    if (!tags) return null;
    const candidate = tags.DateTimeOriginal ?? tags.CreateDate;
    if (!(candidate instanceof Date) || Number.isNaN(candidate.getTime())) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Re-export so callers (InspectionService, exception filter) only
 * depend on a single import path.
 */
export {
  PhotoPipelineError,
  PhotoUnsupportedTypeError,
  PhotoTooLargePixelsError,
};
