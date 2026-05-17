/**
 * ADR-0020 §7 — tenant deletion request email body.
 *
 * Sent to ALL active Owners of the tenant when any Owner posts
 * `/tenants/:id/delete-request`. The email is the multi-Owner peer-
 * recovery channel from §7 race B: if the requesting Owner's
 * credentials are compromised, peer Owners receive the email and
 * can cancel or veto.
 *
 * The confirm-link uses a URL FRAGMENT (`#token=...`) so link-
 * preview bots can't pre-consume the token via GET fetch. The
 * frontend at `${manageUrlBase}/tenants/:tenantId/deletion` reads
 * `location.hash`, strips it, and forwards via POST to the actual
 * consume endpoint.
 */

export interface DeletionRequestEmailContext {
  recipientEmail: string;
  recipientDisplayName: string;
  tenantDisplayName: string;
  requesterDisplayName: string;
  requesterEmail: string;
  /** Plaintext token surfaced once; never persisted. */
  token: string;
  /** Absolute URL the email links to (token rides in fragment). */
  manageUrlBase: string;
  tenantId: string;
  expiresAt: Date;
  coolOffDays: number;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderDeletionRequestEmail(
  ctx: DeletionRequestEmailContext,
): RenderedEmail {
  const subject = `Confirm deletion of Panorama tenant "${ctx.tenantDisplayName}"`;
  const expiresIso = ctx.expiresAt.toISOString();
  const manageUrl = `${ctx.manageUrlBase}/tenants/${ctx.tenantId}/deletion#token=${encodeURIComponent(ctx.token)}`;

  const text = [
    `Hello ${ctx.recipientDisplayName},`,
    '',
    `${ctx.requesterDisplayName} (${ctx.requesterEmail}) requested the deletion of the Panorama tenant "${ctx.tenantDisplayName}".`,
    '',
    `If this was you (or another Owner you trust), confirm the request at:`,
    manageUrl,
    '',
    `Once confirmed, the tenant enters a ${ctx.coolOffDays}-day cool-off window. Any Owner can cancel during that window.`,
    '',
    `If this was NOT you, do nothing — the request expires at ${expiresIso} without action. You may also visit the link above to VETO the request (peer-Owner safety net per ADR-0020 §7).`,
    '',
    `If the link doesn't work, paste this token into the deletion-confirm page:`,
    `  ${ctx.token}`,
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
<h1 style="margin:0 0 16px 0;font-size:22px;color:#f8fafc;">Confirm tenant deletion</h1>
<p style="margin:0 0 16px 0;line-height:1.5;">
<strong>${escapeHtml(ctx.requesterDisplayName)}</strong>
<span style="color:#94a3b8;">(${escapeHtml(ctx.requesterEmail)})</span>
requested the deletion of <strong>${escapeHtml(ctx.tenantDisplayName)}</strong>.
</p>
<p style="margin:24px 0;">
  <a href="${escapeHtml(manageUrl)}"
     style="display:inline-block;background:#f87171;color:#0f172a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
     Review request
  </a>
</p>
<p style="margin:16px 0;line-height:1.5;color:#94a3b8;font-size:13px;">
  Once confirmed, the tenant enters a ${ctx.coolOffDays}-day cool-off window. Any Owner can cancel during that window.
</p>
<p style="margin:16px 0;line-height:1.5;color:#94a3b8;font-size:13px;">
  If this was NOT you, do nothing — the request expires at <code style="color:#e2e8f0;">${escapeHtml(expiresIso)}</code>. You may also visit the link above to VETO the request (peer-Owner safety net).
</p>
<p style="margin:24px 0 0 0;color:#94a3b8;font-size:13px;">
  If the button does not work, paste this token into the deletion page:
  <br/><code style="display:inline-block;background:#0f172a;padding:6px 12px;border-radius:4px;margin-top:8px;color:#e2e8f0;">${escapeHtml(ctx.token)}</code>
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
