#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-$repo_root/dist}"
version="$(<"$repo_root/VERSION")"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || {
  printf 'Noosphere version is not release-safe: %s\n' "$version" >&2
  exit 1
}

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
install -d -m 0755 "$output_dir" "$work_dir/hermes"

"$repo_root/scripts/package-hermes-plugin.sh" "$work_dir/hermes" >/dev/null
hermes_archive="$work_dir/hermes/hermes-noosphere-memory-${version}.tar.gz"
hermes_checksum="$hermes_archive.sha256"
backend="$repo_root/install-openclaw.sh"
backend_sha=$(sha256sum "$backend" | awk '{print $1}')
hermes_sha=$(sha256sum "$hermes_archive" | awk '{print $1}')
launcher_temp="$work_dir/install.sh"

INSTALLER_TEMPLATE="$repo_root/install.sh" \
INSTALLER_OUTPUT="$launcher_temp" \
INSTALLER_VERSION="$version" \
INSTALLER_BACKEND_URL="https://github.com/SweetSophia/noosphere/releases/download/v${version}/install-openclaw.sh" \
INSTALLER_BACKEND_SHA256="$backend_sha" \
INSTALLER_HERMES_URL="https://github.com/SweetSophia/noosphere/releases/download/v${version}/hermes-noosphere-memory-${version}.tar.gz" \
INSTALLER_HERMES_SHA256="$hermes_sha" \
  node <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.env.INSTALLER_TEMPLATE, "utf8");
const replacements = [
  [/^RELEASE_VERSION='[^']+'$/m, `RELEASE_VERSION='${process.env.INSTALLER_VERSION}'`],
  [/^BACKEND_URL='[^']+'$/m, `BACKEND_URL='${process.env.INSTALLER_BACKEND_URL}'`],
  [/^BACKEND_SHA256='[a-f0-9]{64}'$/m, `BACKEND_SHA256='${process.env.INSTALLER_BACKEND_SHA256}'`],
  [/^HERMES_BUNDLE_URL='[^']+'$/m, `HERMES_BUNDLE_URL='${process.env.INSTALLER_HERMES_URL}'`],
  [/^HERMES_BUNDLE_SHA256='[a-f0-9]{64}'$/m, `HERMES_BUNDLE_SHA256='${process.env.INSTALLER_HERMES_SHA256}'`],
];
let output = source;
for (const [pattern, replacement] of replacements) {
  const matches = output.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) throw new Error(`${pattern} must match exactly once, found ${matches.length}`);
  output = output.replace(pattern, replacement);
}
fs.writeFileSync(process.env.INSTALLER_OUTPUT, output, { mode: 0o755 });
NODE

install -m 0755 "$launcher_temp" "$output_dir/install.sh"
install -m 0755 "$backend" "$output_dir/install-openclaw.sh"
install -m 0644 "$hermes_archive" "$output_dir/$(basename "$hermes_archive")"
install -m 0644 "$hermes_checksum" "$output_dir/$(basename "$hermes_checksum")"

(
  cd "$output_dir"
  sha256sum install.sh > install.sh.sha256
  sha256sum install-openclaw.sh > install-openclaw.sh.sha256
)

printf 'Installer assets: %s\n' "$output_dir"
printf 'Version: %s\n' "$version"
printf 'Backend SHA-256: %s\n' "$backend_sha"
printf 'Hermes SHA-256: %s\n' "$hermes_sha"
