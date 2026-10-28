#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend="${1:-$root/install-openclaw.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bash -n "$backend"
REPO_ROOT="$root" BACKEND_UNDER_TEST="$backend" node <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.env.BACKEND_UNDER_TEST, "utf8");
const required = [
  'NOOSPHERE_INSTALL_OPENCLAW="${NOOSPHERE_INSTALL_OPENCLAW:-true}"',
  'if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  need openclaw\nfi',
  'write_credentials_json "$NOOSPHERE_CREDENTIALS_FILE"',
  'assert_no_symlink_path_components "$target" credential',
  'if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  write_credentials_json "$SECRETS_FILE" true',
  'Credentials were not printed. Read the mode-0600 file above when needed.',
  // The decision site must stay wired through the real persist/decide path.
  'persisted_bootstrap_key="$(persist_runtime_env)"',
  'resolve_guided_bootstrap_full_access "${API_KEY:-}" "$persisted_bootstrap_key"',
];
for (const needle of required) {
  if (!source.includes(needle)) throw new Error(`missing backend policy: ${needle}`);
}
if (source.includes("API KEY (save this - it will not be shown again)")) {
  throw new Error("backend prints the bootstrap key by default");
}
const path = require("node:path");
const root = process.env.REPO_ROOT;
function assertInitOnlySetting(text, setting, label) {
  const init = text.match(/^  init:\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:|(?![\s\S]))/m)?.[1];
  const settings = text.match(/^      NOOSPHERE_BOOTSTRAP_FULL_ACCESS:.*$/gm) ?? [];
  if (!init?.includes(setting) || settings.length !== 1) {
    throw new Error(`${label} must declare bootstrap full access only in init: ${setting}`);
  }
}
assertInitOnlySetting(source, 'NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "${BOOTSTRAP_FULL_ACCESS}"', "guided backend");
for (const template of ["docker-compose.yml", "docker-compose.noosphere.yml"]) {
  assertInitOnlySetting(
    fs.readFileSync(path.join(root, template), "utf8"),
    'NOOSPHERE_BOOTSTRAP_FULL_ACCESS: ${NOOSPHERE_BOOTSTRAP_FULL_ACCESS:-false}',
    template,
  );
}
NODE

source "$backend"

# The guided full-scope grant must be requested for a credential the installer
# creates. An upgrade reuses the key persisted in .env: demanding "*" from that
# key aborts the bootstrap transaction and breaks every pre-1.15.1 upgrade.
assert_bootstrap_full_access_behavior() (
  local failures=0
  # A fresh guided install creates the credential and keeps the guided grant.
  [[ "$(resolve_bootstrap_full_access false "" false)" == true ]] || failures=$((failures + 1))
  # An upgrade reuses the persisted key and must not demand "*" from it.
  [[ "$(resolve_bootstrap_full_access true "" false)" == false ]] || failures=$((failures + 1))
  # An explicit operator choice always wins, in both directions.
  [[ "$(resolve_bootstrap_full_access true true true)" == true ]] || failures=$((failures + 1))
  [[ "$(resolve_bootstrap_full_access false false true)" == false ]] || failures=$((failures + 1))
  # An explicitly empty value is a set value that grants nothing: like the
  # Compose templates' ${VAR:-false} resolution it must never resolve to the
  # widest scope.
  [[ "$(resolve_bootstrap_full_access false "" true)" == false ]] || failures=$((failures + 1))
  [[ "$(resolve_bootstrap_full_access true "" true)" == false ]] || failures=$((failures + 1))
  # A malformed explicit value is rejected instead of being coerced.
  if resolve_bootstrap_full_access false maybe true >/dev/null 2>&1; then
    failures=$((failures + 1))
  fi
  # Only the key already persisted in .env counts as an existing credential.
  bootstrap_key_is_persisted "noo_fixture_same" "noo_fixture_same" || failures=$((failures + 1))
  if bootstrap_key_is_persisted "noo_fixture_new" "noo_fixture_old"; then
    failures=$((failures + 1))
  fi
  if bootstrap_key_is_persisted "noo_fixture_new" ""; then
    failures=$((failures + 1))
  fi
  if bootstrap_key_is_persisted "" ""; then
    failures=$((failures + 1))
  fi
  [[ "$failures" == 0 ]]
)

if ! assert_bootstrap_full_access_behavior; then
  echo 'bootstrap full-access behavior assertions failed' >&2
  exit 1
fi
if (
  resolve_bootstrap_full_access() { printf 'true'; }
  assert_bootstrap_full_access_behavior
); then
  echo 'constant bootstrap full-access sabotage unexpectedly passed' >&2
  exit 1
fi

# The decision must be wired through the real persist/decide path. A regression
# that captures the persisted credential after the runtime file is written
# would misclassify a fresh install as an upgrade, so the fixture subprocess
# exercises the same hook main() uses instead of only the helper.
fixture_root="$tmp/fixtures"
mkdir -p "$fixture_root"

# persist_runtime_env writes the whole runtime file, so the fixture needs the
# full credential surface a real install resolves before this point.
fixture_default_vars=(
  NOOSPHERE_VERSION NOOSPHERE_IMAGE NOOSPHERE_PORT APP_URL BIND_ADDRESS
  POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD
  POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD NEXTAUTH_SECRET
  NOOSPHERE_ADMIN_PASSWORD NOOSPHERE_ADMIN_PASSWORD_RESET NOOSPHERE_FORCE_ADMIN
  NOOSPHERE_BOOTSTRAP_SECRETS_FILE REDIS_URL PG_POOL_MAX PG_IDLE_TIMEOUT_MS
  PG_CONN_TIMEOUT_MS NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 NOOSPHERE_HYBRID_RETRIEVAL_ENABLED
  NOOSPHERE_HYBRID_QUERY_PROFILE_ID NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64 NOOSPHERE_HYBRID_WORKER_CONCURRENCY
  NOOSPHERE_HYBRID_LEASE_SECONDS NOOSPHERE_HYBRID_MAX_ATTEMPTS
  NOOSPHERE_HYBRID_WORKER_POLL_MS NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS
  NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES NOOSPHERE_HYBRID_QUEUE_WARNING_DEPTH
  NOOSPHERE_HYBRID_QUEUE_CRITICAL_DEPTH NOOSPHERE_HYBRID_QUEUE_WARNING_AGE_SECONDS
  NOOSPHERE_HYBRID_QUEUE_CRITICAL_AGE_SECONDS
)
for fixture_var in "${fixture_default_vars[@]}"; do
  if [[ -z "${!fixture_var:-}" ]]; then
    export "$fixture_var=noo_${fixture_var}_fixture"
  fi
done

assert_bootstrap_full_access_fixture() (
  local fixture="$1" expected="$2" api_key="$3"
  local persisted_key="${4:-}" override="${5-unset}"
  local fixture_home="$fixture/home"
  mkdir -p "$fixture_home"
  if [[ -n "$persisted_key" ]]; then
    printf 'NOOSPHERE_BOOTSTRAP_API_KEY=%s\n' "$persisted_key" > "$fixture_home/.env"
    chmod 600 "$fixture_home/.env"
  fi
  if [[ "$override" == unset ]]; then
    API_KEY="$api_key" NOOSPHERE_HOME="$fixture_home" \
      NOOSPHERE_INSTALLER_TEST_MODE=bootstrap-full-access \
      bash -c 'set -euo pipefail; source "$1"' _ "$backend" \
      > "$fixture/out" 2> "$fixture/err"
  else
    API_KEY="$api_key" NOOSPHERE_HOME="$fixture_home" \
      NOOSPHERE_BOOTSTRAP_FULL_ACCESS="$override" \
      NOOSPHERE_INSTALLER_TEST_MODE=bootstrap-full-access \
      bash -c 'set -euo pipefail; source "$1"' _ "$backend" \
      > "$fixture/out" 2> "$fixture/err"
  fi
  grep -q "^bootstrap_full_access=$expected\$" "$fixture/out"
)

# A fresh install: the runtime file does not exist yet, so the generated key is
# a new credential and the guided grant must survive the write (the P1 case).
API_KEY=noo_fixture_fresh_key \
  assert_bootstrap_full_access_fixture "$fixture_root/fresh" true noo_fixture_fresh_key
# An upgrade: the persisted key is reused and must not be widened.
API_KEY=noo_fixture_persisted_key \
  assert_bootstrap_full_access_fixture "$fixture_root/persisted" false noo_fixture_persisted_key noo_fixture_persisted_key
# An explicit operator choice still wins over the persisted-credential default.
API_KEY=noo_fixture_persisted_key \
  assert_bootstrap_full_access_fixture "$fixture_root/persisted-explicit" true noo_fixture_persisted_key noo_fixture_persisted_key true
# An explicitly empty export grants nothing, never the widest scope.
API_KEY=noo_fixture_fresh_key \
  assert_bootstrap_full_access_fixture "$fixture_root/fresh-empty" false noo_fixture_fresh_key '' ''

assert_article_verification_floor_behavior() (
  local floor
  docker() {
    [[ "$*" == *'exec noosphere-openclaw-db psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere'* ]] || return 1
    printf '%s\n' "${FIXTURE_ARTICLE_COUNT:?}"
  }

  FIXTURE_ARTICLE_COUNT=not-called
  floor=$(capture_article_verification_floor noosphere-openclaw-db true)
  [[ "$floor" == 0 ]]

  FIXTURE_ARTICLE_COUNT=0
  floor=$(capture_article_verification_floor noosphere-openclaw-db false)
  [[ "$floor" == 0 ]]

  FIXTURE_ARTICLE_COUNT=7
  floor=$(capture_article_verification_floor noosphere-openclaw-db false)
  [[ "$floor" == 7 ]]

  FIXTURE_ARTICLE_COUNT=invalid
  if capture_article_verification_floor noosphere-openclaw-db false >/dev/null 2>&1; then
    return 1
  fi
)

assert_article_verification_floor_behavior
if (
  capture_article_verification_floor() {
    if [[ "$2" == true ]]; then printf '0\n'; else printf '1\n'; fi
  }
  assert_article_verification_floor_behavior
); then
  echo 'constant existing-install article floor sabotage unexpectedly passed' >&2
  exit 1
fi

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
if [[ "$disable" != true || "$noproxy" != true ]]; then
  if [[ -n "${INSTALLER_TEST_PROXY_REJECTION:-}" ]]; then
    printf 'proxy-policy-rejected\n' > "$INSTALLER_TEST_PROXY_REJECTION"
  fi
  exit 92
fi
[[ "$connect_timeout" == 5 && "$max_time" == 15 ]]
[[ -f "$config" ]]
grep -q 'header = "Authorization: Bearer noo_' "$config"
printf '%s %s\n' "$method" "$url" >> "$FAKE_CURL_CALLS"
case "$FAKE_CURL_MODE:$method:$url" in
  reuse:POST:*/api/articles) printf '400' ;;
  reuse:GET:*/api/keys) printf '403' ;;
  create:POST:*/api/keys|read:POST:*/api/keys)
    printf '{"key":"%s"}\n' "$FAKE_CREATED_KEY" > "$output"
    printf '201'
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

mkdir -p "$tmp/credential-parent-target"
printf '%s\n' 'CREDENTIAL_SENTINEL=yes' > "$tmp/credential-parent-target/sentinel"
ln -s "$tmp/credential-parent-target" "$tmp/credential-parent-link"
if write_credentials_json "$tmp/credential-parent-link/credentials.json" \
  >"$tmp/credential-parent-symlink.out" 2>&1; then
  echo 'symlinked credential parent unexpectedly passed' >&2
  exit 1
fi
test -L "$tmp/credential-parent-link"
grep -q '^CREDENTIAL_SENTINEL=yes$' "$tmp/credential-parent-target/sentinel"
test ! -e "$tmp/credential-parent-target/credentials.json"
grep -q 'Refusing symlinked credential path component' "$tmp/credential-parent-symlink.out"

# Recursed controls run all assertions, then stop before creating more controls.
if [[ "${INSTALLER_TEST_CONTROL_CHILD:-false}" == true ]]; then
  printf 'installer_backend_control_behavior=GREEN\n'
  exit 0
fi

# A relocated, unmodified backend must pass first. An unrelated fixture/path
# failure must not be accepted as proof that a security sabotage was detected.
cp "$backend" "$tmp/unchanged.sh"
if ! INSTALLER_TEST_CONTROL_CHILD=true "$0" "$tmp/unchanged.sh" >"$tmp/control-baseline.out" 2>&1; then
  cat "$tmp/control-baseline.out" >&2
  echo 'unmodified relocated backend control failed' >&2
  exit 1
fi
grep -q '^installer_backend_control_behavior=GREEN$' "$tmp/control-baseline.out"

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
if INSTALLER_TEST_CONTROL_CHILD=true INSTALLER_TEST_PROXY_REJECTION="$tmp/proxy-rejection" \
  "$0" "$tmp/proxy-sabotaged.sh" >"$tmp/proxy-control.out" 2>&1; then
  echo 'backend proxy-bypass sabotage unexpectedly passed' >&2
  exit 1
fi
grep -q '^proxy-policy-rejected$' "$tmp/proxy-rejection"
grep -q 'refusing to rotate it after a transport failure' "$tmp/proxy-control.out"

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
if INSTALLER_TEST_CONTROL_CHILD=true "$0" "$tmp/sabotaged.sh" >"$tmp/guard-control.out" 2>&1; then
  echo 'backend guard sabotage unexpectedly passed' >&2
  exit 1
fi
grep -q 'missing backend policy: if' "$tmp/guard-control.out"

# The generated Compose value must come from the resolver at the call site.
# Replacing that call with a constant must turn the suite red.
cp "$backend" "$tmp/full-access-sabotaged.sh"
SABOTAGED_BACKEND="$tmp/full-access-sabotaged.sh" node <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.env.SABOTAGED_BACKEND, "utf8");
const guarded = 'resolve_guided_bootstrap_full_access "${API_KEY:-}" "$persisted_bootstrap_key"';
if (!source.includes(guarded)) throw new Error("cannot locate full-access sabotage target");
// The decision needle appears at the main call site and in the regression
// hook; a constant must replace both so the suite fails at the policy check.
fs.writeFileSync(
  process.env.SABOTAGED_BACKEND,
  source.split(guarded).join("BOOTSTRAP_FULL_ACCESS=true"),
);
NODE
if INSTALLER_TEST_CONTROL_CHILD=true "$0" "$tmp/full-access-sabotaged.sh" >"$tmp/full-access-control.out" 2>&1; then
  echo 'constant guided full-access call-site sabotage unexpectedly passed' >&2
  exit 1
fi
grep -qF 'missing backend policy: resolve_guided_bootstrap_full_access "${API_KEY:-}" "$persisted_bootstrap_key"' "$tmp/full-access-control.out"

printf 'installer_backend_tests=GREEN core_mode_guard=yes credential_modes=0700/0600 scoped_keys=yes read_key_rejected=yes transport_rotation=blocked local_bootstrap_destination=yes article_floor=preserved proxy_bypass=yes secret_argv=clean child_env=clean credential_parent_symlink=blocked full_access_fixture=yes call_site_sabotage=red sabotage=red\n'
