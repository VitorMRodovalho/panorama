'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// UX-22 (#46): photo upload with progress, cancel, and retry. Drivers
// upload at fleet yards on spotty cellular — without progress feedback
// they assume the upload failed and either resubmit (duplicates) or
// navigate away (losing the photo). Posts to a same-origin route handler
// (apps/web/src/app/api/inspections/[id]/photos/route.ts) so the session
// cookie travels without CORS.
//
// Strings are passed in from the server-rendered parent because the i18n
// loader in apps/web/src/lib/i18n.ts is `import 'server-only'` — it
// cannot cross the 'use client' boundary. The parent owns locale
// resolution and passes the resolved strings (including the seven
// pretty-printed server error messages) so the component never embeds
// English-only literals.

interface UploaderStrings {
  upload: string;
  uploading: string;
  cancel: string;
  retry: string;
  aborted: string;
  failed: string;
  pickFile: string;
  pickFileFirst: string;
  help: string;
  error: {
    rateLimitedSeconds: string; // contains {{seconds}} placeholder
    rateLimited: string;
    tooLargePixels: string;
    unsupportedMediaType: string;
    processingFailed: string;
    capReached: string;
    uploadKeyCollision: string;
    tooLarge: string;
    generic: string;
  };
}

interface PhotoUploaderProps {
  inspectionId: string;
  responseId?: string | undefined;
  strings: UploaderStrings;
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

function generateUploadKey(): string {
  return crypto.randomUUID();
}

// Map server-side error code -> user-facing string. Codes mirror the
// core-api photo controller; the strings come from props (i18n'd by the
// server-rendered parent).
function prettifyError(
  message: string,
  retryAfterSeconds: number | undefined,
  errStrings: UploaderStrings['error'],
): string {
  const m = message.toLowerCase();
  if (m.includes('rate_limited')) {
    return retryAfterSeconds !== undefined
      ? errStrings.rateLimitedSeconds.replace('{{seconds}}', String(retryAfterSeconds))
      : errStrings.rateLimited;
  }
  if (m.includes('photo_too_large_pixels')) return errStrings.tooLargePixels;
  if (m.includes('unsupported_media_type')) return errStrings.unsupportedMediaType;
  if (m.includes('photo_processing_failed')) return errStrings.processingFailed;
  if (m.includes('inspection_photo_cap_reached')) return errStrings.capReached;
  if (m.includes('upload_key_collision')) return errStrings.uploadKeyCollision;
  if (m.includes('photo_too_large')) return errStrings.tooLarge;
  return errStrings.generic;
}

export function PhotoUploader({
  inspectionId,
  responseId,
  strings,
}: PhotoUploaderProps): React.JSX.Element {
  const router = useRouter();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });

  function startUpload(file: File): void {
    if (state.kind === 'uploading') return;

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;

    const form = new FormData();
    form.append('photo', file);
    form.append('clientUploadKey', generateUploadKey());
    if (responseId) form.append('responseId', responseId);

    xhr.upload.addEventListener('progress', (evt) => {
      if (!evt.lengthComputable) return;
      const percent = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
      setState({ kind: 'uploading', percent });
    });

    xhr.addEventListener('load', () => {
      xhrRef.current = null;
      if (xhr.status === 201) {
        setState({ kind: 'idle' });
        if (fileInputRef.current) fileInputRef.current.value = '';
        router.refresh();
        return;
      }
      // If the upstream returned non-JSON (e.g. an HTML 502 from a flaky
      // proxy on slow 3G), fall back to a status-code-keyed message
      // rather than swallowing the signal.
      const contentType = xhr.getResponseHeader('content-type') ?? '';
      let parsed: { message?: string; retryAfterSeconds?: number } = {};
      if (contentType.includes('application/json')) {
        try {
          parsed = JSON.parse(xhr.responseText) as typeof parsed;
        } catch {
          parsed = { message: 'photo_upload_failed' };
        }
      } else {
        parsed = { message: xhr.status === 413 ? 'photo_too_large' : 'photo_upload_failed' };
      }
      setState({
        kind: 'error',
        message: prettifyError(
          parsed.message ?? 'photo_upload_failed',
          parsed.retryAfterSeconds,
          strings.error,
        ),
      });
      // Move focus to Retry so keyboard users land on the next action.
      setTimeout(() => retryButtonRef.current?.focus(), 0);
    });

    xhr.addEventListener('error', () => {
      xhrRef.current = null;
      setState({ kind: 'error', message: strings.failed });
      setTimeout(() => retryButtonRef.current?.focus(), 0);
    });

    xhr.addEventListener('abort', () => {
      xhrRef.current = null;
      setState({ kind: 'aborted' });
    });

    xhr.open('POST', `/api/inspections/${inspectionId}/photos`);
    setState({ kind: 'uploading', percent: 0 });
    // Move focus to Cancel so the driver realises they have an out.
    setTimeout(() => cancelButtonRef.current?.focus(), 0);
    xhr.send(form);
  }

  function onFileChange(): void {
    // Picking (or clearing) a file resets transient error/aborted UI so
    // the next Upload click feels like a fresh attempt.
    setState({ kind: 'idle' });
  }

  function onSubmitClick(): void {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      // Keep the button enabled and surface the nudge inline rather
      // than disabling it — disabled buttons are an accessibility
      // dead end on touch devices (no hover, no focus indicator).
      setState({ kind: 'error', message: strings.pickFileFirst });
      return;
    }
    startUpload(file);
  }

  function onCancel(): void {
    xhrRef.current?.abort();
  }

  function onRetry(): void {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setState({ kind: 'error', message: strings.pickFileFirst });
      return;
    }
    startUpload(file);
  }

  const isUploading = state.kind === 'uploading';

  return (
    <div
      className="panorama-form-grid"
      style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #334155' }}
    >
      <div style={{ gridColumn: '1 / -1' }}>
        <label htmlFor={fileInputId} style={{ display: 'block', marginBottom: 4 }}>
          {strings.pickFile}
        </label>
        <input
          id={fileInputId}
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          disabled={isUploading}
          onChange={onFileChange}
          className="panorama-input"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {!isUploading ? (
          <button type="button" className="panorama-button" onClick={onSubmitClick}>
            {strings.upload}
          </button>
        ) : null}
        {isUploading ? (
          <>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{state.percent}%</span>
            <progress
              value={state.percent}
              max={100}
              aria-label={strings.uploading}
              style={{ width: '100%', maxWidth: 360, height: 12 }}
            />
            <button
              ref={cancelButtonRef}
              type="button"
              className="panorama-button secondary"
              onClick={onCancel}
              style={{ fontSize: 14 }}
            >
              {strings.cancel}
            </button>
          </>
        ) : null}
        {state.kind === 'error' ? (
          <>
            <span
              role="alert"
              style={{
                color: '#b91c1c',
                fontSize: 14,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span aria-hidden="true">⚠</span>
              {state.message}
            </span>
            <button
              ref={retryButtonRef}
              type="button"
              className="panorama-button"
              onClick={onRetry}
            >
              {strings.retry}
            </button>
          </>
        ) : null}
        {state.kind === 'aborted' ? (
          <span role="status" style={{ color: '#94a3b8', fontSize: 14 }}>
            {strings.aborted}
          </span>
        ) : null}
      </div>
      <p
        style={{
          gridColumn: '1 / -1',
          color: '#94a3b8',
          fontSize: 12,
          margin: 0,
        }}
      >
        {strings.help}
      </p>
    </div>
  );
}
