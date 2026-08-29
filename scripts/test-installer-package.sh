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

printf 'installer_package_tests=GREEN assets=6 deterministic=yes piped_entrypoint=yes sibling_checksum_sensitive=yes remote_checksum_sensitive=yes\n'
