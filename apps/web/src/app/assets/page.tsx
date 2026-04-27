import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../lib/api';
import { loadMessages } from '../../lib/i18n';
import { getCurrentSession } from '../../lib/session';
import { logoutAction, switchTenantAction } from '../login/actions';

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

interface AssetListItem {
  id: string;
  tag: string;
  name: string;
  status: string;
  bookable: boolean;
  modelName: string | null;
  categoryName: string | null;
}

interface AssetsResponse {
  items: AssetListItem[];
  total: number;
}

interface OwnershipSummary {
  tenantId: string;
  activeOwners: number;
  isSpof: boolean;
}

export default async function AssetsPage(): Promise<ReactNode> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);

  const [assetsRes, ownershipRes] = await Promise.all([
    apiGet<AssetsResponse>('/assets?limit=100'),
    apiGet<OwnershipSummary>(`/tenants/${session.currentTenantId}/ownership-summary`),
  ]);
  const items: AssetListItem[] = assetsRes.ok ? assetsRes.data.items : [];
  const ownership = ownershipRes.ok ? ownershipRes.data : null;
  const showOwnerBanner =
    session.currentRole === 'owner' && ownership?.isSpof === true;

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
              <select
                className="panorama-select"
                name="tenantId"
                defaultValue={session.currentTenantId}
              >
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
            {session.displayName}{' '}
            <span className="panorama-pill">{session.currentRole}</span>
          </span>
          <form action={logoutAction} style={{ display: 'inline' }}>
            <button type="submit" className="panorama-button secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="panorama-content">
        <nav style={{ marginBottom: 16, display: 'flex', gap: 8, fontSize: 14 }}>
          <strong>Assets</strong>
          <span>·</span>
          <Link href="/reservations">Reservations</Link>
          <span>·</span>
          <Link href="/inspections">Inspections</Link>
          <span>·</span>
          <Link href="/maintenance">Maintenance</Link>
        </nav>
        {showOwnerBanner ? (
          <div className="panorama-banner-warning">
            <strong>This tenant has a single Owner.</strong> Invite a second
            Owner so access isn't lost if this account becomes unavailable.
          </div>
        ) : null}
        <div className="panorama-card">
          <h2 style={{ margin: '0 0 16px' }}>
            Assets <span className="panorama-pill">{items.length}</span>
          </h2>
          {!assetsRes.ok ? (
            <p className="panorama-error">Failed to load assets (HTTP {assetsRes.status}).</p>
          ) : items.length === 0 ? (
            <p className="panorama-empty">
              This tenant has no assets yet. Seed some via{' '}
              <code>pnpm --filter @panorama/core-api prisma:seed</code> or run the Snipe-IT
              migrator.
            </p>
          ) : (
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Bookable</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((asset) => (
                  <tr key={asset.id}>
                    <td>{asset.tag}</td>
                    <td>{asset.name}</td>
                    <td>{asset.modelName ?? '—'}</td>
                    <td>{asset.categoryName ?? '—'}</td>
                    <td>{asset.status}</td>
                    <td>{asset.bookable ? 'Yes' : 'No'}</td>
                    {isAdmin ? (
                      <td>
                        <Link
                          href={`/maintenance?assetId=${asset.id}`}
                          className="panorama-button secondary"
                          style={{ fontSize: 12 }}
                        >
                          {messages.t('asset.action.open_maintenance')}
                        </Link>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
