import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../../lib/api';
import { loadMessages } from '../../../lib/i18n';
import { getCurrentSession } from '../../../lib/session';
import { logoutAction } from '../../login/actions';
import { archiveTemplateAction } from './actions';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  categoryKind: string | null;
  categoryId: string | null;
  displayOrder: number;
  archivedAt: string | null;
  createdAt: string;
  items: Array<{ label: string; itemType: string }>;
}

interface ListResponse {
  items: TemplateRow[];
}

interface AdminTemplatesPageProps {
  searchParams: Promise<{
    error?: string;
    created?: string;
    archived?: string;
    includeArchived?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function AdminTemplatesPage({
  searchParams,
}: AdminTemplatesPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!ADMIN_ROLES.has(session.currentRole)) {
    redirect('/inspections?error=' + encodeURIComponent('Admin role required.'));
  }

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  const includeArchived = sp.includeArchived === 'true';
  const listRes = await apiGet<ListResponse>(
    `/inspection-templates?includeArchived=${includeArchived ? 'true' : 'false'}&limit=200`,
  );
  const items = listRes.ok ? listRes.data.items : [];

  return (
    <>
      <header className="panorama-header">
        <div>
          <strong>Panorama</strong>
          <span className="panorama-pill">
            {session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantDisplayName ??
              'Unknown tenant'}
          </span>
        </div>
        <div>
          <span style={{ marginRight: 12 }}>
            {session.displayName} <span className="panorama-pill">{session.currentRole}</span>
          </span>
          <form action={logoutAction} style={{ display: 'inline' }}>
            <button type="submit" className="panorama-button secondary">Logout</button>
          </form>
        </div>
      </header>

      <section className="panorama-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>Inspection templates</h1>
          <div>
            <Link href="/inspections" className="panorama-button secondary" style={{ marginRight: 8 }}>
              ← {messages.t('nav.inspections')}
            </Link>
            <Link href="/admin/inspection-templates/new" className="panorama-button">
              {messages.t('inspection.template.create')}
            </Link>
          </div>
        </div>

        {sp.error ? (
          <div className="panorama-banner-warning">{sp.error}</div>
        ) : null}
        {sp.created ? (
          <div className="panorama-banner-success">Template created.</div>
        ) : null}
        {sp.archived ? (
          <div className="panorama-banner-success">Template archived.</div>
        ) : null}

        <form method="GET" className="panorama-card" style={{ marginBottom: 16 }}>
          <label>
            <input
              type="checkbox"
              name="includeArchived"
              value="true"
              defaultChecked={includeArchived}
            />
            &nbsp;Include archived
          </label>
          <button type="submit" className="panorama-button secondary" style={{ marginLeft: 12 }}>
            Filter
          </button>
        </form>

        {items.length === 0 ? (
          <div className="panorama-card">{messages.t('inspection.template.list.empty')}</div>
        ) : (
          <div className="panorama-card" style={{ padding: 0 }}>
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Items</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.description ? (
                        <div style={{ color: '#94a3b8', fontSize: 12 }}>{row.description}</div>
                      ) : null}
                    </td>
                    <td>
                      {row.categoryKind ? (
                        <span className="panorama-pill">kind: {row.categoryKind}</span>
                      ) : row.categoryId ? (
                        <span className="panorama-pill">category-id</span>
                      ) : (
                        <span style={{ color: '#fca5a5' }}>(no scope?)</span>
                      )}
                    </td>
                    <td>
                      {row.items.length}{' '}
                      <span style={{ color: '#94a3b8', fontSize: 12 }}>
                        ({row.items.slice(0, 3).map((i) => i.label).join(', ')}
                        {row.items.length > 3 ? '…' : ''})
                      </span>
                    </td>
                    <td>{row.displayOrder}</td>
                    <td>
                      {row.archivedAt ? (
                        <span className="panorama-pill" style={{ background: '#374151' }}>
                          archived
                        </span>
                      ) : (
                        <span className="panorama-pill">active</span>
                      )}
                    </td>
                    <td>
                      {row.archivedAt ? (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      ) : (
                        <form action={archiveTemplateAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="id" value={row.id} />
                          <button type="submit" className="panorama-button secondary">
                            {messages.t('inspection.template.archive')}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 12 }}>
          Edit isn't shipped in 0.3 — to change a template, archive it and create a new one. Existing
          inspections preserve their snapshot regardless (ADR-0012 §2).
        </p>
      </section>
    </>
  );
}
