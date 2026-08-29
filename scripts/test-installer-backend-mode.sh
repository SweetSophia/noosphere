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
fixture_value() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))'
}
APP_URL=http://127.0.0.1:6578
API_KEY="noo_fixture_$(fixture_value)"
INTEGRATION_API_KEY="noo_fixture_$(fixture_value)"
ADMIN_PASSWORD="fixture-$(fixture_value)"
POSTGRES_PASSWORD="fixture-$(fixture_value)"
POSTGRES_MIGRATION_PASSWORD="fixture-$(fixture_value)"
POSTGRES_APP_PASSWORD="fixture-$(fixture_value)"
POSTGRES_HYBRID_ADMIN_PASSWORD="fixture-$(fixture_value)"
POSTGRES_HYBRID_WORKER_PASSWORD="fixture-$(fixture_value)"
NEXTAUTH_SECRET="fixture-$(fixture_value)"
mkdir -p "$tmp/fake-bin"
cat > "$tmp/fake-bin/openclaw" <<'OPENCLAW'
#!/usr/bin/env bash
set -euo pipefail
env | sort > "$OPENCLAW_ENV_CAPTURE"
OPENCLAW
chmod 700 "$tmp/fake-bin/openclaw"
cat > "$tmp/fake-bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
config='' output='' url=''
for arg in "$@"; do
  [[ "$arg" != *noo_* ]] || {
    echo 'secret appeared in curl argv' >&2
    exit 90
  }
done
while (($# > 0)); do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ -f "$config" ]]
grep -q 'header = "Authorization: Bearer noo_' "$config"
printf '%s\n' "$url" >> "$FAKE_CURL_CALLS"
case "$FAKE_CURL_MODE:$url" in
  reuse:*/api/articles*) printf '200' ;;
  reuse:*/api/keys) printf '403' ;;
  create:*/api/keys)
    printf '{"key":"%s"}\n' "$FAKE_CREATED_KEY" > "$output"
    ;;
  *) exit 91 ;;
esac
CURL
chmod 700 "$tmp/fake-bin/curl"
: > "$tmp/curl.calls"
export FAKE_CURL_CALLS="$tmp/curl.calls"
safe_existing="noo_fixture_$(fixture_value)"
selected=$(PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=reuse \
  select_scoped_integration_key "$safe_existing" default)
[[ "$selected" == "$safe_existing" ]]
created_key="noo_fixture_$(fixture_value)"
selected=$(PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=create FAKE_CREATED_KEY="$created_key" \
  select_scoped_integration_key '' opencode)
[[ "$selected" == "$created_key" ]]
if grep -q 'noo_' "$tmp/curl.calls"; then
  echo 'secret appeared in captured curl URLs' >&2
  exit 1
fi
export POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD
export POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD
export NEXTAUTH_SECRET NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"
export REDIS_URL="redis://fixture.invalid"
export NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="fixture-provider-config"
export NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64="fixture-cache-keys"
export OPENCLAW_ENV_CAPTURE="$tmp/openclaw.env" INSTALLER_SAFE_MARKER=preserved
PATH="$tmp/fake-bin:$PATH" run_openclaw gateway status
for secret_name in \
  POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD \
  POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD NEXTAUTH_SECRET \
  REDIS_URL NOOSPHERE_ADMIN_PASSWORD NOOSPHERE_BOOTSTRAP_API_KEY \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64; do
  if grep -q "^${secret_name}=" "$tmp/openclaw.env"; then
    echo "OpenClaw child inherited secret variable: ${secret_name}" >&2
    exit 1
  fi
done
grep -q '^INSTALLER_SAFE_MARKER=preserved$' "$tmp/openclaw.env"
write_credentials_json "$tmp/user/credentials.json"
write_credentials_json "$tmp/runtime/noosphere-memory.json" true

CREDENTIALS_USER="$tmp/user/credentials.json" \
CREDENTIALS_RUNTIME="$tmp/runtime/noosphere-memory.json" \
EXPECTED_INTEGRATION_KEY="$INTEGRATION_API_KEY" \
EXPECTED_BOOTSTRAP_KEY="$API_KEY" \
  node <<'NODE'
const fs = require("node:fs");
const user = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_USER, "utf8"));
const runtime = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_RUNTIME, "utf8"));
if (Object.keys(user).sort().join() !== "adminEmail,adminPassword,apiKey,baseUrl,bootstrapApiKey") process.exit(1);
if (user.apiKey !== process.env.EXPECTED_INTEGRATION_KEY) process.exit(3);
if (user.bootstrapApiKey !== process.env.EXPECTED_BOOTSTRAP_KEY) process.exit(4);
if (user.apiKey === user.bootstrapApiKey) process.exit(5);
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

printf 'installer_backend_tests=GREEN core_mode_guard=yes credential_modes=0700/0600 scoped_keys=yes secret_argv=clean child_env=clean sabotage=red\n'
