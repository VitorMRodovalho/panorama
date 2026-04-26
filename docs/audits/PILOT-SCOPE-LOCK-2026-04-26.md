# Pilot scope lock — 2026-04-26

Maintainer commitment to the won't-ship-for-pilot list documented in
`docs/audits/2026-04-23-wave-3.md` §"Explicit won't-ship-for-pilot"
(line 93 of that file). Closes the §"Decisions needing maintainer
input" item 3 from `HANDOFF-2026-04-23.md`.

## Won't ship for pilot — committed

Per Wave 3a Pilot readiness review:

- CSV export
- Stranded reservation flow
- Auto-suggest maintenance from FAIL / damage flag (the Bucket B
  manual maintenance UI ships; the auto-suggest path is 0.4)
- Mileage / time-based PM alerts (cron + UI)
- Training-expiry gating
- Reservation notification emails (basic invitation email ships;
  reservation lifecycle emails are 0.4)
- Email-bounce webhook
- JIT tenant membership (admin-via-UI invitation is the path)
- Snipe-IT compat shim (PAT auth ships; shim adapter layer is 0.4)
- Mobile-responsive tables (tablet/desktop during pilot is the
  contract; mobile polish is 0.4)
- Saved reports / dashboards
- Plugin SDK (per ADR-0006 strip-back path #84 — Community SDK is
  type re-exports only at 0.3; runtime + sandboxing is 0.4+)
- SAML / LDAP / SCIM (OIDC + invitation-link is the pilot path)

## Why this matters

The 2026-09 pilot timeline (per HANDOFF-2026-04-23 §Sprint Split
Scenario A — solo maintainer) holds **only if and only if scope is
held to this MVP cut**. Any feature creep ("while we're at it") will
push the pilot to Q4 2026 or later.

Maintainer (Vitor Rodovalho, 2026-04-26): committed.

## When this list changes

Re-open via a wave-N audit doc when an explicit pilot-tenant
requirement surfaces from a real user voice (Amtrak/FDT operator,
SnipeScheduler-FleetManager community member, etc.). Don't extend
this list because a contributor proposes a "small while-we're-here
addition" — those go to 0.4+ by default.
