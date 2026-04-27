import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import { startInspectionAction } from '../actions';

interface AssetSlim {
  id: string;
  tag: string;
  name: string;
  bookable: boolean;
  status: string;
}

interface AssetsResponse {
  items: AssetSlim[];
  total: number;
}

interface NewInspectionPageProps {
  searchParams: Promise<{
    asset?: string;
    reservation?: string;
    error?: string;
    errorItems?: string;
  }>;
}

/**
 * Launcher: pick an asset (and optionally a reservation), submit to
 * `startInspectionAction`. The action's POST returns either a NEW
 * IN_PROGRESS inspection OR a RESUME of an existing one within the
 * stale-window — either way it redirects to `/inspections/:id`.
 *
 * Asset + reservation can be pre-filled via query string when the
 * driver came from a reservation page's "Start pre-trip" button
 * (wired in step 11d, the reservation tether button).
 */
export default async function NewInspectionPage({
  searchParams,
}: NewInspectionPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  const assetsRes = await apiGet<AssetsResponse>('/assets?limit=200');
  const assets = (assetsRes.ok ? assetsRes.data.items : []).filter((a) => a.bookable);
  const presetAsset = sp.asset ?? '';

  return (
    <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>{messages.t('inspection.start')}</h1>
          <Link href="/inspections" className="panorama-button secondary">
            ← {messages.t('nav.inspections')}
          </Link>
        </div>

        {sp.error ? (
          <div className="panorama-banner-warning">
            {messages.t(sp.error, sp.errorItems ? { items: sp.errorItems } : undefined)}
          </div>
        ) : null}

        {assets.length === 0 ? (
          <div className="panorama-card">
            {messages.t('inspection.new.no_bookable_assets.prefix')}{' '}
            <Link href="/assets">{messages.t('nav.assets')}</Link>
            {messages.t('inspection.new.no_bookable_assets.suffix')}
          </div>
        ) : (
          <form action={startInspectionAction} className="panorama-card panorama-form-grid">
            <label>
              {messages.t('inspection.new.field.asset_label')}
              <select
                name="assetId"
                required
                defaultValue={presetAsset}
                className="panorama-select"
              >
                <option value="">{messages.t('inspection.new.field.asset_placeholder')}</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.tag} — {a.name}
                    {a.status !== 'READY' ? ` (${a.status})` : ''}
                  </option>
                ))}
              </select>
            </label>

            {sp.reservation ? (
              <input type="hidden" name="reservationId" value={sp.reservation} />
            ) : null}

            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
              <button type="submit" className="panorama-button">
                {messages.t('inspection.start')}
              </button>
              <Link href="/inspections" className="panorama-button secondary">
                {messages.t('actions.cancel')}
              </Link>
            </div>

            <p style={{ gridColumn: '1 / -1', color: '#94a3b8', fontSize: 13, margin: '8px 0 0 0' }}>
              {messages.t('inspection.new.help')}
            </p>
          </form>
        )}
    </>
  );
}
