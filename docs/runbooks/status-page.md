# Status page runbook

> **Status.** Round 7 §9 of the Wave 0 plan. Minimal-viable
> monitoring infrastructure shipped 2026-05-18; visual public
> status page deployment is operator-side follow-up after Wave 0
> closure.

This page tells the maintainer how Panorama's uptime monitoring
works, where to see the signal, what to do when a probe trips,
and how to add new monitored endpoints when the hosted app URL
flips.

The companion artefact is `.github/workflows/status-page.yml` — a
cron-driven HTTP probe that runs every 15 minutes against the
configured monitored endpoints.

## What's monitored today

As of 2026-05-18 (Round 7 §9 first cut):

| Target | URL | Expected | Notes |
|---|---|---|---|
| `docs-site` | `https://panorama.vitormr.dev/` | HTTP 200 | VitePress documentation site hosted on GitHub Pages |

The hosted app endpoint(s) get added here when Wave 0 §10 URL flip
completes. Add a new entry under `matrix.target` in the workflow
file and the next cron tick picks it up automatically.

**Security constraint (per `HANDOFF-2026-05-16-wave0-scan.md`
security C1):** probes hit `/health` ONLY (or the public homepage
of the docs site). NO body matching, NO tenant-named probes. The
probe checks HTTP status only — the response body is discarded
(`-o /dev/null`). This bounds the information an external observer
of the probe traffic can learn about Panorama's internal state.

## Where to see the signal

### Workflow run history

GitHub Actions tab → `Status page` workflow → run list:

```
https://github.com/VitorMRodovalho/panorama/actions/workflows/status-page.yml
```

Green = probe passed. Red = probe failed. Cron runs every 15
minutes; manual runs available via `workflow_dispatch` for ad-hoc
checks during incident response.

### Issues labeled `incident-detected`

When a scheduled (cron) probe fails, the workflow auto-opens a
GitHub issue labeled `incident-detected`. Subsequent failures on
the same day comment on the existing issue instead of opening
duplicates. The de-dup key is `(target_name, date)`.

Find them here:

```
https://github.com/VitorMRodovalho/panorama/issues?q=is%3Aopen+label%3Aincident-detected
```

### Workflow-run annotations

Each probe emits `::notice` (pass) or `::error` (fail) annotations
visible in the workflow run summary. Open any specific run to see
the URL, observed status, and latency for each monitored target.

## What to do when a probe trips

When the cron fires red:

1. **Acknowledge.** Open the auto-created `incident-detected`
   issue. The first comment is the probe run that detected the
   outage; that's **T=0** for the
   [`incident.md`](./incident.md) Phase 1 detection timestamp.
2. **Confirm.** Manually trigger the workflow via
   `workflow_dispatch` to confirm the probe still fails. A
   transient probe failure (one in 96/day = 1.04% baseline noise
   on a healthy system) resolves on the next cron without operator
   action.
3. **Triage.** Follow
   [`incident.md`](./incident.md) Phase 2 (Triage). For a docs-
   site outage, the blast radius is "visitors can't read the
   marketing/docs site"; severity P2 unless it correlates with
   hosted-app outage. For a hosted-app outage, severity escalates
   per the table in `incident.md`.
4. **Contain + recover** per the per-severity playbook in
   `incident.md` Phases 3-5.
5. **Close the issue** when the cron starts passing again.
   Document the root cause in the issue body before closing so the
   audit trail survives.

## Adding new monitored endpoints

Edit `.github/workflows/status-page.yml`, find the `matrix.target`
list, and add a new entry. Example for the hosted-app endpoint
once Wave 0 §10 URL flip completes:

```yaml
matrix:
  target:
    - name: docs-site
      url: https://panorama.vitormr.dev/
      expect_status: '200'
      description: VitePress documentation site (GitHub Pages)
    - name: hosted-app
      url: https://panorama.example.com/health
      expect_status: '200'
      description: Hosted Panorama API health endpoint (Fly)
```

The next cron tick picks up the new entry. No workflow restart
needed. Test the new endpoint manually via `workflow_dispatch`
before relying on the cron signal.

**What NOT to add:**
- Tenant-named endpoints (`https://app.example.com/t/acme/health`)
  — leaks tenant slugs to anyone watching the probe traffic.
- Endpoints requiring auth — the probe is unauthenticated by
  design.
- Endpoints with body assertions — the probe deliberately discards
  the body.

## Visual public status page — operator-side follow-up

The Wave 0 §9 acceptance bar is "status page exists" with operator-
accessible signal. The current shape (workflow runs + issues) meets
that bar via GitHub-native surfaces. A visual public status page —
the kind a customer bookmarks at `status.panorama.example.com` and
checks during a perceived outage — is a separate operator-side
deliverable that builds on this workflow's signal.

Two paths for the visual page:

1. **Sibling Upptime repo** (recommended).
   - Create `VitorMRodovalho/panorama-status` from the upstream
     `upptime/upptime` template.
   - Configure its `.upptimerc.yml` to monitor the same endpoints.
   - GH Pages of the sibling repo publishes the visual status page
     to e.g. `vitormrodovalho.github.io/panorama-status` or a
     custom subdomain `status.panorama.vitormr.dev`.
   - Sibling repo handles its own commit churn (Upptime writes
     uptime data to main every cron tick — keeps Panorama's main
     repo clean).
2. **In-repo with separate output branch.**
   - Add the full Upptime workflows to this repo (`uptime.yml`,
     `response-time.yml`, `graphs.yml`, `summary.yml`, etc.).
   - Configure them to write data to an `upptime-data` orphan
     branch instead of main.
   - Deploy the visual page from `upptime-data` to a sister GH
     Pages path or subdomain.
   - More complex; only choose if a sibling repo would create
     organisational friction.

Either path is operator-side and not blocked by this PR. The
current `status-page.yml` workflow is the canary signal regardless
of which visual surface ships later.

## Cost

- **GitHub Actions runner minutes:** unmetered on public AGPL
  repos.
- **GitHub API calls:** issue creation + comment per failure run;
  far below any quota.
- **Storage:** the workflow does NOT commit data to the repo (no
  `status/history.json` log file polluting main). Signal lives in
  Actions run history (90-day retention) + issue trail (forever).

When the visual page ships (sibling-repo path), the only added cost
is the sibling repo's own Actions minutes (also unmetered for
public).

## What this runbook does NOT cover

- **Synthetic transactions** (login → reservation → check-out
  flow). The current probe is HEAD-style HTTP only. A future
  PR can add Playwright-driven synthetic flows when the hosted
  app has stable login + seeded test tenant.
- **Browser-side performance** (Web Vitals, real-user monitoring).
  ADR-0018's Sentry opt-in already covers backend-side error
  reporting; client-side RUM is Round 7 / Enterprise wedge.
- **Telemetry on the workflow itself.** If the cron workflow stops
  running (GH Actions outage, billing issue, repository archived),
  the absence of failure-issues looks identical to a healthy system.
  Mitigation: a sister "heartbeat" workflow that creates an issue
  if N hours pass without a status-page run. Out of scope today;
  the GH Actions free tier reliability is acceptable for a public-
  preview phase.
- **Alerting beyond GH issues.** A `notify-on-incident` Slack /
  Discord / Matrix webhook is a Round 7 sibling PR if the operator
  wants push-to-phone notification.

## Drill cadence

Once a quarter, manually trigger the workflow via
`workflow_dispatch` against a known-good endpoint to confirm the
probe + issue-opener path still works end-to-end. Record the drill
in the `incident-detected` label's history. Pair this drill with
the [restore drill](./restore.md) quarterly cadence — one
operator-hour slot for both.
