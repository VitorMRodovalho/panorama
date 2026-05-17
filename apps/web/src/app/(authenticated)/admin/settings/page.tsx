import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import { PageHeader } from '@/components/page-header';
import { updateTenantSettingsAction } from './actions';

interface TenantSettings {
  tenantId: string;
  autoOpenMaintenanceFromInspection: boolean;
}

interface SettingsPageProps {
  searchParams: Promise<{ saved?: string; error?: string }>;
}

const ADMIN_READ_ROLES = new Set(['owner', 'fleet_admin']);

/**
 * Tenant settings admin page (Round 4 PR5 / #48 fold-in).
 *
 * Owner-only writes, fleet_admin read-only access. Single toggle today:
 * `autoOpenMaintenanceFromInspection` — when ON, a NEEDS_MAINTENANCE
 * inspection auto-opens a maintenance ticket via the
 * MaintenanceTicketSubscriber. Default off because not every fleet
 * wants automated ticket creation (some manage maintenance in an
 * external CMMS and just want the inspection as evidence).
 */
export default async function TenantSettingsPage({
  searchParams,
}: SettingsPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!ADMIN_READ_ROLES.has(session.currentRole)) redirect('/reservations');

  const isOwner = session.currentRole === 'owner';
  const tenantId = session.currentTenantId;
  const currentMembership = session.memberships.find(
    (m) => m.tenantId === tenantId,
  );
  const messages = loadMessages(currentMembership?.tenantLocale);

  const settingsRes = await apiGet<TenantSettings>(`/tenants/${tenantId}/settings`);
  const settings: TenantSettings = settingsRes.ok
    ? settingsRes.data
    : { tenantId, autoOpenMaintenanceFromInspection: false };

  return (
    <>
      <PageHeader
        title={messages.t('settings.title')}
        description={messages.t('settings.description')}
      />

      {sp.saved ? (
        <div className="panorama-banner-success">{messages.t('settings.banner.saved')}</div>
      ) : null}
      {sp.error ? (
        <div className="panorama-banner-warning">{messages.t(sp.error)}</div>
      ) : null}
      {!settingsRes.ok ? (
        <div className="panorama-banner-warning">
          {messages.t('settings.error.load_failed', { status: settingsRes.status })}
        </div>
      ) : null}

      <div className="panorama-card">
        {/* ux-critic a11y note — the "you cannot change this" cue must
            precede the disabled control so a screen-reader user hears
            the context before tabbing into the checkbox. */}
        {!isOwner ? (
          <p className="panorama-settings-readonly-notice">
            {messages.t('settings.read_only_notice')}
          </p>
        ) : null}
        <form action={updateTenantSettingsAction}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <fieldset className="panorama-settings-fieldset" disabled={!isOwner}>
            <legend className="panorama-sr-only">
              {messages.t('settings.title')}
            </legend>

            <label className="panorama-settings-toggle">
              <input
                type="checkbox"
                name="autoOpenMaintenanceFromInspection"
                defaultChecked={settings.autoOpenMaintenanceFromInspection}
              />
              <span>
                <strong>{messages.t('settings.auto_open_maintenance.label')}</strong>
                <p className="panorama-settings-toggle-description">
                  {messages.t('settings.auto_open_maintenance.description')}
                </p>
              </span>
            </label>

            {isOwner ? (
              <button type="submit" className="panorama-button">
                {messages.t('settings.action.save')}
              </button>
            ) : null}
          </fieldset>
        </form>
      </div>
    </>
  );
}
