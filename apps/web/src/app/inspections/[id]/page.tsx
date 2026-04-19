import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../../lib/api';
import { loadMessages } from '../../../lib/i18n';
import { getCurrentSession } from '../../../lib/session';
import { logoutAction } from '../../login/actions';
import {
  cancelInspectionAction,
  completeInspectionAction,
  respondInspectionAction,
  reviewInspectionAction,
} from '../actions';

interface SnapshotItem {
  id: string;
  position: number;
  label: string;
  itemType: 'BOOLEAN' | 'TEXT' | 'NUMBER' | 'PHOTO';
  required: boolean;
  photoRequired: boolean;
  minValue: number | null;
  maxValue: number | null;
  helpText: string | null;
}

interface TemplateSnapshot {
  name: string;
  description: string | null;
  templateVersionAt: string;
  items: SnapshotItem[];
}

interface InspectionDetail {
  id: string;
  tenantId: string;
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
  templateSnapshot: TemplateSnapshot;
}

interface AssetSlim {
  id: string;
  tag: string;
  name: string;
}

interface TemplateMeta {
  id: string;
  updatedAt: string;
}

interface InspectionDetailPageProps {
  params: { id: string };
  searchParams: {
    error?: string;
    saved?: string;
    resumed?: string;
    reviewed?: string;
  };
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function InspectionDetailPage({
  params,
  searchParams,
}: InspectionDetailPageProps): Promise<JSX.Element> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  const inspectionRes = await apiGet<InspectionDetail>(`/inspections/${params.id}`);
  if (!inspectionRes.ok) {
    redirect(`/inspections?error=${encodeURIComponent('Inspection not found.')}`);
  }
  const inspection = inspectionRes.data;
  const isStarter = inspection.startedByUserId === session.userId;
  const canEdit = inspection.status === 'IN_PROGRESS' && (isStarter || isAdmin);
  const canReview =
    inspection.status === 'COMPLETED' &&
    inspection.reviewedAt === null &&
    isAdmin &&
    (inspection.outcome === 'FAIL' || inspection.outcome === 'NEEDS_MAINTENANCE');

  // Asset label + the divergence-banner check (template snapshot vs
  // live template's updatedAt — ADR-0012 §2 + persona-fleet-ops).
  const [assetRes, templateMetaRes] = await Promise.all([
    apiGet<{ items: AssetSlim[] }>('/assets?limit=200'),
    inspection.templateId
      ? apiGet<TemplateMeta>(`/inspection-templates/${inspection.templateId}`)
      : Promise.resolve({ ok: false, status: 404 } as const),
  ]);
  const asset = assetRes.ok
    ? assetRes.data.items.find((a) => a.id === inspection.assetId)
    : null;
  const templateUpdatedAt = templateMetaRes.ok ? templateMetaRes.data.updatedAt : null;
  const snapshotDiverged =
    templateUpdatedAt !== null &&
    new Date(templateUpdatedAt).getTime() > new Date(inspection.templateSnapshot.templateVersionAt).getTime();

  // Pre-fill of saved values is intentionally NOT done here. The
  // /:id endpoint doesn't ship responses; a dedicated GET would be
  // a 0.4 polish (out of scope). For 0.3 the partial-save flow is
  // visible via the `?saved=<itemId>` banner the action redirects
  // back to.

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
          <h1 style={{ margin: 0 }}>{inspection.templateSnapshot.name}</h1>
          <Link href="/inspections" className="panorama-button secondary">
            ← {messages.t('nav.inspections')}
          </Link>
        </div>

        <div className="panorama-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span><strong>Asset:</strong> {asset ? `${asset.tag} — ${asset.name}` : inspection.assetId.slice(0, 8)}</span>
            <span><strong>Started:</strong> {new Date(inspection.startedAt).toLocaleString()}</span>
            <span>
              <strong>Status:</strong>{' '}
              <span className="panorama-pill">{messages.t(`inspection.status.${inspection.status}`)}</span>
            </span>
            {inspection.outcome ? (
              <span>
                <strong>Outcome:</strong>{' '}
                <span
                  className="panorama-pill"
                  style={
                    inspection.outcome === 'FAIL'
                      ? { background: '#7f1d1d', color: '#fecaca' }
                      : inspection.outcome === 'NEEDS_MAINTENANCE'
                      ? { background: '#78350f', color: '#fde68a' }
                      : undefined
                  }
                >
                  {messages.t(`inspection.outcome.${inspection.outcome}`)}
                </span>
              </span>
            ) : null}
            {inspection.reservationId ? (
              <Link href={`/reservations`} style={{ color: '#7dd3fc' }}>
                Linked reservation
              </Link>
            ) : null}
          </div>
        </div>

        {searchParams.error ? <div className="panorama-banner-warning">{searchParams.error}</div> : null}
        {searchParams.resumed ? (
          <div className="panorama-banner-success">Resumed your in-progress inspection.</div>
        ) : null}
        {searchParams.saved ? (
          <div className="panorama-banner-success">Item saved.</div>
        ) : null}
        {searchParams.reviewed ? (
          <div className="panorama-banner-success">Inspection reviewed.</div>
        ) : null}

        {snapshotDiverged ? (
          <div className="panorama-banner-warning">
            {messages.t('inspection.template.divergence_banner')}
          </div>
        ) : null}

        <h2 style={{ margin: '16px 0 8px 0', fontSize: 18 }}>Items</h2>
        {inspection.templateSnapshot.items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            inspectionId={inspection.id}
            canEdit={canEdit}
            messages={messages}
            justSaved={searchParams.saved === item.id}
          />
        ))}

        {canEdit ? (
          <div className="panorama-card" style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 8px 0', fontSize: 18 }}>{messages.t('inspection.complete')}</h2>
            <form action={completeInspectionAction} className="panorama-form-grid">
              <input type="hidden" name="inspectionId" value={inspection.id} />
              <label>
                {messages.t('inspection.outcome')}
                <select name="outcome" required className="panorama-select">
                  <option value="">— pick —</option>
                  <option value="PASS">{messages.t('inspection.outcome.PASS')}</option>
                  <option value="FAIL">{messages.t('inspection.outcome.FAIL')}</option>
                  <option value="NEEDS_MAINTENANCE">
                    {messages.t('inspection.outcome.NEEDS_MAINTENANCE')}
                  </option>
                </select>
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                {messages.t('inspection.summary_note')}
                <textarea
                  name="summaryNote"
                  rows={2}
                  className="panorama-input"
                  placeholder={messages.t('inspection.summary_note_placeholder')}
                />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                <button type="submit" className="panorama-button">
                  {messages.t('inspection.complete')}
                </button>
                <CancelInspectionButton inspectionId={inspection.id} t={messages.t} />
              </div>
            </form>
          </div>
        ) : null}

        {canReview ? (
          <div className="panorama-card" style={{ marginTop: 16 }}>
            <h2 style={{ margin: '0 0 8px 0', fontSize: 18 }}>{messages.t('inspection.review')}</h2>
            <form action={reviewInspectionAction} className="panorama-form-grid">
              <input type="hidden" name="inspectionId" value={inspection.id} />
              <label style={{ gridColumn: '1 / -1' }}>
                {messages.t('inspection.review_note')}
                <textarea
                  name="reviewNote"
                  rows={3}
                  className="panorama-input"
                  placeholder={messages.t('inspection.review_note_placeholder')}
                />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                <button type="submit" className="panorama-button">
                  {messages.t('inspection.review')}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {inspection.reviewedAt ? (
          <div className="panorama-card" style={{ marginTop: 16 }}>
            <strong>Reviewed</strong> {new Date(inspection.reviewedAt).toLocaleString()}
            {inspection.reviewNote ? (
              <p style={{ margin: '8px 0 0 0' }}>{inspection.reviewNote}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}

function ItemCard({
  item,
  inspectionId,
  canEdit,
  messages,
  justSaved,
}: {
  item: SnapshotItem;
  inspectionId: string;
  canEdit: boolean;
  messages: { t: (key: string) => string };
  justSaved: boolean;
}): JSX.Element {
  return (
    <div className="panorama-card" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>
          {item.label}
          {item.required ? (
            <span style={{ color: '#fca5a5', marginLeft: 6 }}>{messages.t('inspection.item.required')}</span>
          ) : null}
          {item.photoRequired || item.itemType === 'PHOTO' ? (
            <span className="panorama-pill" style={{ marginLeft: 6 }}>
              {messages.t('inspection.item.photo_required')}
            </span>
          ) : null}
        </h3>
        {justSaved ? <span style={{ color: '#7dd3fc' }}>✓ saved</span> : null}
      </div>
      {item.helpText ? (
        <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0 8px 0' }}>{item.helpText}</p>
      ) : null}

      {canEdit ? (
        <form action={respondInspectionAction} className="panorama-form-grid">
          <input type="hidden" name="inspectionId" value={inspectionId} />
          <input type="hidden" name="snapshotItemId" value={item.id} />
          <input type="hidden" name="itemType" value={item.itemType} />

          {item.itemType === 'BOOLEAN' ? (
            <label>
              <select name="booleanValue" required defaultValue="" className="panorama-select">
                <option value="">— pick —</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
          ) : null}

          {item.itemType === 'TEXT' ? (
            <label style={{ gridColumn: '1 / -1' }}>
              <input type="text" name="textValue" maxLength={2000} className="panorama-input" />
            </label>
          ) : null}

          {item.itemType === 'NUMBER' ? (
            <label>
              <input
                type="number"
                name="numberValue"
                step="any"
                {...(item.minValue !== null ? { min: item.minValue } : {})}
                {...(item.maxValue !== null ? { max: item.maxValue } : {})}
                className="panorama-input"
              />
              {item.minValue !== null || item.maxValue !== null ? (
                <span style={{ color: '#94a3b8', fontSize: 12, marginLeft: 6 }}>
                  ({item.minValue ?? '−∞'} … {item.maxValue ?? '+∞'})
                </span>
              ) : null}
            </label>
          ) : null}

          {item.itemType === 'PHOTO' ? (
            <p style={{ gridColumn: '1 / -1', color: '#94a3b8', fontSize: 13 }}>
              Photo upload UI lands in step 11b (this page wires the read-side; the writer is queued).
            </p>
          ) : null}

          <label style={{ gridColumn: '1 / -1' }}>
            <input
              type="text"
              name="note"
              maxLength={2000}
              className="panorama-input"
              placeholder={messages.t('inspection.item.note_optional')}
            />
          </label>

          <div style={{ gridColumn: '1 / -1' }}>
            <button type="submit" className="panorama-button secondary">
              Save
            </button>
          </div>
        </form>
      ) : (
        <p style={{ color: '#94a3b8', fontStyle: 'italic', margin: 0 }}>
          {item.itemType === 'PHOTO' ? '(photo)' : '(read-only — inspection is not in progress)'}
        </p>
      )}
    </div>
  );
}

function CancelInspectionButton({
  inspectionId,
  t,
}: {
  inspectionId: string;
  t: (key: string) => string;
}): JSX.Element {
  return (
    <form action={cancelInspectionAction} style={{ display: 'inline' }}>
      <input type="hidden" name="inspectionId" value={inspectionId} />
      <button type="submit" className="panorama-button secondary">
        {t('inspection.cancel')}
      </button>
    </form>
  );
}
