import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../../lib/api';
import { loadMessages } from '../../../lib/i18n';
import { getCurrentSession } from '../../../lib/session';
import { logoutAction } from '../../login/actions';
import {
  cancelMaintenanceAction,
  completeMaintenanceAction,
  startWorkAction,
} from '../actions';

interface Ticket {
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
  supplierName: string | null;
  mileageAtService: number | null;
  expectedReturnAt: string | null;
  nextServiceMileage: number | null;
  nextServiceDate: string | null;
  cost: string | null;
  isWarranty: boolean;
  notes: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNote: string | null;
  createdAt: string;
  createdByUserId: string;
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

interface MaintenanceDetailProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    opened?: string;
    started?: string;
    completed?: string;
    cancelled?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function MaintenanceDetailPage({
  params,
  searchParams,
}: MaintenanceDetailProps): Promise<ReactNode> {
  const { id } = await params;
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');

  const isAdmin = ADMIN_ROLES.has(session.currentRole);

  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);

  const [ticketRes, assetsRes] = await Promise.all([
    apiGet<Ticket>(`/maintenances/${id}`),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);
  if (!ticketRes.ok) {
    if (ticketRes.status === 404) notFound();
    redirect('/maintenance?error=errors.could_not_load_ticket');
  }
  const ticket = ticketRes.data;
  const assetsById = new Map<string, AssetSlim>(
    (assetsRes.ok ? assetsRes.data.items : []).map((a) => [a.id, a]),
  );
  const asset = assetsById.get(ticket.assetId);

  const isAssignee =
    ticket.assigneeUserId !== null && ticket.assigneeUserId === session.userId;
  const canTransitionFromOpenOrInProgress = isAdmin || isAssignee;
  const canCancel = isAdmin;

  const currentTenantName =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantDisplayName ??
    'Unknown tenant';

  return (
    <>
      <header className="panorama-header">
        <div>
          <strong>Panorama</strong>
          <span className="panorama-pill">{currentTenantName}</span>
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
        <div style={{ marginBottom: 8 }}>
          <Link href="/maintenance" className="panorama-button secondary">
            ← {messages.t('maintenance.list.title')}
          </Link>
        </div>

        <h1 style={{ marginTop: 8 }}>{ticket.title}</h1>
        <div style={{ marginBottom: 16 }}>
          <StatusPill status={ticket.status} t={messages.t} />
          <span className="panorama-pill" style={{ marginLeft: 6 }}>
            {messages.t(`maintenance.type.${ticket.maintenanceType}`)}
          </span>
          {ticket.severity ? (
            <span
              className="panorama-pill"
              style={{ marginLeft: 6, background: '#78350f', color: '#fde68a' }}
            >
              {ticket.severity}
            </span>
          ) : null}
          {ticket.isWarranty ? (
            <span className="panorama-pill" style={{ marginLeft: 6 }}>
              {messages.t('maintenance.field.is_warranty')}
            </span>
          ) : null}
        </div>

        {sp.error ? (
          <div className="panorama-banner-warning">{messages.t(sp.error)}</div>
        ) : null}
        {sp.opened ? (
          <div className="panorama-banner-success">
            {messages.t('maintenance.banner.opened')}
          </div>
        ) : null}
        {sp.started ? (
          <div className="panorama-banner-success">
            {messages.t('maintenance.banner.started_work')}
          </div>
        ) : null}
        {sp.completed ? (
          <div className="panorama-banner-success">
            {messages.t('maintenance.banner.completed')}
          </div>
        ) : null}
        {sp.cancelled ? (
          <div className="panorama-banner-success">
            {messages.t('maintenance.banner.cancelled')}
          </div>
        ) : null}

        <div className="panorama-card" style={{ marginBottom: 16 }}>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: '180px 1fr',
              gap: '6px 12px',
              margin: 0,
            }}
          >
            <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.field.asset')}</dt>
            <dd style={{ margin: 0 }}>
              {asset ? (
                <>
                  <strong>{asset.tag}</strong> — {asset.name}
                </>
              ) : (
                ticket.assetId
              )}
            </dd>

            <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.detail.opened_at')}</dt>
            <dd style={{ margin: 0 }}>{new Date(ticket.startedAt).toLocaleString()}</dd>

            <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.detail.opened_by')}</dt>
            <dd style={{ margin: 0 }}>{ticket.createdByUserId}</dd>

            {ticket.assigneeUserId ? (
              <>
                <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.field.assignee')}</dt>
                <dd style={{ margin: 0 }}>{ticket.assigneeUserId}</dd>
              </>
            ) : null}

            {ticket.supplierName ? (
              <>
                <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.field.supplier')}</dt>
                <dd style={{ margin: 0 }}>{ticket.supplierName}</dd>
              </>
            ) : null}

            {ticket.mileageAtService !== null ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.field.mileage_at_service')}
                </dt>
                <dd style={{ margin: 0 }}>{ticket.mileageAtService.toLocaleString()}</dd>
              </>
            ) : null}

            {ticket.cost !== null ? (
              <>
                <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.field.cost')}</dt>
                <dd style={{ margin: 0 }}>{ticket.cost}</dd>
              </>
            ) : null}

            {ticket.triggeringReservationId ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.detail.triggered_by_reservation')}
                </dt>
                <dd style={{ margin: 0 }}>
                  <Link href="/reservations" className="panorama-link">
                    {ticket.triggeringReservationId.slice(0, 8)}
                  </Link>
                </dd>
              </>
            ) : null}

            {ticket.triggeringInspectionId ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.detail.triggered_by_inspection')}
                </dt>
                <dd style={{ margin: 0 }}>
                  <Link
                    href={`/inspections/${ticket.triggeringInspectionId}`}
                    className="panorama-link"
                  >
                    {ticket.triggeringInspectionId.slice(0, 8)}
                  </Link>
                </dd>
              </>
            ) : null}

            {ticket.notes ? (
              <>
                <dt style={{ color: '#94a3b8' }}>{messages.t('maintenance.field.notes')}</dt>
                <dd
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    background: '#0f172a',
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  {ticket.notes}
                </dd>
              </>
            ) : null}

            {ticket.completedAt ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.detail.completed_at')}
                </dt>
                <dd style={{ margin: 0 }}>{new Date(ticket.completedAt).toLocaleString()}</dd>
              </>
            ) : null}
            {ticket.completedByUserId ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.detail.completed_by')}
                </dt>
                <dd style={{ margin: 0 }}>{ticket.completedByUserId}</dd>
              </>
            ) : null}
            {ticket.completionNote ? (
              <>
                <dt style={{ color: '#94a3b8' }}>
                  {messages.t('maintenance.field.completion_note')}
                </dt>
                <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ticket.completionNote}</dd>
              </>
            ) : null}
          </dl>
        </div>

        {/* Status transition controls. State machine per ADR-0016 §2:
            OPEN → IN_PROGRESS / COMPLETED / CANCELLED
            IN_PROGRESS → COMPLETED / CANCELLED
            terminal states (COMPLETED / CANCELLED) — no controls. */}
        {ticket.status === 'OPEN' || ticket.status === 'IN_PROGRESS' ? (
          <div
            className="panorama-card"
            style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}
          >
            {ticket.status === 'OPEN' && canTransitionFromOpenOrInProgress ? (
              <details>
                <summary className="panorama-button" style={{ cursor: 'pointer' }}>
                  {messages.t('maintenance.action.start_work')}
                </summary>
                <form
                  action={startWorkAction}
                  className="panorama-inline-form"
                  style={{ marginTop: 8 }}
                >
                  <input type="hidden" name="id" value={ticket.id} />
                  <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                    {messages.t('maintenance.confirm.start_work')}
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
                    {messages.t('maintenance.confirm.checkbox')}
                  </label>
                  <button type="submit" className="panorama-button">
                    {messages.t('maintenance.action.start_work')}
                  </button>
                </form>
              </details>
            ) : null}

            {canTransitionFromOpenOrInProgress ? (
              <details>
                {/* Complete is primary on IN_PROGRESS (the natural next step
                    is to finish the in-flight work). On OPEN it's the
                    less-common skip-ahead path, so render as secondary
                    so the visual weight pushes ops toward Start work
                    first. */}
                <summary
                  className={
                    ticket.status === 'IN_PROGRESS'
                      ? 'panorama-button'
                      : 'panorama-button secondary'
                  }
                  style={{ cursor: 'pointer' }}
                >
                  {messages.t('maintenance.action.complete')}
                </summary>
                <form
                  action={completeMaintenanceAction}
                  className="panorama-form-grid"
                  style={{ marginTop: 8 }}
                >
                  <input type="hidden" name="id" value={ticket.id} />
                  <p style={{ gridColumn: '1 / -1', margin: '0 0 6px', fontSize: 13 }}>
                    {messages.t('maintenance.confirm.complete')}
                  </p>
                  <label style={{ gridColumn: '1 / -1' }}>
                    {messages.t('maintenance.field.completion_note')}
                    <textarea
                      name="completionNote"
                      className="panorama-input"
                      rows={3}
                      maxLength={8000}
                    />
                  </label>
                  <label>
                    {messages.t('maintenance.field.next_service_mileage')}
                    <input
                      type="number"
                      name="nextServiceMileage"
                      className="panorama-input"
                      min={0}
                    />
                  </label>
                  <label>
                    {messages.t('maintenance.field.next_service_date')}
                    <input
                      type="date"
                      name="nextServiceDate"
                      className="panorama-input"
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
                  <label
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 13,
                    }}
                  >
                    <input type="checkbox" required />
                    {messages.t('maintenance.confirm.checkbox')}
                  </label>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <button type="submit" className="panorama-button">
                      {messages.t('maintenance.action.complete')}
                    </button>
                  </div>
                </form>
              </details>
            ) : null}

            {canCancel ? (
              <details>
                <summary
                  className="panorama-button secondary"
                  style={{ cursor: 'pointer' }}
                >
                  {messages.t('maintenance.action.cancel')}
                </summary>
                <form
                  action={cancelMaintenanceAction}
                  className="panorama-inline-form"
                  style={{ marginTop: 8 }}
                >
                  <input type="hidden" name="id" value={ticket.id} />
                  <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                    {messages.t('maintenance.confirm.cancel')}
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
                    {messages.t('maintenance.confirm.checkbox')}
                  </label>
                  <button type="submit" className="panorama-button secondary">
                    {messages.t('maintenance.action.cancel')}
                  </button>
                </form>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}

function StatusPill({
  status,
  t,
}: {
  status: Ticket['status'];
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
