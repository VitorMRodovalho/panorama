import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { resolveRequestLocale } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'Panorama',
  description: 'Unified open-source platform for IT asset + operational fleet management.',
};

/**
 * Root layout — locale-aware shell (#44 UX-01 / UX-37).
 *
 * `<html lang>` is resolved at request time via the same precedence the
 * pre-session pages use: `panorama_locale` cookie → `Accept-Language`
 * header → 'en'. Authenticated pages still loadMessages(tenantLocale)
 * because the tenant's preference is more authoritative once the user
 * is signed in — but the lang attribute on the html element comes from
 * here, so screen readers and search engines see the right language
 * tag for the rendered text.
 *
 * `<meta viewport>` is ensured here so mobile renders default to the
 * device width (UX-37 audit finding) rather than a 980px desktop
 * scale-down. RTL planning is deferred — the `dir` attribute stays
 * `ltr` until we add an RTL locale.
 */
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const locale = await resolveRequestLocale();
  return (
    <html lang={locale} dir="ltr">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <main className="panorama-main">{children}</main>
      </body>
    </html>
  );
}
