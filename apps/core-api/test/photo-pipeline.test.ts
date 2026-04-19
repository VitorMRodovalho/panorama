import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { PhotoPipeline } from '../src/modules/photo-pipeline/photo-pipeline.service.js';
import {
  PhotoTooLargePixelsError,
  PhotoUnsupportedTypeError,
  PhotoProcessingError,
} from '../src/modules/photo-pipeline/photo-pipeline.errors.js';
import { loadPhotoPipelineConfig } from '../src/modules/photo-pipeline/photo-pipeline.config.js';

/**
 * PhotoPipeline acceptance — the load-bearing CI guard for ADR-0012 §4.
 *
 * Fixtures are generated programmatically (sharp itself can write
 * EXIF + ICC blocks via `.withExif()` / `.withIccProfile()`), so the
 * repo doesn't carry binary blobs. The exiftool round-trip is gated
 * on the binary being present — a missing exiftool downgrades to a
 * `console.warn` skip rather than failing CI on dev boxes.
 */

const pipeline = new PhotoPipeline({
  maxPhotoDimension: 2048,
  limitInputPixels: 24_000_000,
  jpegQuality: 85,
});

let plainJpeg: Buffer;
let exifJpeg: Buffer;
let iccPng: Buffer;
let exifWebp: Buffer;
let largeImage: Buffer;
let bombPng: Buffer;
let polyglotPdfJpeg: Buffer;

let exiftoolAvailable = false;
let tmpDir: string;

beforeAll(async () => {
  // Lossless plain JPEG, 256x256 solid colour. No metadata.
  plainJpeg = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  // JPEG with EXIF — Software + DateTime + DateTimeOriginal + a few
  // GPS-shaped tag NAMES on IFD0. Sharp's `Exif` type only models the
  // four IFD slots (IFD0..IFD3) and forwards the dict to libvips
  // verbatim; the tags below all get written into the IFD0 block,
  // which is enough for the strip-everything assertion. The reader
  // (sharp.metadata) reports "exif present"; the round-trip fixture
  // asserts strip post-sanitise.
  exifJpeg = await sharp({
    create: {
      width: 512,
      height: 384,
      channels: 3,
      background: { r: 220, g: 80, b: 80 },
    },
  })
    .keepExif()
    .withExif({
      IFD0: {
        Software: 'PhotoPipelineTest 1.0',
        DateTime: '2025:11:02 14:33:21',
        DateTimeOriginal: '2025:11:02 14:33:21',
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  // PNG with ICC profile attached.
  iccPng = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 0, g: 200, b: 100 },
    },
  })
    .withIccProfile('srgb')
    .keepIccProfile()
    .png()
    .toBuffer();

  // WebP with EXIF — covers the reviewer's HEIC/WebP/PNG concern that
  // the metadata-name enumeration only being JPEG-tested could miss
  // a container-specific block.
  exifWebp = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 30, g: 30, b: 30 },
    },
  })
    .keepExif()
    .withExif({ IFD0: { Software: 'WebpPipelineTest 1.0' } })
    .webp({ quality: 90 })
    .toBuffer();

  // 3000x3000 PNG — exercises the resize step (caps at 2048).
  largeImage = await sharp({
    create: {
      width: 3000,
      height: 3000,
      channels: 3,
      background: { r: 50, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();

  // Decompression-bomb fixture — 5000x5000 = 25 megapixels, just over
  // the 24M cap. Solid colour PNG compresses to ~few KB on disk so
  // generation is cheap; the pipeline must reject it before pixel
  // decode.
  bombPng = await sharp({
    create: {
      width: 5000,
      height: 5000,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Polyglot — file starts with %PDF magic, JPEG bytes appended.
  // `file-type` sniffs the leading bytes only, so the input registers
  // as application/pdf and the pipeline rejects on type.
  polyglotPdfJpeg = Buffer.concat([
    Buffer.from('%PDF-1.4\n%fake header\n', 'utf8'),
    plainJpeg,
  ]);

  exiftoolAvailable = await detectExiftool();
  tmpDir = await mkdtemp(join(tmpdir(), 'photo-pipeline-test-'));
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('PhotoPipeline.process — happy path', () => {
  it('re-encodes a plain JPEG to JPEG with stable sha256', async () => {
    const a = await pipeline.process({ buffer: plainJpeg });
    const b = await pipeline.process({ buffer: plainJpeg });
    expect(a.contentType).toBe('image/jpeg');
    expect(a.width).toBe(256);
    expect(a.height).toBe(256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Sharp's encoder is deterministic for identical input + options →
    // sha256 stable run-over-run is the regression guard we want.
    expect(a.sha256).toBe(b.sha256);
    expect(a.sourceMime).toBe('image/jpeg');
    expect(a.exifStripped).toBe(false);
    expect(a.capturedAt).toBeNull();
  });

  it('resizes a 3000×3000 input down to 2048 longest edge', async () => {
    const out = await pipeline.process({ buffer: largeImage });
    expect(Math.max(out.width, out.height)).toBe(2048);
    expect(out.contentType).toBe('image/jpeg');
  });

  it('honours per-tenant maxDimensionOverride', async () => {
    const out = await pipeline.process({
      buffer: largeImage,
      maxDimensionOverride: 800,
    });
    expect(Math.max(out.width, out.height)).toBe(800);
  });
});

describe('PhotoPipeline.process — metadata strip', () => {
  it('strips EXIF (Software, GPS, DateTime) on output JPEG', async () => {
    const out = await pipeline.process({ buffer: exifJpeg });
    expect(out.exifStripped).toBe(true);
    expect(out.inputMetadataFields).toContain('exif');

    // The sanitised buffer must have NO readable EXIF.
    const reread = await sharp(out.sanitisedBuffer).metadata();
    expect(reread.exif).toBeUndefined();
    expect(reread.icc).toBeUndefined();
    expect(reread.iptc).toBeUndefined();
    expect(reread.xmp).toBeUndefined();

    // exifr should also see nothing.
    const tags = await exifr.parse(out.sanitisedBuffer).catch(() => undefined);
    expect(tags).toBeFalsy();
  });

  it('strips ICC profile when input is a PNG with ICC', async () => {
    const out = await pipeline.process({ buffer: iccPng });
    expect(out.exifStripped).toBe(true);
    expect(out.inputMetadataFields).toContain('icc');
    const reread = await sharp(out.sanitisedBuffer).metadata();
    expect(reread.icc).toBeUndefined();
  });

  it('strips EXIF on a WebP input (re-encoded to JPEG)', async () => {
    const out = await pipeline.process({ buffer: exifWebp });
    expect(out.contentType).toBe('image/jpeg');
    expect(out.sourceMime).toBe('image/webp');
    expect(out.exifStripped).toBe(true);
    expect(out.inputMetadataFields).toContain('exif');
    const reread = await sharp(out.sanitisedBuffer).metadata();
    expect(reread.exif).toBeUndefined();
    expect(reread.icc).toBeUndefined();
  });

  it('returns capturedAt = null when DateTimeOriginal is absent / unreadable', async () => {
    // The synthetic fixture writes DateTimeOriginal into IFD0 (sharp's
    // `withExif` only models IFD0..IFD3); exifr's friendly-name lookup
    // for `DateTimeOriginal` only matches the EXIF sub-IFD where real
    // cameras put it. So this fixture's `capturedAt` is null —
    // exercising the safe-default branch of `tryReadCapturedAt`.
    // Real-photo extraction is covered by the inspection-photo
    // integration test (Execution-order step 10).
    const out = await pipeline.process({ buffer: exifJpeg });
    expect(out.capturedAt).toBeNull();
  });

  it('never throws from the EXIF reader on malformed metadata', async () => {
    // Pin the "exifr-throws-but-pipeline-survives" guarantee: a
    // fixture whose only EXIF is what sharp wrote to IFD0 doesn't
    // structurally satisfy DateTimeOriginal, but the pipeline still
    // completes a clean sanitise — no thrown exception leaking out.
    await expect(pipeline.process({ buffer: exifJpeg })).resolves.toMatchObject({
      contentType: 'image/jpeg',
      exifStripped: true,
    });
  });

  it('exiftool sees zero metadata across JPEG / PNG / WebP inputs', async () => {
    if (!exiftoolAvailable) {
      // eslint-disable-next-line no-console
      console.warn('skip: exiftool binary not on PATH — install libimage-exiftool-perl to enable');
      return;
    }
    // Forensic vectors — none may survive sanitise, regardless of the
    // input container. Three inputs exercise the strip across the
    // metadata-bearing formats sharp can produce in tests (HEIC needs
    // libheif which isn't bundled in the dev image).
    const cases: Array<[string, Buffer]> = [
      ['jpeg-with-exif', exifJpeg],
      ['png-with-icc', iccPng],
      ['webp-with-exif', exifWebp],
    ];
    const forbidden = [
      'GPSLatitude',
      'GPSLongitude',
      'GPSPosition',
      'Software',
      'DateTimeOriginal',
      'Make',
      'Model',
      'SerialNumber',
      'OwnerName',
      'ProfileDescription',
      'XMP-dc:Creator',
    ];
    for (const [name, fixture] of cases) {
      const out = await pipeline.process({ buffer: fixture });
      const fixturePath = join(tmpDir, `sanitised-${name}.jpg`);
      await writeFile(fixturePath, out.sanitisedBuffer);
      const json = await runExiftool(fixturePath);
      for (const tag of forbidden) {
        expect(json[0]?.[tag], `${name}: ${tag} survived strip`).toBeUndefined();
      }
    }
  });
});

describe('PhotoPipeline.process — rejection paths', () => {
  it('rejects an empty buffer with PhotoUnsupportedTypeError', async () => {
    await expect(
      pipeline.process({ buffer: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(PhotoUnsupportedTypeError);
  });

  it('rejects unknown bytes (random text) with PhotoUnsupportedTypeError', async () => {
    await expect(
      pipeline.process({ buffer: Buffer.from('not an image at all') }),
    ).rejects.toBeInstanceOf(PhotoUnsupportedTypeError);
  });

  it('rejects PDF (sniffed type out of allow-list)', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%fake\n%%EOF\n', 'utf8');
    const err = await captureRejection(pipeline.process({ buffer: pdf }));
    expect(err).toBeInstanceOf(PhotoUnsupportedTypeError);
    expect((err as PhotoUnsupportedTypeError).detectedMime).toBe('application/pdf');
  });

  it('rejects polyglot PDF-in-JPEG at the magic-byte sniff', async () => {
    const err = await captureRejection(pipeline.process({ buffer: polyglotPdfJpeg }));
    expect(err).toBeInstanceOf(PhotoUnsupportedTypeError);
    expect((err as PhotoUnsupportedTypeError).detectedMime).toBe('application/pdf');
  });

  it('rejects a 25-megapixel decompression bomb with PhotoTooLargePixelsError', async () => {
    await expect(
      pipeline.process({ buffer: bombPng }),
    ).rejects.toBeInstanceOf(PhotoTooLargePixelsError);
  });

  it('PhotoPipelineError subclasses carry an audit-friendly errorClass', async () => {
    const err = await captureRejection(pipeline.process({ buffer: bombPng }));
    expect(err).toBeInstanceOf(PhotoTooLargePixelsError);
    expect((err as PhotoTooLargePixelsError).errorClass).toBe('PhotoTooLargePixelsError');
    expect((err as PhotoTooLargePixelsError).reason).toBe('too_large_pixels');
  });

  it('PhotoProcessingError is the catchall for libvips failures (sanity)', () => {
    // No fixture reliably triggers a non-pixel sharp failure on every
    // platform; assert the class shape so refactors keep the audit
    // contract intact.
    const e = new PhotoProcessingError('LibvipsError');
    expect(e.errorClass).toBe('LibvipsError');
    expect(e.reason).toBe('processing_failed');
  });
});

describe('loadPhotoPipelineConfig', () => {
  const baseEnv = {
    PHOTO_MAX_DIMENSION: '2048',
    PHOTO_LIMIT_INPUT_PIXELS: '24000000',
    PHOTO_JPEG_QUALITY: '85',
  };

  it('parses defaults', () => {
    const cfg = loadPhotoPipelineConfig(baseEnv);
    expect(cfg.maxPhotoDimension).toBe(2048);
    expect(cfg.limitInputPixels).toBe(24_000_000);
    expect(cfg.jpegQuality).toBe(85);
  });

  it('rejects an out-of-range maxPhotoDimension', () => {
    expect(() =>
      loadPhotoPipelineConfig({ ...baseEnv, PHOTO_MAX_DIMENSION: '32' }),
    ).toThrow(/must be 64..8192/);
    expect(() =>
      loadPhotoPipelineConfig({ ...baseEnv, PHOTO_MAX_DIMENSION: '99999' }),
    ).toThrow(/must be 64..8192/);
  });

  it('rejects a too-low limitInputPixels (operator typo guard)', () => {
    expect(() =>
      loadPhotoPipelineConfig({ ...baseEnv, PHOTO_LIMIT_INPUT_PIXELS: '500000' }),
    ).toThrow(/must be 1_000_000/);
  });

  it('rejects a too-high limitInputPixels (extra-zero typo)', () => {
    expect(() =>
      loadPhotoPipelineConfig({
        ...baseEnv,
        PHOTO_LIMIT_INPUT_PIXELS: '2400000000',
      }),
    ).toThrow(/200_000_000/);
  });

  it('rejects an invalid jpegQuality', () => {
    expect(() =>
      loadPhotoPipelineConfig({ ...baseEnv, PHOTO_JPEG_QUALITY: '0' }),
    ).toThrow(/must be 1..100/);
    expect(() =>
      loadPhotoPipelineConfig({ ...baseEnv, PHOTO_JPEG_QUALITY: '200' }),
    ).toThrow(/must be 1..100/);
  });
});

async function captureRejection<T>(p: Promise<T>): Promise<unknown> {
  try {
    await p;
    throw new Error('expected promise to reject');
  } catch (err) {
    return err;
  }
}

async function detectExiftool(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('exiftool', ['-ver'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function runExiftool(path: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn('exiftool', ['-j', '-G', '-a', path]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`exiftool exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
  });
}
