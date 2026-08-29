#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/fake-bin" "$tmp/home/.config/opencode" "$tmp/home/.config/kilo"
fixture_api_key="noo_fixture_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"

cat > "$tmp/fake-backend.sh" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$NOOSPHERE_INSTALL_OPENCLAW" > "$INSTALLER_TEST_RECORD"
install -d -m 700 "$(dirname "$NOOSPHERE_CREDENTIALS_FILE")"
CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" node <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(process.env.CREDENTIALS_FILE, `${JSON.stringify({
  baseUrl: "http://127.0.0.1:6578",
  apiKey: process.env.NOOSPHERE_TEST_API_KEY,
  adminEmail: "admin@noosphere.local",
  adminPassword: "fixture-admin-password",
}, null, 2)}\n`, { mode: 0o600 });
NODE
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
  NOOSPHERE_TEST_API_KEY="$fixture_api_key"
)

mkdir -p "$tmp/home/.hermes/plugins/noosphere" "$tmp/home/.hermes/skills/noosphere-memory-hermes"
touch "$tmp/home/.hermes/plugins/noosphere/stale.py" "$tmp/home/.hermes/skills/noosphere-memory-hermes/stale.md"

env "${common_env[@]}" bash "$root/install.sh" \
  --non-interactive --with hermes,opencode,kilocode > "$tmp/install.out"

test "$(<"$tmp/backend-mode.txt")" = false
! grep -q "$fixture_api_key" "$tmp/install.out"
! grep -q 'fixture-admin-password' "$tmp/install.out"

env \
  OPENCODE_CONFIG="$tmp/home/.config/opencode/opencode.json" \
  KILOCODE_CONFIG="$tmp/home/.config/kilo/kilo.json" \
  HERMES_ENV="$tmp/home/.hermes/.env" \
  HERMES_CONFIG="$tmp/home/.hermes/noosphere.json" \
  NOOSPHERE_TEST_API_KEY="$fixture_api_key" \
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
if (opencodeEntries[0][1].apiKey !== process.env.NOOSPHERE_TEST_API_KEY) process.exit(4);
if (kiloEntries[0][1].apiKey !== process.env.NOOSPHERE_TEST_API_KEY) process.exit(5);
const hermesEnv = fs.readFileSync(process.env.HERMES_ENV, "utf8");
if (!hermesEnv.includes(`HERMES_NOOSPHERE_API_KEY=${process.env.NOOSPHERE_TEST_API_KEY}`)) process.exit(6);
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
grep -q '^version: 1.12.0$' "$tmp/home/.hermes/plugins/noosphere/plugin.yaml"
grep -q '^config set memory.provider noosphere$' "$tmp/hermes.log"

# Exercise the single-file launcher path with a checksum-owned Hermes archive.
mkdir -p "$tmp/hermes-release" "$tmp/remote-launcher"
"$root/scripts/package-hermes-plugin.sh" "$tmp/hermes-release" >/dev/null
hermes_archive="$tmp/hermes-release/hermes-noosphere-memory-1.12.0.tar.gz"
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
target=''
while (($# > 0)); do
  case "$1" in
    -o) target=$2; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$target" ]]
cp "$INSTALLER_TEST_HERMES_ARCHIVE" "$target"
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
! grep -q 'memory setup' "$tmp/hermes.log"
! grep -q "$fixture_api_key" "$tmp/hermes-remote.out"

mkdir -p "$tmp/no-hermes-bin"
cp "$tmp/fake-bin/curl" "$tmp/no-hermes-bin/curl"
env "${common_env[@]}" \
  PATH="$tmp/no-hermes-bin:/usr/bin:/bin" \
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
mkdir -p "$tmp/modes/existing/.noosphere"
touch "$tmp/modes/existing/.noosphere/.env"
env HOME="$tmp/modes/existing" NOOSPHERE_HOME="$tmp/modes/existing/.noosphere" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-existing.out"
grep -q 'Mode:      upgrade or verify existing installation' "$tmp/mode-existing.out"
printf '%s\n' '{"phase":"provisioning"}' > \
  "$tmp/modes/resume/backups/postgres-pgvector/noosphere_postgres_data.phase-a2b.json"
env HOME="$tmp/modes/resume" NOOSPHERE_HOME="$tmp/modes/resume" PATH="$mode_path" \
  bash "$root/install.sh" --dry-run --core-only > "$tmp/mode-resume.out"
grep -q 'Mode:      resume or verify interrupted installation' "$tmp/mode-resume.out"

printf 'installer_ux_tests=GREEN core_mode=yes lifecycle_modes=3 no_tty_guard=yes integration_merge=yes remote_hermes=yes stale_overlay=clean secret_output=clean guards=7\n'
