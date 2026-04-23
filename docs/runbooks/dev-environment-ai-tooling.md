# Runbook — Safe dev-environment AI tooling

_Last reviewed: 2026-04-23 (drafted from Wave 3b audit, finding MCP-01). Next review: 2026-07-23 or sooner if new AI-supply-chain CVEs disclosed._

## Why this exists

On 2026-04-20, OX Security disclosed design-level RCE vulnerabilities in Anthropic's MCP (Model Context Protocol) SDK:

- CVE-2025-49596 (MCP Inspector)
- CVE-2026-22252 (LibreChat)
- CVE-2026-22688 (WeKnora)
- CVE-2025-54994 (`@akoskm/create-mcp-server-stdio`)
- CVE-2025-54136 (Cursor)
- Plus 10 new CVEs in LiteLLM, LangChain, LangFlow, Flowise, LettaAI, LangBot, Windsurf, and others.

The core flaw: MCP's STDIO transport allows editing an MCP configuration file to trigger **arbitrary OS command execution** on the host running the MCP. One category is **zero-click prompt injection** — an attacker-controlled prompt can cause an AI assistant to edit an MCP config and thereby run commands with no user interaction.

**Anthropic has declined to patch the reference implementation, calling the behaviour "expected."** The risk is ongoing and not fully remediable upstream.

Reference: [The Hacker News — Anthropic MCP Design Vulnerability Enables RCE](https://thehackernews.com/2026/04/anthropic-mcp-design-vulnerability.html).

## Scope

This runbook applies to **every contributor** whose development workstation has access to:

- Any Panorama source repository
- Any `.env` file used with Panorama (dev, staging, or production)
- Any credential that can access a Panorama Postgres, Redis, object store, or cloud account
- Any code-signing key, Git PAT, or SSH key used with the Panorama project

## What's at risk on your workstation

| Asset | Typical location | Compromise impact |
|---|---|---|
| `DATABASE_URL`, `SESSION_SECRET` | `.env`, shell history | Full-tenant data read; session forgery |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `.env` | Photo storage exfil or wipe |
| SMTP credentials | `.env` | Email spoofing as Panorama |
| Supabase service-role key | `.env` (staging) | Cross-tenant RLS bypass on staging |
| Git PAT, SSH key | `~/.gitconfig`, `~/.ssh/` | Repo tampering; malicious commit to `main` |
| Cloud provider tokens | `~/.config/`, env | Full cloud account takeover |
| Source code | Project directory | AGPL — leak is reputational, but credentials are the real loss |

## Allowed MCP servers

Use only MCP servers on the verified list. Current list (2026-04-23):

| MCP server | Purpose | Verified version | Verified by / date |
|---|---|---|---|
| Supabase MCP | Schema management, migrations | `<pin the version>` | `<maintainer>` / `<date>` |
| _Others_ | Require maintainer approval before use | — | — |

The list is short on purpose. Any MCP server not on this list is **forbidden** until reviewed and added.

## Forbidden

- Installing MCP servers from unverified marketplaces or community repos.
- Running MCP servers referenced in PRs or branches you have not personally reviewed line-by-line.
- Sharing MCP configuration files that embed credentials.
- Running MCP servers as root or with unrestricted filesystem/network access.
- Enabling auto-update on any MCP server.

## Hardening steps

### 1. Isolate MCP servers

Run each MCP server in a container or isolate with no host filesystem access beyond the project directory (read-only). Example Docker pattern:

```bash
docker run --rm -it \
  --read-only \
  --tmpfs /tmp \
  --network bridge \
  --cap-drop ALL \
  -v "$PWD:/workspace:ro" \
  mcp-server:<pinned-version>
```

### 2. Credential hygiene

- Don't keep production credentials on dev machines. Use `doppler run`, `op run`, or equivalent — credentials should be ephemeral, not in `.env`.
- Dev/staging `.env` values should be rotatable at short notice (< 1 hour).
- Never commit `.env` (already enforced by `.gitignore` + gitleaks).

### 3. Review MCP server source before first use

Before running any MCP server, grep it for:

- `child_process.exec` / `spawn` / `execSync` — arbitrary command execution
- File system writes outside the project directory
- Network calls to unexpected domains
- `eval` / `new Function` — runtime code generation

If any of these appear without clear justification, don't run the server.

### 4. Pin MCP server versions

Don't auto-update. Review the upstream changelog line-by-line before bumping.

### 5. Separate AI-assisted work from credentialed work

Consider running AI coding tools (Cursor, Claude Desktop) in a separate OS user or a VM that has no access to your production `.env` or staging credentials. This is friction, but it collapses the blast radius if an MCP server is compromised.

## If you suspect compromise

1. **Immediately rotate** every credential that was reachable from your workstation:
   - All `.env` file values: `DATABASE_URL` password, `SESSION_SECRET`, `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, `SMTP_PASSWORD`, Supabase service-role key, any cloud provider token.
   - Revoke GitHub PATs and SSH keys. Generate new ones.
   - If you've used `sudo` recently on the machine, rotate the root password too.
2. **Notify** the maintainer at `security@vitormr.dev` (see `SECURITY.md`). Include:
   - Which MCP server(s) you were running.
   - When you last ran each.
   - Which credentials were accessible at that time.
3. **Preserve logs.** Don't delete MCP server logs, terminal history (`~/.bash_history`, `~/.zsh_history`), or your shell session.
4. **Scan for unexpected processes:**
   ```bash
   ps aux | grep -iE "mcp|node" | grep -v grep
   ```
5. **Check git history for unexpected commits:**
   ```bash
   git log --all --oneline --since="7 days ago"
   git fsck --full
   ```
6. **Review AWS / Cloudflare / Fly.io / Supabase audit logs** for activity from your workstation IP in the last 30 days.
7. Do not push any further commits from this workstation until the maintainer clears it.

## Why we wrote this

The Panorama product itself does not use MCP today (verified — `pnpm ls -r --depth 999` returns no matches for `@modelcontextprotocol/*` or any transitive MCP SDK). The risk addressed by this runbook is **supply-chain via contributor workstation**, not product surface.

See also: ADR-0017 (AI/LLM integration principles) for the policy governing future product-side AI integrations.
