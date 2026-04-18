/**
 * Trilingual reservation-decision email copy (EN / PT-BR / ES).
 *
 * Follows the invitation-email.templates pattern — inline TS strings
 * now, migrate to packages/i18n bundles when the runtime loader is
 * wired. Kept minimal for 0.3; a richer HTML layout + rich-text
 * localisation can land with persona-fleet-ops feedback.
 */

export type SupportedLocale = 'en' | 'pt-br' | 'es';

export interface ReservationDecisionEmailContext {
  locale: SupportedLocale;
  decision: 'approved' | 'rejected';
  recipientEmail: string;
  recipientName: string;
  tenantDisplayName: string;
  approverName: string;
  assetLabel: string | null; // `${tag} — ${name}` or null when no asset
  startAt: Date;
  endAt: Date;
  note: string | null;
  reservationUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderReservationDecisionEmail(
  ctx: ReservationDecisionEmailContext,
): RenderedEmail {
  const locale = normalizeLocale(ctx.locale);
  const t = TRANSLATIONS[locale][ctx.decision];
  const window = formatWindow(ctx.startAt, ctx.endAt, locale);

  const subject = t.subject(ctx.tenantDisplayName);
  const lines = [
    t.greeting(ctx.recipientName || ctx.recipientEmail),
    '',
    t.body(ctx.approverName, ctx.tenantDisplayName, ctx.assetLabel, window),
  ];
  if (ctx.note) {
    lines.push('', t.noteLabel + ' ' + ctx.note);
  }
  lines.push('', t.cta, ctx.reservationUrl, '', t.signature);
  const text = lines.join('\n');

  const html = /* html */ `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px 0;margin:0;">
<table role="presentation" align="center" width="540" cellpadding="0" cellspacing="0"
       style="background:#1e293b;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:22px;color:#f8fafc;">${escapeHtml(t.headline(ctx.tenantDisplayName))}</h1>
<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(t.greeting(ctx.recipientName || ctx.recipientEmail))}</p>
<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(
    t.body(ctx.approverName, ctx.tenantDisplayName, ctx.assetLabel, window),
  )}</p>
${ctx.note
  ? `<p style="margin:0 0 12px 0;padding:12px;background:#0f172a;border-left:3px solid #64748b;line-height:1.5;"><strong>${escapeHtml(
      t.noteLabel,
    )}</strong> ${escapeHtml(ctx.note)}</p>`
  : ''}
<p style="margin:24px 0;">
<a href="${escapeHtml(ctx.reservationUrl)}"
   style="display:inline-block;background:#38bdf8;color:#0f172a;padding:12px 20px;border-radius:8px;font-weight:600;text-decoration:none;">
${escapeHtml(t.cta)}</a>
</p>
<p style="margin:16px 0 0 0;color:#94a3b8;font-size:13px;">${escapeHtml(t.signature)}</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------

const TRANSLATIONS: Record<
  SupportedLocale,
  Record<
    'approved' | 'rejected',
    {
      subject: (tenant: string) => string;
      headline: (tenant: string) => string;
      greeting: (name: string) => string;
      body: (
        approver: string,
        tenant: string,
        asset: string | null,
        window: string,
      ) => string;
      noteLabel: string;
      cta: string;
      signature: string;
    }
  >
> = {
  en: {
    approved: {
      subject: (t) => `${t}: your reservation is approved`,
      headline: (t) => `${t} — reservation approved`,
      greeting: (n) => `Hi ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} approved your reservation at ${tenant}${asset ? ` for ${asset}` : ''} (${window}). You're cleared to proceed.`,
      noteLabel: 'Note from approver:',
      cta: 'Open reservation',
      signature: 'Panorama Fleet',
    },
    rejected: {
      subject: (t) => `${t}: your reservation was not approved`,
      headline: (t) => `${t} — reservation rejected`,
      greeting: (n) => `Hi ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} was unable to approve your reservation at ${tenant}${asset ? ` for ${asset}` : ''} (${window}).`,
      noteLabel: 'Reason:',
      cta: 'Open reservation',
      signature: 'Panorama Fleet',
    },
  },
  'pt-br': {
    approved: {
      subject: (t) => `${t}: sua reserva foi aprovada`,
      headline: (t) => `${t} — reserva aprovada`,
      greeting: (n) => `Olá ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} aprovou sua reserva em ${tenant}${asset ? ` para ${asset}` : ''} (${window}). Você está liberado(a) para seguir.`,
      noteLabel: 'Observação do aprovador:',
      cta: 'Abrir reserva',
      signature: 'Panorama Fleet',
    },
    rejected: {
      subject: (t) => `${t}: sua reserva não foi aprovada`,
      headline: (t) => `${t} — reserva recusada`,
      greeting: (n) => `Olá ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} não pôde aprovar sua reserva em ${tenant}${asset ? ` para ${asset}` : ''} (${window}).`,
      noteLabel: 'Motivo:',
      cta: 'Abrir reserva',
      signature: 'Panorama Fleet',
    },
  },
  es: {
    approved: {
      subject: (t) => `${t}: tu reserva fue aprobada`,
      headline: (t) => `${t} — reserva aprobada`,
      greeting: (n) => `Hola ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} aprobó tu reserva en ${tenant}${asset ? ` para ${asset}` : ''} (${window}). Puedes proceder.`,
      noteLabel: 'Nota del aprobador:',
      cta: 'Abrir reserva',
      signature: 'Panorama Fleet',
    },
    rejected: {
      subject: (t) => `${t}: tu reserva no fue aprobada`,
      headline: (t) => `${t} — reserva rechazada`,
      greeting: (n) => `Hola ${n},`,
      body: (approver, tenant, asset, window) =>
        `${approver} no pudo aprobar tu reserva en ${tenant}${asset ? ` para ${asset}` : ''} (${window}).`,
      noteLabel: 'Motivo:',
      cta: 'Abrir reserva',
      signature: 'Panorama Fleet',
    },
  },
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function normalizeLocale(raw: string | undefined): SupportedLocale {
  const l = (raw ?? 'en').toLowerCase();
  if (l.startsWith('pt')) return 'pt-br';
  if (l.startsWith('es')) return 'es';
  return 'en';
}

function formatWindow(start: Date, end: Date, locale: SupportedLocale): string {
  const fmt = new Intl.DateTimeFormat(localeToIntl(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${fmt.format(start)} → ${fmt.format(end)}`;
}

function localeToIntl(locale: SupportedLocale): string {
  switch (locale) {
    case 'pt-br':
      return 'pt-BR';
    case 'es':
      return 'es-ES';
    default:
      return 'en-US';
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
