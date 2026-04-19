/**
 * Trilingual inspection-outcome email copy (EN / PT-BR / ES).
 *
 * Mirrors `reservation-email.templates.ts` — same dark-mode HTML
 * shell, same trilingual structure, same future migration path to
 * `packages/i18n` runtime bundles in 0.4 (not earlier — keeping the
 * bundle change isolated from the inspection feature ship).
 *
 * The template-divergence banner string flagged by persona-fleet-ops
 * (mixed-language crews) lands in the inspection UI bundle — not the
 * email — and ships in step 12 of ADR-0012's execution order.
 */

import type { SupportedLocale, RenderedEmail } from './reservation-email.templates.js';

export type InspectionEmailOutcome = 'FAIL' | 'NEEDS_MAINTENANCE';

export interface InspectionOutcomeEmailContext {
  locale: SupportedLocale;
  outcome: InspectionEmailOutcome;
  recipientEmail: string;
  recipientName: string;
  tenantDisplayName: string;
  starterName: string;
  /** `${assetTag} — ${assetName}`. */
  assetLabel: string;
  /** ISO date or pretty string. */
  completedAt: Date;
  photoCount: number;
  responseCount: number;
  summaryNote: string | null;
  inspectionUrl: string;
  /** Null when not tied to a reservation (ad-hoc inspection). */
  reservationUrl: string | null;
}

export function renderInspectionOutcomeEmail(
  ctx: InspectionOutcomeEmailContext,
): RenderedEmail {
  const locale = normalizeLocale(ctx.locale);
  const t = TRANSLATIONS[locale][ctx.outcome];
  const completed = formatTimestamp(ctx.completedAt, locale);

  const subject = t.subject(ctx.tenantDisplayName, ctx.assetLabel);
  const lines = [
    t.greeting(ctx.recipientName || ctx.recipientEmail),
    '',
    t.body(ctx.starterName, ctx.assetLabel, completed),
    '',
    `${t.metricsLabel}: ${ctx.responseCount} ${t.responsesNoun} · ${ctx.photoCount} ${t.photosNoun}`,
  ];
  if (ctx.summaryNote) {
    lines.push('', `${t.summaryLabel} ${ctx.summaryNote}`);
  }
  lines.push('', t.cta, ctx.inspectionUrl);
  if (ctx.reservationUrl) {
    lines.push('', t.reservationCta, ctx.reservationUrl);
  }
  lines.push('', t.signature);
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
<h1 style="margin:0 0 16px 0;font-size:22px;color:${ctx.outcome === 'FAIL' ? '#fca5a5' : '#fcd34d'};">${escapeHtml(t.headline(ctx.tenantDisplayName, ctx.assetLabel))}</h1>
<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(t.greeting(ctx.recipientName || ctx.recipientEmail))}</p>
<p style="margin:0 0 12px 0;line-height:1.5;">${escapeHtml(
    t.body(ctx.starterName, ctx.assetLabel, completed),
  )}</p>
<p style="margin:0 0 12px 0;color:#94a3b8;font-size:13px;">${escapeHtml(
    `${t.metricsLabel}: ${ctx.responseCount} ${t.responsesNoun} · ${ctx.photoCount} ${t.photosNoun}`,
  )}</p>
${ctx.summaryNote
  ? `<p style="margin:0 0 12px 0;padding:12px;background:#0f172a;border-left:3px solid #64748b;line-height:1.5;"><strong>${escapeHtml(
      t.summaryLabel,
    )}</strong> ${escapeHtml(ctx.summaryNote)}</p>`
  : ''}
<p style="margin:24px 0;">
<a href="${escapeHtml(ctx.inspectionUrl)}"
   style="display:inline-block;background:#38bdf8;color:#0f172a;padding:12px 20px;border-radius:8px;font-weight:600;text-decoration:none;">
${escapeHtml(t.cta)}</a>
</p>
${ctx.reservationUrl
  ? `<p style="margin:0 0 16px 0;font-size:13px;"><a href="${escapeHtml(
      ctx.reservationUrl,
    )}" style="color:#7dd3fc;">${escapeHtml(t.reservationCta)}</a></p>`
  : ''}
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

interface OutcomeStrings {
  subject: (tenant: string, asset: string) => string;
  headline: (tenant: string, asset: string) => string;
  greeting: (name: string) => string;
  body: (starter: string, asset: string, completedAt: string) => string;
  metricsLabel: string;
  responsesNoun: string;
  photosNoun: string;
  summaryLabel: string;
  cta: string;
  reservationCta: string;
  signature: string;
}

const TRANSLATIONS: Record<
  SupportedLocale,
  Record<InspectionEmailOutcome, OutcomeStrings>
> = {
  en: {
    FAIL: {
      subject: (t, a) => `${t}: pre-trip FAIL on ${a}`,
      headline: (_t, a) => `Pre-trip failed — ${a}`,
      greeting: (n) => `Hi ${n},`,
      body: (starter, asset, when) =>
        `${starter} completed an inspection on ${asset} at ${when} and the outcome was FAIL. The vehicle should not go out until reviewed by an admin.`,
      metricsLabel: 'Inspection',
      responsesNoun: 'responses',
      photosNoun: 'photos',
      summaryLabel: 'Driver summary:',
      cta: 'Open inspection',
      reservationCta: 'View related reservation',
      signature: 'Panorama Fleet',
    },
    NEEDS_MAINTENANCE: {
      subject: (t, a) => `${t}: ${a} needs maintenance`,
      headline: (_t, a) => `Needs maintenance — ${a}`,
      greeting: (n) => `Hi ${n},`,
      body: (starter, asset, when) =>
        `${starter} completed an inspection on ${asset} at ${when} and flagged it for maintenance. Schedule service before the next assignment.`,
      metricsLabel: 'Inspection',
      responsesNoun: 'responses',
      photosNoun: 'photos',
      summaryLabel: 'Driver summary:',
      cta: 'Open inspection',
      reservationCta: 'View related reservation',
      signature: 'Panorama Fleet',
    },
  },
  'pt-br': {
    FAIL: {
      subject: (t, a) => `${t}: pré-viagem REPROVADA em ${a}`,
      headline: (_t, a) => `Pré-viagem reprovada — ${a}`,
      greeting: (n) => `Olá ${n},`,
      body: (starter, asset, when) =>
        `${starter} concluiu uma inspeção em ${asset} às ${when} e o resultado foi REPROVADO. O veículo não deve sair até a revisão por um administrador.`,
      metricsLabel: 'Inspeção',
      responsesNoun: 'respostas',
      photosNoun: 'fotos',
      summaryLabel: 'Resumo do motorista:',
      cta: 'Abrir inspeção',
      reservationCta: 'Ver reserva relacionada',
      signature: 'Panorama Fleet',
    },
    NEEDS_MAINTENANCE: {
      subject: (t, a) => `${t}: ${a} precisa de manutenção`,
      headline: (_t, a) => `Precisa de manutenção — ${a}`,
      greeting: (n) => `Olá ${n},`,
      body: (starter, asset, when) =>
        `${starter} concluiu uma inspeção em ${asset} às ${when} e o sinalizou para manutenção. Agende o serviço antes da próxima atribuição.`,
      metricsLabel: 'Inspeção',
      responsesNoun: 'respostas',
      photosNoun: 'fotos',
      summaryLabel: 'Resumo do motorista:',
      cta: 'Abrir inspeção',
      reservationCta: 'Ver reserva relacionada',
      signature: 'Panorama Fleet',
    },
  },
  es: {
    FAIL: {
      subject: (t, a) => `${t}: pre-viaje RECHAZADO en ${a}`,
      headline: (_t, a) => `Pre-viaje rechazado — ${a}`,
      greeting: (n) => `Hola ${n},`,
      body: (starter, asset, when) =>
        `${starter} completó una inspección en ${asset} a las ${when} y el resultado fue RECHAZADO. El vehículo no debe salir hasta ser revisado por un administrador.`,
      metricsLabel: 'Inspección',
      responsesNoun: 'respuestas',
      photosNoun: 'fotos',
      summaryLabel: 'Resumen del conductor:',
      cta: 'Abrir inspección',
      reservationCta: 'Ver reserva relacionada',
      signature: 'Panorama Fleet',
    },
    NEEDS_MAINTENANCE: {
      subject: (t, a) => `${t}: ${a} necesita mantenimiento`,
      headline: (_t, a) => `Necesita mantenimiento — ${a}`,
      greeting: (n) => `Hola ${n},`,
      body: (starter, asset, when) =>
        `${starter} completó una inspección en ${asset} a las ${when} y lo marcó para mantenimiento. Programe el servicio antes de la próxima asignación.`,
      metricsLabel: 'Inspección',
      responsesNoun: 'respuestas',
      photosNoun: 'fotos',
      summaryLabel: 'Resumen del conductor:',
      cta: 'Abrir inspección',
      reservationCta: 'Ver reserva relacionada',
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

function formatTimestamp(dt: Date, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(localeToIntl(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(dt);
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
