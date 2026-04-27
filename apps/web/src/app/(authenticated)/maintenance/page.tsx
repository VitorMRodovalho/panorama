import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import { openMaintenanceAction } from './actions';

interface TicketRow {
  id: string;
  tenantId: string;
  assetId: string;
  maintenanceType: string;
  title: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  severity: string | null;
  triggeringReservationId: string | null;
  triggeringInspectionId: string | null;
  assigneeUserId: string | null;
  startedAt: string;
  cost: string | null;
  isWarranty: boolean;
  notes: string | null;
  createdAt: string;
  createdByUserId: string;
}

interface ListResponse {
  items: TicketRow[];
  nextCursor: string | null;
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

interface MaintenancePageProps {
  searchParams: Promise<{
    status?: string;
    assetId?: string;
    error?: string;
    cancelled?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

const MAINTENANCE_TYPES = [
  'Maintenance',
  'Repair',
  'PAT Test',
  'Upgrade',
  'Hardware Support',
  'Software Support',
  'Inspection',
  'Tire',
  'Calibration',
] as const;

export default async function MaintenancePage({
  searchParams,
}: MaintenancePageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const status = sp.status && sp.status !== 'all' ? sp.status : undefined;
  const assetIdFilter = sp.assetId && sp.assetId.trim().length > 0 ? sp.assetId : undefined;

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);

  const queryParts = [
    status ? `status=${status}` : '',
    assetIdFilter ? `assetId=${assetIdFilter}` : '',
    'limit=100',
  ].filter(Boolean);

  const [listRes, assetsRes] = await Promise.all([
    apiGet<ListResponse>(`/maintenances?${queryParts.join('&')}`),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);
  const items = listRes.ok ? listRes.data.items : [];
  const assetsById = new Map<string, AssetSlim>(
    (assetsRes.ok ? assetsRes.data.items : []).map((a) => [a.id, a]),
  );

  return (
    <>
        <h1 style={{ margin: '0 0 16px' }}>{messages.t('maintenance.list.title')}</h1>

        {sp.error ? (
          <div className="panorama-banner-warning">{messages.t(sp.error)}</div>
        ) : null}
        {sp.cancelled ? (
          <div className="panorama-banner-success">
            {messages.t('maintenance.banner.cancelled')}
          </div>
        ) : null}

        <form
          method="GET"
          className="panorama-card"
          style={{
            marginBottom: 16,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <label>
            {messages.t('maintenance.filter.status')}:&nbsp;
            <select name="status" defaultValue={sp.status ?? 'all'} className="panorama-select">
              <option value="all">{messages.t('maintenance.filter.all')}</option>
              <option value="OPEN">{messages.t('maintenance.status.OPEN')}</option>
              <option value="IN_PROGRESS">{messages.t('maintenance.status.IN_PROGRESS')}</option>
              <option value="COMPLETED">{messages.t('maintenance.status.COMPLETED')}</option>
              <option value="CANCELLED">{messages.t('maintenance.status.CANCELLED')}</option>
            </select>
          </label>
          <label>
            {messages.t('maintenance.filter.asset')}:&nbsp;
            <select name="assetId" defaultValue={sp.assetId ?? ''} className="panorama-select">
              <option value="">{messages.t('maintenance.filter.all')}</option>
              {(assetsRes.ok ? assetsRes.data.items : []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tag} — {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="panorama-button secondary">
            {messages.t('actions.filter')}
          </button>
        </form>

        {isAdmin ? (
          <details className="panorama-card" style={{ marginBottom: 16 }}>
            <summary
              className="panorama-button"
              style={{ cursor: 'pointer', display: 'inline-block' }}
            >
              {messages.t('maintenance.action.open')}
            </summary>
            <form
              action={openMaintenanceAction}
              className="panorama-form-grid"
              style={{ marginTop: 12 }}
            >
              <label style={{ gridColumn: '1 / -1' }}>
                {messages.t('maintenance.field.title')}
                <input
                  type="text"
                  name="title"
                  className="panorama-input"
                  required
                  minLength={3}
                  maxLength={200}
                />
              </label>
              <label>
                {messages.t('maintenance.field.asset')}
                {/* Pre-fill from `?assetId=` when navigating in from the
                    asset row CTA or the reservation damage callout. */}
                <select
                  name="assetId"
                  className="panorama-select"
                  required
                  defaultValue={assetIdFilter ?? ''}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {(assetsRes.ok ? assetsRes.data.items : []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.tag} — {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {messages.t('maintenance.field.type')}
                <select
                  name="maintenanceType"
                  className="panorama-select"
                  required
                  defaultValue="Repair"
                >
                  {MAINTENANCE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {messages.t(`maintenance.type.${t}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {messages.t('maintenance.field.severity')}
                <input
                  type="text"
                  name="severity"
                  className="panorama-input"
                  maxLength={40}
                  placeholder={messages.t('maintenance.field.severity_placeholder')}
                />
              </label>
              <label>
                {messages.t('maintenance.field.supplier')}
                <input
                  type="text"
                  name="supplierName"
                  className="panorama-input"
                  maxLength={200}
                />
              </label>
              <label>
                {messages.t('maintenance.field.mileage_at_service')}
                <input
                  type="number"
                  name="mileageAtService"
                  className="panorama-input"
                  min={0}
                />
              </label>
              <label>
                {messages.t('maintenance.field.cost')}
                <input
                  type="number"
                  name="cost"
                  className="panorama-input"
                  min={0}
                  step="0.01"
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" name="isWarranty" />
                {messages.t('maintenance.field.is_warranty')}
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                {messages.t('maintenance.field.notes')}
                <textarea
                  name="notes"
                  className="panorama-input"
                  rows={3}
                  maxLength={8000}
                />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                <button type="submit" className="panorama-button">
                  {messages.t('maintenance.action.open')}
                </button>
              </div>
            </form>
          </details>
        ) : null}

        {items.length === 0 ? (
          <div className="panorama-card">{messages.t('maintenance.list.empty')}</div>
        ) : (
          <div className="panorama-card" style={{ padding: 0 }}>
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>{messages.t('maintenance.column.title')}</th>
                  <th>{messages.t('maintenance.column.asset')}</th>
                  <th>{messages.t('maintenance.column.type')}</th>
                  <th>{messages.t('maintenance.column.status')}</th>
                  <th>{messages.t('maintenance.column.started')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const asset = assetsById.get(row.assetId);
                  return (
                    <tr key={row.id}>
                      <td>{row.title}</td>
                      <td>{asset ? `${asset.tag} — ${asset.name}` : row.assetId.slice(0, 8)}</td>
                      <td>{messages.t(`maintenance.type.${row.maintenanceType}`)}</td>
                      <td>
                        <StatusPill status={row.status} t={messages.t} />
                      </td>
                      <td>{new Date(row.startedAt).toLocaleString()}</td>
                      <td>
                        <Link
                          href={`/maintenance/${row.id}`}
                          className="panorama-button secondary"
                        >
                          {messages.t('actions.open')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

function StatusPill({
  status,
  t,
}: {
  status: TicketRow['status'];
  t: (key: string) => string;
}): ReactNode {
  const tone =
    status === 'OPEN'
      ? { background: '#7c2d12', color: '#fed7aa' }
      : status === 'IN_PROGRESS'
        ? { background: '#1e3a8a', color: '#bfdbfe' }
        : status === 'COMPLETED'
          ? { background: '#14532d', color: '#bbf7d0' }
          : { background: '#374151', color: '#d1d5db' };
  return (
    <span className="panorama-pill" style={tone}>
      {t(`maintenance.status.${status}`)}
    </span>
  );
}
