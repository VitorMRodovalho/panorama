import { redirect } from 'next/navigation';
import { apiGet } from '../../lib/api';
import { getCurrentSession } from '../../lib/session';
import { logoutAction, switchTenantAction } from '../login/actions';
import {
  approveReservationAction,
  cancelReservationAction,
  checkinReservationAction,
  checkoutReservationAction,
  createReservationAction,
  rejectReservationAction,
} from './actions';

interface ReservationView {
  id: string;
  assetId: string | null;
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
  searchParams: {
    scope?: string;
    status?: string;
    error?: string;
    created?: string;
    cancelled?: string;
    approved?: string;
    rejected?: string;
    checkedout?: string;
    checkedin?: string;
  };
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);

export default async function ReservationsPage({
  searchParams,
}: ReservationsPageProps): Promise<JSX.Element> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const isAdmin = ADMIN_ROLES.has(session.currentRole);

  const scopeParam = searchParams.scope === 'tenant' && isAdmin ? 'tenant' : 'mine';
  const statusParam = (searchParams.status ?? 'open').toString();

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
          <a href="/assets">Assets</a>
          <span>·</span>
          <strong>Reservations</strong>
          <span>·</span>
          <a href="/reservations/calendar">Calendar</a>
        </nav>

        {searchParams.error ? (
          <div className="panorama-banner-warning">{searchParams.error}</div>
        ) : null}
        {searchParams.created ? (
          <div className="panorama-banner-success">Reservation created.</div>
        ) : null}
        {searchParams.cancelled ? (
          <div className="panorama-banner-success">Reservation cancelled.</div>
        ) : null}
        {searchParams.approved ? (
          <div className="panorama-banner-success">Reservation approved.</div>
        ) : null}
        {searchParams.rejected ? (
          <div className="panorama-banner-success">Reservation rejected.</div>
        ) : null}
        {searchParams.checkedout ? (
          <div className="panorama-banner-success">Reservation checked out.</div>
        ) : null}
        {searchParams.checkedin ? (
          <div className="panorama-banner-success">Reservation checked in.</div>
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
              {['open', 'pending', 'approved', 'cancelled', 'all'].map((s) => (
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
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.startAt).toLocaleString()}</td>
                    <td>{new Date(r.endAt).toLocaleString()}</td>
                    <td>{r.assetId ? assets.find((a) => a.id === r.assetId)?.tag ?? r.assetId.slice(0, 8) : '—'}</td>
                    <td>{r.approvalStatus}</td>
                    <td>{r.lifecycleStatus}</td>
                    <td>{r.purpose ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
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
                          <form action={approveReservationAction} style={{ display: 'inline', marginLeft: 6 }}>
                            <input type="hidden" name="id" value={r.id} />
                            <button type="submit" className="panorama-button">
                              Approve
                            </button>
                          </form>
                          <form action={rejectReservationAction} style={{ display: 'inline', marginLeft: 6 }}>
                            <input type="hidden" name="id" value={r.id} />
                            <button type="submit" className="panorama-button secondary">
                              Reject
                            </button>
                          </form>
                        </>
                      ) : null}
                      {canCheckout(r) ? (
                        <details style={{ display: 'inline-block', marginLeft: 6 }}>
                          <summary className="panorama-button" style={{ cursor: 'pointer' }}>
                            Check out
                          </summary>
                          <form action={checkoutReservationAction} className="panorama-inline-form">
                            <input type="hidden" name="id" value={r.id} />
                            <input type="number" name="mileage" placeholder="Mileage out" min={0} />
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
                ))}
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
