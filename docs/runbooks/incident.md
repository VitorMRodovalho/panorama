# Incident response runbook

> **Status — working document.** Round 6 PR1 of the Wave 0 plan. The
> LGPD timing references on this page reflect the maintainer's
> reading of Art. 48 LGPD + **Resolução CD/ANPD nº 15, de 24 de
> abril de 2024** current as of 2026-05-17; the exact regulatory
> clock for a given incident class must be confirmed with legal
> counsel before the hosted URL flip (Round 7 §9 — Privacy / ToS /
> status page). Procedure shape and internal-comms surface are not
> gated on that confirmation and are usable today.

This page tells the maintainer (and any future on-call) what to do
when a security or availability incident hits Panorama. It is the
companion to:

- [`verify-audit-chain.md`](./verify-audit-chain.md) — the post-
  incident integrity check for the audit log.
- [`secrets-rotation.md`](./secrets-rotation.md) — the rotation
  primitives invoked during the *Contain* phase.
- [`secrets-inventory.md`](./secrets-inventory.md) — what's in scope
  for rotation.
- [`dev-environment-ai-tooling.md`](./dev-environment-ai-tooling.md)
  §"Incident response" — the contributor-side reporting flow for
  developer-workstation incidents (the 2026-04-20 MCP CVE family
  template).
- [SECURITY.md](../../SECURITY.md) — the public reporting policy.

## What counts as an incident

An incident is any event that:

- Compromises (or is suspected to compromise) the confidentiality,
  integrity, or availability of tenant data
- Breaches the multi-tenant isolation contract (a query returns a
  row from another tenant; an audit-chain verifier reports a hash
  mismatch)
- Exposes a secret listed in [`secrets-inventory.md`](./secrets-inventory.md)
- Renders the production API unavailable for more than 15
  consecutive minutes
- Triggers a vulnerability report that the maintainer accepts as
  in-scope per [SECURITY.md](../../SECURITY.md) §"Out of scope"

Out of scope (handled elsewhere, not via this runbook):

- A self-hoster's deployment breaking — they own ops on AGPL.
- A third-party platform outage (Cloudflare, Supabase, Fly, AWS
  region) without confirmed Panorama-data impact — track the
  provider's status page; escalate only if data loss is suspected.
- A driver/operator entering wrong asset data — that's a UX bug,
  not an incident.

## Severity taxonomy

The severity label drives downstream timing: ANPD notification,
tenant notification, post-mortem publication.

| Severity | Trigger | Response time | Examples |
|---|---|---|---|
| **P0 — Critical** | Confirmed tenant-data exposure OR cross-tenant data leak OR audit-chain tamper | Page maintainer immediately; LGPD 72h clock starts on confirmation | Audit-chain verifier reports a hash mismatch + the affected rows include another tenant's PII |
| **P1 — High** | Suspected (not confirmed) data exposure OR production API down >15 minutes OR confirmed-exposure CVE in a dependency whose call surface Panorama uses, patch not yet shipped | Acknowledge within 1 hour; investigation begins same day | A WAF log shows a successful SQL-injection probe pattern, root cause unknown; OR an upstream library publishes a CVE with confirmed exploit affecting code Panorama calls |
| **P2 — Medium** | Security-relevant finding without an active exposure path Panorama uses | Acknowledge within 1 business day | A dependency CVE in a code path Panorama does not exercise; pre-disclosure window |
| **Informational** | Reportable findings that do not affect production | Track in audit-2026-mm-dd issue list | A self-hoster files a hardening suggestion |

When in doubt: classify ONE level higher than your gut. Down-grading
later is cheap; up-grading after the legal-notification clock has
already started is not.

## The 5-phase procedure

### Phase 1 — Detect

A signal arrives:

- The maintainer notices the audit-chain verifier failed in CI
- An automated alert (post-Round 6 — once status page lands)
- A tenant reports unexpected data in their UI
- A security researcher emails `vitor@vitormr.dev`
- The Sentry account flags an unhandled error spike (per
  [ADR-0018](../adr/0018-observability-stack.md))

**Action:** record the timestamp of the signal. This is **T=0** for
all downstream clocks — signal-receipt, NOT incident-occurrence.
The LGPD `tomada de conhecimento` framing supports this; document
the gap between occurrence and detection in the post-mortem
timeline so the regulatory clock and the forensic timeline don't
get conflated. Open a private GitHub Security Advisory draft at
<https://github.com/VitorMRodovalho/panorama/security/advisories/new>
even before you know the scope — the draft is invisible to the
public until you publish, and it makes the audit trail traceable.

### Phase 2 — Triage

Within the response time for the severity, answer:

- **What happened?** One sentence. ("Audit-chain verifier reported
  `selfHash mismatch on event evt-X`.")
- **What's affected?** Tenants, users, secrets, code paths.
- **Is it ongoing?** A static exposure (one-time leak) vs an
  active attack vector (the SQL injection probe still works).
- **What's the severity?** P0/P1/P2 per the table above.

If you cannot answer "is it ongoing" within the response-time
window, default to **YES** and proceed to *Contain*.

### Phase 3 — Contain

The goal: stop the bleeding. Order of operations is severity-
dependent.

For **secret exposure** (any row in `secrets-inventory.md`
suspected to have leaked):

- `SESSION_SECRET` — use the **emergency path** (Path A) in
  [`secrets-rotation.md`](./secrets-rotation.md). Do **NOT** use
  the routine flip-then-drop; that keeps the leaked value valid
  for `SESSION_MAX_AGE_SECONDS`.
- `OIDC_GOOGLE_CLIENT_SECRET` / `OIDC_MICROSOFT_CLIENT_SECRET` —
  rotate at the IdP first (Google Cloud Console / Microsoft Entra
  admin), update the env, redeploy. **All in-flight OIDC dances
  fail** during the window; users with active sessions stay
  logged in until session expiry. New logins succeed on the new
  secret. Inform the affected tenant before rotating.
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (or `R2_*`
  equivalent) — rotate at the provider (Cloudflare R2 / AWS IAM /
  Backblaze), update the env, redeploy. **Existing pre-signed
  URLs minted before the rotation continue to work** (signature
  is bound to the old key for the URL's TTL — typically 60s for
  download URLs per `tenant-export.service.ts`), so a leak of the
  S3 keys does NOT require invalidating in-flight downloads.
  Photo-upload signed URLs use the same model. Browser-side
  cached presigned URLs in driver phones (photo upload tokens)
  expire on their own short TTL.
- `SENTRY_DSN` — regenerate at sentry.io for the operator's
  project, update env, redeploy. Events from a leaked DSN sent
  by an attacker would land in the operator's quota (DoS via
  fake events) — not a confidentiality concern. Lower urgency.
- `TURNSTILE_SECRET` (Cloudflare Turnstile, ADR-0020 self-serve
  signup) — rotate at Cloudflare, update env, redeploy. Existing
  signup flows in-flight fail their CAPTCHA verification and the
  user re-tries. Acceptable for the signup surface.
- `SMTP_*` — rotate at the provider (Mailgun / SendGrid / SES /
  Postmark), update env, redeploy. In-flight email sends fail
  and the BullMQ retry queue picks them up under the new creds.
- **Anything else listed in
  [`secrets-inventory.md`](./secrets-inventory.md)** — rotate at
  the provider per its own platform procedure; redeploy
  Panorama with the new value. The full per-secret matrix with
  blast-radius + verification steps lands in Round 6 PR3
  (expansion of `secrets-rotation.md`).

For **cross-tenant data leak** (RLS bypass, query that returned
another tenant's rows):

- If the leak is in an opt-in feature surface, disable the
  endpoint via the relevant flag (`FEATURE_INSPECTIONS`,
  `FEATURE_MAINTENANCE`, `FEATURE_SELF_SERVE_SIGNUP`).
- If the leak is in the **always-on community surface**
  (reservations, assets, audit log, CSV export) — none of which
  is gated by a feature flag — there is no scalpel-level cut.
  Take the whole API down:
  - **Hosted (Fly):** `fly scale count 0 --app panorama`
  - **Self-host (docker compose):** `docker compose -f
    infra/docker/compose.prod.yml stop core-api`
  - **k8s / Coolify / other:** drop replicas to zero via your
    platform's controls
  A status-page-driven `MAINTENANCE_MODE=true` env that returns
  503 from middleware (without taking the container down) is a
  Round 7 follow-up; until it lands, scale-to-zero is the only
  honest cut.
- Run [`verify-audit-chain.md`](./verify-audit-chain.md) against
  the affected tenants to bound the time window of the exposure.
- **Do NOT** set `WEB_ORIGIN=""` thinking it forces fail-closed.
  The CSRF allowlist is always seeded with the configured
  `APP_BASE_URL` before `WEB_ORIGIN` is parsed
  (`apps/core-api/src/modules/auth/auth.config.ts`); emptying
  `WEB_ORIGIN` strips split-origin entries only. Same-origin
  browser POSTs still pass. Even if CSRF *did* fail closed, that
  only blocks writes — not the leaky read path.

For **production API down**:

- The hosted instance runs on Fly. `fly status --app panorama` +
  `fly logs --app panorama` are the first commands.
- The same scripts work on self-host deployments running docker
  compose — substitute `docker compose ps` / `docker compose logs
  core-api`.

For **developer workstation compromise** (MCP CVE family / supply
chain): follow
[`dev-environment-ai-tooling.md`](./dev-environment-ai-tooling.md)
§"Incident response".

### Phase 4 — Notify

The notification matrix is severity-driven.

#### P0 — Critical

1. **Affected tenant(s)** within 24 hours of confirmation. Use the
   tenant-notification template below. Include: what happened,
   what data was involved, what the tenant should do, what
   Panorama did to contain, when they'll get a follow-up. A
   one-line "we're investigating, you'll hear more by <time>"
   heads-up email MAY go out in parallel with Phase 3 — speed
   matters for an active leak on driver shift-start; the full
   notification follows once Contain is verified.
2. **ANPD (Brazilian DPA)** within the regulatory clock. As of
   2026-05-17 the working target is **3 dias úteis (3 business
   days) from `tomada de conhecimento`** (the controller becoming
   aware of the incident) per **Resolução CD/ANPD nº 15, de 24 de
   abril de 2024, Art. 5**. The 72-hour figure that some operators
   anchor to is the **EU GDPR Art. 33** rule, which does NOT
   apply here — under Brazilian rules, 3 business days from a
   Friday detection can mean a Wednesday filing.

   The Art. 5 trigger is not "any incident" — it's a leak that
   creates **"significant risk or relevant damage to data
   subjects"** (Resolução 15, Art. 5 §1). Lower-risk incidents
   do not require ANPD notification; document the
   not-notifying-because rationale in the GitHub Security
   Advisory draft so the audit trail survives.

   Channel: <https://www.gov.br/anpd/pt-br>. The form's current
   field schema (incident category, data classes, count of
   affected data subjects, geographic scope, containment status,
   remediation plan, subject-notification status, contact for
   follow-up) MUST be confirmed with legal counsel before the
   first filing — the form changes; this runbook does not.

   The LGPD timing on this page is the maintainer's working
   reading; **legal counsel review is a Round 7 hard gate before
   the hosted URL flips** (Round 7 §9 Privacy / ToS).
3. **Public security advisory** via the GitHub draft from Phase
   1, once the patch is shipping or shipped. Coordinate the
   public-disclosure timing with the reporter (if applicable) per
   the SECURITY.md timeline.

#### P1 — High

1. **Affected tenant(s) if any** within 72 hours.
2. **ANPD only if confirmation moves it to P0.** If P1 stays P1
   (no confirmed exposure), no ANPD notification — but document
   the not-notifying-because rationale in the advisory draft so
   the audit trail is intact.
3. **Public security advisory** at the maintainer's discretion;
   strongly recommended if the finding could affect self-hosters.

#### P2 — Medium

1. **Affected self-hosters** via a GitHub Security Advisory + a
   release note on the next patch release. No direct tenant
   notification.
2. **No ANPD notification.**

### Phase 5 — Recover + Post-mortem

1. Verify the contain step took: re-run the relevant smoke (login
   flow, audit-chain verifier, cross-tenant isolation tests in
   `community-smoke.e2e.test.ts`).
2. **Write the post-mortem within 7 days** of the incident close.
   Use the template at the bottom of this page.
3. File concrete follow-up issues for every preventative measure
   identified. Tag them `incident-followup` so they're tracked.
4. Decide on the public-disclosure language. Default: publish the
   post-mortem after the patch lands across all known
   deployments + 30-day grace period for self-hosters who pull on
   a slower cadence.

## Templates

### Tenant-notification email (P0/P1 draft)

```
Subject: [Panorama] Important security notice affecting your account

Hi <tenant-display-name>,

This is a notice about a security incident on your Panorama
account. We are sending this to <recipient> because they are the
account Owner on file.

WHAT HAPPENED
On <date>, we identified a <one-sentence description of the
incident class>. The incident affected <data classes — e.g.,
"reservation records and asset metadata for your tenant"; or "a
session cookie that could be replayed by an attacker">.

WHAT WE DID
<Containment actions: rotated SESSION_SECRET, disabled the affected
endpoint, force-logged-out all sessions, etc.>

WHAT YOU SHOULD DO
1. Log in to Panorama. Go to Settings → Sessions and click
   "Log out everywhere" to invalidate any session that may
   have been stolen.
2. Go to Settings → Audit log, filter by the last 7 days, and
   look for any check-out, reservation, or asset edit that
   isn't yours. Reply to this email if you see anything
   unfamiliar — include the row id from the audit row.
3. If you have integrations using Personal Access Tokens
   (PATs), regenerate them at Settings → Tokens.

Worked example of WHAT HAPPENED text (drafter: fill in
real specifics; do NOT include endpoint/exploit detail that
weaponises the disclosure for an attacker reading the email):

  "On 2026-MM-DD at HH:MM (BRT), we identified a session-cookie
  encryption issue that could have allowed an attacker holding
  the leaked encryption key to read or forge session cookies
  for accounts in your tenant. We have rotated the key and
  invalidated every active session as of HH:MM today; existing
  data in your tenant was not modified."

WHAT'S NEXT
We will publish a public post-mortem at <link> by <date>. If you
have questions or notice anything unusual in your tenant, reply
to this email or write vitor@vitormr.dev.

The Panorama maintainer
```

### ANPD notification (P0 draft)

ANPD does not accept ad-hoc emails — use the official form at
<https://www.gov.br/anpd>. The fields the form requires include:
incident category, data classes, number of affected data subjects,
geographic scope, containment status, planned remediation,
notification status of affected subjects, contact for follow-up.
Confirm the form's current schema with legal counsel before filing.

### Post-mortem template

```
# Post-mortem: <one-line description>

Date of incident: <ISO date>
Date of detection: <ISO date>
Date of containment: <ISO date>
Date of resolution: <ISO date>
Severity: P0 / P1 / P2
Affected tenants: <count or list>
Affected data classes: <list>

## Scope of impact

- Duration of exposure: <start ISO date> → <end ISO date>
- Blast radius: <how many users / records / API calls were touched>
- Blast-prevention: <what stopped the exposure from growing larger;
  e.g., RLS holding for read-paths even though write-path leaked>
- Data residency / cross-border movement: <yes/no + details if yes>

## Timeline

- T+0:00 — <event>
- T+0:NN — <event>
- ...

## Root cause

<2-4 paragraphs>

## Resolution

<What we shipped to close the issue, including PR / commit links>

## What went well

- ...

## What we missed

- ...

## Action items

Every item below MUST be filed as a GitHub issue with label
`incident-followup` AND linked to a milestone before the post-
mortem is considered closed. Checkboxes without issue links rot.

- [ ] <#issue-number> — <action item title>
- [ ] ...

## Public disclosure

<Link to public advisory + release notes>
```

## Contact directory

| Role | Contact |
|---|---|
| Maintainer (primary) | <vitor@vitormr.dev> |
| Hosted instance ops | Same as maintainer (single-operator deploy) |
| Legal counsel | TBD — must be in place before the hosted URL flips |
| ANPD official form | <https://www.gov.br/anpd> |
| Sentry project | The operator's own (per [ADR-0018](../adr/0018-observability-stack.md)) — Panorama maintainer does not have access |
| GitHub security advisories | <https://github.com/VitorMRodovalho/panorama/security/advisories> |

## What this runbook does NOT cover

- **Physical security** of any host (data center, office, laptop).
  AGPL self-host: operator's responsibility.
- **Third-party platform incidents** without confirmed Panorama-
  data impact. Report to the platform; track on their status page.
- **Post-auth admin abuse** within a tenant (a tenant Owner
  deleting their own data). Documented in [SECURITY.md](../../SECURITY.md)
  §"Out of scope" — treated as customer-side.
- **Bug bounty payout decisions.** See [SECURITY.md](../../SECURITY.md)
  §"Bug-bounty status".
- **Insurance claims / D&O coverage** — outside scope of this
  runbook entirely; consult legal counsel.
- **Maintainer unavailability >24h** (vacation, illness, family
  emergency). Hosted-instance Wave 0 ships single-operator with
  bus-factor of 1; affected tenants experience delayed response
  per the [SECURITY.md](../../SECURITY.md) acknowledgement
  windows. AGPL self-hosters operate their own incident response.
  Multi-operator on-call rotation lands when the hosted instance
  has paying customers (post-Wave-0).
- **Managed 24×7 on-call, named CSM, and orchestrated tenant
  notification across a hosted fleet.** That is the Enterprise
  managed-service wedge (see [feature matrix row 27](../en/feature-matrix.md)).
  The Community runbook here is what self-hosters and the current
  hosted instance run themselves.

## Drill cadence

Once the hosted URL flips (Round 7 §10), drill against this runbook
**once per quarter**: a tabletop exercise where one synthetic
incident at each of P0/P1/P2 walks through Phases 1-5 without
touching production. Record the drill in the audit log with action
`panorama.maintainer.incident_drill_completed` (action name
reserved; the registry entry + emitter land in Round 6 PR2
alongside the executed restore drill).

Until the URL flips, drill cadence is **once at Wave 0 Round 6
PR2** alongside the actual restore drill that closes Wave 0 §8.

**Enforcement mechanism.** A GitHub Actions cron job opens a
`incident-drill-due` labeled issue 7 days before each scheduled
drill date — quarterly tabletop is theater without it. The cron
landing PR is a Round 6 PR2 sibling, not this one; until then the
drill cadence depends on the maintainer's calendar.
