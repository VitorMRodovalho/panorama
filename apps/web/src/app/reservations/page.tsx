import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '../../lib/api';
import { loadMessages } from '../../lib/i18n';
import { getCurrentSession } from '../../lib/session';
import { logoutAction, switchTenantAction } from '../login/actions';
import {
  approveBasketAction,
  approveReservationAction,
  cancelBasketAction,
  cancelReservationAction,
  checkinReservationAction,
  checkoutReservationAction,
  createBasketAction,
  createReservationAction,
  rejectBasketAction,
  rejectReservationAction,
} from './actions';

interface ReservationView {
  id: string;
  assetId: string | null;
  basketId: string | null;
  requesterUserId: string;
  onBehalfUserId: string | null;
  startAt: string;
  endAt: string;
  purpose: string | null;
  approvalStatus: string;
  lifecycleStatus: string;
  approvalNote: string | null;
  checkedOutAt: string | null;
  mileageOut: number | null;
  checkedInAt: string | null;
  mileageIn: number | null;
  damageFlag: boolean;
  damageNote: string | null;
  isOverdue: boolean;
  createdAt: string;
}

interface ReservationListResponse {
  items: ReservationView[];
}

interface AssetListItem {
  id: string;
  tag: string;
  name: string;
  bookable: boolean;
  status: string;
}

interface AssetsResponse {
  items: AssetListItem[];
  total: number;
}

interface ReservationsPageProps {
  searchParams: Promise<{
    scope?: string;
    status?: string;
    error?: string;
    created?: string;
    cancelled?: string;
    approved?: string;
    rejected?: string;
    checkedout?: string;
    checkedin?: string;
    basket?: string;
    basketId?: string;
    batch?: string;
    processed?: string;
    skipped?: string;
    skippedReasons?: string;
  }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function ReservationsPage({
  searchParams,
}: ReservationsPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  // Pick locale from the current tenant's membership — same pattern
  // the notification email channel uses. `session` is guaranteed
  // truthy here (redirect above short-circuits null).
  const currentMembership = session.memberships.find(
    (m) => m.tenantId === session.currentTenantId,
  );
  const messages = loadMessages(currentMembership?.tenantLocale);

  const scopeParam = sp.scope === 'tenant' && isAdmin ? 'tenant' : 'mine';
  const statusParam = (sp.status ?? 'open').toString();

  const [resList, assetList] = await Promise.all([
    apiGet<ReservationListResponse>(
      `/reservations?scope=${scopeParam}&status=${encodeURIComponent(statusParam)}`,
    ),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);
  const items: ReservationView[] = resList.ok ? resList.data.items : [];
  const assets: AssetListItem[] = (assetList.ok ? assetList.data.items : []).filter(
    (a) => a.bookable,
  );

  // Batch-action metadata per basket: first-row id (where we anchor the
  // buttons), total size, how many rows are batch-eligible per verb.
  // Computed once server-side; the row renderer just reads from the Map.
  const basketMeta = new Map<
    string,
    { firstRowId: string; size: number; pending: number; cancellable: number }
  >();
  for (const r of items) {
    if (!r.basketId) continue;
    const prev = basketMeta.get(r.basketId);
    const isPending = r.approvalStatus === 'PENDING_APPROVAL' && r.lifecycleStatus !== 'CANCELLED';
    const isCancellable =
      r.lifecycleStatus !== 'CANCELLED' &&
      r.lifecycleStatus !== 'RETURNED' &&
      r.lifecycleStatus !== 'CHECKED_OUT';
    if (!prev) {
      basketMeta.set(r.basketId, {
        firstRowId: r.id,
        size: 1,
        pending: isPending ? 1 : 0,
        cancellable: isCancellable ? 1 : 0,
      });
    } else {
      prev.size += 1;
      if (isPending) prev.pending += 1;
      if (isCancellable) prev.cancellable += 1;
    }
  }

  return (
    <>
      <header className="panorama-header">
        <div>
          <strong>Panorama</strong>
          <span className="panorama-pill">
            {session.memberships.find((m) => m.tenantId === session.currentTenantId)
              ?.tenantDisplayName ?? 'Unknown tenant'}
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
          <Link href="/assets">Assets</Link>
          <span>·</span>
          <strong>Reservations</strong>
          <span>·</span>
          <Link href="/reservations/calendar">Calendar</Link>
          <span>·</span>
          <Link href="/inspections">Inspections</Link>
          <span>·</span>
          <Link href="/maintenance">Maintenance</Link>
        </nav>

        {sp.error ? (
          <div className="panorama-banner-warning">{sp.error}</div>
        ) : null}
        {sp.created ? (
          <div className="panorama-banner-success">Reservation created.</div>
        ) : null}
        {sp.cancelled ? (
          <div className="panorama-banner-success">Reservation cancelled.</div>
        ) : null}
        {sp.approved ? (
          <div className="panorama-banner-success">Reservation approved.</div>
        ) : null}
        {sp.rejected ? (
          <div className="panorama-banner-success">Reservation rejected.</div>
        ) : null}
        {sp.checkedout ? (
          <div className="panorama-banner-success">Reservation checked out.</div>
        ) : null}
        {sp.checkedin ? (
          <div className="panorama-banner-success">Reservation checked in.</div>
        ) : null}
        {sp.basket ? (
          <div className="panorama-banner-success">
            Basket created{sp.basketId ? ` (basket ${sp.basketId.slice(0, 8)}…).` : '.'}
          </div>
        ) : null}
        {sp.batch ? (
          <div
            className={
              Number(sp.processed ?? '0') === 0 &&
              Number(sp.skipped ?? '0') === 0
                ? 'panorama-banner-warning'
                : 'panorama-banner-success'
            }
          >
            {renderBatchBanner(messages.t, {
              verb: sp.batch,
              processed: Number(sp.processed ?? '0'),
              skipped: Number(sp.skipped ?? '0'),
              skippedReasons: sp.skippedReasons ?? '',
            })}
          </div>
        ) : null}

        <div className="panorama-card">
          <h2 style={{ margin: '0 0 12px' }}>New reservation</h2>
          <form action={createReservationAction} className="panorama-form-grid">
            <div className="panorama-field">
              <label htmlFor="assetId">Asset</label>
              <select id="assetId" name="assetId" required>
                <option value="">Select a bookable asset…</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.tag} — {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="panorama-field">
              <label htmlFor="startAt">Start</label>
              <input id="startAt" name="startAt" type="datetime-local" required />
            </div>
            <div className="panorama-field">
              <label htmlFor="endAt">End</label>
              <input id="endAt" name="endAt" type="datetime-local" required />
            </div>
            <div className="panorama-field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="purpose">Purpose (optional)</label>
              <input id="purpose" name="purpose" type="text" maxLength={2000} />
            </div>
            <button type="submit" className="panorama-button" style={{ gridColumn: '1 / -1' }}>
              Create reservation
            </button>
          </form>
        </div>

        <details className="panorama-card" style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 16 }}>
            New basket (multiple assets, same window)
          </summary>
          <form action={createBasketAction} className="panorama-form-grid" style={{ marginTop: 12 }}>
            <div className="panorama-field" style={{ gridColumn: '1 / -1' }}>
              <label>Assets (pick up to 20)</label>
              <div className="panorama-basket-assets">
                {assets.length === 0 ? (
                  <p className="panorama-empty" style={{ margin: 0 }}>
                    No bookable assets in this tenant.
                  </p>
                ) : (
                  assets.map((a) => (
                    <label key={a.id} className="panorama-basket-asset">
                      <input type="checkbox" name="basketAssetIds" value={a.id} />
                      <span>
                        {a.tag} <span style={{ color: 'var(--pan-muted)' }}>— {a.name}</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="panorama-field">
              <label htmlFor="basketStart">Start</label>
              <input id="basketStart" name="startAt" type="datetime-local" required />
            </div>
            <div className="panorama-field">
              <label htmlFor="basketEnd">End</label>
              <input id="basketEnd" name="endAt" type="datetime-local" required />
            </div>
            <div className="panorama-field">
              <label htmlFor="basketPurpose">Purpose (optional)</label>
              <input id="basketPurpose" name="purpose" type="text" maxLength={2000} />
            </div>
            <button type="submit" className="panorama-button" style={{ gridColumn: '1 / -1' }}>
              Create basket
            </button>
          </form>
        </details>

        <div className="panorama-card" style={{ marginTop: 16 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}
          >
            <h2 style={{ margin: 0 }}>
              Reservations <span className="panorama-pill">{items.length}</span>
            </h2>
            <nav style={{ display: 'flex', gap: 10, fontSize: 13 }}>
              <a
                href={`/reservations?scope=mine&status=${statusParam}`}
                style={{ fontWeight: scopeParam === 'mine' ? 600 : 400 }}
              >
                Mine
              </a>
              {isAdmin ? (
                <a
                  href={`/reservations?scope=tenant&status=${statusParam}`}
                  style={{ fontWeight: scopeParam === 'tenant' ? 600 : 400 }}
                >
                  Tenant
                </a>
              ) : null}
              {['open', 'pending', 'approved', 'cancelled', 'overdue', 'all'].map((s) => (
                <a
                  key={s}
                  href={`/reservations?scope=${scopeParam}&status=${s}`}
                  style={{ fontWeight: statusParam === s ? 600 : 400 }}
                >
                  {s}
                </a>
              ))}
            </nav>
          </div>

          {!resList.ok ? (
            <p className="panorama-error">Failed to load reservations (HTTP {resList.status}).</p>
          ) : items.length === 0 ? (
            <p className="panorama-empty">No reservations in this view.</p>
          ) : (
            <table className="panorama-table">
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End</th>
                  <th>Asset</th>
                  <th>Approval</th>
                  <th>Lifecycle</th>
                  <th>Purpose</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const meta = r.basketId ? basketMeta.get(r.basketId) : undefined;
                  const isBasketAnchor = meta !== undefined && meta.firstRowId === r.id;
                  return (
                  <tr key={r.id} data-basket={r.basketId ?? undefined}>
                    <td>{new Date(r.startAt).toLocaleString()}</td>
                    <td>{new Date(r.endAt).toLocaleString()}</td>
                    <td>
                      {r.assetId
                        ? assets.find((a) => a.id === r.assetId)?.tag ?? r.assetId.slice(0, 8)
                        : '—'}
                      {r.basketId ? (
                        <span
                          className="panorama-pill panorama-basket-pill"
                          title={`Part of basket ${r.basketId}`}
                        >
                          basket {r.basketId.slice(0, 6)}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {humaniseApproval(messages.t, r.approvalStatus)}
                      {/* OPS-01 (#33): surface the approver's note so the
                          requester sees *why* a reservation was rejected (or
                          approved with caveats) without having to walk to
                          dispatch. Amber callout — matches the reject-panel
                          warning style — so a 5am driver in sun glare on a
                          phone can't miss it. */}
                      {r.approvalNote &&
                      (r.approvalStatus === 'REJECTED' || r.approvalStatus === 'APPROVED') ? (
                        <div
                          title={r.approvalNote}
                          style={{
                            marginTop: 4,
                            padding: '6px 8px',
                            fontSize: 13,
                            lineHeight: 1.4,
                            color: '#7a3a00',
                            background: '#fff4e0',
                            border: '1px solid #f0c890',
                            borderRadius: 4,
                            whiteSpace: 'normal',
                            maxWidth: 320,
                          }}
                        >
                          <strong style={{ display: 'block', marginBottom: 2 }}>
                            {messages.t('reservation.approvalNote.label')}
                          </strong>
                          {r.approvalNote}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {humaniseLifecycle(messages.t, r.lifecycleStatus)}
                      {/* #77 PILOT-04 — overdue pill is the visual signal
                          ops needs to chase a forgotten check-in. Renders
                          on (a) currently-actionable overdue returns
                          (CHECKED_OUT past endAt with isOverdue=true) AND
                          (b) no-show transitions (lifecycleStatus=MISSED
                          — auto-flipped by ReservationSweepService.runNoShowSweep).
                          Distinct red palette so it doesn't visually merge
                          with the amber damage / approval-note callouts
                          below. */}
                      {(r.isOverdue && r.lifecycleStatus === 'CHECKED_OUT') ||
                      r.lifecycleStatus === 'MISSED' ? (
                        <span
                          className="panorama-pill"
                          style={{
                            marginLeft: 6,
                            background: '#fde2e0',
                            border: '1px solid #e07064',
                            color: '#8c2114',
                            fontWeight: 600,
                          }}
                          title={
                            r.lifecycleStatus === 'MISSED'
                              ? messages.t('reservation.overdue.no_show_title')
                              : messages.t('reservation.overdue.checked_out_title')
                          }
                        >
                          {r.lifecycleStatus === 'MISSED'
                            ? messages.t('reservation.overdue.no_show_pill')
                            : messages.t('reservation.overdue.checked_out_pill')}
                        </span>
                      ) : null}
                      {/* Damage callout — when the driver flagged damage at
                          check-in, surface the note + a quick path to open a
                          maintenance ticket pre-filled from this reservation
                          (#74 PILOT-03 web slice). */}
                      {r.damageFlag && r.assetId ? (
                        <div
                          style={{
                            marginTop: 4,
                            padding: '6px 8px',
                            fontSize: 13,
                            lineHeight: 1.4,
                            color: '#7a3a00',
                            background: '#fff4e0',
                            border: '1px solid #f0c890',
                            borderRadius: 4,
                            whiteSpace: 'normal',
                            maxWidth: 320,
                          }}
                        >
                          <strong style={{ display: 'block', marginBottom: 2 }}>
                            {messages.t('reservation.damage.flagged')}
                          </strong>
                          {r.damageNote ?? '—'}
                          {isAdmin ? (
                            <div style={{ marginTop: 4 }}>
                              <Link
                                href={`/maintenance?assetId=${r.assetId}`}
                                className="panorama-link"
                                style={{ fontSize: 12 }}
                              >
                                {messages.t('reservation.action.open_maintenance_for_damage')}
                                {' →'}
                              </Link>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td>{r.purpose ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {isBasketAnchor && meta ? (
                        <div style={{ marginBottom: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {isAdmin && meta.pending > 0 ? (
                            <>
                              <details style={{ display: 'inline-block' }}>
                                <summary
                                  className="panorama-button"
                                  style={{ cursor: 'pointer' }}
                                  title={`Approve all ${meta.pending} pending reservations in this basket`}
                                >
                                  Approve {meta.pending} pending
                                </summary>
                                <form
                                  action={approveBasketAction}
                                  className="panorama-inline-form"
                                >
                                  <input type="hidden" name="basketId" value={r.basketId!} />
                                  <input
                                    type="text"
                                    name="note"
                                    placeholder="Note (optional, attached to each row)"
                                    maxLength={500}
                                  />
                                  <button type="submit" className="panorama-button">
                                    Approve basket
                                  </button>
                                </form>
                              </details>
                              <details style={{ display: 'inline-block' }}>
                                <summary
                                  className="panorama-button secondary"
                                  style={{ cursor: 'pointer' }}
                                  title={`Reject all ${meta.pending} pending reservations in this basket`}
                                >
                                  Reject {meta.pending} pending
                                </summary>
                                <form
                                  action={rejectBasketAction}
                                  className="panorama-inline-form"
                                >
                                  <input type="hidden" name="basketId" value={r.basketId!} />
                                  <p style={{ margin: '0 0 6px', fontSize: 12, color: '#a14d00' }}>
                                    {messages.t('reservation.action.reject.note_label')}
                                  </p>
                                  <textarea
                                    name="note"
                                    required
                                    minLength={1}
                                    maxLength={500}
                                    rows={2}
                                    placeholder={messages.t(
                                      'reservation.action.reject.note_placeholder',
                                    )}
                                  />
                                  <button type="submit" className="panorama-button secondary">
                                    Reject basket
                                  </button>
                                </form>
                              </details>
                            </>
                          ) : null}
                          {meta.cancellable > 0 ? (
                            <details style={{ display: 'inline-block' }}>
                              <summary
                                className="panorama-button secondary"
                                style={{ cursor: 'pointer' }}
                                title={`Cancel ${meta.cancellable} of ${meta.size} reservations in this basket (terminal rows like checked-out are skipped)`}
                              >
                                Cancel {meta.cancellable} of {meta.size}
                              </summary>
                              <form
                                action={cancelBasketAction}
                                className="panorama-inline-form"
                              >
                                <input type="hidden" name="basketId" value={r.basketId!} />
                                <input
                                  type="text"
                                  name="reason"
                                  placeholder="Reason (optional, attached to each row)"
                                  maxLength={500}
                                />
                                <button type="submit" className="panorama-button secondary">
                                  Cancel basket
                                </button>
                              </form>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                      {canCancel(r, isAdmin) ? (
                        <form action={cancelReservationAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="panorama-button secondary">
                            Cancel
                          </button>
                        </form>
                      ) : null}
                      {isAdmin && r.approvalStatus === 'PENDING_APPROVAL' ? (
                        <>
                          {/* OPS-01 (#33): both approve and reject open a
                              confirm panel so a single misclick on a busy
                              Monday morning queue can't push the action
                              through. Reject also forces a non-empty note
                              (server enforces this too). */}
                          <details style={{ display: 'inline-block', marginLeft: 6 }}>
                            <summary className="panorama-button" style={{ cursor: 'pointer' }}>
                              {messages.t('actions.approve')}
                            </summary>
                            <form
                              action={approveReservationAction}
                              className="panorama-inline-form"
                            >
                              <input type="hidden" name="id" value={r.id} />
                              <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                                {messages.t('reservation.action.approve.confirm_title')}
                              </p>
                              <input
                                type="text"
                                name="note"
                                maxLength={500}
                                placeholder={messages.t(
                                  'reservation.action.approve.note_placeholder',
                                )}
                              />
                              {/* Required checkbox is the forcing function:
                                  the disclosure-triangle pattern alone lets
                                  a hurried admin click-click through (open
                                  panel, click confirm). The checkbox breaks
                                  muscle memory — same forcing function the
                                  rejection textarea provides on the other
                                  side. */}
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
                                {messages.t('reservation.action.approve.confirm_checkbox')}
                              </label>
                              <button type="submit" className="panorama-button">
                                {messages.t('reservation.action.approve.confirm_button')}
                              </button>
                            </form>
                          </details>
                          <details style={{ display: 'inline-block', marginLeft: 6 }}>
                            <summary
                              className="panorama-button secondary"
                              style={{ cursor: 'pointer' }}
                            >
                              {messages.t('actions.reject')}
                            </summary>
                            <form
                              action={rejectReservationAction}
                              className="panorama-inline-form"
                            >
                              <input type="hidden" name="id" value={r.id} />
                              <p style={{ margin: '0 0 6px', fontSize: 13 }}>
                                {messages.t('reservation.action.reject.confirm_title')}
                              </p>
                              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#a14d00' }}>
                                {messages.t('reservation.action.reject.note_label')}
                              </p>
                              <textarea
                                name="note"
                                required
                                minLength={1}
                                maxLength={500}
                                rows={2}
                                placeholder={messages.t(
                                  'reservation.action.reject.note_placeholder',
                                )}
                              />
                              <button type="submit" className="panorama-button secondary">
                                {messages.t('reservation.action.reject.confirm_button')}
                              </button>
                            </form>
                          </details>
                        </>
                      ) : null}
                      {canCheckout(r) && r.assetId ? (
                        <a
                          href={`/inspections/new?asset=${r.assetId}&reservation=${r.id}`}
                          className="panorama-button secondary"
                          style={{ marginLeft: 6, textDecoration: 'none' }}
                          title={messages.t('inspection.tether.required')}
                        >
                          {messages.t('inspection.tether.start_pre_trip')}
                        </a>
                      ) : null}
                      {canCheckout(r) ? (
                        <details style={{ display: 'inline-block', marginLeft: 6 }}>
                          <summary className="panorama-button" style={{ cursor: 'pointer' }}>
                            Check out
                          </summary>
                          <form action={checkoutReservationAction} className="panorama-inline-form">
                            <input type="hidden" name="id" value={r.id} />
                            <input
                              type="number"
                              name="mileage"
                              placeholder="Mileage out"
                              min={0}
                              required
                              aria-required="true"
                            />
                            <input type="text" name="condition" placeholder="Condition" maxLength={200} />
                            <button type="submit" className="panorama-button">
                              Confirm
                            </button>
                          </form>
                        </details>
                      ) : null}
                      {canCheckin(r) ? (
                        <details style={{ display: 'inline-block', marginLeft: 6 }}>
                          <summary className="panorama-button" style={{ cursor: 'pointer' }}>
                            Check in
                          </summary>
                          <form action={checkinReservationAction} className="panorama-inline-form">
                            <input type="hidden" name="id" value={r.id} />
                            <input
                              type="number"
                              name="mileage"
                              placeholder="Mileage in"
                              min={r.mileageOut ?? 0}
                              required
                              aria-required="true"
                            />
                            <input type="text" name="condition" placeholder="Condition" maxLength={200} />
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <input type="checkbox" name="damageFlag" /> Damage?
                            </label>
                            <input type="text" name="damageNote" placeholder="Damage note (if any)" maxLength={500} />
                            <button type="submit" className="panorama-button">
                              Confirm
                            </button>
                          </form>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function canCancel(r: ReservationView, isAdmin: boolean): boolean {
  if (r.lifecycleStatus === 'CANCELLED' || r.lifecycleStatus === 'RETURNED') return false;
  if (r.lifecycleStatus === 'CHECKED_OUT') return false;
  // The server re-enforces requester + admin; render the button whenever
  // the row is in a cancellable state and let the server reject if the
  // user isn't entitled.
  return true;
  // (isAdmin kept in signature for future row-scoped logic.)
  void isAdmin;
}

function canCheckout(r: ReservationView): boolean {
  if (r.lifecycleStatus !== 'BOOKED') return false;
  return r.approvalStatus === 'APPROVED' || r.approvalStatus === 'AUTO_APPROVED';
}

function canCheckin(r: ReservationView): boolean {
  return r.lifecycleStatus === 'CHECKED_OUT';
}

// User-facing reservation state strings live in packages/i18n.
// Helpers translate machine enum values (PENDING_APPROVAL, BOOKED, …)
// into ops-lingo via the loader's t() — locale picked from the
// current tenant's preference per ADR-0003 §Locale routing.

function humaniseApproval(t: (k: string) => string, status: string): string {
  return t(`reservation.approval.${status}`);
}
function humaniseLifecycle(t: (k: string) => string, status: string): string {
  return t(`reservation.lifecycle.${status}`);
}

// Batch skip reasons from the service (see
// ReservationService.runBasketBatch). Values with a colon (e.g.
// "not_pending:auto_approved") get mapped to underscore-joined keys
// so JSON bundles don't have to escape ":"; unrecognised reasons
// fall back to the raw string — better than silently hiding.
function humaniseBatchReason(t: (k: string) => string, raw: string): string {
  const key = `reservation.batch.skip.${raw.replace(/:/g, '_')}`;
  const translated = t(key);
  // loadMessages returns the raw key when no translation exists; use
  // that as the cue to fall through to a dynamic fallback.
  if (translated !== key) return translated;
  if (raw.startsWith('blackout_conflict')) return t('reservation.batch.skip.blackout_conflict');
  if (raw.startsWith('not_pending:')) return `already ${raw.slice('not_pending:'.length)}`;
  return raw;
}

function renderBatchBanner(
  t: (key: string) => string,
  opts: {
    verb: string;
    processed: number;
    skipped: number;
    skippedReasons: string;
  },
): ReactNode {
  const { verb, processed, skipped, skippedReasons } = opts;
  const verbPast =
    verb === 'cancel' ? 'cancelled' : verb === 'approve' ? 'approved' : 'rejected';
  if (processed === 0 && skipped === 0) {
    return <>Basket {verb}: nothing to apply — the basket was empty or all rows were terminal.</>;
  }
  const reasons = skippedReasons
    .split('|')
    .filter((s) => s.length > 0)
    .map((pair) => {
      const idx = pair.lastIndexOf(':');
      if (idx < 0) return { reason: pair, count: 1 };
      const reason = pair.slice(0, idx);
      const count = Number(pair.slice(idx + 1));
      return { reason, count: Number.isFinite(count) ? count : 1 };
    });
  return (
    <>
      Basket {verb}: <strong>{processed}</strong> {verbPast}
      {skipped > 0 ? (
        <>
          , <strong>{skipped}</strong> skipped
          {reasons.length > 0 ? (
            <>
              {' '}(
              {reasons.map((r, i) => (
                <span key={r.reason}>
                  {i > 0 ? '; ' : ''}
                  {r.count} {humaniseBatchReason(t, r.reason)}
                </span>
              ))}
              )
            </>
          ) : null}
        </>
      ) : null}
      .
    </>
  );
}
