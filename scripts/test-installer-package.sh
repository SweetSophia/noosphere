#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
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

(
  cd "$first"
  node "$root/scripts/check-postgres-image-policy.mjs" --verify-release-files
) > "$tmp/release-files-positive.out"
grep -q 'PostgreSQL image policy check passed' "$tmp/release-files-positive.out"
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

printf 'installer_package_tests=GREEN assets=6 deterministic=yes piped_entrypoint=yes sibling_checksum_sensitive=yes remote_checksum_sensitive=yes release_set_verified=yes release_negative_controls=7\n'
