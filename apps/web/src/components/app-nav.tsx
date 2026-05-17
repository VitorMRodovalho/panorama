'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AppNavItem {
  href: string;
  label: string;
}

export interface AppNavProps {
  /** Primary nav items, in display order. Round 4 PR2 settled the ops
      verb order: Calendar → Reservations → Inspections → Assets →
      Maintenance. */
  items: AppNavItem[];
  /** Admin items, surfaced under a single "Admin ▾" overflow when
      non-empty. Empty for non-admin roles. */
  adminItems?: AppNavItem[];
  /** Localised label for the admin overflow trigger. */
  adminLabel?: string;
}

/**
 * Path-aware nav strip for the authenticated app shell. Renders each
 * primary item as a `<Link>`; the current page (matched by
 * `pathname.startsWith` with sibling-specificity tie-break) gets
 * `aria-current="page"` which the CSS flips to `font-weight: 600`.
 *
 * Round 4 PR2 changes vs the #78 PILOT-11 original:
 *   - Inline styles removed; styles live in globals.css under
 *     `.panorama-nav*` rules.
 *   - Admin items collapsed under an "Admin ▾" `<details>` overflow.
 *     Native widget — no client-state needed beyond `usePathname`.
 *
 * Client component because `usePathname` requires the browser hook —
 * the surrounding `AppShell` stays a server component so the
 * tenant + session reads happen on the server.
 *
 * TODO(Round 5+): native `<details>` does NOT close on outside-click;
 * ops at 5am can accidentally open the admin menu and lose tap-target
 * coverage on the other nav items underneath the popover. The cheap
 * uplift is an Esc-to-close client handler; the expensive uplift is a
 * `<dialog popover>`-based replacement. Acceptable for design-partner
 * canary; revisit before public preview.
 *
 * Note: `open` is computed from pathname on every render. If a user is
 * on an admin page and manually closes the overflow, the next AppNav
 * render (e.g. on any state-bearing parent re-render) will force it back
 * open. Pathname changes are the only render trigger today, so the edge
 * is latent. If a future change makes AppNav re-render for other reasons,
 * switch to a `useRef`-anchored "initial open" pattern.
 */
export function AppNav({ items, adminItems, adminLabel }: AppNavProps): ReactNode {
  const pathname = usePathname();
  const allItems = [...items, ...(adminItems ?? [])];
  const hasAdmin = (adminItems?.length ?? 0) > 0;
  const adminOpen =
    hasAdmin && (adminItems ?? []).some((item) => isActive(pathname, item.href, allItems));

  return (
    <nav aria-label="Primary" className="panorama-nav">
      {items.map((item, idx) => {
        const active = isActive(pathname, item.href, allItems);
        return (
          <span key={item.href} className="panorama-nav-item">
            <Link
              href={item.href}
              className="panorama-nav-link"
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
            </Link>
            {idx < items.length - 1 || hasAdmin ? (
              <span className="panorama-nav-sep" aria-hidden="true">·</span>
            ) : null}
          </span>
        );
      })}
      {hasAdmin ? (
        <details className="panorama-nav-admin" open={adminOpen}>
          <summary>{adminLabel ?? 'Admin'}</summary>
          <div className="panorama-nav-admin-content">
            {(adminItems ?? []).map((item) => {
              const active = isActive(pathname, item.href, allItems);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </details>
      ) : null}
    </nav>
  );
}

// Exact match for the leaf URL so /assets doesn't also match /assets/123;
// startsWith for parent paths so /reservations/calendar still highlights
// "Reservations" when calendar isn't a separate item. If a more-specific
// sibling (deeper href starting with this one's prefix) is also in the
// list AND the pathname matches it, defer to the sibling.
function isActive(pathname: string, href: string, all: AppNavItem[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + '/')) return false;
  return !all.some(
    (other) =>
      other.href !== href &&
      other.href.startsWith(href + '/') &&
      pathname.startsWith(other.href),
  );
}
