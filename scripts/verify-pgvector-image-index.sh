#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF=${1:?"usage: verify-pgvector-image-index.sh <multi-arch-image-ref>"}

manifest_json=$(docker buildx imagetools inspect "$IMAGE_REF" --raw)
printf '%s' "$manifest_json" | jq -e '
  [.manifests[] | select(.platform.os == "linux")] as $runnable
  | ($runnable | length) == 2
    and any($runnable[]; .platform.architecture == "amd64")
    and any($runnable[]; .platform.architecture == "arm64")
' >/dev/null

sbom_json=$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{ json .SBOM }}')
printf '%s' "$sbom_json" | jq -e '
  .["linux/amd64"].SPDX != null and .["linux/arm64"].SPDX != null
' >/dev/null

provenance_json=$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{ json .Provenance }}')
printf '%s' "$provenance_json" | jq -e '
  .["linux/amd64"].SLSA != null and .["linux/arm64"].SLSA != null
' >/dev/null

printf 'multi-architecture index, SBOM, and provenance verified: %s\n' "$IMAGE_REF"
