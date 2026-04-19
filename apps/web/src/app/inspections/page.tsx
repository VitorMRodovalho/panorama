import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../lib/api';
import { loadMessages } from '../../lib/i18n';
import { getCurrentSession } from '../../lib/session';
import { logoutAction, switchTenantAction } from '../login/actions';

interface InspectionRow {
  id: string;
  templateId: string | null;
  assetId: string;
  reservationId: string | null;
  startedByUserId: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  outcome: 'PASS' | 'FAIL' | 'NEEDS_MAINTENANCE' | null;
  summaryNote: string | null;
  startedAt: string;
  completedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  createdAt: string;
}

interface ListResponse {
  items: InspectionRow[];
}

interface AssetSlim {
  id: string;
  tag: string;
  name: string;
}

interface AssetsResponse {
  items: AssetSlim[];
  total: number;
}

interface InspectionsPageProps {
  searchParams: {
    scope?: string;
    status?: string;
    outcome?: string;
    needsReview?: string;
    error?: string;
    completed?: string;
    cancelled?: string;
  };
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function InspectionsPage({
  searchParams,
}: InspectionsPageProps): Promise<JSX.Element> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  // Driver default = scope=mine; admin default = scope=tenant + needsReview
  // (the review queue per ADR-0012 §11).
  const requestedScope = searchParams.scope === 'tenant' ? 'tenant' : 'mine';
  const scope = requestedScope === 'tenant' && !isAdmin ? 'mine' : requestedScope;
  const status = searchParams.status ?? 'all';
  const outcome = searchParams.outcome ?? 'all';
  const needsReview = searchParams.needsReview === 'true';

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  const queryParts = [
    `scope=${scope}`,
    `status=${status}`,
    `outcome=${outcome}`,
    needsReview ? 'needsReview=true' : '',
    'limit=200',
  ].filter(Boolean);
  const [listRes, assetsRes] = await Promise.all([
    apiGet<ListResponse>(`/inspections?${queryParts.join('&')}`),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);
  const items = listRes.ok ? listRes.data.items : [];
  const assetsById = new Map<string, AssetSlim>(
    (assetsRes.ok ? assetsRes.data.items : []).map((a) => [a.id, a]),
  );

  return (
    <>
      <header className="panorama-header">
        <div>
          <strong>Panorama</strong>
          <span className="panorama-pill">
            {session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantDisplayName ??
              'Unknown tenant'}
          </span>
          {session.memberships.length > 1 ? (
            <form action={switchTenantAction} style={{ display: 'inline-block', marginLeft: 12 }}>
              <select className="panorama-select" name="tenantId" defaultValue={session.currentTenantId}>
                {session.memberships.map((m) => (
                  <option key={m.tenantId} value={m.tenantId}>
                    {m.tenantDisplayName} · {m.role}
                  </option>
                ))}
              </select>
              <button type="submit" className="panorama-button secondary" style={{ marginLeft: 6 }}>
                Switch
              </button>
            </form>
          ) : null}
        </div>
        <div>
          <span style={{ marginRight: 12 }}>
            {session.displayName} <span className="panorama-pill">{session.currentRole}</span>
          </span>
          <form action={logoutAction} style={{ display: 'inline' }}>
            <button type="submit" className="panorama-button secondary">
              Logout
            </button>
          </form>
        </div>
      </header>

      <section className="panorama-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>{messages.t('nav.inspections')}</h1>
          <div>
            <Link href="/assets" className="panorama-button secondary" style={{ marginRight: 8 }}>
              {messages.t('nav.assets')}
            </Link>
            <Link href="/reservations" className="panorama-button secondary" style={{ marginRight: 8 }}>
              {messages.t('nav.bookings')}
            </Link>
            <Link href="/inspections/new" className="panorama-button">
              {messages.t('inspection.start')}
            </Link>
          </div>
        </div>

        {searchParams.error ? (
          <div className="panorama-banner-warning">{searchParams.error}</div>
        ) : null}
        {searchParams.completed ? (
          <div className="panorama-banner-success">Inspection completed.</div>
        ) : null}
        {searchParams.cancelled ? (
          <div className="panorama-banner-success">Inspection cancelled.</div>
        ) : null}

        <form method="GET" className="panorama-card" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            Scope:&nbsp;
            <select name="scope" defaultValue={scope} className="panorama-select">
              <option value="mine">{messages.t('inspection.list.filter.scope_mine')}</option>
              {isAdmin ? <option value="tenant">{messages.t('inspection.list.filter.scope_tenant')}</option> : null}
            </select>
          </label>
          <label>
            Status:&nbsp;
            <select name="status" defaultValue={status} className="panorama-select">
              <option value="all">All</option>
              <option value="IN_PROGRESS">{messages.t('inspection.status.IN_PROGRESS')}</option>
              <option value="COMPLETED">{messages.t('inspection.status.COMPLETED')}</option>
              <option value="CANCELLED">{messages.t('inspection.status.CANCELLED')}</option>
            </select>
          </label>
          <label>
            Outcome:&nbsp;
            <select name="outcome" defaultValue={outcome} className="panorama-select">
              <option value="all">All</option>
              <option value="PASS">{messages.t('inspection.outcome.PASS')}</option>
              <option value="FAIL">{messages.t('inspection.outcome.FAIL')}</option>
              <option value="NEEDS_MAINTENANCE">{messages.t('inspection.outcome.NEEDS_MAINTENANCE')}</option>
            </select>
          </label>
          {isAdmin ? (
            <label>
              <input type="checkbox" name="needsReview" value="true" defaultChecked={needsReview} />
              &nbsp;{messages.t('inspection.list.filter.needs_review')}
            </label>
          ) : null}
          <button type="submit" className="panorama-button secondary">Filter</button>
        </form>

        {items.length === 0 ? (
          <div className="panorama-card">{messages.t('inspection.list.empty')}</div>
        ) : (
          <div className="panorama-card" style={{ padding: 0 }}>
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>Reviewed</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const asset = assetsById.get(row.assetId);
                  return (
                    <tr key={row.id}>
                      <td>{asset ? `${asset.tag} — ${asset.name}` : row.assetId.slice(0, 8)}</td>
                      <td>{new Date(row.startedAt).toLocaleString()}</td>
                      <td>
                        <span className="panorama-pill">{messages.t(`inspection.status.${row.status}`)}</span>
                      </td>
                      <td>
                        {row.outcome ? (
                          <span
                            className="panorama-pill"
                            style={
                              row.outcome === 'FAIL'
                                ? { background: '#7f1d1d', color: '#fecaca' }
                                : row.outcome === 'NEEDS_MAINTENANCE'
                                ? { background: '#78350f', color: '#fde68a' }
                                : undefined
                            }
                          >
                            {messages.t(`inspection.outcome.${row.outcome}`)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{row.reviewedAt ? new Date(row.reviewedAt).toLocaleDateString() : '—'}</td>
                      <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.summaryNote ?? row.reviewNote ?? '—'}
                      </td>
                      <td>
                        <Link href={`/inspections/${row.id}`} className="panorama-button secondary">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
