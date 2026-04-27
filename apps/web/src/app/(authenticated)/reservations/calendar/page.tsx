import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { loadMessages, type SupportedLocale } from '@/lib/i18n';
import { getCurrentSession } from '@/lib/session';

interface ReservationView {
  id: string;
  assetId: string | null;
  startAt: string;
  endAt: string;
  approvalStatus: string;
  lifecycleStatus: string;
}
interface ReservationListResponse {
  items: ReservationView[];
}
interface BlackoutView {
  id: string;
  assetId: string | null;
  title: string;
  startAt: string;
  endAt: string;
}
interface BlackoutListResponse {
  items: BlackoutView[];
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
}

interface CalendarPageProps {
  searchParams: Promise<{ scope?: string; days?: string }>;
}

const ADMIN_ROLES = new Set(['owner', 'fleet_admin']);
const DEFAULT_DAYS = 14;
const MIN_DAYS = 7;
const MAX_DAYS = 60;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Server-rendered 14-day timeline. Each asset is a row; time runs
 * left → right. Reservations render as colored blocks; blackouts get
 * their own amber color. Zero client JS — entirely SSR CSS-grid +
 * absolute-positioned blocks on top of a day grid.
 *
 * Non-admins see only their own reservations + blackouts (privacy:
 * don't leak other users' bookings via cross-tenant calendar). Admins
 * toggle to scope=tenant to see every reservation in the window.
 */
export default async function ReservationCalendarPage({
  searchParams,
}: CalendarPageProps): Promise<ReactNode> {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const isAdmin = ADMIN_ROLES.has(session.currentRole);
  const tenantLocale =
    session.memberships.find((m) => m.tenantId === session.currentTenantId)?.tenantLocale ??
    'en';
  const messages = loadMessages(tenantLocale);
  const localeForDates = messages.locale;

  const requestedScope = sp.scope === 'tenant' && isAdmin ? 'tenant' : 'mine';
  const days = clampDays(Number(sp.days ?? DEFAULT_DAYS));
  const startOfToday = atStartOfDay(new Date());
  const windowStart = startOfToday;
  const windowEnd = new Date(startOfToday.getTime() + days * DAY_MS);
  const fromIso = windowStart.toISOString();
  const toIso = windowEnd.toISOString();

  const [reservationsRes, blackoutsRes, assetsRes] = await Promise.all([
    apiGet<ReservationListResponse>(
      `/reservations?scope=${requestedScope}&status=all&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=200`,
    ),
    apiGet<BlackoutListResponse>(
      `/blackouts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=200`,
    ),
    apiGet<AssetsResponse>('/assets?limit=200'),
  ]);

  const reservations = reservationsRes.ok ? reservationsRes.data.items : [];
  const blackouts = blackoutsRes.ok ? blackoutsRes.data.items : [];
  const assets = (assetsRes.ok ? assetsRes.data.items : []).filter((a) => a.bookable);

  const bookedAssetIds = new Set<string>();
  for (const r of reservations) if (r.assetId) bookedAssetIds.add(r.assetId);
  for (const b of blackouts) if (b.assetId) bookedAssetIds.add(b.assetId);

  // Show only assets with activity + any that the admin explicitly sees.
  // For an empty tenant, still show the bookable roster so the admin can
  // sanity-check "nothing's booked next fortnight".
  const assetsToShow = assets;

  const globalBlackouts = blackouts.filter((b) => b.assetId === null);

  return (
    <>

      <div className="panorama-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <h2 style={{ margin: 0 }}>
            {messages.t('calendar.title', { days })}{' '}
            <span className="panorama-pill">
              {messages.t('calendar.asset_count', { count: assetsToShow.length })}
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* #76 PILOT-05: deep-link from calendar to the blackout admin
                page so coordinators don't have to know the URL. Admin-only;
                the page itself re-checks the role + redirects. */}
            {isAdmin ? (
              <Link href="/admin/blackouts" className="panorama-button secondary">
                {messages.t('calendar.add_blackout')}
              </Link>
            ) : null}
          <nav style={{ display: 'flex', gap: 10, fontSize: 13 }}>
            <a
              href={`/reservations/calendar?scope=mine&days=${days}`}
              style={{ fontWeight: requestedScope === 'mine' ? 600 : 400 }}
            >
              {messages.t('calendar.scope.mine')}
            </a>
            {isAdmin ? (
              <a
                href={`/reservations/calendar?scope=tenant&days=${days}`}
                style={{ fontWeight: requestedScope === 'tenant' ? 600 : 400 }}
              >
                {messages.t('calendar.scope.tenant')}
              </a>
            ) : null}
            <span>·</span>
            {[7, 14, 30].map((d) => (
              <a
                key={d}
                href={`/reservations/calendar?scope=${requestedScope}&days=${d}`}
                style={{ fontWeight: days === d ? 600 : 400 }}
              >
                {messages.t('calendar.days_label', { days: d })}
              </a>
            ))}
          </nav>
          </div>
        </div>

        <CalendarLegend t={messages.t} />

        <div className="panorama-calendar">
          <div className="panorama-calendar-header">
            <div className="panorama-calendar-assetcol">
              {messages.t('calendar.column.asset')}
            </div>
            <div className="panorama-calendar-days">
              {Array.from({ length: days }).map((_, i) => {
                const day = new Date(windowStart.getTime() + i * DAY_MS);
                return (
                  <div key={i} className="panorama-calendar-daylabel">
                    {day.toLocaleDateString(localeForDates, { month: 'short', day: 'numeric' })}
                  </div>
                );
              })}
            </div>
          </div>

          {assetsToShow.length === 0 ? (
            <p className="panorama-empty" style={{ margin: '16px 0' }}>
              {messages.t('calendar.empty')}
            </p>
          ) : (
            assetsToShow.map((asset) => (
              <div key={asset.id} className="panorama-calendar-row">
                <div className="panorama-calendar-assetcol" title={asset.name}>
                  <strong>{asset.tag}</strong>
                  <span style={{ color: 'var(--pan-muted)', fontSize: 12 }}>
                    {' '}
                    {asset.name}
                  </span>
                </div>
                <div className="panorama-calendar-track">
                  {globalBlackouts.map((b) => (
                    <Block
                      key={`g-${b.id}`}
                      kind="blackout-global"
                      label={b.title}
                      startMs={Date.parse(b.startAt)}
                      endMs={Date.parse(b.endAt)}
                      windowStartMs={windowStart.getTime()}
                      windowEndMs={windowEnd.getTime()}
                    />
                  ))}
                  {blackouts
                    .filter((b) => b.assetId === asset.id)
                    .map((b) => (
                      <Block
                        key={`b-${b.id}`}
                        kind="blackout"
                        label={b.title}
                        startMs={Date.parse(b.startAt)}
                        endMs={Date.parse(b.endAt)}
                        windowStartMs={windowStart.getTime()}
                        windowEndMs={windowEnd.getTime()}
                      />
                    ))}
                  {reservations
                    .filter((r) => r.assetId === asset.id)
                    .map((r) => (
                      <Block
                        key={`r-${r.id}`}
                        kind={reservationKind(r)}
                        label={labelForReservation(r, localeForDates)}
                        startMs={Date.parse(r.startAt)}
                        endMs={Date.parse(r.endAt)}
                        windowStartMs={windowStart.getTime()}
                        windowEndMs={windowEnd.getTime()}
                      />
                    ))}
                </div>
              </div>
            ))
          )}
        </div>

        {!reservationsRes.ok ? (
          <p className="panorama-error">
            {messages.t('calendar.error.load_failed', { status: reservationsRes.status })}
          </p>
        ) : null}
      </div>
    </>
  );
}

function CalendarLegend({ t }: { t: (k: string) => string }): ReactNode {
  return (
    <div className="panorama-calendar-legend">
      <Swatch kind="pending" label={t('calendar.legend.pending')} />
      <Swatch kind="approved" label={t('calendar.legend.approved')} />
      <Swatch kind="checkedout" label={t('calendar.legend.checkedout')} />
      <Swatch kind="returned" label={t('calendar.legend.returned')} />
      <Swatch kind="blackout" label={t('calendar.legend.blackout')} />
    </div>
  );
}

function Swatch({ kind, label }: { kind: string; label: string }): ReactNode {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
      <span className={`panorama-swatch panorama-block--${kind}`} />
      <span style={{ fontSize: 12 }}>{label}</span>
    </span>
  );
}

function Block({
  kind,
  label,
  startMs,
  endMs,
  windowStartMs,
  windowEndMs,
}: {
  kind: string;
  label: string;
  startMs: number;
  endMs: number;
  windowStartMs: number;
  windowEndMs: number;
}): ReactNode {
  const clampedStart = Math.max(startMs, windowStartMs);
  const clampedEnd = Math.min(endMs, windowEndMs);
  if (clampedEnd <= clampedStart) return null;
  const windowWidthMs = windowEndMs - windowStartMs;
  const leftPct = ((clampedStart - windowStartMs) / windowWidthMs) * 100;
  const widthPct = ((clampedEnd - clampedStart) / windowWidthMs) * 100;
  return (
    <div
      className={`panorama-block panorama-block--${kind}`}
      style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.5)}%` }}
      title={label}
    >
      {label}
    </div>
  );
}

function reservationKind(r: ReservationView): string {
  if (r.lifecycleStatus === 'CANCELLED') return 'cancelled';
  if (r.lifecycleStatus === 'RETURNED') return 'returned';
  if (r.lifecycleStatus === 'CHECKED_OUT') return 'checkedout';
  if (r.approvalStatus === 'PENDING_APPROVAL') return 'pending';
  if (r.approvalStatus === 'REJECTED') return 'rejected';
  return 'approved';
}

function labelForReservation(r: ReservationView, locale: SupportedLocale): string {
  const fmt = (d: string): string =>
    new Date(d).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: 'numeric' });
  return `${fmt(r.startAt)}–${fmt(r.endAt)}`;
}

function atStartOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.trunc(n)));
}
