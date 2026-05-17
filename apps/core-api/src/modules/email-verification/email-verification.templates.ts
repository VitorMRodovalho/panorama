/**
 * ADR-0020 §3 — verification email body.
 *
 * Kept English-only for PR 2; the trilingual sibling lives at
 * `invitation-email.templates.ts` and the same pattern can be
 * lifted here when the public-preview launch needs PT-BR + ES.
 *
 * Link shape — token rides in the URL FRAGMENT (`#token=...`) NOT
 * the query string. URL fragments never reach the server, so
 * link-preview bots (Outlook Safe-Links, Slack unfurl, Mimecast URL
 * Defense, Gmail content-inspection) that GET the URL cannot
 * exfiltrate or pre-consume the token. The frontend at
 * `${verifyUrlBase}` reads `location.hash`, strips it, and forwards
 * the value via POST to the same endpoint — matching the §3
 * "POST not GET" contract for the actual consume call.
 *
 * The paste-fallback (raw token below the button) is text-only, so
 * no inline scanner fetches it; the token is exposed inside the
 * email body itself, which the recipient's inbox already trusts.
 */

export interface VerificationEmailContext {
  recipientEmail: string;
  tenantDisplayName: string;
  /** Plaintext token surfaced once; never persisted. */
  token: string;
  /** Absolute URL the email body links to, e.g. `${baseUrl}/auth/verify`. */
  verifyUrlBase: string;
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderVerificationEmail(ctx: VerificationEmailContext): RenderedEmail {
  const subject = `Verify your Panorama tenant "${ctx.tenantDisplayName}"`;
  const expiresIso = ctx.expiresAt.toISOString();
  // §3 — fragment, NOT query. The frontend at verifyUrlBase reads
  // `location.hash`, strips it, and POSTs the token to /auth/verify.
  // Link-preview bots that fetch the URL never see the token.
  const verifyUrl = `${ctx.verifyUrlBase}#token=${encodeURIComponent(ctx.token)}`;

  const text = [
    `Hello ${ctx.recipientEmail},`,
    '',
    `You just signed up for a Panorama tenant: ${ctx.tenantDisplayName}.`,
    `To finish setup, confirm your email by clicking the link below:`,
    '',
    verifyUrl,
    '',
    `This link expires at ${expiresIso}.`,
    '',
    `If the link does not work, paste this token into the verification page:`,
    `  ${ctx.token}`,
    '',
    `If you did not sign up for Panorama, ignore this email — your tenant will be cleaned up automatically.`,
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
<h1 style="margin:0 0 16px 0;font-size:22px;color:#f8fafc;">Verify your tenant</h1>
<p style="margin:0 0 16px 0;line-height:1.5;">You just signed up for the Panorama tenant
<strong>${escapeHtml(ctx.tenantDisplayName)}</strong>. Confirm your email to finish setup.</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(verifyUrl)}"
     style="display:inline-block;background:#38bdf8;color:#0f172a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
     Verify email
  </a>
</p>
<p style="margin:16px 0;color:#94a3b8;font-size:13px;">
  This link expires at <code style="color:#e2e8f0;">${escapeHtml(expiresIso)}</code>.
</p>
<p style="margin:24px 0 0 0;color:#94a3b8;font-size:13px;">
  If the button does not work, paste this token into the verification page:
  <br/><code style="display:inline-block;background:#0f172a;padding:6px 12px;border-radius:4px;margin-top:8px;color:#e2e8f0;">${escapeHtml(ctx.token)}</code>
</p>
<p style="margin:24px 0 0 0;color:#64748b;font-size:12px;">
  If you did not sign up for Panorama, ignore this email — your tenant will be cleaned up automatically.
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
