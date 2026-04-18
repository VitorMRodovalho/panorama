import 'server-only';

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
