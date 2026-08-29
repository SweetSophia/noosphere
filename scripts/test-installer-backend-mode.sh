#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend="${1:-$root/install-openclaw.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bash -n "$backend"
BACKEND_UNDER_TEST="$backend" node <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.env.BACKEND_UNDER_TEST, "utf8");
const required = [
  'NOOSPHERE_INSTALL_OPENCLAW="${NOOSPHERE_INSTALL_OPENCLAW:-true}"',
  'if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  need openclaw\nfi',
  'write_credentials_json "$NOOSPHERE_CREDENTIALS_FILE"',
  'if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  write_credentials_json "$SECRETS_FILE" true',
  'Credentials were not printed. Read the mode-0600 file above when needed.',
];
for (const needle of required) {
  if (!source.includes(needle)) throw new Error(`missing backend policy: ${needle}`);
}
if (source.includes("API KEY (save this - it will not be shown again)")) {
  throw new Error("backend prints the bootstrap key by default");
}
NODE

source "$backend"
APP_URL=http://127.0.0.1:6578
API_KEY=noo_fixture_backend_key
ADMIN_PASSWORD=fixture-admin
POSTGRES_PASSWORD=fixture-postgres
POSTGRES_MIGRATION_PASSWORD=fixture-migration
POSTGRES_APP_PASSWORD=fixture-app
POSTGRES_HYBRID_ADMIN_PASSWORD=fixture-hybrid-admin
POSTGRES_HYBRID_WORKER_PASSWORD=fixture-hybrid-worker
NEXTAUTH_SECRET=fixture-nextauth
write_credentials_json "$tmp/user/credentials.json"
write_credentials_json "$tmp/runtime/noosphere-memory.json" true

CREDENTIALS_USER="$tmp/user/credentials.json" \
CREDENTIALS_RUNTIME="$tmp/runtime/noosphere-memory.json" \
  node <<'NODE'
const fs = require("node:fs");
const user = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_USER, "utf8"));
const runtime = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_RUNTIME, "utf8"));
if (Object.keys(user).sort().join() !== "adminEmail,adminPassword,apiKey,baseUrl") process.exit(1);
if (!runtime.postgresPassword || !runtime.nextAuthSecret) process.exit(2);
NODE
for directory in "$tmp/user" "$tmp/runtime"; do
  test "$(stat -c '%a' "$directory")" = 700
done
for file in "$tmp/user/credentials.json" "$tmp/runtime/noosphere-memory.json"; do
  test "$(stat -c '%a' "$file")" = 600
done

cp "$backend" "$tmp/sabotaged.sh"
SABOTAGED_BACKEND="$tmp/sabotaged.sh" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SABOTAGED_BACKEND;
let source = fs.readFileSync(path, "utf8");
const guarded = 'if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  need openclaw\nfi';
if (!source.includes(guarded)) throw new Error("cannot locate sabotage target");
source = source.replace(guarded, "need openclaw");
fs.writeFileSync(path, source);
NODE
if "$0" "$tmp/sabotaged.sh" >/dev/null 2>&1; then
  echo 'backend guard sabotage unexpectedly passed' >&2
  exit 1
fi

printf 'installer_backend_tests=GREEN core_mode_guard=yes credential_modes=0700/0600 sabotage=red\n'
