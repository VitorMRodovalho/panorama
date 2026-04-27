import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/session';
import { loadMessages } from '@/lib/i18n';
import { logoutAction, switchTenantAction } from '@/app/login/actions';
import { AppNav, type AppNavItem } from './app-nav';

/**
 * AppShell — single header + nav + content frame for all authenticated
 * routes (#78 PILOT-11). Lives at `apps/web/src/app/(authenticated)/layout.tsx`
 * via Next.js route group; pages don't render their own header anymore.
 *
 * Pre-#78 each authenticated page rolled its own `<header>` + nav strip
 * with subtly different shapes — the assets page had no nav at all,
 * the calendar page had no header at all. This component centralises:
 *
 *   - Panorama branding + current-tenant pill
 *   - Tenant switcher (visible only when the user has >1 membership)
 *   - User name + role + sign-out
 *   - Primary nav row (path-aware highlights via the client `<AppNav>`)
 *
 * Out of pilot-minimal scope per the issue: responsive sidebar collapse,
 * notification bell, keyboard shortcuts, search. Those are queued in
 * Wave 1 #45.
 */

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export async function AppShell({ children }: { children: ReactNode }): Promise<ReactNode> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const featureMaintenance =
    (process.env['FEATURE_MAINTENANCE'] ?? 'false').toLowerCase() === 'true';

  const currentMembership = session.memberships.find(
    (m) => m.tenantId === session.currentTenantId,
  );
  const messages = loadMessages(currentMembership?.tenantLocale);

  // Pilot-minimal nav per issue #78. Maintenance gated on feature flag;
  // admin links visible only to owner/fleet_admin. Calendar is its own
  // entry so coordinators don't have to drill into Reservations to find
  // it (persona-fleet-ops feedback in earlier reviews).
  //
  // Future admin entries (Invitations once #75 lands) get appended here
  // — the comment is the breadcrumb so future contributors don't
  // re-derive the placement. #76 Blackouts admin UI landed.
  const navItems: AppNavItem[] = [
    { href: '/assets', label: messages.t('nav.assets') },
    { href: '/reservations', label: messages.t('nav.reservations') },
    { href: '/reservations/calendar', label: messages.t('nav.calendar') },
    { href: '/inspections', label: messages.t('nav.inspections') },
    ...(featureMaintenance
      ? [{ href: '/maintenance', label: messages.t('nav.maintenance') }]
      : []),
    ...(isAdmin
      ? [
          {
            href: '/admin/inspection-templates',
            label: messages.t('nav.admin_inspection_templates'),
          },
          {
            href: '/admin/blackouts',
            label: messages.t('nav.admin_blackouts'),
          },
        ]
      : []),
  ];

  return (
    <>
      <header className="panorama-header">
        <div>
          <strong>Panorama</strong>
          <span className="panorama-pill">
            {currentMembership?.tenantDisplayName ??
              messages.t('shell.unknown_tenant')}
          </span>
          {session.memberships.length > 1 ? (
            <form
              action={switchTenantAction}
              style={{ display: 'inline-block', marginLeft: 12 }}
            >
              <select
                className="panorama-select"
                name="tenantId"
                defaultValue={session.currentTenantId}
                aria-label={messages.t('shell.switch_tenant_label')}
              >
                {session.memberships.map((m) => (
                  <option key={m.tenantId} value={m.tenantId}>
                    {m.tenantDisplayName} · {m.role}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="panorama-button secondary"
                style={{ marginLeft: 6 }}
              >
                {messages.t('shell.switch_tenant_button')}
              </button>
            </form>
          ) : null}
        </div>
        <div>
          <span style={{ marginRight: 12 }}>
            {session.displayName}{' '}
            <span className="panorama-pill">{session.currentRole}</span>
          </span>
          <form action={logoutAction} style={{ display: 'inline' }}>
            <button type="submit" className="panorama-button secondary">
              {messages.t('shell.sign_out')}
            </button>
          </form>
        </div>
      </header>

      <section className="panorama-content">
        <AppNav items={navItems} />
        {children}
      </section>
    </>
  );
}
