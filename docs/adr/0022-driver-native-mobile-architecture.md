# ADR-0022: Driver native mobile architecture (Expo / React Native)

- Status: Proposed (2026-05-18). Drafted as a Wave B prereq per
  `docs/audits/roadmap-to-feature-complete-2026-05-18.md` §"Wave B —
  Driver Native Mobile App" and maintainer decision #3 of the
  2026-05-18 planning round (native Expo over PWA).
- Date: 2026-05-18
- Deciders: Vitor Rodovalho (maintainer)
- Reviewers (5-agent planning round, 2026-05-18):
  - persona-fleet-ops → "If you only ship one wave next, ship the
    Driver mobile PWA + photo-evidence GA." This ADR's existence
    elevates driver-mobile from "the one wave that flips a paying
    customer" framing to a settled architectural commitment.
  - product-lead → originally recommended PWA per "no native mobile
    app before web mobile-responsive PWA" anti-goal. **Overridden by
    maintainer decision #3 (2026-05-18)**; accepted trade-off
    documented in §Consequences below.
  - tech-lead → flagged ADR-0022 as a Wave B prereq alongside
    ADR-0021; "no Wave B code without ADR-0022 Accepted."
  - data-architect → no schema implications direct; the device-token
    PAT scope extension touches `PersonalAccessToken.scope` which
    has the slot for the new value already.
  - ux-critic → no direct review of the native shape (out of
    domain — apps/web/ focus). Endorses the native path's
    accessibility ceiling (sunlight, gloves, low-end Android).
- Related:
  - [ADR-0001 Stack choice](./0001-stack-choice.md) — set NestJS +
    Next.js + Postgres + Prisma. This ADR adds React Native + Expo
    as a sibling client surface; does NOT modify the existing stack.
  - [ADR-0002 OSS/Community + commercial Enterprise split](./0002-oss-commercial-split.md)
    — the Expo app ships under AGPL; same edition discipline as the
    web app.
  - [ADR-0012 Inspection checklists + photo evidence pipeline](./0012-inspection-photo-pipeline.md)
    — the photo pipeline this app's check-in/check-out flow consumes.
  - [ADR-0018 Observability stack](./0018-observability-stack.md) —
    pino + Sentry opt-in extends naturally to the Expo app via
    @sentry/react-native (a separate Sentry project for the mobile
    surface, decided in §6 below).
  - **ADR-0021 Web frontend architecture** (sibling, drafted in
    parallel) — confirms that the web app retains a minimal `/me`
    fallback but NOT the driver primary surface, so this ADR owns
    that surface entirely.
  - **ADR-0010 Snipe-IT compat shim — auth model (per-user PATs)**
    — the device-token approach below extends PAT.scope with a new
    value rather than introducing a parallel auth model.

## Context

The 2026-05-18 5-agent planning round identified the driver mobile
surface as the single highest-leverage feature wave ("the one wave
that flips a paying customer" per persona-fleet-ops). Comparing to
FleetManager v2.1's `my_bookings.php`: Panorama has no equivalent
driver-self-serve surface today.

The 2026-05-18 maintainer decision #3 chose **native React Native /
Expo** over a PWA-on-Next.js path. The product-lead's "no native
mobile app before PWA" anti-goal was explicitly overruled. This
ADR documents the trade-off accepted with that decision and the
specific architectural shape for the resulting `apps/driver-app/`
workspace.

The driver persona's environment is the constraint that drives
nearly every decision below:

- **Hardware**: 3-5-year-old Android phones common in bus barns
  and yards; iPhone older models on the fleet-manager-bought side.
  RAM ≤ 4 GB; storage ≤ 32 GB; cameras of varying quality.
- **Network**: spotty cellular signal common; bus barns
  notoriously RF-shielded (steel + concrete); shift starts at
  05:00 in a place with no WiFi.
- **Physical**: gloved hands; rain on screen; direct sunlight in
  outdoor checkouts; truck cab vibration during inspection photo
  capture.
- **Authentication friction**: drivers refuse to type long
  passwords on phone keyboards in cold weather. QR-scan check-out
  is the operational primitive.
- **Trust model**: a driver's device may be lost or stolen;
  credentials must rotate without compromising the entire fleet's
  auth state.

These constraints are not unique to fleet ops but are unusually
severe for SaaS UX. Native APIs (camera, SQLite, background sync,
push notifications) deliver materially better outcomes than a
service-worker PWA in this scenario — the cost of running a
second build pipeline is accepted in exchange.

## Decision

Panorama ships a separate Expo / React Native app at
`apps/driver-app/` for the driver persona. The web app retains a
minimal `/me` desktop fallback per ADR-0021 §4 but is NOT the
primary driver UX.

### 1. Workspace package: `apps/driver-app/`

Added to the existing pnpm workspace. Sibling to `apps/core-api/`
and `apps/web/`. Bundle ID + binary identity:

- iOS: `app.panorama.driver`
- Android: `app.panorama.driver` (same — Expo defaults align)
- App Store / Play Store listing name: "Panorama Driver"

The workspace's `package.json` declares `expo` as the toolchain.
No code is shared with `apps/web/` at the JSX level (React DOM vs
React Native are different runtimes); shared business types live
in `packages/types/` (or a new sibling) and DTO contracts come
from the core-api via OpenAPI generation.

### 2. Expo SDK + EAS Build

- **Expo SDK 50+** (latest stable at PR-cut time; specific version
  pinned in package.json + bumped deliberately)
- **React Native 0.74+** (matches Expo SDK 50+ baseline)
- **TypeScript** end-to-end (existing repo discipline)
- **EAS Build** for native binary compilation (not local Xcode /
  Android Studio CI). EAS gives reproducible cloud builds + over-
  the-air (OTA) updates without App Store re-review for JS-only
  changes.
- **EAS Update** for OTA JS bundle delivery to deployed apps.
  Channel layout: `internal` (design partners via TestFlight + Play
  Internal Track), `production` (App Store + Play Store GA).
- **No vanilla React Native CLI fallback.** The app is Expo-managed
  end-to-end. Bare workflow is not adopted to keep the build
  pipeline standardised.

### 3. Authentication: device-token PAT scope

Extend `PersonalAccessToken.scope` (existing column on the model,
populated since ADR-0010) with a new value `device_token`. Issuance
flow:

1. Driver opens the app on first install.
2. App requests a one-time device-enroll code via the core-api
   `/auth/device/start` endpoint (new). Endpoint returns a 6-digit
   code + an enrollment-session id.
3. Driver enters the code on the web app's `/me?enroll=true` page
   (logged in via password / OIDC). Web app calls
   `/auth/device/finish` which mints a `device_token` PAT scoped to
   `(userId, deviceFingerprint)` and returns it to the mobile app
   via long-poll on the enrollment-session.
4. Mobile app stores the PAT in **Expo SecureStore** (Keychain on
   iOS, KeyStore on Android — OS-level credential isolation).
5. Subsequent API calls include the PAT as an
   `Authorization: Bearer ...` header.

Token rotation: 30-day device-token lifetime with refresh-on-use
sliding window. Lost-device path: tenant Owner / Admin revokes the
PAT via the existing `/admin/tokens` UI (same flow as ADR-0010's
Snipe-IT compat tokens).

**Why not session cookies (the web approach):** cookies require
the WebView container or a custom cookie jar; native apps
conventionally use Bearer tokens. Extending the existing PAT model
keeps the auth code paths unified server-side.

### 4. Offline-first data layer: TanStack Query + Expo SQLite

The app must function in a no-signal bus barn. The data layer:

- **TanStack Query (v5+)** for in-memory query/mutation state with
  cache-first / network-update patterns.
- **Expo SQLite** as the persistence layer behind TanStack Query's
  `persistQueryClient` plugin. Cached query results + pending
  mutations survive app restart.
- **Mutation queue** for offline writes (check-out, inspection
  submission, damage report). Each mutation is recorded as a row
  in the local SQLite `pending_mutations` table; the sync engine
  replays them when connectivity returns.
- **Conflict resolution: server-wins.** If a pending mutation
  conflicts with the server's current state (e.g., reservation
  already canceled by dispatcher), the server's response is
  authoritative; the app surfaces the conflict to the driver with
  a remediation prompt. No CRDT, no last-write-wins, no
  three-way-merge. Matches the audit-chain immutability discipline
  of the core-api (per ADR-0003 + the digest pre-image work in
  migration 0021).
- **NO WatermelonDB / Realm / RxDB.** TanStack Query + Expo SQLite
  + a thin sync engine is sufficient and avoids the steep learning
  curve + maintenance cost of those alternatives.

The sync engine lives in `apps/driver-app/src/sync/`. It exposes
`enqueueMutation(name, payload)` to features and runs an
`onForeground` + `onConnectivityChange` flush. Mutations are
acknowledged by the server's HTTP 2xx + an `If-Match`-style
version check (the core-api endpoints accept the reservation /
inspection version known to the client; mismatch returns 409 with
the current state).

### 5. Navigation: React Navigation

- **React Navigation v6+** with the `native-stack` navigator for
  the primary screen graph. Bottom tabs only if usage patterns
  demand them (likely not — drivers do one task at a time).
- **Deep linking** via `panorama://r/:reservationId` (custom URL
  scheme) + Universal Links / App Links (`panorama.example.com/r/:id`
  on the hosted-app domain redirects to the app, falls back to web
  `/me`). The QR codes printed on cab dashboards encode the
  Universal Link form.
- **NO Expo Router file-based routing in this app.** React
  Navigation's imperative + typed API is more legible for the
  small screen graph (∼6 screens: enroll, my-reservations, next-
  reservation, inspection, return, settings).

### 6. Observability: @sentry/react-native (separate Sentry project)

- **@sentry/react-native** (the Expo-compatible variant), gated on
  the same `SENTRY_DSN_MOBILE` env var (separate from the core-api's
  `SENTRY_DSN`, per ADR-0018's opt-in model).
- **Separate Sentry project** for the mobile surface. Shares the
  same operator's quota but isolates the issue stream so a flood
  of crashes on a specific Android model doesn't contaminate the
  core-api's issue triage.
- **Source map upload via EAS Build hooks** so stack traces are
  symbolicated. Sentry DSN baked into the binary at build time (NOT
  shipped via OTA update).
- **No analytics, no Mixpanel, no Firebase Analytics.** Same anti-
  goal as the web app (per ADR-0014 hosted-instance constraints).
  The privacy policy commitments in PR #245 apply to the mobile
  app too.

### 7. Camera + photo pipeline

- **Expo Camera** (`expo-camera`) for the inspection capture flow.
  Capture → Expo ImageManipulator (EXIF strip + downscale if larger
  than the configured ceiling) → upload via the existing
  presigned-URL flow from `apps/core-api/src/modules/object-storage/`.
- **Offline draft via Expo SQLite**: when no signal, captures are
  written to the local `pending_uploads` table with their tenant +
  inspection-item linkage; sync engine flushes on connectivity
  return.
- **EXIF strip happens on-device** before the bytes leave the
  phone. The core-api retains its own EXIF strip as defence in
  depth (per ADR-0012), but the driver's GPS coordinates never
  enter Panorama's storage.

### 8. Push notifications

- **Expo Notifications** (FCM on Android, APNs on iOS via Expo's
  managed credential pipeline).
- **Triggered server-side** by the existing NotificationModule
  (per ADR-0011 event bus) when:
  - A new reservation is assigned to the driver
  - A reservation's status changes (approved, canceled, vehicle
    swapped)
  - A maintenance alert affects the driver's current reservation
  - A tenant-wide announcement is published (P0 incident, etc.)
- **Device registration** happens at enrollment time (decision §3);
  the device-token PAT carries the FCM / APNs token in its
  metadata.

### 9. End-to-end testing: Maestro

- **Maestro** for the e2e test surface, not Detox.
- Reason: Maestro's YAML-based DSL is simpler than Detox's JS
  scripting; setup is lighter (no Xcode rebuild per change); the
  mobile e2e surface is small enough that Maestro's expressiveness
  ceiling is not a constraint. Detox is more powerful but the
  power isn't needed for a 6-screen app.
- **CI gate**: `driver-native-smoke.maestro.yml` runs against an
  Android emulator + iOS simulator in EAS Build's CI workflow.
  Required before Wave B closes.

### 10. Build distribution

- **Internal track (design partners)**: TestFlight (iOS) + Play
  Internal Track (Android). Invite-only, signed with the
  maintainer's Apple Developer Program identity + Google Play
  Developer account.
- **Production track (App Store + Play Store)**: gated on the URL
  flip (Wave 0 §10) + the v2 6-agent scan acceptance + counsel
  review on legal pages (#245).
- **EAS Update OTA** for JS-only changes between binary releases.
  Native code changes require a new binary upload + store review.

### 11. AGPL compliance

The Expo app ships under AGPL same as the rest of Panorama. Per
AGPL §5(d), the source is published at the same repo URL; the
about screen in the app links to that source. The Apple App Store
+ Google Play Store policies are compatible with AGPL for an app
where the operator (maintainer) is the publisher; the binary is
shipped via the stores under the same license as the source.

The "network-use is conveyance" surface of AGPL §13 applies if
the mobile app talks to a remote core-api (which it does for the
hosted instance). The hosted-app server-side AGPL §13 obligations
are met by the existing
`https://github.com/VitorMRodovalho/panorama` link in the legal
pages from PR #245.

## Consequences

### Positive

- The driver persona's "first 5 minutes after login" gap closes
  (per persona-fleet-ops planning round §3). FleetManager v2.1's
  `my_bookings.php` parity achievable in Wave B; the photo-evidence
  GA via `Expo Camera + ImageManipulator + presigned-URL upload`
  pipeline is operationally superior to the web's service-worker
  shim.
- Native APIs unlock the 5am bus-barn scenario in ways a PWA
  cannot: foreground/background camera reliability, persistent
  notifications across app restarts, OS-level credential storage
  (Keychain / KeyStore), background sync that survives the
  service-worker eviction the browser would otherwise impose.
- Sub-1-second QR-scan-to-check-out flow becomes feasible (web
  PWA hits the 1-3 second range at best due to service-worker
  startup + cache hydration).
- Separates the driver issue stream from the core-api issue
  stream (Sentry project split) — Android-specific crashes don't
  pollute backend triage.
- Procurement-credibility differentiator: enterprise buyers ask
  "do you have a mobile app?" and the answer is now yes, with
  TestFlight / Play Internal evidence available pre-GA.

### Negative

- **Second build pipeline.** EAS Build + EAS Update is operationally
  one more system to keep healthy + one more set of credentials to
  rotate per `docs/runbooks/secrets-rotation.md` (added in a future
  PR alongside Wave B PR1).
- **Second test surface.** Maestro CI run is its own pipeline,
  separate from the web's Playwright e2e + the core-api's vitest.
  Adds ~5-10 min to the CI matrix.
- **App Store / Play Store review cycles.** Each binary release
  goes through Apple's 24-48 hour review + Google's typical
  4-hour review. OTA updates via EAS Update bypass this for
  JS-only changes but require care that no native module bumps
  sneak through.
- **Developer Program fees.** Apple Developer Program $99/year +
  Google Play Developer one-time $25. Operating cost the maintainer
  accepts.
- **Bus-factor risk amplified.** The maintainer (bus-factor 1)
  now maintains a second runtime; if mobile build breaks, fix
  requires Expo / React Native expertise. Documented in the
  Wave B PRs + the secrets-rotation runbook's mobile section.
- **AGPL store-distribution discussion.** App Store + Play Store
  policies on AGPL'd apps have edge cases (e.g., the App Store
  bans some copyleft licenses' source-availability requirements
  in specific ways). The maintainer accepts the risk that a store
  may reject the listing; mitigation is documented at submission
  time. The hosted-app web surface continues regardless.

### Neutral / locked-in

- The driver persona's primary UX surface is the Expo app
  henceforth. The web `/me` fallback (ADR-0021 §4) exists for
  desktop-only edge cases but is NOT the canonical driver
  experience.
- Future driver-adjacent features (push-to-talk, dashcam
  integration, telematics polling) land in the Expo app first;
  the web mirror catches up opportunistically or stays unimpl-
  emented if not justified.
- The PersonalAccessToken model becomes the device-token home —
  no parallel Mobile-only Auth table.
- TanStack Query is the ONLY client-side data-fetching library
  in Panorama's client surfaces (Expo app uses it; web app does
  NOT per ADR-0021 §2). No cross-app sharing of query keys or
  cache; each app owns its own.

## Alternatives considered

### A. PWA on the existing Next.js web app

Service-worker + offline storage via IndexedDB + add-to-home-
screen prompt. The original `(driver)/` route group plan in
earlier roadmap drafts.

**Why not:** maintainer decision #3 on 2026-05-18. Specifically:
camera reliability + persistent push notifications + Keychain-
grade credential storage are materially better with native than
with a service-worker PWA in the 5am-bus-barn scenario. The
product-lead anti-goal "no native mobile app before PWA" is
acknowledged + overridden.

### B. Capacitor / Ionic hybrid

Wrap the Next.js app in a Capacitor shell to get a "native
binary" that shares 90% of its code with the web app.

**Why not:** the share-with-web claim is true in theory but the
driver UX is genuinely different from the desktop dispatcher UX
(persona walkthroughs in the roadmap confirm). Capacitor adds a
build step + a UIWebView abstraction layer without delivering
native-API quality for camera / SQLite / push. The "shared
codebase" wins less than the planning round expected.

### C. Flutter

Cross-platform native via Dart + Flutter's widget tree.

**Why not:** introduces a third language (Dart) + a separate
ecosystem. The maintainer's existing TS / React expertise
transfers to React Native + Expo with minimal new conceptual
overhead. Flutter's UI ceiling is higher in some respects but
the price (a new toolchain + new community + new hiring pipeline)
isn't justified at this scale.

### D. Vanilla React Native (bare workflow)

Skip Expo and run on bare React Native with full native control.

**Why not:** EAS Build + EAS Update deliver 90% of the operational
upside (reproducible cloud builds, OTA updates) for 10% of the
maintenance cost. Bare workflow's "full control" is needed only
if a native module isn't covered by Expo's managed APIs — none
of our planned features triggers that today (Camera, SQLite,
Notifications, Linking, SecureStore are all Expo-managed).

### E. WebView wrapper around the existing web app

A native shell that opens `panorama.vitormr.dev/me` in a UIWebView.

**Why not:** identical UX to a browser bookmark with extra
maintenance overhead. App Store / Play Store reject "webview
wrappers without significant native features" per their guidelines.
Wasted effort.

### F. Separate codebase per platform (Swift + Kotlin)

Native iOS in Swift + native Android in Kotlin, no cross-platform
layer.

**Why not:** doubles the surface area, doubles the build + test
+ release pipeline cost, requires Swift + Kotlin expertise on top
of TS. Justified only if a specific native capability is unreachable
through Expo's managed layer — not the case today.

### G. WatermelonDB / Realm / RxDB instead of TanStack Query + Expo SQLite

Use a heavier offline-first DB engine that handles sync state +
conflict resolution as a first-class concern.

**Why not:** these engines optimise for the case where the
client is an authoritative writer in conflict with the server.
Panorama's server is the authority (audit-chain immutability,
RLS enforcement); the client is a cache + a mutation queue.
TanStack Query + Expo SQLite + a thin sync engine matches that
shape. WatermelonDB et al would over-engineer the sync problem
for the trade-off they impose (learning curve, schema migrations
in two places, schema-drift risk).

### H. Detox instead of Maestro for e2e

Detox is the older, more established React Native e2e framework.

**Why not:** Maestro's YAML DSL is simpler; the 6-screen surface
of this app doesn't need Detox's depth. The CI integration is
also lighter (no Xcode rebuild per test change). If Maestro proves
inadequate as the app grows, an ADR amendment can swap.

## Implementation notes

Sequencing within Wave B (per the roadmap):

1. **PR — Expo app scaffold.** `apps/driver-app/` workspace + Expo
   SDK init + EAS Build config + minimal "hello world" screen + CI
   wiring (lint + typecheck for the new workspace).
2. **PR — Device-token PAT + enrollment flow.** Backend extension
   to `PersonalAccessToken.scope`; new `/auth/device/{start,finish}`
   endpoints; web `/me?enroll=true` UI hook; mobile enrollment
   screen + SecureStore wire.
3. **PR — My-reservations + next-reservation screens.** Offline-
   first via TanStack Query + Expo SQLite; mutation queue
   scaffolding (server-wins conflict resolution).
4. **PR — Inspection capture flow.** Expo Camera + ImageManipulator
   + presigned-URL upload + offline draft via SQLite.
5. **PR — QR deep-link routing.** Universal Links / App Links
   configuration; `panorama://r/:id` scheme; in-app router dispatch
   based on reservation status.
6. **PR — Push notifications.** Expo Notifications integration +
   server-side trigger from NotificationModule events.
7. **PR — FEATURE_INSPECTIONS canary close.** Flip the backend
   feature flag default-on (closes 0.3 #4 per the project memory);
   remove the conditional in code.
8. **PR — Maestro e2e gate.** `driver-native-smoke.maestro.yml`
   added to CI; required before Wave B closes.
9. **PR — Web `/me` fallback minimal.** The desktop-driver edge-
   case route in `apps/web/` (per ADR-0021 §4); ships alongside
   the Expo app to keep the persona accessible from a yard
   supervisor's terminal.
10. **PR — Persona walkthrough doc.** `docs/audits/walkthrough-
    wave-B-<date>.md` covering: driver scans cab QR → enrollment
    on first launch → check-out vehicle 47 in 2 clicks → 3-photo
    pre-trip inspection on a 5-year-old Android in airplane mode
    → driver returns to depot, signal returns, photos upload,
    driver checks in 3 hours later.
11. **PR — TestFlight + Play Internal first invites.** Maintainer
    invites the first 3 design partners; Wave B is canary-ready.

**Exit criteria for Wave B:** ADR-0022 Accepted (this ADR); the
above 11 PRs landed; FEATURE_INSPECTIONS default-on flipped;
Maestro CI gate green; TestFlight / Play Internal active with
first design-partner installs.

**Wave B GA gate:** App Store + Play Store production listing
goes live only after:
- Wave 0 §10 v2 6-agent scan green-lights
- Wave 0 §9 counsel review on legal pages complete
- Hosted-URL flip (ADR-0014 amendment) accepted
- Design-partner feedback from the TestFlight / Play Internal
  cohort surfaces no P0 blockers

The store-listing process itself (screenshots, app description,
privacy policy URL pointing to `/legal/privacy`, age rating, etc.)
is a Wave B-end deliverable handled by the maintainer.

The ADR is forward-only: no plan to migrate the web app's `/me`
fallback to a native shell; no plan to add a second mobile-shaped
client (e.g., a separate maintenance-tech app). If a future persona
demands its own native surface, an ADR amendment justifies it
before the workspace is created.
