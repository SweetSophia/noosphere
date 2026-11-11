#!/usr/bin/env bash
# Publish an already packed artifact, then verify exact registry bytes.
# Only npm's explicit duplicate-version error may fall through after failure.
# Other publish errors are not evidence of eventual registry propagation.
set -euo pipefail
if (( $# != 3 )); then
  printf 'Usage: %s <tarball> <package@version> <sha512-integrity>\n' "${0##*/}" >&2
  exit 3
fi
tarball=$1
target=$2
integrity=$3
if [[ ! -f "$tarball" || ! -r "$tarball" || ! "$target" =~ ^(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+@[0-9][0-9A-Za-z.+-]*$ || ! "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]]; then
  printf 'Invalid packed artifact, exact package version or sha512 integrity.\n' >&2
  exit 3
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output=$(mktemp) || exit 4
trap 'rm -f "$output"' EXIT
if npm publish "$tarball" --access public --provenance >"$output" 2>&1; then
  printf 'npm accepted publication of %s; verifying registry integrity.\n' "$target"
else
  status=$?
  if grep -qE 'code (E403|EPUBLISHCONFLICT)([^A-Z0-9]|$)' "$output" &&
    grep -qiF 'cannot publish over the previously published versions' "$output"; then
    printf 'npm reports an existing version of %s; exact-integrity readback decides.\n' "$target"
  else
    code=$(grep -oE 'code E[A-Z0-9]+' "$output" | head -n 1 || true)
    code=${code#code }
    # Do not echo arbitrary npm/registry output that may contain credentials.
    printf 'npm publish failed for %s (status %s, code %s). Publication is not confirmed; check npm credentials, package access and registry availability.\n' "$target" "$status" "${code:-UNKNOWN}" >&2
    exit 5
  fi
fi
bash "$script_dir/verify-npm-publication-integrity.sh" "$target" "$integrity" 600 15
