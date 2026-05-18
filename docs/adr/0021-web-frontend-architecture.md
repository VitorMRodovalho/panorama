# ADR-0021: Web frontend architecture

- Status: Accepted (2026-05-18 via v2 6-agent scan, per `HANDOFF-2026-05-18-v2-6agent-scan.md` §1 tech-lead condition). Drafted as a Wave 0+ prereq per
  `docs/audits/roadmap-to-feature-complete-2026-05-18.md` §"Wave 0+
  — Web foundation" and tech-lead's per-PR scan finding on PR #241
  ("apps/web/ architecturally not ready — no features/ folder, 5
  components total, flat lib/api.ts, no data-fetching ADR").
- Date: 2026-05-18
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (5-agent planning round, 2026-05-18):
  - tech-lead → "Recommend an ADR: `0021-web-frontend-architecture.md`
    covering features/, data-fetching, state, mobile route group,
    and design-system boundary. Land it before any feature wave
    ships."
  - ux-critic → flagged the same gap from a UX angle: "Not ready.
    Current shape is a route tree with five shared components."
    Sections §3 (apps/web/ architectural readiness) + §9 (UX veto
    list) constrain the decisions below.
  - product-lead → no veto; "operational ROI matches the audience."
  - data-architect → no schema implications (frontend-only).
  - persona-fleet-ops → endorses the role-aware `/` dashboard
    decision below as the canonical Fleet manager "first 5 minutes
    after login" surface.
- Related:
  - [ADR-0001 Stack choice](./0001-stack-choice.md) — Next.js + React
    chosen; this ADR refines the layout inside that choice.
  - [ADR-0007 Tenant + Owner role](./0007-tenant-owner-role.md) — the
    four personas (Fleet manager, Dispatcher, Driver, Maintenance
    tech) drive the role-aware router design.
  - [ADR-0018 Observability stack](./0018-observability-stack.md) —
    pino mixin + request-id ALS that the frontend's Server Actions
    inherit at the API boundary.
  - **ADR-0022 Driver native mobile architecture** (sibling, drafted
    in parallel) — confirms that the driver-persona surface lives in
    a separate Expo app, NOT under `apps/web/(driver)/`. The web
    app retains a minimal `/me` route for the rare desktop-driver
    edge case but is NOT the primary driver UX.

## Context

`apps/web/` shipped in Round 4 (#221 tenant settings + #218 shell/nav
+ #220 approvals queue) at ~10% of FleetManager v2.1 / Snipe-IT
feature surface per the 2026-05-17 session-end perception walkthrough.
The current state, as of the merge of #245 (2026-05-18):

- **Routes:** `apps/web/src/app/(authenticated)/{assets,reservations,
  inspections,maintenance,admin/*}/page.tsx`, plus public routes
  `apps/web/src/app/login/page.tsx`,
  `apps/web/src/app/invitations/accept/page.tsx`, and the new
  `apps/web/src/app/legal/{privacy,terms}/page.tsx`.
- **Components:** five files total in `apps/web/src/components/`:
  `app-shell.tsx`, `app-nav.tsx`, `page-header.tsx`, and two
  page-specific helpers. No `Button`, `Card`, `Table`, `EmptyState`,
  `Toast`, or `Modal` primitives.
- **Data-fetching:** a single flat `apps/web/src/lib/api.ts` with
  per-route `apiGet`/`apiPost` calls invoked directly inside Server
  Components. No TanStack Query / SWR / RSC-cache strategy decided.
- **State management:** none — URL state for filters, Server Actions
  for mutations.
- **Mobile responsiveness:** breakpoints at 720px on the header +
  form grid only; tables, calendar, and most pages have no mobile
  story.
- **Design tokens:** single dark theme (`globals.css:1-10`), accent
  `#3fb69a`, surface `#131a30`. No light theme.
- **Root redirect:** `apps/web/src/app/page.tsx` unconditionally
  redirects to `/assets` — wrong for every persona except a one-time
  configurator (per the 2026-05-18 ux-critic finding).

The 2026-05-18 planning round identified the architectural risk:
adding Wave A (Teams + AssetAssignment UI), Wave C (calendar drag +
dispatcher tools), and Wave D (Fleet manager dashboard + reports v1)
without first deciding the frontend's shape would create per-PR
decisions that accumulate into a god-file (`lib/api.ts`),
inconsistent data-fetching (some Server Action, some client fetch,
some prop-drilled), and design primitives extracted at the third
copy instead of the first.

tech-lead's per-PR scan called this out as a BLOCKER for any feature
wave. This ADR removes the block.

## Decision

### 1. Feature-folder layout under `apps/web/src/features/`

Establish a `features/` directory parallel to `app/`. Each feature
owns its own components, hooks, types, and data-fetching helpers:

```
apps/web/src/features/
├── scheduling/          # Wave C (calendar drag + dispatcher)
│   ├── components/
│   │   ├── CalendarGantt.tsx
│   │   ├── ReservationCard.tsx
│   │   └── ConflictBadge.tsx
│   ├── hooks/
│   │   └── useDragReschedule.ts   # client-island only
│   ├── api/
│   │   └── reservations.ts        # feature-scoped api calls
│   └── types/
│       └── reservation.ts
├── reporting/           # Wave D + G
├── maintenance/         # Wave E
├── teams/               # Wave A
└── driver-fallback/     # minimal desktop /me for yard supervisor
                          # edge case (primary driver UX is the
                          # native Expo app per ADR-0022)
```

Rules:

- **Routes in `app/` import from `features/`, not the other way.**
  Pages stay thin (route-level concerns: auth, locale, layout); the
  feature implementation lives in `features/`.
- **No cross-feature service imports.** `features/scheduling/` does
  NOT `import` from `features/maintenance/`. Cross-feature
  composition happens AT THE ROUTE level (the page composes a
  scheduling component and a maintenance component side by side).
- **Shared primitives stay in `apps/web/src/components/`** (the
  design-system layer, see decision §3). Anything specific to a
  feature lives inside that feature's folder.
- **`apps/web/src/lib/api.ts` becomes thin** — keeps the
  `apiFetch`/`apiPost` primitives + auth + error handling. Per-domain
  fetch helpers move to `features/<feature>/api/`.

This layout is a **rule-of-three trigger**: extract a shared module
out of `features/` to `components/` or `lib/` only at the third
copy. Premature abstraction is the failure mode this ADR targets.

### 2. Data-fetching: RSC by default, client islands for interactivity

The contract:

- **Default: React Server Components + `revalidatePath`.** Every
  page is a Server Component that fetches data via the existing
  `apps/web/src/lib/api.ts` primitives at render time. Mutations use
  Server Actions (`'use server'` functions) that call the API +
  trigger `revalidatePath` / `revalidateTag` for cache invalidation.
- **Client islands for interactivity ONLY.** A component becomes
  client (`'use client'`) only when it needs:
  - Drag-and-drop (calendar, basket builder)
  - Optimistic updates (bulk approve, inline edits)
  - Real-time subscriptions (notifications inbox — future wave)
  - Browser-only APIs (clipboard, file picker, geolocation)
  - User-event handlers that drive in-component state that doesn't
    cleanly map to URL state
- **NO client-side data fetching by default.** No TanStack Query, no
  SWR, no `useEffect(() => fetch(...), [])` patterns. If a component
  needs data, it's either:
  - A Server Component that fetches at render
  - A client island that receives data as props from a Server
    Component parent (the parent does the fetch)
  - A Server Action that returns data on mutation

The exception: the future native Expo app (ADR-0022) uses TanStack
Query for offline-first sync. The WEB app does NOT inherit that
choice — different runtime, different patterns. Code does NOT cross
the boundary.

**Caching:** Next.js's `revalidatePath('/...')` after Server Actions
+ `unstable_cache` for read paths that benefit from RSC-level memo.
No custom cache layer; no Redis cache from the frontend; no
client-side cache state machine.

### 3. Design-system primitives at `apps/web/src/components/` + `packages/ui-kit`

Promote the existing primitives to a coherent set BEFORE Wave A's
first PR:

- **`apps/web/src/components/`** — primitives the web app uses
  directly. Today: `app-shell`, `app-nav`, `page-header`. Add:
  `Button`, `Card`, `EmptyState`, `Toast`, `Modal`, `Table`,
  `StatusPill`, `Skeleton`.
- **`packages/ui-kit/`** (already exists as a workspace) — shared
  cross-app primitives if/when a second app surfaces (the Expo app
  per ADR-0022 will NOT share React Native components with React
  DOM, so today the kit's audience is web-only).

Primitives must:
- Be styleable via CSS variables (light/dark theme prep, see §6)
- Use `<button>` for clickable actions (≥48px tap target), `<a>`
  via Next.js `<Link>` for navigation (the lint rule
  `@next/next/no-html-link-for-pages` enforces this — caught in
  PR #245's first-push lint failure)
- Carry their own accessibility annotations (`aria-label` when icon-
  only, `aria-current` for active nav items, etc.)
- NOT use icon-as-only-affordance (every status pill prefixes a text
  letter per ux-critic's §6 status-by-text-not-colour discipline)

**Veto list (from the ux-critic planning round, §9):**

- No modal-stacking (modal opens modal opens modal). Linear discipline:
  route, don't modal.
- No side-drawer with a form that should be a page (>5 fields or any
  tabs = page).
- No toasts as the only error feedback for destructive actions.
- No infinite scroll on operational tables.
- No pie charts.
- No hamburger nav on desktop (5 items fit horizontally).
- No `apps/web/src/hooks/use-*.ts` shared-hooks god-file. Hooks live
  next to their feature.
- No `apps/web/src/lib/utils.ts` god-file.

### 4. Role-aware root route `/` dashboard

Replace `apps/web/src/app/page.tsx`'s unconditional
`redirect('/assets')` with a persona-aware router:

```typescript
// Pseudocode shape
async function RootPage() {
  const session = await loadSession();
  if (!session) redirect('/login');
  const primaryRole = derivePrimaryRole(session.memberships[0]);
  switch (primaryRole) {
    case 'owner':            redirect('/dashboard');
    case 'admin':            redirect('/reservations/calendar');
    case 'maintenance':      redirect('/maintenance/queue?assignee=me');
    case 'member':           redirect('/me');  // minimal web /me fallback
    default:                 redirect('/assets');
  }
}
```

- **`/dashboard`** (new, Wave 0+) — Fleet manager / Owner landing.
  KPI band, action queue (pending approvals), today's calendar
  strip, utilisation tiles. Text-first. Replaces the current
  `redirect('/assets')` default which was wrong for every persona.
- **`/me`** (new, Wave 0+ minimal version) — desktop driver fallback.
  Renders the next + active reservation as cards with check-out /
  check-in / report-damage CTAs. NOT the primary driver UX — the
  primary lives in the native Expo app (ADR-0022). The web `/me`
  exists for the yard-supervisor edge case (e.g., checking out a
  vehicle on behalf of a driver from a desktop terminal).
- **`/maintenance/queue`** — Maintenance tech's morning huddle view
  (Wave E). The role router points here once the page exists; until
  then, falls back to `/maintenance`.

### 5. Mobile route group separation

The web app does NOT host the driver-persona primary surface (that
lives in the Expo app per ADR-0022). For the minimal web `/me`
fallback, no separate route group is created — `/me` sits in the
`(authenticated)/` route group like every other authenticated page,
sized to be readable on phones-by-accident but not optimised for
the gloves+sunlight scenario the Expo app targets.

The `(driver)/` route group that earlier roadmap drafts proposed is
**explicitly scrapped** under this ADR. Decisions §1 + §4 cover the
desktop fallback adequately.

### 6. Light theme + theme tokens

Add a light theme using CSS variables:

```css
:root {
  --pan-bg: #f5f7fa;
  --pan-surface: #ffffff;
  --pan-text: #1a1f2c;
  /* ... */
}

@media (prefers-color-scheme: dark) {
  :root {
    --pan-bg: #0b1020;
    --pan-surface: #131a30;
    --pan-text: #f2f4fa;
    /* ... */
  }
}
```

Also expose a `panorama_theme` cookie + a toggle in the user
settings menu that overrides the system preference. Default: system.

Light theme is non-negotiable for outdoor drivers and sunlight-
readable scenarios per the ux-critic accessibility framing. The
status-page banner styling shipped in #245 is light-theme-friendly
(`#ffc457` background tint with sufficient contrast in both modes).

### 7. State management

- **URL state** for filters, search, sort, pagination, and any
  state a user might want to deep-link / share / refresh-survive.
- **Server Actions** for mutations + their immediate UI feedback.
- **React local state (`useState`, `useReducer`)** for in-component
  ephemeral state (open/closed dropdown, in-flight form draft, etc.).
- **NO global state library** (no Zustand, Jotai, Redux, etc.) for
  the web app. The Expo app per ADR-0022 may use TanStack Query
  for cache-shaped state; the web app does not.

If a piece of state genuinely needs to cross route boundaries AND
URL state is the wrong shape (rare — usually it's the right shape),
land an ADR amendment naming the specific case before reaching for
a state library.

### 8. Forms

Server Actions handle form submission by default. For form-level
validation:

- Server-side validation via Zod (already a dep) at the Server
  Action's entry; returns structured errors.
- Client-side hints via native HTML5 (`required`, `pattern`,
  `min`/`max`, `aria-invalid`). NO `react-hook-form`, NO `formik`.
- Inline error display next to the field (NOT toast — per §3 veto).

Forms that exceed the 5-fields-or-tabs heuristic become their own
page (`/admin/teams/new`, not a modal in `/admin/teams`).

### 9. Internationalisation contract preserved

The existing `apps/web/src/lib/i18n.ts` (loads from
`packages/i18n/{en,pt-br,es}/common.json` at server-render time, zero
client JS) is the contract. Every new page uses `loadMessages(locale)`
+ `messages.t('key')`. Every new key lands in all 3 locale files OR
the CI gate (`pnpm i18n:check` → "i18n coverage (EN = PT-BR = ES)")
blocks merge.

The legal-page content keys shipped in #245 are the established
pattern: long-form content in a per-locale `content.ts` if it doesn't
fit a translation-key shape; short UI strings in the common.json
bundle.

### 10. Testing primitives

- Unit tests (vitest) for hooks + utility functions
- Component tests (vitest + @testing-library/react) for client
  components when the user-event surface justifies it
- e2e (Playwright) for cross-page flows: the existing
  `community-smoke.e2e.test.ts` is the precedent (Round 5 PR1)
- Server Components are tested via their e2e flow + via testing the
  Server Action handlers directly (call the function with mocked
  session + assert the response)

The web app's package.json `test` script runs vitest;
`test:e2e` runs Playwright. Both must pass before merge to main.

## Consequences

### Positive

- Wave A (Teams) + Wave C (calendar drag) + Wave D (dashboard +
  reports) all have a settled architectural foundation. Per-PR
  scans no longer surface "needs an ADR first" as a blocker.
- The features/ folder layout keeps the route tree shallow — `app/`
  remains thin route definitions, `features/` carries the
  implementation. New feature waves add to `features/`; the route
  tree only grows when a new URL path appears.
- RSC-by-default + Server Actions match Next 16's strengths and
  preserve the "Zero client JS" moat for the calendar's SSR-CSS-grid
  render path that PR #220 established.
- Light theme + accessibility primitives let outdoor / sunlight /
  mobile-on-desktop personas land without per-PR pixel polish.
- The role-aware `/` dashboard closes the "every persona lands at
  `/assets` which is wrong for them" gap that ux-critic flagged on
  2026-05-18.

### Negative

- Establishing the features/ folder + primitives is real work
  (estimated ~3-5 PRs in Wave 0+). Wave A cannot start its first PR
  until at least the Button/Card/EmptyState primitives + the `/`
  role router land — otherwise Wave A's first PR introduces those
  primitives ad-hoc.
- The "no client data-fetching" rule means some patterns popular in
  CSR React apps (debounced search across pages, autocomplete with
  ranked results) need to route through Server Actions, which is
  slower. Acceptable trade-off; if a specific feature genuinely
  needs CSR-data-fetch, the ADR can be amended for that case.
- The `packages/ui-kit/` ambiguity (cross-app primitive home vs
  web-only `apps/web/src/components/`) needs a follow-up clarification
  ADR if a second React-DOM app surfaces (today there is no second
  React-DOM app; the Expo app per ADR-0022 uses React Native).

### Neutral / locked-in

- The four personas (Fleet manager, Dispatcher, Driver, Maintenance
  tech) are the persona walkthrough surface for every wave per the
  roadmap; the role router cements them in code.
- The `(authenticated)/` route group remains the primary auth
  boundary. Public routes (`/login`, `/invitations/accept`, `/legal/*`)
  sit outside it.
- ux-critic veto list (§3) becomes the standing review surface for
  every apps/web/ PR.

## Alternatives considered

### A. TanStack Query + client-side data fetching

Use TanStack Query for client-side data caching across the web app
(mirroring what ADR-0022 chose for the Expo app).

**Why not:** the web app doesn't need offline-first or cross-route
cache sharing the way an offline-capable mobile app does. RSC +
Server Actions cover the realistic web use cases; adding TanStack
Query adds a client-side state library + cache-invalidation surface
+ bundle size with no offsetting benefit. The web app stays
server-first.

### B. PWA with mobile route group for driver UX

Earlier roadmap drafts proposed `apps/web/src/app/(driver)/` as a
mobile-optimised route group with offline support via Service
Worker.

**Why not:** maintainer decision #3 on 2026-05-18 chose native React
Native / Expo over PWA. The web app retains a minimal `/me` fallback
(decision §4); the primary driver UX lives in the Expo app per
ADR-0022.

### C. shadcn/ui or Radix UI as the design-system foundation

Use shadcn/ui (Radix primitives + Tailwind) as the component library.

**Why not:** Panorama's existing styling is plain CSS with custom
properties (no Tailwind), and the existing primitives are
already shipped under that pattern. Introducing Tailwind +
shadcn/ui adds a build-time dependency, a new mental model, and a
significant rewrite of every existing route's styling. The
incremental cost outweighs the design-system polish gain at this
scale. Re-evaluate if a designer joins the team or if a paying
customer specifically asks for a Tailwind-based theming surface.

### D. Atomic Design (atoms/molecules/organisms/templates/pages)

Adopt the Atomic Design taxonomy for `apps/web/src/components/`.

**Why not:** the maintainer is bus-factor 1; Atomic Design's value
emerges with a larger team that benefits from the shared taxonomy.
For a single-maintainer + agent-committee workflow, the simpler
"primitives at the top, features inside their folder" rule (§1 + §3)
is more legible.

### E. Storybook + chromatic for component documentation

Document every primitive in Storybook with visual regression tests
via Chromatic.

**Why not:** premature for a 10-component primitive set. The cost
of maintaining stories + Chromatic CI integration is non-trivial
and the audience (a single maintainer) doesn't yet need it. Re-
evaluate at Wave G when the dashboard surface adds visual-regression
sensitivity that justifies the tooling.

## Implementation notes

Sequencing within Wave 0+:

1. **PR — Establish `features/` folder + tooling.** Add an `apps/web/`
   ESLint rule that warns when `app/(authenticated)/<feature>/` files
   contain >50 lines of non-route logic (encourages extraction to
   `features/`). No production code change — just the scaffold + lint
   rule.
2. **PR — Promote design-system primitives.** Extract `Button`,
   `Card`, `EmptyState`, `Toast`, `Modal`, `Table`, `StatusPill`,
   `Skeleton` from per-page CSS into `apps/web/src/components/`.
   Add visual snapshot tests via vitest + @testing-library.
3. **PR — Light theme + theme cookie.** Add the CSS variable swap +
   `panorama_theme` cookie + toggle in user settings.
4. **PR — Role-aware `/` dashboard skeleton.** Replace
   `apps/web/src/app/page.tsx`'s `redirect('/assets')` with the
   persona router. Stub `/dashboard` + `/me` + `/maintenance/queue`
   with EmptyState placeholders (population is per-wave).
5. **PR — Tap-target + accessibility ground-truth pass.** Audit
   every interactive element for ≥48px touch target + AA contrast;
   fix in-place.

**Exit criteria for Wave 0+:** ADR-0021 Accepted (this ADR); ~5 PRs
landed per above; ux-critic signs off that the web is ready to host
the Wave A code that follows.

**Wave A's first PR** (Teams migration 0027 admin UI) imports from
the primitives + the features/ folder. Wave A is the architectural
canary for this ADR; any pattern that fights features/ in Wave A
triggers a same-day ADR amendment discussion before the pattern
proliferates.

The ADR is forward-only: existing routes (assets, reservations,
inspections, maintenance, admin) keep their current shape until they
hit a feature-wave PR that touches them. They migrate to the
features/ layout opportunistically, not via a big-bang refactor.
