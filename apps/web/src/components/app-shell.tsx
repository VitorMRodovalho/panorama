import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/session';
import { loadMessages } from '@/lib/i18n';
import { logoutAction, switchTenantAction } from '@/app/login/actions';
import { AppNav, type AppNavItem } from './app-nav';

/**
 * AppShell — single header + nav + content frame for all authenticated
 * routes (#78 PILOT-11; Round 4 PR2 refactor for nav-order + overflow
 * menus + inline-style cleanup).
 *
 * Round 4 PR2 changes vs the #78 original:
 *   - Nav order: Calendar → Reservations → Inspections → Assets →
 *     Maintenance (ops-verb order; closes persona C13 + ux-critic C7a).
 *   - Admin items collapsed under "Admin ▾" overflow inside the
 *     primary nav (closes persona C13).
 *   - Tenant switcher + sign-out collapsed into a user overflow menu
 *     in the header (frees ~120px; closes ux-critic C7c+d).
 *   - All inline styles lifted into `globals.css` under `.panorama-*`
 *     rules (closes ux-critic C7b).
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

  // Ops-verb primary nav (Round 4 PR2): Calendar comes first so a
  // coordinator landing on the app can see the schedule before
  // drilling into any specific row. Maintenance is gated on its
  // feature flag.
  const primaryNav: AppNavItem[] = [
    { href: '/reservations/calendar', label: messages.t('nav.calendar') },
    { href: '/reservations', label: messages.t('nav.reservations') },
    { href: '/inspections', label: messages.t('nav.inspections') },
    { href: '/assets', label: messages.t('nav.assets') },
    ...(featureMaintenance
      ? [{ href: '/maintenance', label: messages.t('nav.maintenance') }]
      : []),
  ];

  // Admin overflow — surfaced as an "Admin ▾" menu inside the primary
  // nav for owner/fleet_admin only. Adding a new admin page = append
  // a row here.
  const adminNav: AppNavItem[] = isAdmin
    ? [
        { href: '/admin/invitations', label: messages.t('nav.admin_invitations') },
        {
          href: '/admin/inspection-templates',
          label: messages.t('nav.admin_inspection_templates'),
        },
        { href: '/admin/blackouts', label: messages.t('nav.admin_blackouts') },
        { href: '/admin/settings', label: messages.t('nav.admin_settings') },
      ]
    : [];

  const showSwitcher = session.memberships.length > 1;

  return (
    <>
      <header className="panorama-header">
        <div className="panorama-header-brand">
          <strong>Panorama</strong>
          {/* Tenant pill uses a distinct treatment vs the role pill in
              the user menu — a maintenance manager working two yards
              needs to glance at the header and KNOW which fleet's data
              they're touching (mis-tenant approvals are how 45-minute
              concurrency horrors compound). */}
          <span className="panorama-tenant-pill">
            {currentMembership?.tenantDisplayName ??
              messages.t('shell.unknown_tenant')}
          </span>
        </div>
        <details className="panorama-user-menu">
          {/* No aria-label: the visible displayName + role IS the
              accessible name (ux-critic feedback — generic "User menu"
              hid the user identity from screen readers). The chevron
              affordance is supplied by the CSS ::after rule so a 5am
              dispatch shed still gets the "this opens" cue without sun
              glare hiding an 11px symbol. */}
          <summary>
            <span>{session.displayName}</span>
            <span className="panorama-pill">{session.currentRole}</span>
          </summary>
          <div className="panorama-user-menu-content">
            {showSwitcher ? (
              <div className="panorama-user-menu-section">
                <span className="panorama-user-menu-label">
                  {messages.t('shell.switch_tenant_label')}
                </span>
                <form action={switchTenantAction}>
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
                  <button type="submit" className="panorama-button secondary">
                    {messages.t('shell.switch_tenant_button')}
                  </button>
                </form>
              </div>
            ) : null}
            <div className="panorama-user-menu-section">
              <form action={logoutAction}>
                <button type="submit" className="panorama-button secondary">
                  {messages.t('shell.sign_out')}
                </button>
              </form>
            </div>
          </div>
        </details>
      </header>

      <main className="panorama-content">
        <AppNav
          items={primaryNav}
          adminItems={adminNav}
          adminLabel={messages.t('nav.admin_menu_label')}
        />
        {children}
      </main>
    </>
  );
}
