# SBOM + supply-chain verification runbook

> **Status.** Round 7 §9 of the Wave 0 plan. Ships the
> infrastructure now (`.github/workflows/sbom.yml`); the first
> signed-release tag is operator-side when the maintainer cuts
> v0.x.

This page tells operators (self-hosters + procurement reviewers +
the hosted-instance maintainer) how Panorama's Software Bill of
Materials (SBOM) is generated, signed, distributed, and verified.

The companion artefact is `.github/workflows/sbom.yml` — a CI
workflow that emits a CycloneDX 1.5 JSON SBOM on every push to
main and signs it via `cosign sign-blob` keyless (sigstore Fulcio
+ GitHub OIDC, no key management) when a release tag is pushed.

## What the SBOM contains

A CycloneDX JSON document listing every npm dependency Panorama
installs at runtime, with:

- Package name + version
- License (when declared in `package.json`)
- Package URL (PURL) — canonical identifier for the registry source
- Hashes (when present in the lockfile)
- Dependency tree relationships

What it does **NOT** contain:

- devDependencies (vitest, prettier, eslint, etc.) — stripped by
  `pnpm install --prod`. SBOM reflects what ships, not what builds.
- Postgres / Redis / Docker base-image dependencies. The SBOM is
  scoped to the Node.js runtime surface; OS-level dependencies
  live in the container's separate SBOM (out of scope today; see
  §"What this runbook does NOT cover").

## Where to find the SBOM

### Latest main-branch SBOM (always available)

GitHub Actions tab → `SBOM + sigstore signing` workflow → most
recent run on `main` → Artifacts → `panorama-sbom-<sha>`.

```
https://github.com/VitorMRodovalho/panorama/actions/workflows/sbom.yml
```

90-day retention per GitHub Actions default. Re-runnable via
`workflow_dispatch` for ad-hoc regeneration after a security
advisory drops.

### Tagged-release SBOM (signed)

When the maintainer cuts a release tag (`v0.x`, `v1.0`, etc.), the
workflow:

1. Regenerates the SBOM
2. Signs it via cosign keyless (GitHub OIDC → Fulcio → ephemeral
   cert; signature logged to Rekor transparency log)
3. Attaches three files to the GitHub release:
   - `panorama-sbom.json` — the SBOM itself
   - `panorama-sbom.json.sig` — detached signature
   - `panorama-sbom.json.crt` — Fulcio cert tying the signature
     to the workflow run that produced it

Releases live at:

```
https://github.com/VitorMRodovalho/panorama/releases
```

Each release's Assets section carries the three files.

## How to verify a signed SBOM

Install cosign (one-time setup):

```bash
# macOS
brew install cosign

# Linux (Debian/Ubuntu)
curl -fsSL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 \
    -o /usr/local/bin/cosign
chmod +x /usr/local/bin/cosign

# Verify the install
cosign version
```

Verify the SBOM signature:

```bash
# Download the three files from the release Assets:
gh release download v0.x -p 'panorama-sbom.json*'

# Verify against the GitHub-OIDC identity that signed.
# The cert-identity-regexp matches any workflow run on the panorama
# repo's main branch; the cert-oidc-issuer is the GH Actions OIDC
# provider.
cosign verify-blob \
    --signature panorama-sbom.json.sig \
    --certificate panorama-sbom.json.crt \
    --certificate-identity-regexp "https://github.com/VitorMRodovalho/panorama/.github/workflows/sbom.yml@refs/tags/v.*" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    panorama-sbom.json
# Verified OK
```

A successful verification proves:

1. The SBOM was produced by the official Panorama CI workflow on
   the named release tag.
2. The signing certificate was issued by sigstore Fulcio (not a
   self-signed cert pretending to be Panorama).
3. The signing event was logged to the Rekor transparency log —
   irreversible audit trail visible at
   [search.sigstore.dev](https://search.sigstore.dev/).

If verification fails: do NOT trust the SBOM. Open a Security
Advisory at the panorama repo per
[`SECURITY.md`](../../SECURITY.md). A failed signature on a
release artefact is a supply-chain compromise signal.

## Using the SBOM for vulnerability scanning

The CycloneDX format is consumed by every major SCA scanner:

- **Trivy:** `trivy sbom panorama-sbom.json`
- **Grype:** `grype sbom:./panorama-sbom.json`
- **OWASP Dependency-Track:** upload as a project version
- **Snyk:** `snyk test --sbom panorama-sbom.json`
- **JFrog Xray:** consume via the Bill-of-Materials API

The SBOM acts as the input to **your** scanner with **your**
policy. The maintainer does not run a continuous SBOM-driven
scanner today (see §"What this runbook does NOT cover"); operators
are encouraged to wire one up.

## SBOM regeneration cadence

- **On every push to main** that touches `package.json`,
  `pnpm-lock.yaml`, or workspace package manifests. Stale SBOMs
  cannot drift from the lockfile.
- **On manual trigger** via `workflow_dispatch` for ad-hoc fresh
  snapshots.
- **On release tag** with cosign signing + release attachment.

Cron-driven regeneration on a quiet codebase is unnecessary — the
SBOM only changes when dependencies change, and dependency changes
flow through PR merges to main.

## Self-host operator guidance

A self-hoster running Panorama in their own environment should:

1. **Verify the release SBOM signature** before each upgrade
   (procedure above).
2. **Run their own SCA scanner** against the SBOM (Trivy / Grype /
   whatever your security baseline mandates). Panorama's CI runs
   Trivy on the source tree (`.github/workflows/ci.yml` → Trivy
   step); operators should ALSO run their own to catch the gap
   between "code in repo" and "code as deployed in your
   environment".
3. **Cache the SBOM** in their internal compliance archive. Some
   procurement reviews ask for "the SBOM as of the version you're
   running" historically; the GitHub release page is the source of
   truth.

## For procurement / due diligence reviewers

A summary of Panorama's supply-chain posture as of 2026-05-18:

| Property | Status |
|---|---|
| SBOM format | CycloneDX 1.5 JSON |
| SBOM generation | Reproducible via `pnpm install --prod --frozen-lockfile` + `@cyclonedx/cyclonedx-npm@^3` |
| Signing | cosign keyless (sigstore Fulcio + GH OIDC) on release tags |
| Transparency log | Rekor — every signing event publicly auditable |
| Lockfile pinning | pnpm-lock.yaml committed; CI gates use `--frozen-lockfile` |
| Dependency licence scan | `pnpm dlx license-checker-rseidelsohn` on every PR (per CI `Dependency licence scan` gate) |
| Static analysis | CodeQL (JS/TS + GH Actions) on every PR |
| SAST | Trivy filesystem scan on every PR |
| Secret scanning | Gitleaks on every PR |
| OSSF Scorecard | Weekly + on every push to main |

For deeper questions, contact `vitor@vitormr.dev`.

## What this runbook does NOT cover

- **Container-image SBOMs.** Panorama ships as a Node app + npm
  deps SBOM; the Docker base images (`node:22-alpine`, etc.) have
  their own SBOMs published by their maintainers. Operators
  running containerised deployments should generate their image
  SBOM via `syft <image>` or `trivy image --format cyclonedx`.
- **Runtime attestation / SLSA build provenance.** Out of scope
  for the Community-edition free preview. SLSA Level 3 attestation
  is a future Round (post-1.0) item.
- **Continuous SBOM-driven vulnerability monitoring.** Operators
  wire up their own SCA scanner (Trivy, Grype, Dependency-Track,
  Snyk, etc.) and feed it the SBOM. Panorama's CI runs SCA on the
  source tree but does NOT run a continuous SBOM-against-CVE
  monitor — that's a Round 7 sibling deliverable if the
  maintainer scopes it.
- **Closed-source dependency disclosure.** Panorama has none today
  (AGPL stack); if it ever adds one (e.g., a managed Enterprise
  dependency), the SBOM mark for closed-source surfaces stays
  honest via CycloneDX's `licenses` field.
- **Cross-repo / multi-repo SBOM aggregation.** Panorama is a
  single repo today. Operators with a multi-repo deployment that
  also runs sister tools (e.g., a forked plugin, custom
  middleware) generate their own aggregated SBOM via their
  internal toolchain.

## Drill cadence

Once a quarter, verify the latest release's SBOM signature
end-to-end:

1. Pull the SBOM + sig + cert from the most recent release
2. Run `cosign verify-blob` per the procedure above
3. Confirm Rekor entry visible at search.sigstore.dev
4. Record the drill in the audit log via
   `panorama.maintainer.sbom_verify_completed` (action name
   reserved; emitter is a Round 7 follow-up PR alongside the
   `restore-drill-due` cron)

Pair this drill with the restore drill ([`restore.md`](./restore.md))
and the status-page drill ([`status-page.md`](./status-page.md))
into one quarterly operator-hour slot.
