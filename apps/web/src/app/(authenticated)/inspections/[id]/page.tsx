import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';
import {
  cancelInspectionAction,
  completeInspectionAction,
  respondInspectionAction,
  reviewInspectionAction,
} from '../actions';
import { PhotoUploader } from './photo-uploader';

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
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    errorItems?: string;
    saved?: string;
    resumed?: string;
    reviewed?: string;
    photo?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function InspectionDetailPage({
  params,
  searchParams,
}: InspectionDetailPageProps): Promise<ReactNode> {
  const [p, sp] = await Promise.all([params, searchParams]);
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ?? 'en';
  const messages = loadMessages(tenantLocale);

  const inspectionRes = await apiGet<InspectionDetail>(`/inspections/${p.id}`);
  if (!inspectionRes.ok) {
    redirect('/inspections?error=inspection.error.inspection_not_found');
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ margin: 0 }}>{inspection.templateSnapshot.name}</h1>
          <Link href="/inspections" className="panorama-button secondary">
            ← {messages.t('nav.inspections')}
          </Link>
        </div>

        <div className="panorama-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span><strong>{messages.t('inspection.detail.label.asset')}</strong> {asset ? `${asset.tag} — ${asset.name}` : inspection.assetId.slice(0, 8)}</span>
            <span><strong>{messages.t('inspection.detail.label.started')}</strong> {new Date(inspection.startedAt).toLocaleString(messages.locale)}</span>
            <span>
              <strong>{messages.t('inspection.detail.label.status')}</strong>{' '}
              <span className="panorama-pill">{messages.t(`inspection.status.${inspection.status}`)}</span>
            </span>
            {inspection.outcome ? (
              <span>
                <strong>{messages.t('inspection.detail.label.outcome')}</strong>{' '}
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
                {messages.t('inspection.detail.linked_reservation')}
              </Link>
            ) : null}
          </div>
        </div>

        {sp.error ? (
          <div className="panorama-banner-warning">
            {messages.t(sp.error, sp.errorItems ? { items: sp.errorItems } : undefined)}
          </div>
        ) : null}
        {sp.resumed ? (
          <div className="panorama-banner-success">{messages.t('inspection.banner.resumed')}</div>
        ) : null}
        {sp.saved ? (
          <div className="panorama-banner-success">{messages.t('inspection.banner.item_saved')}</div>
        ) : null}
        {sp.reviewed ? (
          <div className="panorama-banner-success">{messages.t('inspection.banner.reviewed')}</div>
        ) : null}
        {sp.photo === 'ok' ? (
          <div className="panorama-banner-success">{messages.t('inspection.banner.photo_uploaded')}</div>
        ) : null}

        {snapshotDiverged ? (
          <div className="panorama-banner-warning">
            {messages.t('inspection.template.divergence_banner')}
          </div>
        ) : null}

        <h2 style={{ margin: '16px 0 8px 0', fontSize: 18 }}>{messages.t('inspection.detail.items_heading')}</h2>
        {inspection.templateSnapshot.items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            inspectionId={inspection.id}
            canEdit={canEdit}
            messages={messages}
            justSaved={sp.saved === item.id}
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
                  <option value="">{messages.t('inspection.detail.outcome_pick_placeholder')}</option>
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
            <strong>{messages.t('inspection.detail.reviewed_label')}</strong>{' '}
            {new Date(inspection.reviewedAt).toLocaleString(messages.locale)}
            {inspection.reviewNote ? (
              <p style={{ margin: '8px 0 0 0' }}>{inspection.reviewNote}</p>
            ) : null}
          </div>
        ) : null}
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
}): ReactNode {
  const showsPhotoUpload =
    canEdit && (item.itemType === 'PHOTO' || item.photoRequired);
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
        {justSaved ? <span style={{ color: '#7dd3fc' }}>{messages.t('inspection.detail.just_saved')}</span> : null}
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
                <option value="">{messages.t('inspection.detail.boolean_pick_placeholder')}</option>
                <option value="true">{messages.t('common.yes')}</option>
                <option value="false">{messages.t('common.no')}</option>
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

          {item.itemType !== 'PHOTO' ? (
            <label style={{ gridColumn: '1 / -1' }}>
              <input
                type="text"
                name="note"
                maxLength={2000}
                className="panorama-input"
                placeholder={messages.t('inspection.item.note_optional')}
              />
            </label>
          ) : null}

          {item.itemType !== 'PHOTO' ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <button type="submit" className="panorama-button secondary">
                {messages.t('actions.save')}
              </button>
            </div>
          ) : null}
        </form>
      ) : (
        <p style={{ color: '#94a3b8', fontStyle: 'italic', margin: 0 }}>
          {messages.t('inspection.detail.read_only')}
        </p>
      )}

      {showsPhotoUpload ? (
        <PhotoUploader
          inspectionId={inspectionId}
          strings={{
            upload: messages.t('inspection.photo.upload'),
            uploading: messages.t('inspection.photo.uploading'),
            cancel: messages.t('inspection.photo.cancel'),
            retry: messages.t('inspection.photo.retry'),
            aborted: messages.t('inspection.photo.upload_aborted'),
            failed: messages.t('inspection.photo.upload_failed'),
            pickFile: messages.t('inspection.photo.pick_file'),
            pickFileFirst: messages.t('inspection.photo.pick_file_first'),
            help: messages.t('inspection.photo.help'),
            error: {
              rateLimitedSeconds: messages.t('inspection.photo.error.rate_limited'),
              rateLimited: messages.t('inspection.photo.error.rate_limited_no_seconds'),
              tooLargePixels: messages.t('inspection.photo.error.too_large_pixels'),
              unsupportedMediaType: messages.t('inspection.photo.error.unsupported_media_type'),
              processingFailed: messages.t('inspection.photo.error.processing_failed'),
              capReached: messages.t('inspection.photo.error.cap_reached'),
              uploadKeyCollision: messages.t('inspection.photo.error.upload_key_collision'),
              tooLarge: messages.t('inspection.photo.error.too_large'),
              generic: messages.t('inspection.photo.error.generic'),
            },
          }}
        />
      ) : null}
    </div>
  );
}

function CancelInspectionButton({
  inspectionId,
  t,
}: {
  inspectionId: string;
  t: (key: string) => string;
}): ReactNode {
  return (
    <form action={cancelInspectionAction} style={{ display: 'inline' }}>
      <input type="hidden" name="inspectionId" value={inspectionId} />
      <button type="submit" className="panorama-button secondary">
        {t('inspection.cancel')}
      </button>
    </form>
  );
}
