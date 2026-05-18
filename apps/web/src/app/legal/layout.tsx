import type { ReactNode } from 'react';

/**
 * Public legal-page layout — used for /legal/privacy + /legal/terms.
 *
 * Unauthenticated by design. Visitors landing here from a homepage CTA
 * or a footer link should NOT be redirected to /login. The pages render
 * server-side with no client JS; navigation back to the marketing site
 * is via the in-page anchor + the docs link.
 *
 * Wave 0 §9 plain-language v1 draft — final language pending counsel
 * review per ADR-0014 §C6 trigger.
 */
export default function LegalLayout({ children }: { children: ReactNode }): ReactNode {
  return <div className="panorama-legal">{children}</div>;
}
