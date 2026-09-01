#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/hermes-noosphere-memory"
output_dir="${1:-$repo_root/dist}"
version="$(sed -n 's/^version:[[:space:]]*//p' "$source_dir/plugins/memory/noosphere/plugin.yaml")"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || {
  printf 'Hermes plugin version is not release-safe: %s\n' "$version" >&2
  exit 1
}

archive_name="hermes-noosphere-memory-${version}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

install -d -m 0755 "$work_dir/$archive_name" "$output_dir"
tar \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  -C "$source_dir" -cf - . |
  tar -C "$work_dir/$archive_name" -xf -
install -m 0644 "$repo_root/LICENSE" "$work_dir/$archive_name/LICENSE"
install -m 0644 "$repo_root/NOTICE" "$work_dir/$archive_name/NOTICE"
chmod -R u=rwX,go=rX "$work_dir/$archive_name"

archive_path="$output_dir/${archive_name}.tar.gz"
tar \
  --sort=name \
  --mtime='@0' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --format=ustar \
  -C "$work_dir" -cf - "$archive_name" |
  gzip -n > "$archive_path"

(
  cd "$output_dir"
  sha256sum "${archive_name}.tar.gz" > "${archive_name}.tar.gz.sha256"
)

printf 'Hermes bundle: %s\n' "$archive_path"
printf 'SHA-256 file: %s.sha256\n' "$archive_path"
