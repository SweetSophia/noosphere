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
NOOSPHERE_PORT=6578
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
config='' output='' url='' method=GET disable=false noproxy=false connect_timeout='' max_time=''
for arg in "$@"; do
  [[ "$arg" != *noo_* ]] || {
    echo 'secret appeared in curl argv' >&2
    exit 90
  }
done
while (($# > 0)); do
  case "$1" in
    --disable) disable=true; shift ;;
    --noproxy) [[ "$2" == '*' ]]; noproxy=true; shift 2 ;;
    --connect-timeout) connect_timeout=$2; shift 2 ;;
    --max-time) max_time=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    --request) method=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ "$disable" == true && "$noproxy" == true ]]
[[ "$connect_timeout" == 5 && "$max_time" == 15 ]]
[[ -f "$config" ]]
grep -q 'header = "Authorization: Bearer noo_' "$config"
printf '%s %s\n' "$method" "$url" >> "$FAKE_CURL_CALLS"
case "$FAKE_CURL_MODE:$method:$url" in
  reuse:POST:*/api/articles) printf '400' ;;
  reuse:GET:*/api/keys) printf '403' ;;
  create:POST:*/api/keys|read:POST:*/api/keys)
    printf '{"key":"%s"}\n' "$FAKE_CREATED_KEY" > "$output"
    ;;
  read:POST:*/api/articles) printf '403' ;;
  read:GET:*/api/keys) printf '403' ;;
  *) exit 91 ;;
esac
CURL
chmod 700 "$tmp/fake-bin/curl"
: > "$tmp/curl.calls"
export FAKE_CURL_CALLS="$tmp/curl.calls"
export http_proxy='http://proxy.invalid:8080' https_proxy='http://proxy.invalid:8080'
export HTTP_PROXY='http://proxy.invalid:8080' HTTPS_PROXY='http://proxy.invalid:8080'
export ALL_PROXY='socks5://proxy.invalid:1080' all_proxy='socks5://proxy.invalid:1080'
safe_existing="noo_fixture_$(fixture_value)"
selected=$(PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=reuse \
  select_scoped_integration_key "$safe_existing" default)
[[ "$selected" == "$safe_existing" ]]
created_key="noo_fixture_$(fixture_value)"
selected=$(PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=create FAKE_CREATED_KEY="$created_key" \
  select_scoped_integration_key '' opencode)
[[ "$selected" == "$created_key" ]]
read_only="noo_fixture_$(fixture_value)"
rotated_key="noo_fixture_$(fixture_value)"
selected=$(PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=read FAKE_CREATED_KEY="$rotated_key" \
  select_scoped_integration_key "$read_only" kilocode)
[[ "$selected" == "$rotated_key" && "$selected" != "$read_only" ]]
: > "$tmp/curl.calls"
transport_key="noo_fixture_$(fixture_value)"
if PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=transport \
  select_scoped_integration_key "$transport_key" hermes >"$tmp/transport.out" 2>"$tmp/transport.err"; then
  echo 'transport failure unexpectedly rotated or reused a scoped key' >&2
  exit 1
fi
grep -q 'refusing to rotate it after a transport failure' "$tmp/transport.err"
if grep -q '^POST .*/api/keys$' "$tmp/curl.calls"; then
  echo 'transport failure reached scoped-key creation' >&2
  exit 1
fi
original_app_url=$APP_URL
APP_URL=https://attacker.invalid:6578
if PATH="$tmp/fake-bin:$PATH" FAKE_CURL_MODE=create FAKE_CREATED_KEY="$created_key" \
  create_scoped_integration_key redirected >/dev/null 2>&1; then
  echo 'non-local bootstrap-key destination unexpectedly passed' >&2
  exit 1
fi
APP_URL=$original_app_url
if grep -q 'attacker.invalid' "$tmp/curl.calls"; then
  echo 'bootstrap key provisioning reached a non-local URL' >&2
  exit 1
fi
if grep -q 'noo_' "$tmp/curl.calls"; then
  echo 'secret appeared in captured curl URLs' >&2
  exit 1
fi
export POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD
export POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD
export NEXTAUTH_SECRET NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"
export REDIS_URL="redis://fixture.invalid"
provider_fixture="fixture-$(fixture_value)"
hmac_fixture="fixture-$(fixture_value)"
provider_b64_fixture="fixture-$(fixture_value)"
hmac_b64_fixture="fixture-$(fixture_value)"
export NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON="[{\"apiKey\":\"${provider_fixture}\"}]"
export NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$provider_b64_fixture"
export NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON="{\"v1\":\"${hmac_fixture}\"}"
export NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64="$hmac_b64_fixture"
export OPENCLAW_ENV_CAPTURE="$tmp/openclaw.env" INSTALLER_SAFE_MARKER=preserved
PATH="$tmp/fake-bin:$PATH" run_openclaw gateway status
for secret_name in \
  POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD \
  POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD NEXTAUTH_SECRET \
  REDIS_URL NOOSPHERE_ADMIN_PASSWORD NOOSPHERE_BOOTSTRAP_API_KEY \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 \
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64; do
  if grep -q "^${secret_name}=" "$tmp/openclaw.env"; then
    echo "OpenClaw child inherited secret variable: ${secret_name}" >&2
    exit 1
  fi
done
grep -q '^INSTALLER_SAFE_MARKER=preserved$' "$tmp/openclaw.env"
preserved_key="noo_fixture_$(fixture_value)"
mkdir -p "$tmp/user"
PRESERVED_KEY="$preserved_key" CREDENTIALS_USER="$tmp/user/credentials.json" node -e '
  require("node:fs").writeFileSync(process.env.CREDENTIALS_USER, JSON.stringify({
    integrationApiKeys: { hermes: process.env.PRESERVED_KEY },
  }));
'
chmod 600 "$tmp/user/credentials.json"
write_credentials_json "$tmp/user/credentials.json"
write_credentials_json "$tmp/runtime/noosphere-memory.json" true false

CREDENTIALS_USER="$tmp/user/credentials.json" \
CREDENTIALS_RUNTIME="$tmp/runtime/noosphere-memory.json" \
EXPECTED_INTEGRATION_KEY="$INTEGRATION_API_KEY" \
EXPECTED_BOOTSTRAP_KEY="$API_KEY" \
EXPECTED_PRESERVED_KEY="$preserved_key" \
  node <<'NODE'
const fs = require("node:fs");
const user = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_USER, "utf8"));
const runtime = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_RUNTIME, "utf8"));
if (Object.keys(user).sort().join() !== "adminEmail,adminPassword,apiKey,baseUrl,bootstrapApiKey,integrationApiKeys") process.exit(1);
if (user.apiKey !== process.env.EXPECTED_INTEGRATION_KEY) process.exit(3);
if (user.bootstrapApiKey !== process.env.EXPECTED_BOOTSTRAP_KEY) process.exit(4);
if (user.apiKey === user.bootstrapApiKey) process.exit(5);
if (user.integrationApiKeys.hermes !== process.env.EXPECTED_PRESERVED_KEY) process.exit(6);
if (!runtime.postgresPassword || !runtime.nextAuthSecret) process.exit(2);
if (runtime.bootstrapApiKey !== undefined) process.exit(7);
NODE
for directory in "$tmp/user" "$tmp/runtime"; do
  test "$(stat -c '%a' "$directory")" = 700
done
for file in "$tmp/user/credentials.json" "$tmp/runtime/noosphere-memory.json"; do
  test "$(stat -c '%a' "$file")" = 600
done

cp "$backend" "$tmp/proxy-sabotaged.sh"
SABOTAGED_BACKEND="$tmp/proxy-sabotaged.sh" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SABOTAGED_BACKEND;
let source = fs.readFileSync(path, "utf8");
const guarded = `curl --disable --noproxy '*' --connect-timeout 5 --max-time 15 "$@"`;
if (!source.includes(guarded)) throw new Error("cannot locate proxy sabotage target");
source = source.replace(guarded, `curl "$@"`);
fs.writeFileSync(path, source);
NODE
if "$0" "$tmp/proxy-sabotaged.sh" >/dev/null 2>&1; then
  echo 'backend proxy-bypass sabotage unexpectedly passed' >&2
  exit 1
fi

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

printf 'installer_backend_tests=GREEN core_mode_guard=yes credential_modes=0700/0600 scoped_keys=yes read_key_rejected=yes transport_rotation=blocked local_bootstrap_destination=yes proxy_bypass=yes secret_argv=clean child_env=clean sabotage=red\n'
