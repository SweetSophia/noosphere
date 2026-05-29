#!/usr/bin/env bash
set -euo pipefail

APP_URL="${NOOSPHERE_APP_URL:-http://127.0.0.1:6578}"
DB_CONTAINER="${NOOSPHERE_DB_CONTAINER:-noosphere-db}"
DB_USER="${NOOSPHERE_DB_USER:-noosphere}"
DB_NAME="${NOOSPHERE_DB_NAME:-noosphere}"
EXPECTED_DB_VOLUME="${NOOSPHERE_EXPECTED_DB_VOLUME:-noosphere_postgres_data}"
MIN_TOPICS="${NOOSPHERE_MIN_TOPICS:-1}"
MIN_ARTICLES="${NOOSPHERE_MIN_ARTICLES:-1}"
MIN_API_KEYS="${NOOSPHERE_MIN_API_KEYS:-1}"

fail() {
  printf 'Noosphere deploy verification failed: %s\n' "$1" >&2
  exit 1
}

require_positive_int() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be a non-negative integer, got '$value'"
}

require_positive_int "NOOSPHERE_MIN_TOPICS" "$MIN_TOPICS"
require_positive_int "NOOSPHERE_MIN_ARTICLES" "$MIN_ARTICLES"
require_positive_int "NOOSPHERE_MIN_API_KEYS" "$MIN_API_KEYS"

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || fail "database container '$DB_CONTAINER' does not exist"

mounted_volume="$(
  docker inspect "$DB_CONTAINER" \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
)"

if [[ -z "$mounted_volume" ]]; then
  fail "could not determine Postgres data volume mounted by '$DB_CONTAINER'"
fi

if [[ "$mounted_volume" != "$EXPECTED_DB_VOLUME" ]]; then
  fail "database container uses volume '$mounted_volume', expected '$EXPECTED_DB_VOLUME'"
fi

curl -fsS "$APP_URL/api/health" >/dev/null || fail "health check failed at $APP_URL/api/health"

counts="$(
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -Atc \
    'select (select count(*) from "Topic"), (select count(*) from "Article" where "deletedAt" is null), (select count(*) from "ApiKey");'
)"

IFS='|' read -r topics articles api_keys <<< "$counts"

require_positive_int "topic count" "$topics"
require_positive_int "article count" "$articles"
require_positive_int "API key count" "$api_keys"

(( topics >= MIN_TOPICS )) || fail "topic count is $topics, expected at least $MIN_TOPICS"
(( articles >= MIN_ARTICLES )) || fail "article count is $articles, expected at least $MIN_ARTICLES"
(( api_keys >= MIN_API_KEYS )) || fail "API key count is $api_keys, expected at least $MIN_API_KEYS"

printf 'Noosphere deploy verification passed: volume=%s health=ok topics=%s articles=%s apiKeys=%s\n' \
  "$mounted_volume" "$topics" "$articles" "$api_keys"
