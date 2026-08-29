#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/fake-bin" "$tmp/home/.config/opencode" "$tmp/home/.config/kilo"

cat > "$tmp/fake-backend.sh" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$NOOSPHERE_INSTALL_OPENCLAW" > "$INSTALLER_TEST_RECORD"
install -d -m 700 "$(dirname "$NOOSPHERE_CREDENTIALS_FILE")"
cat > "$NOOSPHERE_CREDENTIALS_FILE" <<'JSON'
{
  "baseUrl": "http://127.0.0.1:6578",
  "apiKey": "noo_fixture_installer_key",
  "adminEmail": "admin@noosphere.local",
  "adminPassword": "fixture-admin-password"
}
JSON
chmod 600 "$NOOSPHERE_CREDENTIALS_FILE"
BACKEND
chmod 700 "$tmp/fake-backend.sh"

cat > "$tmp/fake-bin/hermes" <<'HERMES'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$INSTALLER_TEST_HERMES_LOG"
HERMES
chmod 700 "$tmp/fake-bin/hermes"

cat > "$tmp/home/.config/opencode/opencode.json" <<'JSON'
{
  "plugin": [
    "other-opencode-plugin",
    "@sweetsophia/opencode-noosphere-memory@0.4.0"
  ]
}
JSON
cat > "$tmp/home/.config/kilo/kilo.json" <<'JSON'
{
  "plugin": [
    "other-kilo-plugin",
    ["@sweetsophia/kilocode-noosphere-memory@0.4.0", {"autoRecall": false}]
  ]
}
JSON

common_env=(
  HOME="$tmp/home"
  HERMES_HOME="$tmp/home/.hermes"
  PATH="$tmp/fake-bin:$PATH"
  NOOSPHERE_HOME="$tmp/home/.noosphere"
  NOOSPHERE_BACKEND_PATH="$tmp/fake-backend.sh"
  INSTALLER_TEST_RECORD="$tmp/backend-mode.txt"
  INSTALLER_TEST_HERMES_LOG="$tmp/hermes.log"
)

env "${common_env[@]}" bash "$root/install.sh" \
  --non-interactive --with hermes,opencode,kilocode > "$tmp/install.out"

test "$(<"$tmp/backend-mode.txt")" = false
! grep -q 'noo_fixture_installer_key' "$tmp/install.out"
! grep -q 'fixture-admin-password' "$tmp/install.out"

env \
  OPENCODE_CONFIG="$tmp/home/.config/opencode/opencode.json" \
  KILOCODE_CONFIG="$tmp/home/.config/kilo/kilo.json" \
  HERMES_ENV="$tmp/home/.hermes/.env" \
  HERMES_CONFIG="$tmp/home/.hermes/noosphere.json" \
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
if (opencodeEntries.length !== 1 || opencodeEntries[0][0] !== "@sweetsophia/opencode-noosphere-memory@1.12.0") process.exit(1);
if (kiloEntries.length !== 1 || kiloEntries[0][0] !== "@sweetsophia/kilocode-noosphere-memory@1.12.0") process.exit(2);
if (!opencode.plugin.includes("other-opencode-plugin") || !kilo.plugin.includes("other-kilo-plugin")) process.exit(3);
if (opencodeEntries[0][1].apiKey !== "noo_fixture_installer_key") process.exit(4);
if (kiloEntries[0][1].apiKey !== "noo_fixture_installer_key") process.exit(5);
const hermesEnv = fs.readFileSync(process.env.HERMES_ENV, "utf8");
if (!hermesEnv.includes("HERMES_NOOSPHERE_API_KEY=noo_fixture_installer_key")) process.exit(6);
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
grep -q '^version: 1.12.0$' "$tmp/home/.hermes/plugins/noosphere/plugin.yaml"
grep -q '^config set memory.provider noosphere$' "$tmp/hermes.log"

env "${common_env[@]}" bash "$root/install.sh" \
  --non-interactive --with openclaw > "$tmp/openclaw.out"
test "$(<"$tmp/backend-mode.txt")" = true

if env "${common_env[@]}" bash "$root/install.sh" --non-interactive >/dev/null 2>&1; then
  echo 'non-interactive selection guard unexpectedly passed' >&2
  exit 1
fi
if bash "$root/install.sh" --dry-run --with unknown >/dev/null 2>&1; then
  echo 'unknown integration guard unexpectedly passed' >&2
  exit 1
fi
ln -s "$tmp/fake-backend.sh" "$tmp/backend-link.sh"
if env "${common_env[@]}" NOOSPHERE_BACKEND_PATH="$tmp/backend-link.sh" \
  bash "$root/install.sh" --core-only >/dev/null 2>&1; then
  echo 'symlink backend guard unexpectedly passed' >&2
  exit 1
fi

env "${common_env[@]}" NOOSPHERE_BACKEND_PATH=/does/not/exist \
  bash "$root/install.sh" --dry-run --core-only >/dev/null

printf 'installer_ux_tests=GREEN core_mode=yes integration_merge=yes secret_output=clean guards=4\n'
