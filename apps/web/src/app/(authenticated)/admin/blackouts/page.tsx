import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import { createBlackoutAction, deleteBlackoutAction } from './actions';

interface BlackoutView {
  id: string;
  assetId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  createdByUserId: string;
  createdAt: string;
}

interface BlackoutListResponse {
  items: BlackoutView[];
}

interface AssetListItem {
  id: string;
  tag: string;
  name: string;
  bookable: boolean;
  status: string;
}

interface AssetsResponse {
  items: AssetListItem[];
  total: number;
}

interface BlackoutsPageProps {
  searchParams: Promise<{
    filter?: string;
    error?: string;
    created?: string;
    deleted?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

const FILTER_VALUES = ['active', 'upcoming', 'past', 'all'] as const;
type FilterValue = (typeof FILTER_VALUES)[number];

function isFilterValue(s: string): s is FilterValue {
  return (FILTER_VALUES as readonly string[]).includes(s);
}

export default async function BlackoutsAdminPage({
  searchParams,
}: BlackoutsPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!ADMIN_ROLES.has(session.currentRole)) {
    redirect(
      '/reservations?error=' + encodeURIComponent('blackout.error.admin_required'),
    );
  }

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);

  const filter: FilterValue = isFilterValue(sp.filter ?? '') ? (sp.filter as FilterValue) : 'active';

  // Server-side filter via the existing list endpoint's from/to
  // params. `active` = currently in window (endAt >= now AND
  // startAt <= now). `upcoming` = starts in the future. `past` =
  // ended. `all` = no filter.
  //
  // The list endpoint's `from`/`to` filter on overlap (`endAt >= from
  // AND startAt <= to`), so we map the dashboard filter onto that
  // shape:
  //   active: from = now, to = now (overlap with the instant)
  //   upcoming: from = now+1ms (everything starting after now)
  //   past: to = now-1ms (everything ending before now)
  const now = new Date();
  const oneMs = 1;
  const listQuery = new URLSearchParams();
  if (filter === 'active') {
    listQuery.set('from', now.toISOString());
    listQuery.set('to', now.toISOString());
  } else if (filter === 'upcoming') {
    listQuery.set('from', new Date(now.getTime() + oneMs).toISOString());
  } else if (filter === 'past') {
    listQuery.set('to', new Date(now.getTime() - oneMs).toISOString());
  }
  listQuery.set('limit', '200');

  const [listRes, assetsRes] = await Promise.all([
    apiGet<BlackoutListResponse>(`/blackouts?${listQuery.toString()}`),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);
  const items: BlackoutView[] = listRes.ok ? listRes.data.items : [];
  const assets: AssetListItem[] = (assetsRes.ok ? assetsRes.data.items : []).filter(
    (a) => a.bookable,
  );
  const assetsById = new Map(assets.map((a) => [a.id, a]));

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h1 style={{ margin: 0 }}>{messages.t('blackout.list.title')}</h1>
        <Link
          href="/reservations/calendar"
          className="panorama-button secondary"
        >
          ← {messages.t('nav.calendar')}
        </Link>
      </div>

      {sp.error ? (
        <div className="panorama-banner-warning">{messages.t(sp.error)}</div>
      ) : null}
      {sp.created ? (
        <div className="panorama-banner-success">
          {messages.t('blackout.banner.created')}
        </div>
      ) : null}
      {sp.deleted ? (
        <div className="panorama-banner-success">
          {messages.t('blackout.banner.deleted')}
        </div>
      ) : null}

      <div className="panorama-card">
        <h2 style={{ margin: '0 0 12px' }}>
          {messages.t('blackout.create.title')}
        </h2>
        <form action={createBlackoutAction} className="panorama-form-grid">
          <div className="panorama-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="bo-title">{messages.t('blackout.field.title')}</label>
            <input id="bo-title" name="title" type="text" maxLength={200} required />
          </div>
          <div className="panorama-field">
            <label htmlFor="bo-asset">{messages.t('blackout.field.asset')}</label>
            <select id="bo-asset" name="assetId">
              <option value="">
                {messages.t('blackout.field.asset.global_option')}
              </option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tag} — {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="panorama-field">
            <label htmlFor="bo-start">{messages.t('blackout.field.start')}</label>
            <input id="bo-start" name="startAt" type="datetime-local" required />
          </div>
          <div className="panorama-field">
            <label htmlFor="bo-end">{messages.t('blackout.field.end')}</label>
            <input id="bo-end" name="endAt" type="datetime-local" required />
          </div>
          <div className="panorama-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="bo-reason">{messages.t('blackout.field.reason')}</label>
            <input id="bo-reason" name="reason" type="text" maxLength={2000} />
          </div>
          <button
            type="submit"
            className="panorama-button"
            style={{ gridColumn: '1 / -1' }}
          >
            {messages.t('blackout.action.create')}
          </button>
        </form>
        <p
          style={{
            color: 'var(--pan-muted, #94a3b8)',
            fontSize: 13,
            marginTop: 8,
          }}
        >
          {messages.t('blackout.create.help')}
        </p>
      </div>

      <div className="panorama-card" style={{ marginTop: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>
            {messages.t('blackout.list.title')}{' '}
            <span className="panorama-pill">{items.length}</span>
          </h2>
          <nav style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            {FILTER_VALUES.map((f) => (
              <a
                key={f}
                href={`/admin/blackouts?filter=${f}`}
                style={{ fontWeight: filter === f ? 600 : 400 }}
              >
                {messages.t(`blackout.filter.${f}`)}
              </a>
            ))}
          </nav>
        </div>

        {!listRes.ok ? (
          <p className="panorama-error">
            {messages.t('blackout.list.failed')} (HTTP {listRes.status})
          </p>
        ) : items.length === 0 ? (
          <p className="panorama-empty">{messages.t('blackout.list.empty')}</p>
        ) : (
          <table className="panorama-table">
            <thead>
              <tr>
                <th>{messages.t('blackout.column.title')}</th>
                <th>{messages.t('blackout.column.asset')}</th>
                <th>{messages.t('blackout.column.start')}</th>
                <th>{messages.t('blackout.column.end')}</th>
                <th>{messages.t('blackout.column.reason')}</th>
                <th>{messages.t('blackout.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const asset = b.assetId ? assetsById.get(b.assetId) : null;
                const assetCell = b.assetId
                  ? asset
                    ? `${asset.tag} — ${asset.name}`
                    : b.assetId.slice(0, 8)
                  : messages.t('blackout.field.asset.global_option');
                return (
                  <tr key={b.id}>
                    <td>{b.title}</td>
                    <td>{assetCell}</td>
                    <td>{new Date(b.startAt).toLocaleString()}</td>
                    <td>{new Date(b.endAt).toLocaleString()}</td>
                    <td>{b.reason ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* Forcing function: required-checkbox confirm panel
                          mirrors the OPS-01 (#33) pattern + the maintenance
                          status transitions. Delete is hard-delete on the
                          API side — this guards against an accidental
                          single-click on a Tuesday morning. */}
                      <details style={{ display: 'inline-block' }}>
                        <summary
                          className="panorama-button secondary"
                          style={{ cursor: 'pointer' }}
                        >
                          {messages.t('actions.delete')}
                        </summary>
                        <form
                          action={deleteBlackoutAction}
                          className="panorama-inline-form"
                        >
                          <input type="hidden" name="id" value={b.id} />
                          <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                            {messages.t('blackout.delete.confirm_title')}
                          </p>
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 13,
                              margin: '6px 0',
                            }}
                          >
                            <input type="checkbox" required />
                            {messages.t('blackout.delete.confirm_checkbox')}
                          </label>
                          <button
                            type="submit"
                            className="panorama-button secondary"
                          >
                            {messages.t('blackout.delete.confirm_button')}
                          </button>
                        </form>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
