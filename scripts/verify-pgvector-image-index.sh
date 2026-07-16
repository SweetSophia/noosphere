#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF=${1:?"usage: verify-pgvector-image-index.sh <multi-arch-image-ref>"}

fail() {
  printf '%s\n' "$*" >&2
  return 1
}

if ! manifest_json=$(docker buildx imagetools inspect "$IMAGE_REF" --raw); then
  fail "failed to inspect image index: $IMAGE_REF"
fi
# Keep this exact pair synchronized with both platform matrices in
# postgres-pgvector-image.yml. BuildKit attestation manifests use
# os=unknown/architecture=unknown and are not runnable platforms.
if ! printf '%s' "$manifest_json" | jq -e '
  [.manifests[] | select(
    .platform.os != null
      and .platform.architecture != null
      and .platform.os != "unknown"
      and .platform.architecture != "unknown"
  )] as $runnable
  | ($runnable | length) == 2
    and any($runnable[]; .platform.os == "linux" and .platform.architecture == "amd64")
    and any($runnable[]; .platform.os == "linux" and .platform.architecture == "arm64")
' >/dev/null; then
  fail "image index must contain exactly linux/amd64 and linux/arm64: $IMAGE_REF"
fi

if ! sbom_json=$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{ json .SBOM }}'); then
  fail "failed to inspect image SBOMs: $IMAGE_REF"
fi
if ! printf '%s' "$sbom_json" | jq -e '
  def nonempty_string: type == "string" and length > 0;
  def named_package: type == "object" and (.name | nonempty_string);
  . as $root
  | all(["linux/amd64", "linux/arm64"][];
    . as $platform
    | ($root[$platform].SPDX | type) == "object"
      and ($root[$platform].SPDX.SPDXID | nonempty_string)
      and ($root[$platform].SPDX.spdxVersion | nonempty_string)
      and (($root[$platform].SPDX.packages // null) | type) == "array"
      and any($root[$platform].SPDX.packages[]; named_package)
  )
' >/dev/null; then
  fail "non-empty SPDX SBOM required for linux/amd64 and linux/arm64: $IMAGE_REF"
fi

if ! provenance_json=$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{ json .Provenance }}'); then
  fail "failed to inspect image provenance: $IMAGE_REF"
fi
if ! printf '%s' "$provenance_json" | jq -e '
  def nonempty_string: type == "string" and length > 0;
  def meaningful_digest:
    if type == "object" then
      any(to_entries[]; (.key | nonempty_string) and (.value | nonempty_string))
    else
      false
    end;
  def traced_material:
    type == "object"
      and (.uri | nonempty_string)
      and (.digest | meaningful_digest);
  . as $root
  | all(["linux/amd64", "linux/arm64"][];
    . as $platform
    | ($root[$platform].SLSA | type) == "object"
      and $root[$platform].SLSA.buildType == "https://mobyproject.org/buildkit@v1"
      and (($root[$platform].SLSA.materials // null) | type) == "array"
      and any($root[$platform].SLSA.materials[]; traced_material)
  )
' >/dev/null; then
  fail "non-empty SLSA provenance required for linux/amd64 and linux/arm64: $IMAGE_REF"
fi

printf 'multi-architecture index, SBOM, and provenance verified: %s\n' "$IMAGE_REF"
