/**
 * Trilingual invitation email copy (EN / PT-BR / ES).
 *
 * Kept as inline TS strings for 0.2 so the BullMQ worker has zero file
 * IO on the hot path. When `packages/i18n` gets a proper runtime
 * loader, the per-locale object moves out into JSON next to the other
 * trilingual bundles.
 */

export type SupportedLocale = 'en' | 'pt-br' | 'es';

export interface InvitationEmailContext {
  locale: SupportedLocale;
  recipientEmail: string;
  tenantDisplayName: string;
  inviterDisplayName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderInvitationEmail(ctx: InvitationEmailContext): RenderedEmail {
  const locale = normalizeLocale(ctx.locale);
  const t = TRANSLATIONS[locale];
  const expires = formatExpiry(ctx.expiresAt, locale);
  const roleLabel = roleName(ctx.role, locale);

  const subject = t.subject(ctx.tenantDisplayName);
  const text = [
    t.greeting(ctx.recipientEmail),
    '',
    t.body(ctx.inviterDisplayName, ctx.tenantDisplayName, roleLabel),
    '',
    t.cta,
    ctx.acceptUrl,
    '',
    t.expiryNote(expires),
    '',
    t.ignoreNote,
    '',
    t.signature,
  ].join('\n');

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
<p style="margin:0 0 16px 0;line-height:1.55;">
${escapeHtml(t.body(ctx.inviterDisplayName, ctx.tenantDisplayName, roleLabel))}
</p>
<p style="text-align:center;margin:28px 0;">
<a href="${escapeHtml(ctx.acceptUrl)}"
   style="display:inline-block;background:#22d3ee;color:#0f172a;
          padding:12px 24px;border-radius:8px;font-weight:600;
          text-decoration:none;">${escapeHtml(t.cta)}</a>
</p>
<p style="margin:0 0 8px 0;font-size:13px;color:#94a3b8;">
${escapeHtml(t.expiryNote(expires))}
</p>
<p style="margin:0;font-size:13px;color:#94a3b8;">${escapeHtml(t.ignoreNote)}</p>
</td></tr></table>
<p style="text-align:center;margin-top:16px;font-size:12px;color:#64748b;">
${escapeHtml(t.signature)}
</p>
</body>
</html>`;

  return { subject, text, html };
}

function normalizeLocale(locale: string | undefined): SupportedLocale {
  const l = (locale ?? 'en').toLowerCase();
  if (l.startsWith('pt')) return 'pt-br';
  if (l.startsWith('es')) return 'es';
  return 'en';
}

function formatExpiry(date: Date, locale: SupportedLocale): string {
  const bcp47 = locale === 'pt-br' ? 'pt-BR' : locale;
  try {
    return new Intl.DateTimeFormat(bcp47, {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function roleName(role: string, locale: SupportedLocale): string {
  const table: Record<string, Record<SupportedLocale, string>> = {
    owner: { en: 'Owner', 'pt-br': 'Proprietário', es: 'Propietario' },
    fleet_admin: { en: 'Fleet administrator', 'pt-br': 'Administrador da frota', es: 'Administrador de flota' },
    fleet_staff: { en: 'Fleet staff', 'pt-br': 'Operador da frota', es: 'Operador de flota' },
    driver: { en: 'Driver', 'pt-br': 'Motorista', es: 'Conductor' },
  };
  return table[role]?.[locale] ?? role;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TRANSLATIONS: Record<
  SupportedLocale,
  {
    subject: (tenant: string) => string;
    headline: (tenant: string) => string;
    greeting: (email: string) => string;
    body: (inviter: string, tenant: string, role: string) => string;
    cta: string;
    expiryNote: (expires: string) => string;
    ignoreNote: string;
    signature: string;
  }
> = {
  en: {
    subject: (tenant) => `You're invited to join ${tenant} on Panorama`,
    headline: (tenant) => `Join ${tenant} on Panorama`,
    greeting: (email) => `Hi ${email},`,
    body: (inviter, tenant, role) =>
      `${inviter} invited you to ${tenant} on Panorama as ${role}. Accept the invitation to get access.`,
    cta: 'Accept invitation',
    expiryNote: (expires) => `This invitation expires on ${expires}.`,
    ignoreNote: "If you weren't expecting this, you can safely ignore the email.",
    signature: 'Panorama · One pane of glass for IT assets and fleet.',
  },
  'pt-br': {
    subject: (tenant) => `Você foi convidado para entrar em ${tenant} no Panorama`,
    headline: (tenant) => `Entre em ${tenant} no Panorama`,
    greeting: (email) => `Olá ${email},`,
    body: (inviter, tenant, role) =>
      `${inviter} convidou você para ${tenant} no Panorama como ${role}. Aceite o convite para liberar o acesso.`,
    cta: 'Aceitar convite',
    expiryNote: (expires) => `Este convite expira em ${expires}.`,
    ignoreNote: 'Se você não estava esperando isso, pode ignorar este e-mail com segurança.',
    signature: 'Panorama · Uma visão única para ativos de TI e frota.',
  },
  es: {
    subject: (tenant) => `Te invitaron a unirte a ${tenant} en Panorama`,
    headline: (tenant) => `Únete a ${tenant} en Panorama`,
    greeting: (email) => `Hola ${email},`,
    body: (inviter, tenant, role) =>
      `${inviter} te invitó a ${tenant} en Panorama como ${role}. Acepta la invitación para obtener acceso.`,
    cta: 'Aceptar invitación',
    expiryNote: (expires) => `Esta invitación expira el ${expires}.`,
    ignoreNote: 'Si no esperabas este correo, puedes ignorarlo con seguridad.',
    signature: 'Panorama · Un solo panel para activos de TI y flota.',
  },
};
