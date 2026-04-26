import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../../../lib/api';
import { loadMessages } from '../../../../lib/i18n';
import { getCurrentSession } from '../../../../lib/session';
import { logoutAction } from '../../../login/actions';
import { createTemplateAction } from '../actions';

interface CategorySlim {
  id: string;
  name: string;
  kind: string;
}

interface CategoriesResponse {
  items?: CategorySlim[];
}

interface NewTemplatePageProps {
  searchParams: Promise<{
    error?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

const CATEGORY_KINDS = [
  'HARDWARE',
  'LICENSE',
  'ACCESSORY',
  'CONSUMABLE',
  'COMPONENT',
  'VEHICLE',
  'OTHER',
];

const ITEM_TYPES = [
  { value: 'BOOLEAN', label: 'inspection.template.item.type.BOOLEAN' },
  { value: 'TEXT', label: 'inspection.template.item.type.TEXT' },
  { value: 'NUMBER', label: 'inspection.template.item.type.NUMBER' },
  { value: 'PHOTO', label: 'inspection.template.item.type.PHOTO' },
] as const;

const NUM_ITEM_SLOTS = 10;

export default async function NewTemplatePage({
  searchParams,
}: NewTemplatePageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!ADMIN_ROLES.has(session.currentRole)) {
    redirect('/inspections?error=' + encodeURIComponent('Admin role required.'));
  }

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  // The /categories endpoint isn't ADR-defined yet for the web — fall
  // back gracefully if the call fails. Admins can still pick scope by
  // categoryKind in that case.
  const catsRes = await apiGet<CategoriesResponse>('/categories?limit=200');
  const categories = catsRes.ok ? catsRes.data.items ?? [] : [];

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
          <h1 style={{ margin: 0 }}>{messages.t('inspection.template.create')}</h1>
          <Link href="/admin/inspection-templates" className="panorama-button secondary">
            ← back
          </Link>
        </div>

        {sp.error ? (
          <div className="panorama-banner-warning">{sp.error}</div>
        ) : null}

        <form action={createTemplateAction} className="panorama-card panorama-form-grid">
          <label>
            Name
            <input type="text" name="name" required maxLength={200} className="panorama-input" />
          </label>
          <label>
            Display order
            <input type="number" name="displayOrder" defaultValue={0} min={0} className="panorama-input" />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Description (optional)
            <input type="text" name="description" maxLength={1000} className="panorama-input" />
          </label>

          <fieldset style={{ gridColumn: '1 / -1', border: '1px solid #334155', padding: 12, borderRadius: 6 }}>
            <legend>Scope</legend>
            <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 8px 0' }}>
              Pick EITHER a category kind (template applies to every category of that kind) OR a
              specific category (override). Not both.
            </p>
            <label style={{ marginRight: 16 }}>
              <input type="radio" name="scope" value="kind" defaultChecked />
              &nbsp;{messages.t('inspection.template.scope.kind')}
            </label>
            <label>
              <input type="radio" name="scope" value="category" />
              &nbsp;{messages.t('inspection.template.scope.category')}
            </label>
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <select name="categoryKind" defaultValue="VEHICLE" className="panorama-select">
                {CATEGORY_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <select name="categoryId" defaultValue="" className="panorama-select">
                <option value="">— pick a category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <fieldset style={{ gridColumn: '1 / -1', border: '1px solid #334155', padding: 12, borderRadius: 6 }}>
            <legend>Items (fill any subset; blank rows are ignored)</legend>
            <table className="panorama-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>{messages.t('inspection.template.item.label')}</th>
                  <th>{messages.t('inspection.template.item.type')}</th>
                  <th>{messages.t('inspection.item.required')}</th>
                  <th>{messages.t('inspection.item.photo_required')}</th>
                  <th>{messages.t('inspection.template.item.min_value')}</th>
                  <th>{messages.t('inspection.template.item.max_value')}</th>
                  <th>{messages.t('inspection.template.item.help_text')}</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: NUM_ITEM_SLOTS }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="text"
                        name={`items[${i}][label]`}
                        maxLength={200}
                        className="panorama-input"
                        placeholder={i < 3 ? `e.g. Lights working?` : ''}
                      />
                    </td>
                    <td>
                      <select
                        name={`items[${i}][itemType]`}
                        defaultValue="BOOLEAN"
                        className="panorama-select"
                      >
                        {ITEM_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {messages.t(t.label)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" name={`items[${i}][required]`} />
                    </td>
                    <td>
                      <input type="checkbox" name={`items[${i}][photoRequired]`} />
                    </td>
                    <td>
                      <input type="number" name={`items[${i}][minValue]`} step="any" className="panorama-input" />
                    </td>
                    <td>
                      <input type="number" name={`items[${i}][maxValue]`} step="any" className="panorama-input" />
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`items[${i}][helpText]`}
                        maxLength={1000}
                        className="panorama-input"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 8 }}>
              0.3 ships fixed-{NUM_ITEM_SLOTS} item slots — need more? Archive + recreate, or use the
              API directly. A dynamic add/remove UI is queued for 0.4 polish.
            </p>
          </fieldset>

          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button type="submit" className="panorama-button">
              {messages.t('inspection.template.create')}
            </button>
            <Link href="/admin/inspection-templates" className="panorama-button secondary">
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
