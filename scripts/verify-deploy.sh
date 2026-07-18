#!/usr/bin/env bash
set -euo pipefail

APP_URL="${NOOSPHERE_APP_URL:-http://127.0.0.1:6578}"
DB_CONTAINER="${NOOSPHERE_DB_CONTAINER:-noosphere-db}"
DB_USER="${NOOSPHERE_DB_USER:-noosphere}"
DB_NAME="${NOOSPHERE_DB_NAME:-noosphere}"
EXPECTED_DB_VOLUME="${NOOSPHERE_EXPECTED_DB_VOLUME:-noosphere_postgres_data}"
if [[ "$EXPECTED_DB_VOLUME" == *_data ]]; then
  default_authorization_volume="${EXPECTED_DB_VOLUME%_data}_authorization"
else
  default_authorization_volume="${EXPECTED_DB_VOLUME}_authorization"
fi
EXPECTED_AUTHORIZATION_VOLUME="${NOOSPHERE_EXPECTED_POSTGRES_AUTHORIZATION_VOLUME:-$default_authorization_volume}"
EXPECTED_IMAGE_MODE="${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-candidate}"
POSTGRES_EVIDENCE="${NOOSPHERE_POSTGRES_EVIDENCE:-}"
SOURCE_IMAGE='postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
CANDIDATE_IMAGE='ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292'
EXPECTED_POSTGRES_VERSION='16.14'
EXPECTED_PGVECTOR_VERSION='0.8.1'
MIN_TOPICS="${NOOSPHERE_MIN_TOPICS:-1}"
MIN_ARTICLES="${NOOSPHERE_MIN_ARTICLES:-1}"
MIN_API_KEYS="${NOOSPHERE_MIN_API_KEYS:-1}"
HEALTH_RETRIES="${NOOSPHERE_HEALTH_RETRIES:-10}"
HEALTH_RETRY_DELAY="${NOOSPHERE_HEALTH_RETRY_DELAY:-2}"

fail() {
  printf 'Noosphere deploy verification failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'

require_non_negative_int() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be a non-negative integer, got '$value'"
}

require_non_negative_int "NOOSPHERE_MIN_TOPICS" "$MIN_TOPICS"
require_non_negative_int "NOOSPHERE_MIN_ARTICLES" "$MIN_ARTICLES"
require_non_negative_int "NOOSPHERE_MIN_API_KEYS" "$MIN_API_KEYS"
require_non_negative_int "NOOSPHERE_HEALTH_RETRIES" "$HEALTH_RETRIES"
require_non_negative_int "NOOSPHERE_HEALTH_RETRY_DELAY" "$HEALTH_RETRY_DELAY"
(( HEALTH_RETRIES >= 1 )) || fail "NOOSPHERE_HEALTH_RETRIES must be at least 1, got '$HEALTH_RETRIES'"

validate_volume_and_evidence() {
  mounted_volume="$(
    docker inspect "$DB_CONTAINER" \
      --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
  )"
  [[ -n "$mounted_volume" ]] || fail "could not determine Postgres data volume mounted by '$DB_CONTAINER'"
  [[ "$mounted_volume" == "$EXPECTED_DB_VOLUME" ]] ||
    fail "database container uses volume '$mounted_volume', expected '$EXPECTED_DB_VOLUME'"

  volume_driver="$(docker volume inspect "$mounted_volume" --format '{{.Driver}}')" ||
    fail "failed to inspect PostgreSQL volume '$mounted_volume'"
  [[ "$volume_driver" == local ]] || fail "PostgreSQL volume uses driver '$volume_driver', expected 'local'"

  [[ "$EXPECTED_IMAGE_MODE" == candidate ]] || return 0

  authorization_mounts="$(docker inspect "$DB_CONTAINER" | jq -c --arg volume "$EXPECTED_AUTHORIZATION_VOLUME" '
    [.[0].Mounts[] | select(.Destination == "/run/noosphere-pgvector")]')" ||
    fail 'failed to inspect candidate-authorization mount'
  jq -e --arg volume "$EXPECTED_AUTHORIZATION_VOLUME" '
    length == 1 and .[0].Type == "volume" and .[0].Name == $volume and .[0].RW == false
  ' >/dev/null <<< "$authorization_mounts" ||
    fail "database must mount external authorization volume '$EXPECTED_AUTHORIZATION_VOLUME' read-only"
  authorization_marker="$(docker exec "$DB_CONTAINER" cat /run/noosphere-pgvector/candidate-authorized 2>/dev/null)" ||
    fail 'candidate-authorization marker is missing'
  [[ "$authorization_marker" == "$CANDIDATE_IMAGE" ]] || fail 'candidate-authorization marker names another image'
  writer_marker="$(docker exec "$DB_CONTAINER" cat /run/noosphere-pgvector/writer-authorized 2>/dev/null)" ||
    fail 'writer-authorization marker is missing'
  [[ "$writer_marker" == "$CANDIDATE_IMAGE" ]] || fail 'writer-authorization marker names another image'

  [[ -f "$POSTGRES_EVIDENCE" ]] || fail "PostgreSQL transition evidence does not exist: $POSTGRES_EVIDENCE"
  evidence_phase=$(jq -er '.phase' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence phase'
  evidence_mode=$(jq -er '.mode' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence mode'
  evidence_run=$(jq -er '.runId' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence run ID'
  evidence_probe=$(jq -er '.probeDatabase' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence template0 probe claim'
  evidence_volume=$(jq -er '.volume' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence volume'
  evidence_image=$(jq -er '.candidateImage' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence image'
  evidence_fingerprint=$(jq -er '.volumeFingerprint' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence volume fingerprint'
  evidence_authorization=$(jq -er '.authorizationVolume' "$POSTGRES_EVIDENCE") || fail 'failed to read evidence authorization volume'
  evidence_authorization_fingerprint=$(jq -er '.authorizationVolumeFingerprint' "$POSTGRES_EVIDENCE") ||
    fail 'failed to read evidence authorization volume fingerprint'
  [[ "$evidence_phase" == complete ]] || fail "PostgreSQL transition evidence is not complete: $evidence_phase"
  [[ "$evidence_mode" == switch || "$evidence_mode" == new-install ]] || fail 'PostgreSQL transition evidence has an invalid mode'
  [[ "$evidence_run" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$ ]] || fail 'PostgreSQL transition evidence has an invalid run ID'
  probe_digest=$(printf '%s' "$evidence_run" | sha256sum | awk '{print $1}')
  [[ "$evidence_probe" == "noosphere_a2b_template0_${probe_digest:0:24}" ]] ||
    fail 'PostgreSQL transition evidence has an invalid template0 probe claim'
  [[ "$evidence_volume" == "$mounted_volume" ]] || fail 'PostgreSQL transition evidence names another volume'
  [[ "$evidence_image" == "$CANDIDATE_IMAGE" ]] || fail 'PostgreSQL transition evidence names another candidate image'
  [[ "$evidence_authorization" == "$EXPECTED_AUTHORIZATION_VOLUME" ]] ||
    fail 'PostgreSQL transition evidence names another authorization volume'
  actual_fingerprint=$(docker volume inspect "$mounted_volume" | jq -Sc \
    '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' | sha256sum | awk '{print $1}')
  [[ "$actual_fingerprint" == "$evidence_fingerprint" ]] || fail 'PostgreSQL volume identity differs from completed transition evidence'
  actual_authorization_fingerprint=$(docker volume inspect "$EXPECTED_AUTHORIZATION_VOLUME" | jq -Sc \
    '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' | sha256sum | awk '{print $1}')
  [[ "$actual_authorization_fingerprint" == "$evidence_authorization_fingerprint" ]] ||
    fail 'PostgreSQL authorization volume differs from completed transition evidence'
}

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || fail "database container '$DB_CONTAINER' does not exist"

case "$EXPECTED_IMAGE_MODE" in
  candidate)
    [[ -n "$POSTGRES_EVIDENCE" ]] || fail 'candidate verification requires NOOSPHERE_POSTGRES_EVIDENCE'
    [[ -f "$POSTGRES_EVIDENCE" ]] || fail "PostgreSQL transition evidence does not exist: $POSTGRES_EVIDENCE"
    expected_image="$CANDIDATE_IMAGE"
    expected_pgvector="$EXPECTED_PGVECTOR_VERSION"
    ;;
  source)
    expected_image="$SOURCE_IMAGE"
    expected_pgvector=''
    ;;
  *)
    fail "NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE must be candidate or source"
    ;;
esac

configured_image="$(docker inspect "$DB_CONTAINER" --format '{{.Config.Image}}')"
image_id="$(docker inspect "$DB_CONTAINER" --format '{{.Image}}')"
repo_digests="$(docker image inspect "$image_id" --format '{{json .RepoDigests}}')"
if [[ "$configured_image" != "$expected_image" ]] &&
   ! jq -e --arg image "$expected_image" 'index($image) != null' >/dev/null <<< "$repo_digests"; then
  fail "database container image '$configured_image' is not the exact $EXPECTED_IMAGE_MODE artifact"
fi

postgres_version="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c 'SHOW server_version;')" ||
  fail "failed to query PostgreSQL version from '$DB_CONTAINER'"
[[ "$postgres_version" == "$EXPECTED_POSTGRES_VERSION" ]] ||
  fail "PostgreSQL version is '$postgres_version', expected '$EXPECTED_POSTGRES_VERSION'"

available_pgvector="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT default_version FROM pg_available_extensions WHERE name = 'vector';")" ||
  fail "failed to query pgvector availability from '$DB_CONTAINER'"
[[ "$available_pgvector" == "$expected_pgvector" ]] ||
  fail "pgvector availability is '${available_pgvector:-absent}', expected '${expected_pgvector:-absent}'"

validate_volume_and_evidence

database_list="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
  'SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname;')" ||
  fail 'failed to enumerate PostgreSQL databases'
nonconnectable_count="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
  "SELECT count(*) FROM pg_database WHERE NOT datallowconn AND datname <> 'template0';")" ||
  fail 'failed to enumerate non-connectable PostgreSQL databases'
[[ "$nonconnectable_count" == 0 ]] || fail 'cannot verify vector absence in a non-connectable database'

while IFS= read -r database; do
  [[ -n "$database" ]] || continue
  installed="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$database" -c \
    "SELECT count(*) FROM pg_extension WHERE extname = 'vector';")" ||
    fail "failed to inspect installed extensions in database '$database'"
  [[ "$installed" == 0 ]] || fail "vector extension is installed in database '$database'"
done <<< "$database_list"

if [[ "$EXPECTED_IMAGE_MODE" == candidate ]]; then
  probe="$evidence_probe"
  existing_probe=$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
    "SELECT count(*) FROM pg_database WHERE datname = '$probe';") || fail 'failed to inspect template0 verification claim'
  if [[ "$existing_probe" == 1 ]]; then
    docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
      "DROP DATABASE \"$probe\" WITH (FORCE);" >/dev/null || fail 'failed to remove interrupted template0 verification probe'
  fi
  probe_created=false
  cleanup_probe() {
    if [[ "$probe_created" == true ]]; then
      docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
        "DROP DATABASE IF EXISTS \"$probe\" WITH (FORCE);" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_probe EXIT
  docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
    "CREATE DATABASE \"$probe\" TEMPLATE template0;" >/dev/null || fail 'failed to create template0 verification probe'
  probe_created=true
  template_installed="$(docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$probe" -c \
    "SELECT count(*) FROM pg_extension WHERE extname = 'vector';")" || fail 'failed to inspect template0 verification probe'
  docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c \
    "DROP DATABASE \"$probe\";" >/dev/null || fail 'failed to remove template0 verification probe'
  probe_created=false
  trap - EXIT
  [[ "$template_installed" == 0 ]] || fail 'vector extension is installed in template0'
fi

# Retry health check to tolerate app startup race conditions.
health_ok=false
last_curl_err=0
for ((i = 1; i <= HEALTH_RETRIES; i++)); do
  if curl -fsS --connect-timeout 5 --max-time 10 "$APP_URL/api/health" >/dev/null 2>&1; then
    health_ok=true
    break
  fi
  last_curl_err=$?
  if (( i < HEALTH_RETRIES )); then
    sleep "$HEALTH_RETRY_DELAY"
  fi
done
[[ "$health_ok" == "true" ]] || fail "health check failed at $APP_URL/api/health (last curl exit code: $last_curl_err)"

counts="$(
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -Atc \
    'select (select count(*) from "Topic"), (select count(*) from "Article" where "deletedAt" is null), (select count(*) from "ApiKey");'
)" || fail "failed to query database counts from '$DB_CONTAINER' (is PostgreSQL ready?)"

IFS='|' read -r topics articles api_keys <<< "$counts"

require_non_negative_int "topic count" "$topics"
require_non_negative_int "article count" "$articles"
require_non_negative_int "API key count" "$api_keys"

(( topics >= MIN_TOPICS )) || fail "topic count is $topics, expected at least $MIN_TOPICS"
(( articles >= MIN_ARTICLES )) || fail "article count is $articles, expected at least $MIN_ARTICLES"
(( api_keys >= MIN_API_KEYS )) || fail "API key count is $api_keys, expected at least $MIN_API_KEYS"

printf 'Noosphere deploy verification passed: volume=%s health=ok topics=%s articles=%s apiKeys=%s\n' \
  "$mounted_volume" "$topics" "$articles" "$api_keys"
