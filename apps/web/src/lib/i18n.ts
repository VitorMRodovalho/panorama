import 'server-only';

import { cookies, headers } from 'next/headers';
import enCommon from '@panorama/i18n/en/common.json';
import ptBrCommon from '@panorama/i18n/pt-br/common.json';
import esCommon from '@panorama/i18n/es/common.json';

/**
 * Web i18n loader — server-side only, zero client JS.
 *
 * Locale selection: caller passes the tenant's preferred locale
 * (from `session.memberships[current].tenantLocale`). Unknown /
 * malformed values fall back to 'en'. No build-time code-splitting
 * — three bundles, ~2 kB each, always loaded together so locale
 * switching is a noop per render.
 *
 * Interpolation: `t('key', { name: 'X' })` replaces `{{name}}`
 * placeholders. No plural rules yet (ICU comes with `packages/i18n`
 * maturing in 0.4); for 0.3 the keys we ship don't need plurals.
 *
 * Fallback: missing keys return the raw key string so a render
 * doesn't silently empty — the missing translation is visible on
 * the page and in the logs.
 */

export type SupportedLocale = 'en' | 'pt-br' | 'es';

const BUNDLES: Record<SupportedLocale, Record<string, string>> = {
  en: enCommon as Record<string, string>,
  'pt-br': ptBrCommon as Record<string, string>,
  es: esCommon as Record<string, string>,
};

const DEFAULT_LOCALE: SupportedLocale = 'en';

export function normalizeLocale(raw: string | undefined | null): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  const l = raw.toLowerCase();
  if (l === 'en' || l.startsWith('en-')) return 'en';
  if (l === 'pt-br' || l.startsWith('pt-br') || l.startsWith('pt')) return 'pt-br';
  if (l === 'es' || l.startsWith('es-') || l.startsWith('es_')) return 'es';
  return DEFAULT_LOCALE;
}

export interface Messages {
  readonly locale: SupportedLocale;
  readonly t: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * Resolve the locale for a pre-session page render — login, invitation
 * acceptance, the bare root layout. Order of precedence:
 *
 *   1. `panorama_locale` cookie — set by the user explicitly via a
 *      future locale switcher OR carried over from a previous
 *      authenticated session (the AppShell can refresh it on render
 *      so a logged-out timeout keeps the user's last-chosen locale).
 *   2. `Accept-Language` header — Negotiate the first segment that
 *      matches a supported locale. Browser default if the user hasn't
 *      changed anything.
 *   3. `'en'` — final fallback.
 *
 * Authenticated pages prefer `loadMessages(membership.tenantLocale)`
 * because the tenant's chosen locale is more authoritative than the
 * user's browser. This helper covers the gap before a session exists.
 */
export async function resolveRequestLocale(): Promise<SupportedLocale> {
  const jar = await cookies();
  const cookieLocale = jar.get('panorama_locale')?.value;
  if (cookieLocale) {
    return normalizeLocale(cookieLocale);
  }
  const hdrs = await headers();
  const accept = hdrs.get('accept-language');
  if (accept) {
    // Take the first weighted segment whose tag normalises to a
    // supported locale. Accept-Language is "en-US,en;q=0.9,pt-BR;q=0.8"
    // — split on `,` and `;`, normalise each tag, return on first
    // hit. No q-weight sort: callers should set their preferred
    // language first in their browser, and falling back to header
    // order is a reasonable approximation for the pre-login surface.
    for (const part of accept.split(',')) {
      const tag = part.split(';')[0]?.trim();
      if (!tag) continue;
      const normalized = normalizeLocale(tag);
      // Only return if it's a real match (not the silent fallback).
      if (
        normalized === 'pt-br' ||
        normalized === 'es' ||
        tag.toLowerCase().startsWith('en')
      ) {
        return normalized;
      }
    }
  }
  return DEFAULT_LOCALE;
}

export function loadMessages(rawLocale: string | undefined | null): Messages {
  const locale = normalizeLocale(rawLocale);
  const primary = BUNDLES[locale];
  const fallback = BUNDLES[DEFAULT_LOCALE];
  return {
    locale,
    t(key: string, vars?: Record<string, string | number>): string {
      const template = primary[key] ?? fallback[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
        const v = vars[name];
        return v === undefined ? `{{${name}}}` : String(v);
      });
    },
  };
}
