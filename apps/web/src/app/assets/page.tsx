import { redirect } from 'next/navigation';
import { apiGet } from '../../lib/api';
import { getCurrentSession } from '../../lib/session';
import { logoutAction, switchTenantAction } from '../login/actions';

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

export default async function AssetsPage(): Promise<JSX.Element> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const result = await apiGet<AssetsResponse>('/assets?limit=100');
  const items: AssetListItem[] = result.ok ? result.data.items : [];

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
        <div className="panorama-card">
          <h2 style={{ margin: '0 0 16px' }}>
            Assets <span className="panorama-pill">{items.length}</span>
          </h2>
          {!result.ok ? (
            <p className="panorama-error">Failed to load assets (HTTP {result.status}).</p>
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
