#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF=${1:?"usage: test-pgvector-image.sh <image-ref> [linux/amd64|linux/arm64]"}
PLATFORM=${2:-}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck disable=SC1091
source "$REPO_ROOT/docker/postgres-pgvector/metadata.env"

container="noosphere-pgvector-smoke-${RANDOM}-${RANDOM}"
platform_args=()
if [[ -n "$PLATFORM" ]]; then
  platform_args=(--platform "$PLATFORM")
fi

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
  docker pull "${platform_args[@]}" "$IMAGE_REF" >/dev/null
fi

assert_label() {
  local key=$1
  local expected=$2
  local actual
  actual=$(docker image inspect "$IMAGE_REF" --format "{{ index .Config.Labels \"$key\" }}")
  if [[ "$actual" != "$expected" ]]; then
    printf 'label %s mismatch: expected %s, got %s\n' "$key" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_label org.opencontainers.image.base.digest "${POSTGRES_IMAGE##*@}"
assert_label org.opencontainers.image.licenses "$PGVECTOR_LICENSE"
assert_label io.noosphere.postgresql.version "$POSTGRES_VERSION"
assert_label io.noosphere.alpine.version "$ALPINE_VERSION"
assert_label io.noosphere.pgvector.version "$PGVECTOR_VERSION"
assert_label io.noosphere.pgvector.source.url "$PGVECTOR_SOURCE_URL"
assert_label io.noosphere.pgvector.source.sha256 "$PGVECTOR_SOURCE_SHA256"
assert_label io.noosphere.pgvector.license "$PGVECTOR_LICENSE"
assert_label io.noosphere.pgvector.optflags portable
assert_label io.noosphere.pgvector.llvm-bitcode disabled

docker run -d --rm \
  --name "$container" \
  "${platform_args[@]}" \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test \
  "$IMAGE_REF" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U test -d test >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U test -d test >/dev/null

postgres_version=$(docker exec "$container" psql -U test -d test -Atqc 'SHOW server_version')
alpine_version=$(docker exec "$container" cat /etc/alpine-release)
[[ "$postgres_version" == "$POSTGRES_VERSION" ]]
[[ "$alpine_version" == "$ALPINE_VERSION" ]]

case "$PLATFORM" in
  linux/amd64) expected_machine=x86_64 ;;
  linux/arm64) expected_machine=aarch64 ;;
  "") expected_machine= ;;
  *) printf 'unsupported smoke-test platform: %s\n' "$PLATFORM" >&2; exit 1 ;;
esac
if [[ -n "$expected_machine" ]]; then
  actual_machine=$(docker exec "$container" uname -m)
  [[ "$actual_machine" == "$expected_machine" ]]
fi

docker exec "$container" test -s /usr/share/doc/pgvector/LICENSE
if docker exec "$container" test -d /usr/local/lib/postgresql/bitcode/vector; then
  printf 'unexpected pgvector LLVM bitcode directory is present\n' >&2
  exit 1
fi
docker exec "$container" psql -v ON_ERROR_STOP=1 -U test -d test -qc 'CREATE EXTENSION vector'
extension_version=$(
  docker exec "$container" psql -U test -d test -Atqc \
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
)
[[ "$extension_version" == "$PGVECTOR_VERSION" ]]

vector_result=$(
  docker exec "$container" psql -v ON_ERROR_STOP=1 -U test -d test -Atqc \
    "SELECT CASE WHEN vector_dims('[1,2,3]'::vector) = 3 AND ('[1,2,3]'::vector <-> '[1,2,3]'::vector) = 0 THEN 'ok' ELSE 'invalid' END"
)
[[ "$vector_result" == ok ]]

printf 'pgvector image smoke test passed: %s (%s)\n' "$IMAGE_REF" "${PLATFORM:-native}"
