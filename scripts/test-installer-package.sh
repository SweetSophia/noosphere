#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
[[ $# == 0 || ($# == 1 && "$1" == --backend-resolution-only) ]] || {
  echo 'Usage: test-installer-package.sh [--backend-resolution-only]' >&2
  exit 2
}

# Exercise the checked-in launcher without the UX fixture's backend override.
# Resolution mode exits before the backend can execute or load runtime config.
source_backend_sha=$(sha256sum "$root/install-openclaw.sh" | awk '{print $1}')
NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
  bash "$root/install.sh" --core-only > "$tmp/source-sibling-positive.out"
grep -q "resolved_backend_sha256=$source_backend_sha" "$tmp/source-sibling-positive.out"
mkdir -p "$tmp/tampered-source"
cp "$root/install.sh" "$root/install-openclaw.sh" "$tmp/tampered-source/"
printf '\n# tampered source sibling\n' >> "$tmp/tampered-source/install-openclaw.sh"
if NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
  bash "$tmp/tampered-source/install.sh" --core-only > "$tmp/source-sibling-negative.out" 2>&1; then
  echo 'tampered source sibling backend unexpectedly passed' >&2
  exit 1
fi
grep -q 'unexpected checksum' "$tmp/source-sibling-negative.out"

first="$tmp/first"
second="$tmp/second"
"$root/scripts/package-installer.sh" "$first" >/dev/null
"$root/scripts/package-installer.sh" "$second" >/dev/null
version=$(<"$root/VERSION")
assets=(
  install.sh
  install.sh.sha256
  install-openclaw.sh
  install-openclaw.sh.sha256
  "hermes-noosphere-memory-${version}.tar.gz"
  "hermes-noosphere-memory-${version}.tar.gz.sha256"
)
for asset in "${assets[@]}"; do
  cmp "$first/$asset" "$second/$asset"
done

mode_baseline=''
for mode in 0755 0775 0700; do
  fixture="$tmp/fixture-$mode"
  output="$tmp/output-$mode"
  install -d "$fixture/scripts"
  cp "$root/LICENSE" "$root/NOTICE" "$root/VERSION" \
    "$root/install.sh" "$root/install-openclaw.sh" "$fixture/"
  cp "$root/scripts/package-hermes-plugin.sh" "$root/scripts/package-installer.sh" \
    "$fixture/scripts/"
  cp -a "$root/hermes-noosphere-memory" "$fixture/"
  # Different backend bytes prove packaging refreshes both pins, rather than
  # accidentally inheriting the already-correct source sibling checksum.
  printf '\n# packaging pin refresh fixture\n' >> "$fixture/install-openclaw.sh"
  FIXTURE_ROOT="$fixture" FIXTURE_MODE="$mode" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const mode = Number.parseInt(process.env.FIXTURE_MODE, 8);
const visit = (directory) => {
  fs.chmodSync(directory, mode);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(entryPath);
    } else if (entry.isFile()) {
      const sourceMode = fs.statSync(entryPath).mode;
      fs.chmodSync(entryPath, sourceMode & 0o111 ? mode : mode & 0o666);
    }
  }
};
visit(process.env.FIXTURE_ROOT);
NODE
  "$fixture/scripts/package-installer.sh" "$output" >/dev/null
  fixture_backend_sha=$(sha256sum "$output/install-openclaw.sh" | awk '{print $1}')
  grep -q "^BACKEND_SHA256='$fixture_backend_sha'$" "$output/install.sh"
  grep -q "^SOURCE_BACKEND_SHA256='$fixture_backend_sha'$" "$output/install.sh"
  if [[ -z "$mode_baseline" ]]; then
    mode_baseline="$output"
  else
    for asset in "${assets[@]}"; do
      cmp "$mode_baseline/$asset" "$output/$asset"
    done
  fi
done
mode_extract="$tmp/mode-extract"
mkdir -p "$mode_extract"
tar -xpzf "$mode_baseline/hermes-noosphere-memory-${version}.tar.gz" -C "$mode_extract"
mode_root="$mode_extract/hermes-noosphere-memory-${version}"
test "$(stat -c '%a' "$mode_root")" = 755
test "$(stat -c '%a' "$mode_root/install-hermes.sh")" = 755
test "$(stat -c '%a' "$mode_root/README.md")" = 644
test "$(stat -c '%a' "$mode_root/plugins/memory/noosphere/plugin.yaml")" = 644
(
  cd "$first"
  sha256sum --check install.sh.sha256
  sha256sum --check install-openclaw.sh.sha256
  sha256sum --check "hermes-noosphere-memory-${version}.tar.gz.sha256"
)
bash -n "$first/install.sh" "$first/install-openclaw.sh"
! grep -q '@NOOSPHERE_' "$first/install.sh"
backend_sha=$(sha256sum "$first/install-openclaw.sh" | awk '{print $1}')
hermes_sha=$(sha256sum "$first/hermes-noosphere-memory-${version}.tar.gz" | awk '{print $1}')
grep -q "^BACKEND_SHA256='$backend_sha'$" "$first/install.sh"
grep -q "^SOURCE_BACKEND_SHA256='$backend_sha'$" "$first/install.sh"
grep -q "^HERMES_BUNDLE_SHA256='$hermes_sha'$" "$first/install.sh"

NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
  bash "$first/install.sh" --core-only > "$tmp/sibling-positive.out"
grep -q "resolved_backend_sha256=$backend_sha" "$tmp/sibling-positive.out"
mkdir -p "$tmp/tampered-package"
cp "$first/install.sh" "$first/install-openclaw.sh" "$tmp/tampered-package/"
printf '\n# tampered sibling\n' >> "$tmp/tampered-package/install-openclaw.sh"
if NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
  bash "$tmp/tampered-package/install.sh" --core-only > "$tmp/sibling-negative.out" 2>&1; then
  echo 'tampered sibling backend unexpectedly passed' >&2
  exit 1
fi
grep -q 'unexpected checksum' "$tmp/sibling-negative.out"

mkdir -p "$tmp/remote" "$tmp/fake-bin"
cp "$first/install.sh" "$tmp/remote/install.sh"
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
cp "$FAKE_CURL_SOURCE" "$target"
CURL
chmod 700 "$tmp/fake-bin/curl"

PATH="$tmp/fake-bin:$PATH" \
FAKE_CURL_SOURCE="$first/install-openclaw.sh" \
NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
  bash "$tmp/remote/install.sh" --core-only > "$tmp/remote-positive.out"
grep -q "resolved_backend_sha256=$backend_sha" "$tmp/remote-positive.out"

cat "$tmp/remote/install.sh" | \
  PATH="$tmp/fake-bin:$PATH" \
  FAKE_CURL_SOURCE="$first/install-openclaw.sh" \
  NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
    bash -s -- --core-only > "$tmp/piped-positive.out"
grep -q "resolved_backend_sha256=$backend_sha" "$tmp/piped-positive.out"

cp "$first/install-openclaw.sh" "$tmp/tampered-backend.sh"
printf '\n# tampered\n' >> "$tmp/tampered-backend.sh"
if PATH="$tmp/fake-bin:$PATH" \
  FAKE_CURL_SOURCE="$tmp/tampered-backend.sh" \
  NOOSPHERE_INSTALLER_TEST_MODE=resolve-backend \
    bash "$tmp/remote/install.sh" --core-only > "$tmp/remote-negative.out" 2>&1; then
  echo 'tampered backend unexpectedly passed' >&2
  exit 1
fi
grep -q 'unexpected checksum' "$tmp/remote-negative.out"

if [[ "${1:-}" == --backend-resolution-only ]]; then
  printf 'installer_backend_resolution_tests=GREEN source_sibling=yes source_tamper_rejected=yes package_deterministic=yes packaged_sibling=yes remote_stub=yes piped_stub=yes tamper_rejected=yes backend_execution=no\n'
  exit 0
fi

# Document-policy regression coverage for the packaged-launcher install blocks.
node --test "$root/scripts/packaged-launcher-documents.test.mjs"

(
  cd "$first"
  node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files
) > "$tmp/release-files-positive.out"
grep -q 'PostgreSQL image policy check passed' "$tmp/release-files-positive.out"

cat > "$tmp/mock-release-fetch.mjs" <<'NODE'
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const releaseRoot = resolve(process.env.RELEASE_FIXTURE_DIR);
globalThis.fetch = async (input) => {
  const name = basename(new URL(String(input)).pathname);
  try {
    return new Response(await readFile(resolve(releaseRoot, name)), { status: 200 });
  } catch {
    return new Response("missing", { status: 404 });
  }
};
NODE
RELEASE_FIXTURE_DIR="$first" \
  node --import "$tmp/mock-release-fetch.mjs" \
  "$root/scripts/check-postgres-image-policy.mjs" --verify-release-assets \
  > "$tmp/release-assets-positive.out"
grep -q 'PostgreSQL image policy check passed' "$tmp/release-assets-positive.out"

cp -a "$first" "$tmp/tampered-release"
printf '\n# tampered release backend\n' >> "$tmp/tampered-release/install-openclaw.sh"
if (
  cd "$tmp/tampered-release"
  node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files
) > "$tmp/release-files-negative.out" 2>&1; then
  echo 'tampered six-file release set unexpectedly passed' >&2
  exit 1
fi
grep -q 'release install-openclaw.sh checksum must match downloaded bytes' \
  "$tmp/release-files-negative.out"

cp -a "$first" "$tmp/missing-release"
rm "$tmp/missing-release/install.sh.sha256"
if (cd "$tmp/missing-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/missing-release.out" 2>&1; then
  echo 'missing release asset unexpectedly passed' >&2
  exit 1
fi
grep -q 'release verification directory must contain exactly' "$tmp/missing-release.out"

cp -a "$first" "$tmp/extra-release"
printf 'unexpected\n' > "$tmp/extra-release/extra.txt"
if (cd "$tmp/extra-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/extra-release.out" 2>&1; then
  echo 'extra release asset unexpectedly passed' >&2
  exit 1
fi
grep -q 'release verification directory must contain exactly' "$tmp/extra-release.out"

cp -a "$first" "$tmp/malformed-release"
printf '%s %s\n' "$backend_sha" install-openclaw.sh > "$tmp/malformed-release/install-openclaw.sh.sha256"
if (cd "$tmp/malformed-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/malformed-release.out" 2>&1; then
  echo 'malformed release checksum unexpectedly passed' >&2
  exit 1
fi
grep -q 'install-openclaw.sh.sha256 must contain exactly a SHA-256 and install-openclaw.sh' \
  "$tmp/malformed-release.out"

cp -a "$first" "$tmp/aligned-backend-release"
printf '\n# aligned tamper\n' >> "$tmp/aligned-backend-release/install-openclaw.sh"
(
  cd "$tmp/aligned-backend-release"
  sha256sum install-openclaw.sh > install-openclaw.sh.sha256
)
if (cd "$tmp/aligned-backend-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/aligned-backend-release.out" 2>&1; then
  echo 'aligned tampered backend unexpectedly passed' >&2
  exit 1
fi
grep -q 'release launcher must pin the downloaded backend bytes' "$tmp/aligned-backend-release.out"

cp -a "$first" "$tmp/redirected-launcher-release"
TARGET="$tmp/redirected-launcher-release/install.sh" node <<'NODE'
const fs = require("node:fs");
const target = process.env.TARGET;
let source = fs.readFileSync(target, "utf8");
source = source.replace(
  /^BACKEND_URL=.*$/m,
  "BACKEND_URL='https://attacker.invalid/install-openclaw.sh'",
);
fs.writeFileSync(target, source);
NODE
(
  cd "$tmp/redirected-launcher-release"
  sha256sum install.sh > install.sh.sha256
)
if (cd "$tmp/redirected-launcher-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/redirected-launcher-release.out" 2>&1; then
  echo 'redirected launcher unexpectedly passed' >&2
  exit 1
fi
grep -q 'release launcher backend URL must target its coordinated release asset' \
  "$tmp/redirected-launcher-release.out"

cp -a "$first" "$tmp/aligned-hermes-release"
printf '\naligned Hermes tamper\n' >> "$tmp/aligned-hermes-release/hermes-noosphere-memory-${version}.tar.gz"
(
  cd "$tmp/aligned-hermes-release"
  sha256sum "hermes-noosphere-memory-${version}.tar.gz" \
    > "hermes-noosphere-memory-${version}.tar.gz.sha256"
)
if (cd "$tmp/aligned-hermes-release" && node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files) \
  > "$tmp/aligned-hermes-release.out" 2>&1; then
  echo 'aligned tampered Hermes bundle unexpectedly passed' >&2
  exit 1
fi
grep -q 'release launcher must pin the downloaded Hermes bundle bytes' "$tmp/aligned-hermes-release.out"

# Documentation negative controls: the policy check must reject a documented
# install block that drifts from the published release or loses a guard.
doc_fixture="$tmp/doc-fixture"
mkdir -p "$doc_fixture/docs"
cp "$root/README.md" "$doc_fixture/README.md"
cp "$root/docs/INSTALLATION.md" "$doc_fixture/docs/INSTALLATION.md"

assert_doc_gate_rejects() {
  local label="$1" expected="$2"
  shift 2
  "$@"
  if node "$root/scripts/check-postgres-image-policy.mjs" --packaged-launcher-documents-root "$doc_fixture" \
    > "$tmp/doc-$label.out" 2>&1; then
    echo "documented $label unexpectedly passed" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$tmp/doc-$label.out"; then
    echo "documented $label failed for the wrong reason" >&2
    cat "$tmp/doc-$label.out" >&2
    exit 1
  fi
  cp "$root/README.md" "$doc_fixture/README.md"
  cp "$root/docs/INSTALLATION.md" "$doc_fixture/docs/INSTALLATION.md"
}

assert_doc_gate_rejects \
  'drifted digest' \
  'must document the published install.sh digest' \
  sed -i 's/fa38522104b10991cc85774fade4dffc559090e64838827cffeb74d200d547e0/0000000000000000000000000000000000000000000000000000000000000000/' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'hard-pinned image' \
  'must default NOOSPHERE_IMAGE instead of overriding an operator export' \
  sed -i 's|NOOSPHERE_IMAGE="\${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:1.15.2}"|NOOSPHERE_IMAGE=ghcr.io/sweetsophia/noosphere:1.15.2|' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'hard-pinned version' \
  'must default NOOSPHERE_VERSION instead of overriding an operator export' \
  sed -i 's|NOOSPHERE_VERSION="\${NOOSPHERE_VERSION:-1.15.2}"|NOOSPHERE_VERSION=1.15.2|' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'hard-pinned plugin' \
  'must default NOOSPHERE_PLUGIN_SPEC instead of overriding an operator export' \
  sed -i 's|NOOSPHERE_PLUGIN_SPEC="\${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory@1.15.2}"|NOOSPHERE_PLUGIN_SPEC=npm:@sweetsophia/openclaw-noosphere-memory@1.15.2|' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'mismatched backend tag' \
  'must download the launcher and the backend from the same release tag' \
  sed -i 's|releases/download/v1.15.2/install-openclaw.sh|releases/download/v1.15.1/install-openclaw.sh|' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'missing backend unset' \
  'must unset the backend override so the checksum-verified sibling backend is the one that runs' \
  sed -i '/unset NOOSPHERE_BACKEND_PATH NOOSPHERE_BACKEND_OVERRIDE_SHA256/d' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'missing explicit selection' \
  'must invoke the launcher non-interactively with an explicit integration selection' \
  sed -i 's|bash "\$installer" --non-interactive --with openclaw|bash "\$installer"|' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'single verified digest' \
  'must verify both checksums' \
  sed -i '/sha256sum -c -/!b;n;/\$backend/d' \
    "$doc_fixture/README.md"

assert_doc_gate_rejects \
  'wrong release tag' \
  'must document the published release v' \
  sed -i 's|releases/download/v1.15.2/|releases/download/v9.9.9/|' \
    "$doc_fixture/README.md"

# A document that still carries a valid block must pass.
if ! node "$root/scripts/check-postgres-image-policy.mjs" --packaged-launcher-documents-root "$doc_fixture" \
  > "$tmp/doc-baseline.out" 2>&1; then
  echo 'unchanged documentation unexpectedly failed the policy check' >&2
  cat "$tmp/doc-baseline.out" >&2
  exit 1
fi

printf 'installer_package_tests=GREEN assets=6 deterministic=yes source_mode_matrix=3 canonical_modes=0644/0755 piped_entrypoint=yes sibling_checksum_sensitive=yes remote_checksum_sensitive=yes release_set_verified=yes release_public_fixture_verified=yes release_negative_controls=7 doc_negative_controls=9 doc_baseline=pass\n'
