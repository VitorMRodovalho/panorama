/**
 * Typed errors thrown by `PhotoPipeline.process` (ADR-0012 §4).
 *
 * The HTTP layer (InspectionController) maps these to 4xx codes and
 * funnels the `errorClass` into the `panorama.inspection.photo.*`
 * audit metadata. Keeping the failure taxonomy here means callers
 * never have to `instanceof` libvips error shapes — they
 * pattern-match on these classes only.
 */
export type PhotoPipelineFailureReason =
  | 'unsupported_type'
  | 'too_large_pixels'
  | 'processing_failed';

export class PhotoPipelineError extends Error {
  readonly reason: PhotoPipelineFailureReason;
  /** Best-effort cause class name; never the libvips raw message. */
  readonly errorClass: string;
  constructor(
    reason: PhotoPipelineFailureReason,
    errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoPipelineError';
    this.reason = reason;
    this.errorClass = errorClass;
  }
}

export class PhotoUnsupportedTypeError extends PhotoPipelineError {
  /** Detected MIME or 'unknown' / 'empty_buffer'. */
  readonly detectedMime: string;
  constructor(detectedMime: string) {
    super('unsupported_type', 'PhotoUnsupportedTypeError', `unsupported_type:${detectedMime}`);
    this.name = 'PhotoUnsupportedTypeError';
    this.detectedMime = detectedMime;
  }
}

export class PhotoTooLargePixelsError extends PhotoPipelineError {
  readonly pixels: number;
  readonly limit: number;
  constructor(pixels: number, limit: number) {
    super(
      'too_large_pixels',
      'PhotoTooLargePixelsError',
      `too_large_pixels:${pixels}>limit=${limit}`,
    );
    this.name = 'PhotoTooLargePixelsError';
    this.pixels = pixels;
    this.limit = limit;
  }
}

export class PhotoProcessingError extends PhotoPipelineError {
  constructor(errorClass: string) {
    super('processing_failed', errorClass, `processing_failed:${errorClass}`);
    this.name = 'PhotoProcessingError';
  }
}

/**
 * Wrap a libvips/sharp error so the libvips raw message — which can
 * contain absolute paths or memory addresses on some platforms —
 * never escapes into HTTP responses or audit metadata.
 *
 * `limitInputPixels` violations surface as `Input image exceeds pixel limit`
 * from libvips; that string is matched here so the caller can audit
 * `too_large_pixels` cleanly. `configuredPixelLimit` MUST be the same
 * value the calling pipeline used — otherwise the audit row's `limit`
 * field lies for tenants that override `PHOTO_LIMIT_INPUT_PIXELS`.
 */
export function wrapSharpError(err: unknown, configuredPixelLimit: number): PhotoPipelineError {
  if (err instanceof PhotoPipelineError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/exceeds pixel limit/i.test(message)) {
    // -1 because libvips throws on decode without surfacing the
    // actual pixel count; the caller already pre-flighted on
    // `metadata().width × .height` so the only path here is
    // missing-metadata images that decode large.
    return new PhotoTooLargePixelsError(-1, configuredPixelLimit);
  }
  const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
  return new PhotoProcessingError(errorClass);
}
