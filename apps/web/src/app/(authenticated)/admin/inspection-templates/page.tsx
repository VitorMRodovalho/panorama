import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
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
    errorItems?: string;
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
    redirect('/inspections?error=inspection.template.error.admin_role_required');
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>{messages.t('nav.admin_inspection_templates')}</h1>
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
          <div className="panorama-banner-warning">
            {messages.t(sp.error, sp.errorItems ? { items: sp.errorItems } : undefined)}
          </div>
        ) : null}
        {sp.created ? (
          <div className="panorama-banner-success">{messages.t('inspection.template.banner.created')}</div>
        ) : null}
        {sp.archived ? (
          <div className="panorama-banner-success">{messages.t('inspection.template.banner.archived')}</div>
        ) : null}

        <form method="GET" className="panorama-card" style={{ marginBottom: 16 }}>
          <label>
            <input
              type="checkbox"
              name="includeArchived"
              value="true"
              defaultChecked={includeArchived}
            />
            &nbsp;{messages.t('inspection.template.list.filter.include_archived')}
          </label>
          <button type="submit" className="panorama-button secondary" style={{ marginLeft: 12 }}>
            {messages.t('actions.filter')}
          </button>
        </form>

        {items.length === 0 ? (
          <div className="panorama-card">{messages.t('inspection.template.list.empty')}</div>
        ) : (
          <div className="panorama-card" style={{ padding: 0 }}>
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>{messages.t('inspection.template.list.column.name')}</th>
                  <th>{messages.t('inspection.template.list.column.scope')}</th>
                  <th>{messages.t('inspection.template.list.column.items')}</th>
                  <th>{messages.t('inspection.template.list.column.order')}</th>
                  <th>{messages.t('inspection.template.list.column.status')}</th>
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
                        <span className="panorama-pill">
                          {messages.t('inspection.template.scope.kind_pill', {
                            kind: row.categoryKind,
                          })}
                        </span>
                      ) : row.categoryId ? (
                        <span className="panorama-pill">
                          {messages.t('inspection.template.scope.category_id_pill')}
                        </span>
                      ) : (
                        <span style={{ color: '#fca5a5' }}>
                          {messages.t('inspection.template.scope.none')}
                        </span>
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
                          {messages.t('inspection.template.status.archived')}
                        </span>
                      ) : (
                        <span className="panorama-pill">
                          {messages.t('inspection.template.status.active')}
                        </span>
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
          {messages.t('inspection.template.list.note_no_edit')}
        </p>
    </>
  );
}
