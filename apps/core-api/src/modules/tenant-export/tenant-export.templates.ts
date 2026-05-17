/**
 * ADR-0020 §8 — tenant-data export ready email (amended PR 4).
 *
 * Body links to the PANORAMA download endpoint
 * `${manageUrlBase}/tenants/:tenantId/exports/:jobId/download`,
 * NOT directly to a presigned S3 URL. Rationale (security-reviewer
 * PR 4 BLOCKER 3): corporate mail-security gateways (Mimecast,
 * Microsoft ATP Safe Links, Proofpoint), link-preview bots
 * (Slack unfurl, Discord, iMessage), and inline TLS-inspecting
 * middleboxes will GET every URL in an inbound email AS SOON AS
 * IT ARRIVES. If the link is a presigned S3 URL, the scanner
 * downloads the export bytes into its scan log + cache before the
 * user ever clicks. TTL ≤24h does not mitigate this — the
 * download happens at delivery time.
 *
 * Routing through Panorama defangs the prefetch: an unauthenticated
 * GET against the download endpoint returns 401 (no session); the
 * scanner caches the 401, not the file. When the genuine Owner
 * clicks the link in their browser, the existing session cookie
 * lets the endpoint mint a 60-second presigned URL and 302 to S3.
 */

export interface ExportReadyEmailContext {
  recipientEmail: string;
  recipientDisplayName: string;
  tenantDisplayName: string;
  /** Panorama download URL (NOT a presigned S3 URL). 302s on click. */
  downloadUrl: string;
  expiresAt: Date;
  objectSizeBytes: number;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderExportReadyEmail(ctx: ExportReadyEmailContext): RenderedEmail {
  const subject = `Your Panorama data export for "${ctx.tenantDisplayName}" is ready`;
  const expiresIso = ctx.expiresAt.toISOString();
  const sizeKb = Math.max(1, Math.round(ctx.objectSizeBytes / 1024));

  const text = [
    `Hello ${ctx.recipientDisplayName},`,
    '',
    `Your tenant-data export for "${ctx.tenantDisplayName}" is ready.`,
    `Approximate size: ${sizeKb} KB.`,
    '',
    `Download (link expires at ${expiresIso}):`,
    ctx.downloadUrl,
    '',
    `Once the link expires, contact the Panorama maintainer with this email's date to re-mint a fresh URL from the same archive.`,
    '',
    `— Panorama`,
  ].join('\n');

  const html = /* html */ `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px 0;margin:0;">
<table role="presentation" align="center" width="540" cellpadding="0" cellspacing="0"
       style="background:#1e293b;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:22px;color:#f8fafc;">Export ready</h1>
<p style="margin:0 0 16px 0;line-height:1.5;">Your tenant-data export for
<strong>${escapeHtml(ctx.tenantDisplayName)}</strong> is ready (~${sizeKb} KB).</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(ctx.downloadUrl)}"
     style="display:inline-block;background:#34d399;color:#0f172a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
     Download export
  </a>
</p>
<p style="margin:16px 0;color:#94a3b8;font-size:13px;">
  Link expires at <code style="color:#e2e8f0;">${escapeHtml(expiresIso)}</code>.
</p>
<p style="margin:24px 0 0 0;color:#64748b;font-size:12px;">
  Once the link expires, contact the Panorama maintainer with this email's date to re-mint a fresh URL.
</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
