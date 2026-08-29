#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version=$(tr -d '\r\n' < "$root/VERSION")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/fake-bin" "$tmp/home/.config/opencode" "$tmp/home/.config/kilo"
fixture_api_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_bootstrap_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_hermes_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_opencode_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_kilocode_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_kilocode_rotated_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_transport_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
fixture_admin_password="fixture-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
fixture_postgres_password="fixture-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
fixture_provider_secret="fixture-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
fixture_hmac_secret="fixture-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"

cat > "$tmp/fake-backend.sh" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$NOOSPHERE_INSTALL_OPENCLAW" > "$INSTALLER_TEST_RECORD"
install -d -m 700 "$(dirname "$NOOSPHERE_CREDENTIALS_FILE")"
install -m 600 /dev/null "$NOOSPHERE_CREDENTIALS_FILE"
printf '{\n  "baseUrl": "http://127.0.0.1:6578",\n  "apiKey": "%s",\n  "bootstrapApiKey": "%s",\n  "integrationApiKeys": {\n    "hermes": "%s",\n    "opencode": "%s",\n    "kilocode": "%s"\n  },\n  "adminEmail": "admin@noosphere.local",\n  "adminPassword": "%s"\n}\n' \
  "$NOOSPHERE_TEST_API_KEY" "$NOOSPHERE_TEST_BOOTSTRAP_KEY" \
  "$NOOSPHERE_TEST_HERMES_KEY" "$NOOSPHERE_TEST_OPENCODE_KEY" "$NOOSPHERE_TEST_KILOCODE_KEY" \
  "$NOOSPHERE_TEST_ADMIN_PASSWORD" > "$NOOSPHERE_CREDENTIALS_FILE"
BACKEND
chmod 700 "$tmp/fake-backend.sh"
fake_backend_sha=$(sha256sum "$tmp/fake-backend.sh" | awk '{print $1}')

cat > "$tmp/fake-bin/hermes" <<'HERMES'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$INSTALLER_TEST_HERMES_LOG"
env | sort > "$INSTALLER_TEST_HERMES_ENV_CAPTURE"
HERMES
chmod 700 "$tmp/fake-bin/hermes"

cat > "$tmp/fake-bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
config='' output='' url='' method=GET
for arg in "$@"; do
  [[ "$arg" != *noo_* ]] || { echo 'secret appeared in curl argv' >&2; exit 90; }
done
while (($# > 0)); do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    --request) method=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ -f "$config" && $(stat -c '%a' "$config") == 600 ]]
grep -q 'header = "Authorization: Bearer noo_' "$config"
printf '%s %s\n' "$method" "$url" >> "$INSTALLER_TEST_CURL_CALLS"
case "$method:$url" in
  POST:*/api/articles)
    if grep -Fq -- "$INSTALLER_TEST_TRANSPORT_KEY" "$config"; then
      exit 91
    elif grep -Fq -- "$INSTALLER_TEST_READ_KEY" "$config"; then
      printf '403'
    else
      printf '400'
    fi
    ;;
  GET:*/api/keys)
    if grep -Fq -- "$INSTALLER_TEST_TRANSPORT_KEY" "$config"; then
      exit 91
    fi
    printf '403'
    ;;
  POST:*/api/keys)
    printf '{"key":"%s"}\n' "$INSTALLER_TEST_CREATED_KEY" > "$output"
    ;;
  *) exit 91 ;;
esac
CURL
chmod 700 "$tmp/fake-bin/curl"

cat > "$tmp/home/.config/opencode/opencode.json" <<'JSON'
{
  "plugin": [
    "other-opencode-plugin",
    "@sweetsophia/opencode-noosphere-memory",
    "@sweetsophia/opencode-noosphere-memory@0.4.0"
  ]
}
JSON
cat > "$tmp/home/.config/kilo/kilo.json" <<'JSON'
{
  "plugin": [
    "other-kilo-plugin",
    "@sweetsophia/kilocode-noosphere-memory",
    ["@sweetsophia/kilocode-noosphere-memory@0.4.0", {"autoRecall": false}]
  ]
}
JSON

common_env=(
  HOME="$tmp/home"
  HERMES_HOME="$tmp/home/.hermes"
  PATH="$tmp/fake-bin:$PATH"
  NOOSPHERE_HOME="$tmp/home/.noosphere"
  NOOSPHERE_PORT=6578
  NOOSPHERE_BACKEND_PATH="$tmp/fake-backend.sh"
  NOOSPHERE_BACKEND_OVERRIDE_SHA256="$fake_backend_sha"
  INSTALLER_TEST_RECORD="$tmp/backend-mode.txt"
  INSTALLER_TEST_HERMES_LOG="$tmp/hermes.log"
  INSTALLER_TEST_HERMES_ENV_CAPTURE="$tmp/hermes.env"
  POSTGRES_PASSWORD="$fixture_postgres_password"
  NOOSPHERE_BOOTSTRAP_API_KEY="$fixture_bootstrap_key"
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON="[{\"apiKey\":\"${fixture_provider_secret}\"}]"
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON="{\"v1\":\"${fixture_hmac_secret}\"}"
  NOOSPHERE_TEST_API_KEY="$fixture_api_key"
  NOOSPHERE_TEST_BOOTSTRAP_KEY="$fixture_bootstrap_key"
  NOOSPHERE_TEST_HERMES_KEY="$fixture_hermes_key"
  NOOSPHERE_TEST_OPENCODE_KEY="$fixture_opencode_key"
  NOOSPHERE_TEST_KILOCODE_KEY="$fixture_kilocode_key"
  INSTALLER_TEST_READ_KEY="$fixture_kilocode_key"
  INSTALLER_TEST_CREATED_KEY="$fixture_kilocode_rotated_key"
  INSTALLER_TEST_TRANSPORT_KEY="$fixture_transport_key"
  INSTALLER_TEST_CURL_CALLS="$tmp/curl.calls"
  NOOSPHERE_TEST_ADMIN_PASSWORD="$fixture_admin_password"
)

mkdir -p "$tmp/home/.hermes/plugins/noosphere" "$tmp/home/.hermes/skills/noosphere-memory-hermes"
: > "$tmp/curl.calls"
touch "$tmp/home/.hermes/plugins/noosphere/stale.py" "$tmp/home/.hermes/skills/noosphere-memory-hermes/stale.md"
printf '%s\n' 'KEEP_ME=yes' > "$tmp/home/.hermes/.env"
chmod 644 "$tmp/home/.hermes/.env"

env "${common_env[@]}" bash "$root/install.sh" \
  --non-interactive --with hermes,opencode,kilocode > "$tmp/install.out"

test "$(<"$tmp/backend-mode.txt")" = false
for secret_name in POSTGRES_PASSWORD NOOSPHERE_BOOTSTRAP_API_KEY \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON; do
  if grep -q "^${secret_name}=" "$tmp/hermes.env"; then
    echo "Hermes child inherited secret variable: ${secret_name}" >&2
    exit 1
  fi
done
for secret_value in "$fixture_api_key" "$fixture_bootstrap_key" "$fixture_hermes_key" \
  "$fixture_opencode_key" "$fixture_kilocode_key" "$fixture_kilocode_rotated_key" "$fixture_admin_password"; do
  if grep -Fq "$secret_value" "$tmp/install.out"; then
    echo 'installer output exposed a credential fixture' >&2
    exit 1
  fi
done

env \
  OPENCODE_CONFIG="$tmp/home/.config/opencode/opencode.json" \
  KILOCODE_CONFIG="$tmp/home/.config/kilo/kilo.json" \
  HERMES_ENV="$tmp/home/.hermes/.env" \
  HERMES_CONFIG="$tmp/home/.hermes/noosphere.json" \
  NOOSPHERE_TEST_API_KEY="$fixture_api_key" \
  NOOSPHERE_TEST_BOOTSTRAP_KEY="$fixture_bootstrap_key" \
  NOOSPHERE_TEST_HERMES_KEY="$fixture_hermes_key" \
  NOOSPHERE_TEST_OPENCODE_KEY="$fixture_opencode_key" \
  NOOSPHERE_TEST_KILOCODE_KEY="$fixture_kilocode_rotated_key" \
  NOOSPHERE_TEST_VERSION="$version" \
  node <<'NODE'
const fs = require("node:fs");
const opencode = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
const kilo = JSON.parse(fs.readFileSync(process.env.KILOCODE_CONFIG, "utf8"));
const find = (entries, prefix) => entries.filter((entry) => {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" && spec.startsWith(prefix);
});
const opencodeEntries = find(opencode.plugin, "@sweetsophia/opencode-noosphere-memory@");
const kiloEntries = find(kilo.plugin, "@sweetsophia/kilocode-noosphere-memory@");
if (opencodeEntries.length !== 1 || opencodeEntries[0][0] !== `@sweetsophia/opencode-noosphere-memory@${process.env.NOOSPHERE_TEST_VERSION}`) process.exit(1);
if (kiloEntries.length !== 1 || kiloEntries[0][0] !== `@sweetsophia/kilocode-noosphere-memory@${process.env.NOOSPHERE_TEST_VERSION}`) process.exit(2);
if (!opencode.plugin.includes("other-opencode-plugin") || !kilo.plugin.includes("other-kilo-plugin")) process.exit(3);
if (opencodeEntries[0][1].apiKey !== process.env.NOOSPHERE_TEST_OPENCODE_KEY) process.exit(4);
if (kiloEntries[0][1].apiKey !== process.env.NOOSPHERE_TEST_KILOCODE_KEY) process.exit(5);
if (opencodeEntries[0][1].apiKey === process.env.NOOSPHERE_TEST_BOOTSTRAP_KEY) process.exit(9);
if (kiloEntries[0][1].apiKey === process.env.NOOSPHERE_TEST_BOOTSTRAP_KEY) process.exit(10);
const hermesEnv = fs.readFileSync(process.env.HERMES_ENV, "utf8");
if (!hermesEnv.includes(`HERMES_NOOSPHERE_API_KEY=${process.env.NOOSPHERE_TEST_HERMES_KEY}`)) process.exit(6);
if (hermesEnv.includes(process.env.NOOSPHERE_TEST_BOOTSTRAP_KEY)) process.exit(11);
if (!hermesEnv.includes("KEEP_ME=yes")) process.exit(8);
const hermes = JSON.parse(fs.readFileSync(process.env.HERMES_CONFIG, "utf8"));
if (hermes.base_url !== "http://127.0.0.1:6578") process.exit(7);
NODE

for protected in \
  "$tmp/home/.noosphere/credentials.json" \
  "$tmp/home/.config/opencode/opencode.json" \
  "$tmp/home/.config/kilo/kilo.json" \
  "$tmp/home/.hermes/.env" \
  "$tmp/home/.hermes/noosphere.json"; do
  test "$(stat -c '%a' "$protected")" = 600
done

test -f "$tmp/home/.hermes/plugins/noosphere/plugin.yaml"
test ! -e "$tmp/home/.hermes/plugins/noosphere/stale.py"
test ! -e "$tmp/home/.hermes/skills/noosphere-memory-hermes/stale.md"
grep -q "^version: ${version}$" "$tmp/home/.hermes/plugins/noosphere/plugin.yaml"
grep -q '^config set memory.provider noosphere$' "$tmp/hermes.log"

: > "$tmp/curl.calls"
if env "${common_env[@]}" NOOSPHERE_TEST_HERMES_KEY="$fixture_transport_key" \
  bash "$root/install.sh" --non-interactive --with hermes \
  >"$tmp/transport.out" 2>"$tmp/transport.err"; then
  echo 'launcher transport failure unexpectedly rotated or reused a scoped key' >&2
  exit 1
fi
grep -q 'refusing to rotate it after a transport failure' "$tmp/transport.err"
if grep -q '^POST .*/api/keys$' "$tmp/curl.calls"; then
  echo 'launcher transport failure reached scoped-key creation' >&2
  exit 1
fi

mkdir -p "$tmp/home/.hermes-symlink"
printf '%s\n' 'SENTINEL=yes' > "$tmp/hermes-env-target"
chmod 644 "$tmp/hermes-env-target"
ln -s "$tmp/hermes-env-target" "$tmp/home/.hermes-symlink/.env"
if env "${common_env[@]}" HERMES_HOME="$tmp/home/.hermes-symlink" \
  bash "$root/install.sh" --non-interactive --with hermes > "$tmp/hermes-symlink.out" 2>&1; then
  echo 'symlinked Hermes environment unexpectedly passed' >&2
  exit 1
fi
test -L "$tmp/home/.hermes-symlink/.env"
test "$(stat -c '%a' "$tmp/hermes-env-target")" = 644
grep -q '^SENTINEL=yes$' "$tmp/hermes-env-target"
if grep -q 'HERMES_NOOSPHERE_API_KEY' "$tmp/hermes-env-target"; then
  echo 'symlink target received a Hermes key' >&2
  exit 1
fi

mkdir -p "$tmp/hermes-home-target"
printf '%s\n' 'HOME_SENTINEL=yes' > "$tmp/hermes-home-target/sentinel"
chmod 755 "$tmp/hermes-home-target"
ln -s "$tmp/hermes-home-target" "$tmp/home/.hermes-home-link"
if env "${common_env[@]}" HERMES_HOME="$tmp/home/.hermes-home-link" \
  bash "$root/install.sh" --non-interactive --with hermes > "$tmp/hermes-home-symlink.out" 2>&1; then
  echo 'symlinked Hermes home unexpectedly passed' >&2
  exit 1
fi
test -L "$tmp/home/.hermes-home-link"
test "$(stat -c '%a' "$tmp/hermes-home-target")" = 755
grep -q '^HOME_SENTINEL=yes$' "$tmp/hermes-home-target/sentinel"
test ! -e "$tmp/hermes-home-target/plugins"
grep -q 'Refusing symlinked Hermes home' "$tmp/hermes-home-symlink.out"

cp "$tmp/fake-backend.sh" "$tmp/redirected-backend.sh"
node -e 'const fs=require("node:fs"); const p=process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p,"utf8").replace("http://127.0.0.1:6578", "https://attacker.invalid:6578"));' "$tmp/redirected-backend.sh"
redirected_backend_sha=$(sha256sum "$tmp/redirected-backend.sh" | awk '{print $1}')
if env "${common_env[@]}" \
  NOOSPHERE_BACKEND_PATH="$tmp/redirected-backend.sh" \
  NOOSPHERE_BACKEND_OVERRIDE_SHA256="$redirected_backend_sha" \
  HERMES_HOME="$tmp/home/.hermes-redirected" \
  bash "$root/install.sh" --non-interactive --with hermes > "$tmp/redirected.out" 2>&1; then
  echo 'non-local bootstrap-key destination unexpectedly passed' >&2
  exit 1
fi
grep -q 'non-local Noosphere URL' "$tmp/redirected.out"

cp "$tmp/fake-backend.sh" "$tmp/wrong-port-backend.sh"
node -e 'const fs=require("node:fs"); const p=process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p,"utf8").replaceAll("http://127.0.0.1:6578", "http://127.0.0.1:7777"));' "$tmp/wrong-port-backend.sh"
wrong_port_backend_sha=$(sha256sum "$tmp/wrong-port-backend.sh" | awk '{print $1}')
if env "${common_env[@]}" \
  NOOSPHERE_BACKEND_PATH="$tmp/wrong-port-backend.sh" \
  NOOSPHERE_BACKEND_OVERRIDE_SHA256="$wrong_port_backend_sha" \
  HERMES_HOME="$tmp/home/.hermes-wrong-port" \
  bash "$root/install.sh" --non-interactive --with hermes > "$tmp/wrong-port.out" 2>&1; then
  echo 'wrong-port bootstrap-key destination unexpectedly passed' >&2
  exit 1
fi
grep -q 'non-local Noosphere URL' "$tmp/wrong-port.out"

# Exercise the single-file launcher path with a checksum-owned Hermes archive.
mkdir -p "$tmp/hermes-release" "$tmp/remote-launcher"
"$root/scripts/package-hermes-plugin.sh" "$tmp/hermes-release" >/dev/null
hermes_archive="$tmp/hermes-release/hermes-noosphere-memory-${version}.tar.gz"
hermes_sha=$(sha256sum "$hermes_archive" | awk '{print $1}')
cp "$root/install.sh" "$tmp/remote-launcher/install.sh"
REMOTE_LAUNCHER="$tmp/remote-launcher/install.sh" HERMES_FIXTURE_SHA="$hermes_sha" node <<'NODE'
const fs = require("node:fs");
const path = process.env.REMOTE_LAUNCHER;
let source = fs.readFileSync(path, "utf8");
source = source.replace(/^HERMES_BUNDLE_URL='[^']+'$/m, "HERMES_BUNDLE_URL='https://fixture.invalid/hermes.tar.gz'");
source = source.replace(/^HERMES_BUNDLE_SHA256='[a-f0-9]{64}'$/m, `HERMES_BUNDLE_SHA256='${process.env.HERMES_FIXTURE_SHA}'`);
fs.writeFileSync(path, source, { mode: 0o700 });
NODE
cat > "$tmp/fake-bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
target='' config='' url='' method=GET
for arg in "$@"; do
  [[ "$arg" != *noo_* ]] || { echo 'secret appeared in curl argv' >&2; exit 90; }
done
while (($# > 0)); do
  case "$1" in
    -o|--output) target=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    --request) method=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
if [[ -n "$config" ]]; then
  [[ -f "$config" && $(stat -c '%a' "$config") == 600 ]]
  case "$method:$url" in
    POST:*/api/articles) printf '400' ;;
    GET:*/api/keys) printf '403' ;;
    *) exit 91 ;;
  esac
else
  [[ -n "$target" ]]
  cp "$INSTALLER_TEST_HERMES_ARCHIVE" "$target"
fi
CURL
chmod 700 "$tmp/fake-bin/curl"
: > "$tmp/hermes.log"
env "${common_env[@]}" \
  HERMES_HOME="$tmp/home/.hermes-remote" \
  INSTALLER_TEST_HERMES_ARCHIVE="$hermes_archive" \
  bash "$tmp/remote-launcher/install.sh" --non-interactive --with hermes > "$tmp/hermes-remote.out"
test -f "$tmp/home/.hermes-remote/plugins/noosphere/plugin.yaml"
test -f "$tmp/home/.hermes-remote/skills/noosphere-memory-hermes/SKILL.md"
grep -q '^config set memory.provider noosphere$' "$tmp/hermes.log"
if grep -q 'memory setup' "$tmp/hermes.log"; then
  echo 'nested Hermes setup unexpectedly ran' >&2
  exit 1
fi
for secret_value in "$fixture_api_key" "$fixture_bootstrap_key" "$fixture_hermes_key"; do
  if grep -Fq "$secret_value" "$tmp/hermes-remote.out"; then
    echo 'remote Hermes output exposed a credential fixture' >&2
    exit 1
  fi
done

mkdir -p "$tmp/no-hermes-bin"
cp "$tmp/fake-bin/curl" "$tmp/no-hermes-bin/curl"
node_bin_dir=$(dirname "$(command -v node)")
env "${common_env[@]}" \
  PATH="$tmp/no-hermes-bin:$node_bin_dir:/usr/bin:/bin" \
  HERMES_HOME="$tmp/home/.hermes-without-cli" \
  INSTALLER_TEST_HERMES_ARCHIVE="$hermes_archive" \
  bash "$tmp/remote-launcher/install.sh" --non-interactive --with hermes > "$tmp/hermes-without-cli.out"
grep -q 'Hermes Agent plugin installed' "$tmp/hermes-without-cli.out"
! grep -q 'Hermes Agent configured' "$tmp/hermes-without-cli.out"

env "${common_env[@]}" bash "$root/install.sh" \
  --non-interactive --with openclaw > "$tmp/openclaw.out"
test "$(<"$tmp/backend-mode.txt")" = true

test "$(grep -c 'Configure Noosphere for detected Kilo Code' "$root/install.sh")" = 1
if bash "$root/install.sh" --dry-run >/dev/null 2>&1; then
  echo 'no-tty implicit selection unexpectedly passed' >&2
  exit 1
fi
if env "${common_env[@]}" bash "$root/install.sh" --non-interactive >/dev/null 2>&1; then
  echo 'non-interactive selection guard unexpectedly passed' >&2
  exit 1
fi
if bash "$root/install.sh" --dry-run --with unknown >/dev/null 2>&1; then
  echo 'unknown integration guard unexpectedly passed' >&2
  exit 1
fi
for empty_selection in ',,' none; do
  if bash "$root/install.sh" --dry-run --non-interactive --with="$empty_selection" >/dev/null 2>&1; then
    echo "empty integration guard unexpectedly passed: $empty_selection" >&2
    exit 1
  fi
done
ln -s "$tmp/fake-backend.sh" "$tmp/backend-link.sh"
if env "${common_env[@]}" NOOSPHERE_BACKEND_PATH="$tmp/backend-link.sh" \
  bash "$root/install.sh" --core-only >/dev/null 2>&1; then
  echo 'symlink backend guard unexpectedly passed' >&2
  exit 1
fi

env "${common_env[@]}" NOOSPHERE_BACKEND_PATH=/does/not/exist \
  bash "$root/install.sh" --dry-run --core-only >/dev/null

mkdir -p "$tmp/mode-bin" "$tmp/modes/fresh" "$tmp/modes/existing" \
  "$tmp/modes/partial" "$tmp/modes/unclassified/backups/postgres-pgvector" \
  "$tmp/modes/resume/backups/postgres-pgvector"
cat > "$tmp/mode-bin/docker" <<'DOCKER'
#!/usr/bin/env bash
exit 1
DOCKER
chmod 700 "$tmp/mode-bin/docker"
mode_path="$tmp/mode-bin:/usr/bin:/bin"
env HOME="$tmp/modes/fresh" NOOSPHERE_HOME="$tmp/modes/fresh/.noosphere" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-fresh.out"
grep -q 'Mode:      fresh installation' "$tmp/mode-fresh.out"
mkdir -p "$tmp/modes/existing/.noosphere" "$tmp/modes/partial/.noosphere"
touch "$tmp/modes/existing/.noosphere/.env" "$tmp/modes/existing/.noosphere/docker-compose.yml"
env HOME="$tmp/modes/existing" NOOSPHERE_HOME="$tmp/modes/existing/.noosphere" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-existing.out"
grep -q 'Mode:      upgrade or verify complete installation' "$tmp/mode-existing.out"
touch "$tmp/modes/partial/.noosphere/.env"
env HOME="$tmp/modes/partial" NOOSPHERE_HOME="$tmp/modes/partial/.noosphere" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-partial.out"
grep -q 'Mode:      verify partial existing state before mutation' "$tmp/mode-partial.out"
printf '%s\n' '{not-json' > \
  "$tmp/modes/unclassified/backups/postgres-pgvector/noosphere_postgres_data.phase-a2b.json"
env HOME="$tmp/modes/unclassified" NOOSPHERE_HOME="$tmp/modes/unclassified" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-unclassified.out"
grep -q 'Mode:      verify unclassified existing state before mutation' "$tmp/mode-unclassified.out"
printf '%s\n' '{"phase":"provisioning"}' > \
  "$tmp/modes/resume/backups/postgres-pgvector/noosphere_postgres_data.phase-a2b.json"
env HOME="$tmp/modes/resume" NOOSPHERE_HOME="$tmp/modes/resume" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-resume.out"
grep -q 'Mode:      resume or verify interrupted installation' "$tmp/mode-resume.out"

printf 'installer_ux_tests=GREEN core_mode=yes lifecycle_modes=5 no_tty_guard=yes integration_merge=yes unversioned_dedupe=yes scoped_tool_keys=yes write_key_verified=yes transport_rotation=blocked bootstrap_tool_config=absent randomized_credentials=yes local_bootstrap_destination=yes port_binding=blocked secret_argv=clean child_env=clean remote_hermes=yes stale_overlay=clean hermes_symlink=blocked hermes_home_symlink=blocked atomic_secret_rewrite=yes secret_output=clean guards=11\n'
