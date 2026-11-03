#!/usr/bin/env bash
# scripts/setup-staging-env.sh
#
# Interactive helper to populate apps/core-api/.env.staging with the
# two Supabase connection strings needed to apply migrations + rls.sql
# against the staging project. The .env.staging path is gitignored
# (`apps/*/.env` line in .gitignore), so re-running this is the
# rotation path too.
#
# What you need before running:
#   * Supabase project unpaused.
#   * `psql` (16+) installed locally — script uses it to verify both
#     URLs reach the database before writing.
#   * The project's CA certificate ("Supabase Root 2021 CA"), downloaded
#     from Database Settings → SSL Configuration. Pass its path in
#     SUPABASE_CA_FILE or type it at the prompt. Node does not trust this
#     CA by default, so without it the API cannot connect at all; see
#     docs/en/self-hosting.md, "Supabase: trust the provider's CA".
#   * Two connection strings, copied from Supabase dashboard:
#       Settings → Database → Connection string
#       1) "Connection pooling" tab, mode "Transaction" (port 6543)
#       2) "Direct connection" (port 5432)
#
# TLS: the script replaces any TLS parameters in the pasted URLs with
# the ones each client needs, and probes with `sslmode=verify-full`.
# A probe with `sslmode=require` would prove nothing: psql (libpq)
# encrypts without verifying in that mode, and the API (node-postgres)
# verifies, so the old probe passed in exactly the case the API fails.
#
# What the script does NOT do:
#   * Apply any migrations or run any DDL — connections are SELECT 1
#     reads only.
#   * Send the password anywhere besides `psql` and the local file.
#
# Privacy note: the connection string contains the password and will
# appear briefly in your local `ps` listing while psql runs. Process
# cmdlines are readable by your own user only on default Linux configs;
# if your workstation is shared, run this in a private session.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$REPO_ROOT/apps/core-api/.env.staging"

# --- 0. Refuse to overwrite without explicit y --------------------
if [ -f "$TARGET" ]; then
  echo
  echo "$TARGET already exists."
  read -r -p "Overwrite? (type 'yes' to continue, anything else aborts): " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborted. Existing file unchanged."
    exit 1
  fi
fi

# --- 1. Prereq check ----------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: 'psql' not found in PATH. Install postgresql-client (16+)." >&2
  exit 1
fi
PSQL_VER=$(psql --version | awk '{print $3}' | cut -d. -f1)
if [ "$PSQL_VER" -lt 14 ]; then
  echo "WARN: psql is v$PSQL_VER. Supabase prefers 14+; v16 recommended."
fi

# --- 1b. The provider's CA certificate ----------------------------
# SHA-256 of "Supabase Root 2021 CA" (valid until 2031-04-26). A
# mismatch is a warning, not an error: Supabase may issue a new root.
SUPABASE_ROOT_2021_SHA256="80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA"
CA_FILE="${SUPABASE_CA_FILE:-}"
if [ -z "$CA_FILE" ]; then
  echo
  echo "Path to the Supabase CA certificate (Database Settings → SSL"
  echo "Configuration)."
  read -r -p "      CA file: " CA_FILE
fi
if [ ! -f "$CA_FILE" ] || [ ! -r "$CA_FILE" ]; then
  echo "ERROR: CA file not found or not readable." >&2
  exit 1
fi
CA_FILE="$(cd "$(dirname -- "$CA_FILE")" && pwd -P)/$(basename -- "$CA_FILE")"
# The path goes into the URLs as is, so keep it free of characters
# that a URL or a shell would read differently.
if ! [[ "$CA_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ERROR: move the CA file to a path made only of letters, digits, '.', '_', '-' and '/': $CA_FILE" >&2
  exit 1
fi
if command -v openssl >/dev/null 2>&1; then
  if ! CA_FP=$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 2>/dev/null); then
    echo "ERROR: $CA_FILE is not a PEM certificate." >&2
    exit 1
  fi
  CA_FP="${CA_FP#*=}"
  echo "  CA: $(openssl x509 -in "$CA_FILE" -noout -subject 2>/dev/null)"
  echo "      sha256 $CA_FP"
  if [ "$CA_FP" != "$SUPABASE_ROOT_2021_SHA256" ]; then
    echo "WARN: this is not the Supabase Root 2021 CA. Compare it with the"
    echo "      certificate the dashboard offers before you continue."
  fi
fi

# Rebuild a URL with the given TLS parameters, dropping any the pasted
# URL carried and keeping every other parameter.
with_tls_params() {
  local url="$1" tls="$2" base query="" kv
  local -a parts=() kept=()
  base="${url%%\?*}"
  if [[ "$url" == *\?* ]]; then query="${url#*\?}"; fi
  IFS='&' read -r -a parts <<<"$query"
  for kv in "${parts[@]}"; do
    case "$kv" in
      ''|sslmode=*|sslrootcert=*|sslcert=*|sslkey=*|sslaccept=*) ;;
      *) kept+=("$kv") ;;
    esac
  done
  kept+=("$tls")
  local IFS='&'
  printf '%s?%s' "$base" "${kept[*]}"
}

# --- 2. Prompt for both URLs (hidden input) -----------------------
echo
echo "Paste the two connection strings from Supabase dashboard."
echo "(Settings → Database → Connection string. Use the 'Copy' button"
echo " — paste; characters won't appear as you type.)"
echo
echo "1/2 — Connection pooling (Transaction mode, port 6543)."
echo "      This becomes DATABASE_URL (used by the app at runtime)."
echo "      Shape: postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:6543/postgres?..."
read -r -s -p "      Paste: " DB_URL
echo
echo
echo "2/2 — Direct connection (port 5432)."
echo "      This becomes DATABASE_PRIVILEGED_URL (used for rls.sql DDL)."
echo "      Shape: postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres"
echo "      (TLS parameters in either URL are replaced; see the header.)"
read -r -s -p "      Paste: " DB_PRIV_URL
echo
echo

# --- 3. Basic shape validation ------------------------------------
if ! grep -qE '^postgres(ql)?://[^[:space:]]+' <<<"$DB_URL"; then
  echo "ERROR: DATABASE_URL doesn't look like a Postgres URL." >&2
  exit 1
fi
if ! grep -qE '^postgres(ql)?://[^[:space:]]+' <<<"$DB_PRIV_URL"; then
  echo "ERROR: DATABASE_PRIVILEGED_URL doesn't look like a Postgres URL." >&2
  exit 1
fi

# Heuristic warnings, not hard failures (Supabase URL formats evolve).
if ! grep -q ':6543/' <<<"$DB_URL"; then
  echo "WARN: DATABASE_URL has no :6543 port — make sure you copied the POOLER URL."
fi
if ! grep -q ':5432/' <<<"$DB_PRIV_URL"; then
  echo "WARN: DATABASE_PRIVILEGED_URL has no :5432 port — make sure you copied the DIRECT URL."
fi
if [ "$DB_URL" = "$DB_PRIV_URL" ]; then
  echo "ERROR: Both URLs are identical — check you didn't paste the same one twice." >&2
  exit 1
fi
# The file below single-quotes each value so that `&` survives
# `set -a && . apps/core-api/.env.staging`.
if [[ "$DB_URL$DB_PRIV_URL" == *"'"* ]]; then
  echo "ERROR: a URL contains a single quote. Percent-encode it as %27 in the password." >&2
  exit 1
fi

# --- 3b. TLS parameters per client ---------------------------------
# DATABASE_URL and DATABASE_PRIVILEGED_URL are read by the API
# (node-postgres) and DATABASE_PRIVILEGED_URL also by psql in
# apply-migrations.sh: both verify chain and host name against
# sslrootcert with sslmode=verify-full.
# DATABASE_DIRECT_URL is read only by `prisma migrate deploy`. Prisma's
# schema engine ignores sslrootcert and verifies nothing unless the URL
# says sslaccept=strict, with the CA in sslcert. node-postgres and psql
# read sslcert as a client certificate, so this form stays in
# DATABASE_DIRECT_URL. Measured with Prisma 7.10.1, pg 8.23.1, psql 18.
DB_URL=$(with_tls_params "$DB_URL" "sslmode=verify-full&sslrootcert=$CA_FILE")
DB_DIRECT_URL=$(with_tls_params "$DB_PRIV_URL" "sslmode=require&sslaccept=strict&sslcert=$CA_FILE")
DB_PRIV_URL=$(with_tls_params "$DB_PRIV_URL" "sslmode=verify-full&sslrootcert=$CA_FILE")

# --- 4. Sanity ping each connection (non-destructive) -------------
# sslmode=verify-full: a certificate that does not chain to the CA, or
# a host name the certificate does not cover, fails the probe.
echo "→ Probing pooler connection (DATABASE_URL)..."
if ! POOLER_OUT=$(PGOPTIONS='-c statement_timeout=10000' \
    psql "$DB_URL" -tA -c "SELECT current_user || ' @ ' || inet_server_addr() || ':' || inet_server_port();" 2>&1); then
  echo "ERROR: pooler connection failed:" >&2
  echo "$POOLER_OUT" >&2
  exit 1
fi
echo "  ok: $POOLER_OUT"

echo "→ Probing direct connection (DATABASE_PRIVILEGED_URL)..."
if ! DIRECT_OUT=$(PGOPTIONS='-c statement_timeout=10000' \
    psql "$DB_PRIV_URL" -tA -c "SELECT current_user || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user;" 2>&1); then
  echo "ERROR: direct connection failed:" >&2
  echo "$DIRECT_OUT" >&2
  exit 1
fi
echo "  ok: $DIRECT_OUT"

# Quick sanity: privileged URL should be 'postgres' (Supabase) or
# 'panorama_super_admin' (self-hosted). Either should have BYPASSRLS.
if ! grep -q 'bypassrls=t' <<<"$DIRECT_OUT"; then
  echo "WARN: privileged role does NOT have BYPASSRLS. rls.sql apply may fail."
  echo "       (On Supabase the right user is 'postgres'.)"
fi

# --- 5. Write the file with restrictive perms ---------------------
# Write DATABASE_DIRECT_URL alongside DATABASE_PRIVILEGED_URL — they
# point to the same direct (port 5432) endpoint on Supabase, but
# serve different conceptual roles per apply-migrations.sh contract:
#   DATABASE_DIRECT_URL   → consumed by `prisma migrate deploy`
#                           (pgBouncer transaction-mode breaks
#                           Prisma's session-level migration ops)
#   DATABASE_PRIVILEGED_URL → consumed by rls.sql + supabase-bootstrap.sql
umask 077
cat > "$TARGET" <<EOF
# Generated by scripts/setup-staging-env.sh on $(date -Iseconds).
# Re-run the script to rotate. DATABASE_URL and DATABASE_PRIVILEGED_URL
# were verified with sslmode=verify-full at write time.
# DATABASE_DIRECT_URL is the direct endpoint again, in the TLS form
# Prisma's migration engine needs (psql cannot read that form).
# This file is gitignored (apps/*/.env in .gitignore).
DATABASE_URL='$DB_URL'
DATABASE_DIRECT_URL='$DB_DIRECT_URL'
DATABASE_PRIVILEGED_URL='$DB_PRIV_URL'
EOF
chmod 600 "$TARGET"

echo
echo "✓ Wrote $TARGET (mode 600)."
echo "  Tell Claude: 'staging .env ready'."
