'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AppNavItem {
  href: string;
  label: string;
}

/**
 * Path-aware nav strip for the authenticated app shell. Renders each
 * item as a `<Link>`; the current page (matched by `pathname.startsWith`)
 * gets `font-weight: 600` so a coordinator scanning the bar can spot
 * where they are at a glance.
 *
 * Client component because `usePathname` requires the browser hook —
 * the surrounding `AppShell` stays a server component so the
 * tenant + session reads happen on the server.
 */
export function AppNav({ items }: { items: AppNavItem[] }): React.ReactNode {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      style={{
        marginBottom: 16,
        display: 'flex',
        gap: 12,
        fontSize: 14,
        flexWrap: 'wrap',
      }}
    >
      {items.map((item, idx) => {
        // Exact match for /assets so it doesn't also match /assets/123;
        // startsWith for parent paths so /reservations/calendar still
        // highlights "Reservations" when calendar isn't a separate item.
        // Then we explicitly include /reservations/calendar as its own
        // item — startsWith would highlight both, so we narrow to exact
        // match for the parent-suffix case.
        const isExact = pathname === item.href;
        const isAncestor =
          !isExact &&
          pathname.startsWith(item.href + '/') &&
          // If a more-specific sibling (deeper href starting with this
          // one's prefix) is also in the list AND matches, defer to it.
          !items.some(
            (other) =>
              other.href !== item.href &&
              other.href.startsWith(item.href + '/') &&
              pathname.startsWith(other.href),
          );
        const active = isExact || isAncestor;
        return (
          <span key={item.href} style={{ display: 'inline-flex', gap: 12 }}>
            <Link
              href={item.href}
              style={{ fontWeight: active ? 600 : 400 }}
              aria-current={active ? 'page' : undefined}
            >
              {item.label}
            </Link>
            {idx < items.length - 1 ? (
              <span aria-hidden="true">·</span>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
