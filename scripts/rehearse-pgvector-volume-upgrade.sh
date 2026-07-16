#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_path="$repo_root/docker/postgres-pgvector/rehearsal.env"
fixture_path="$repo_root/docker/postgres-pgvector/rehearsal-fixture.sql"
integrity_path="$repo_root/docker/postgres-pgvector/rehearsal-integrity.sql"
schema_path="$repo_root/docker/postgres-pgvector/rehearsal-schema.sql"
platform=${1:-linux/amd64}

case "$platform" in
  linux/amd64|linux/arm64) ;;
  *) printf 'unsupported platform: %s\n' "$platform" >&2; exit 2 ;;
esac

# shellcheck disable=SC1090
source "$config_path"

for image_ref in "$SOURCE_IMAGE" "$CANDIDATE_IMAGE"; do
  if [[ ! "$image_ref" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf 'rehearsal image is not digest-addressed: %s\n' "$image_ref" >&2
    exit 1
  fi
done
if [[ ! "$EXPECTED_INTEGRITY_SHA256" =~ ^(TO_BE_RECORDED|[0-9a-f]{64})$ ]]; then
  printf 'invalid EXPECTED_INTEGRITY_SHA256 in %s\n' "$config_path" >&2
  exit 1
fi
if [[ ! "$CANDIDATE_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'invalid CANDIDATE_SOURCE_COMMIT in %s\n' "$config_path" >&2
  exit 1
fi

log() { printf '[pgvector-rehearsal:%s] %s\n' "$platform" "$*"; }
die() { printf '[pgvector-rehearsal:%s] ERROR: %s\n' "$platform" "$*" >&2; exit 1; }

for required_command in docker jq node sha256sum od; do
  command -v "$required_command" >/dev/null || die "required command is missing: $required_command"
done
docker buildx version >/dev/null 2>&1 || die 'Docker Buildx plugin is missing'

run_id=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
label_key=io.noosphere.rehearsal
prefix="noosphere-pgvector-rehearsal-${run_id}"
source_volume="${prefix}-source"
physical_volume="${prefix}-physical"
candidate_restore_volume="${prefix}-candidate-restore"
source_restore_volume="${prefix}-source-restore"
backup_volume="${prefix}-backup"
source_container="${prefix}-source"
candidate_container="${prefix}-candidate"
rollback_container="${prefix}-rollback"
candidate_restore_container="${prefix}-candidate-restore"
source_restore_container="${prefix}-source-restore"
copy_container="${prefix}-copy"
control_container="${prefix}-control"

volumes=(
  "$source_volume" "$physical_volume" "$candidate_restore_volume"
  "$source_restore_volume" "$backup_volume"
)
containers=(
  "$source_container" "$candidate_container" "$rollback_container"
  "$candidate_restore_container" "$source_restore_container" "$copy_container"
  "$control_container"
)

[[ -f "$repo_root/node_modules/prisma/build/index.js" ]] ||
  die 'Prisma CLI is missing; run npm ci before the rehearsal'
[[ -d "$repo_root/node_modules/pg" ]] ||
  die 'PostgreSQL Node driver is missing; run npm ci before the rehearsal'

owned_container() {
  [[ "$(docker inspect --format "{{ index .Config.Labels \"$label_key\" }}" "$1" 2>/dev/null || true)" == "$run_id" ]]
}

owned_volume() {
  [[ "$(docker volume inspect --format "{{ index .Labels \"$label_key\" }}" "$1" 2>/dev/null || true)" == "$run_id" ]]
}

cleanup() {
  local resource
  for resource in "${containers[@]}"; do
    if owned_container "$resource"; then
      docker rm --force "$resource" >/dev/null 2>&1 || true
    fi
  done
  for resource in "${volumes[@]}"; do
    if owned_volume "$resource"; then
      docker volume rm "$resource" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

for resource in "${containers[@]}"; do
  if docker container inspect "$resource" >/dev/null 2>&1; then
    die "refusing to reuse pre-existing container $resource"
  fi
done
for resource in "${volumes[@]}"; do
  if docker volume inspect "$resource" >/dev/null 2>&1; then
    die "refusing to reuse pre-existing volume $resource"
  fi
done

declare -A protected_volumes=()
declare -A production_db_containers=(
  [noosphere-db]=1
  [noosphere-openclaw-db]=1
)
while IFS= read -r db_container; do
  [[ -n "$db_container" ]] && production_db_containers["$db_container"]=1
done < <(docker ps -a \
  --filter label=com.docker.compose.project=noosphere \
  --filter label=com.docker.compose.service=db \
  --format '{{.Names}}')
for db_container in "${!production_db_containers[@]}"; do
  if docker container inspect "$db_container" >/dev/null 2>&1; then
    while IFS= read -r mounted_volume; do
      [[ -n "$mounted_volume" ]] && protected_volumes["$mounted_volume"]=1
    done < <(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$db_container")
  fi
done
protected_volumes[noosphere_postgres_data]=1
for resource in "${volumes[@]}"; do
  [[ -z "${protected_volumes[$resource]:-}" ]] || die "refusing protected database volume $resource"
done

docker pull --platform "$platform" "$SOURCE_IMAGE" >/dev/null
docker pull --platform "$platform" "$CANDIDATE_IMAGE" >/dev/null

candidate_provenance=$(
  docker buildx imagetools inspect "$CANDIDATE_IMAGE" --format '{{ json .Provenance }}'
)
if ! provenance_source=$(jq -er --arg platform "$platform" '
  .[$platform]?.SLSA?.metadata?["https://mobyproject.org/buildkit@v1#metadata"]?.vcs?.source
  | select(type == "string" and length > 0)
' <<<"$candidate_provenance"); then
  die "candidate provenance is missing a source for $platform"
fi
if ! provenance_revision=$(jq -er --arg platform "$platform" '
  .[$platform]?.SLSA?.metadata?["https://mobyproject.org/buildkit@v1#metadata"]?.vcs?.revision
  | select(type == "string" and test("^[0-9a-f]{40}$"))
' <<<"$candidate_provenance"); then
  die "candidate provenance is missing a valid revision for $platform"
fi
[[ "$provenance_source" == "$CANDIDATE_SOURCE_REPOSITORY" ]] ||
  die "candidate provenance source is $provenance_source"
[[ "$provenance_revision" == "$CANDIDATE_SOURCE_COMMIT" ]] ||
  die "candidate provenance revision is $provenance_revision"

for resource in "${volumes[@]}"; do
  docker volume create --label "$label_key=$run_id" "$resource" >/dev/null
  owned_volume "$resource" || die "volume ownership label mismatch: $resource"
done

start_database() {
  local name=$1 image=$2 volume=$3 backup_mode=${4:-none}
  local backup_mount=()
  if [[ "$backup_mode" == write ]]; then
    backup_mount=(-v "$backup_volume:/backup")
  elif [[ "$backup_mode" == read ]]; then
    backup_mount=(-v "$backup_volume:/backup:ro")
  fi

  docker run --detach \
    --name "$name" \
    --label "$label_key=$run_id" \
    --platform "$platform" \
    --publish 127.0.0.1::5432 \
    -e POSTGRES_USER=noosphere \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=noosphere \
    -v "$volume:/var/lib/postgresql/data" \
    "${backup_mount[@]}" \
    "$image" >/dev/null

  owned_container "$name" || die "container ownership label mismatch: $name"
  local attempt
  for ((attempt = 1; attempt <= 90; attempt++)); do
    # pg_isready can succeed against the temporary initdb server before the
    # requested database exists. Require a real query against the final DB.
    if [[ "$(docker exec "$name" cat /proc/1/comm 2>/dev/null || true)" == postgres ]] &&
      docker exec "$name" psql -XAtq -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null |
        grep -x '1' >/dev/null; then
      return
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then
      docker logs "$name" >&2 || true
      die "database container exited before readiness: $name"
    fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  die "database did not become ready: $name"
}

assert_mount_identity() {
  local name=$1 expected=$2 actual
  actual=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{println .Name}}{{end}}{{end}}' "$name")
  [[ "$actual" == "$expected" ]] || die "$name mounted $actual instead of $expected"
}

sql_value() {
  local name=$1 query=$2
  docker exec "$name" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c "$query"
}

assert_no_collation_warning() {
  local name=$1 logs
  logs=$(docker logs "$name" 2>&1)
  if grep -Ei 'collation version mismatch|database .* collation version' <<<"$logs" >/dev/null; then
    docker logs "$name" >&2
    die "collation warning found in startup log for $name"
  fi
}

database_identity() {
  local name=$1
  sql_value "$name" "
    SELECT datlocprovider::text || '|' || datcollate || '|' || datctype || '|' ||
           pg_encoding_to_char(encoding) || '|' || coalesce(daticulocale, '<null>') || '|' ||
           coalesce(datcollversion, '<null>') || '|' ||
           coalesce(pg_database_collation_actual_version(oid), '<null>')
    FROM pg_database WHERE datname = current_database();"
}

assert_database_contract() {
  local name=$1 expected_identity=$2 expected_checksums=$3 volume=$4 version mismatch plan
  assert_mount_identity "$name" "$volume"
  version=$(sql_value "$name" 'SHOW server_version;')
  [[ "$version" == "$EXPECTED_POSTGRES_VERSION" ]] || die "$name PostgreSQL version is $version"
  [[ "$(sql_value "$name" "SELECT current_database() || '|' || current_user;")" == 'noosphere|noosphere' ]] || die "$name database identity mismatch"
  [[ "$(database_identity "$name")" == "$expected_identity" ]] || die "$name locale/collation identity changed"
  [[ "$(sql_value "$name" 'SHOW data_checksums;')" == "$expected_checksums" ]] ||
    die "$name data-checksum state changed"
  mismatch=$(sql_value "$name" "
    SELECT count(*) FROM pg_database
    WHERE datname = current_database()
      AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);")
  [[ "$mismatch" == 0 ]] || die "$name reports a collation version mismatch"
  assert_no_collation_warning "$name"
  plan=$(sql_value "$name" "SET enable_seqscan = off; EXPLAIN (COSTS OFF) SELECT id FROM \"UpgradeRehearsalFixture\" ORDER BY \"sortKey\" COLLATE \"default\", id;")
  grep -q 'UpgradeRehearsalFixture_sort_idx' <<<"$plan" || die "$name did not use the collation-sensitive fixture index"
}

table_snapshots() {
  local name=$1 table rows
  while IFS= read -r table; do
    rows=$(sql_value "$name" "
      SET TIME ZONE 'UTC';
      SELECT coalesce(jsonb_agg(row_data ORDER BY row_data::text)::text, '[]')
      FROM (SELECT to_jsonb(table_row) AS row_data FROM public.\"$table\" AS table_row) AS rows;")
    printf '%s|%s\n' "$table" "$rows"
  done < <(sql_value "$name" "
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY tablename;")
}

expected_migration_history() {
  local migration migration_count=0
  while IFS= read -r migration; do
    printf '%s|%s\n' \
      "$(basename "$(dirname "$migration")")" \
      "$(sha256sum "$migration" | awk '{print $1}')"
    migration_count=$((migration_count + 1))
  done < <(find "$repo_root/prisma/migrations" -mindepth 2 -maxdepth 2 -name migration.sql -print | sort)
  [[ "$migration_count" == "$EXPECTED_MIGRATION_COUNT" ]] ||
    die "found $migration_count migrations, expected $EXPECTED_MIGRATION_COUNT"
}

actual_migration_history() {
  local name=$1
  sql_value "$name" "
    SELECT migration_name || '|' || checksum
    FROM \"_prisma_migrations\"
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
    ORDER BY migration_name;"
}

assert_migration_history() {
  local name=$1 expected actual total invalid
  expected=$(expected_migration_history)
  actual=$(actual_migration_history "$name")
  [[ "$actual" == "$expected" ]] || die "$name Prisma migration history does not match the repository"
  total=$(sql_value "$name" 'SELECT count(*) FROM "_prisma_migrations";')
  [[ "$total" == "$EXPECTED_MIGRATION_COUNT" ]] ||
    die "$name has $total migration records, expected $EXPECTED_MIGRATION_COUNT"
  invalid=$(sql_value "$name" '
    SELECT count(*) FROM "_prisma_migrations"
    WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR applied_steps_count <> 1;')
  [[ "$invalid" == 0 ]] || die "$name has incomplete or rolled-back migrations"
}

database_url() {
  local name=$1 port
  port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$name")
  [[ "$port" =~ ^[0-9]+$ ]] || die "could not resolve the published PostgreSQL port for $name"
  printf 'postgresql://noosphere:%s@127.0.0.1:%s/noosphere' "$password" "$port"
}

run_migrations() {
  local name=$1 url
  url=$(database_url "$name")
  (
    cd "$repo_root"
    DATABASE_URL="$url" node docker/migrate-or-baseline.mjs
  ) >/dev/null
  assert_migration_history "$name"
}

integrity_signature() {
  local name=$1
  {
    table_snapshots "$name"
    printf '%s\n' 'prisma_migrations|'
    actual_migration_history "$name"
    docker exec -i "$name" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere < "$integrity_path"
  } | sha256sum | awk '{print $1}'
}

schema_signature() {
  local name=$1
  docker exec -i "$name" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere < "$schema_path" |
    sha256sum | awk '{print $1}'
}

assert_integrity() {
  local name=$1 expected_schema=$2 actual_integrity actual_schema
  assert_migration_history "$name"
  actual_integrity=$(integrity_signature "$name")
  [[ "$actual_integrity" == "$EXPECTED_INTEGRITY_SHA256" ]] ||
    die "$name integrity digest $actual_integrity != $EXPECTED_INTEGRITY_SHA256"
  actual_schema=$(schema_signature "$name")
  [[ "$actual_schema" == "$expected_schema" ]] ||
    die "$name schema digest $actual_schema != $expected_schema"
}

stop_and_assert_clean() {
  local name=$1 volume=$2 expected_checksums=$3 state checksum expected_checksum_version control_output
  case "$expected_checksums" in
    on) expected_checksum_version=1 ;;
    off) expected_checksum_version=0 ;;
    *) die "unsupported data-checksum state: $expected_checksums" ;;
  esac
  docker stop --time 30 "$name" >/dev/null
  control_output=$(docker run --name "$control_container" --label "$label_key=$run_id" \
    --platform "$platform" --entrypoint pg_controldata \
    -v "$volume:/var/lib/postgresql/data:ro" "$SOURCE_IMAGE" \
    /var/lib/postgresql/data)
  owned_container "$control_container" || die "control container ownership label mismatch"
  state=$(awk -F: '/Database cluster state/ {sub(/^[[:space:]]+/, "", $2); print $2}' \
    <<<"$control_output")
  checksum=$(awk -F: '/Data page checksum version/ {sub(/^[[:space:]]+/, "", $2); print $2}' \
    <<<"$control_output")
  docker rm "$control_container" >/dev/null
  [[ "$state" == 'shut down' ]] || die "$volume cluster state is $state"
  [[ "$checksum" == "$expected_checksum_version" ]] ||
    die "$volume data-checksum version is $checksum"
}

restore_backup() {
  local name=$1
  docker exec "$name" pg_restore \
    --exit-on-error --no-owner --no-privileges \
    -U noosphere -d noosphere /backup/noosphere.dump >/dev/null
}

log 'creating deterministic source database and logical backup'
start_database "$source_container" "$SOURCE_IMAGE" "$source_volume" write
run_migrations "$source_container"
docker exec -i "$source_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere < "$fixture_path" >/dev/null
initial_identity=$(database_identity "$source_container")
initial_checksums=$(sql_value "$source_container" 'SHOW data_checksums;')
initial_schema=$(schema_signature "$source_container")
initial_integrity=$(integrity_signature "$source_container")
if [[ "$EXPECTED_INTEGRITY_SHA256" == TO_BE_RECORDED ]]; then
  printf 'record EXPECTED_INTEGRITY_SHA256=%s in %s\n' "$initial_integrity" "$config_path" >&2
  exit 3
fi
assert_database_contract "$source_container" "$initial_identity" "$initial_checksums" "$source_volume"
assert_integrity "$source_container" "$initial_schema"
# Negative control: prove the oracle catches value-only corruption even when
# every table count and the entire schema remain unchanged.
sql_value "$source_container" "UPDATE \"Session\" SET \"sessionToken\" = 'mutated-session-token' WHERE \"id\" = 'rehearsal-session';" >/dev/null
[[ "$(integrity_signature "$source_container")" != "$EXPECTED_INTEGRITY_SHA256" ]] ||
  die 'integrity oracle missed a non-count-changing row mutation'
sql_value "$source_container" "UPDATE \"Session\" SET \"sessionToken\" = 'rehearsal-session-token' WHERE \"id\" = 'rehearsal-session';" >/dev/null
[[ "$(integrity_signature "$source_container")" == "$EXPECTED_INTEGRITY_SHA256" ]] ||
  die 'integrity fixture did not return to its committed digest after the negative control'
docker exec "$source_container" pg_dump \
  --format=custom --no-owner --no-privileges \
  -U noosphere -d noosphere -f /backup/noosphere.dump
docker exec "$source_container" pg_restore --list /backup/noosphere.dump |
  grep 'TABLE DATA.*UpgradeRehearsalFixture' >/dev/null ||
  die 'logical backup is missing rehearsal fixture data'
stop_and_assert_clean "$source_container" "$source_volume" "$initial_checksums"

log 'copying the clean source volume and starting the candidate image'
docker run --name "$copy_container" --label "$label_key=$run_id" \
  --platform "$platform" --user root --entrypoint sh \
  -v "$source_volume:/from:ro" -v "$physical_volume:/to" \
  "$SOURCE_IMAGE" -c 'cp -a /from/. /to/' >/dev/null
owned_container "$copy_container" || die "copy container ownership label mismatch"
docker rm "$copy_container" >/dev/null
start_database "$candidate_container" "$CANDIDATE_IMAGE" "$physical_volume"
run_migrations "$candidate_container"
assert_database_contract "$candidate_container" "$initial_identity" "$initial_checksums" "$physical_volume"
assert_integrity "$candidate_container" "$initial_schema"
[[ "$(sql_value "$candidate_container" "SELECT default_version FROM pg_available_extensions WHERE name = 'vector';")" == "$EXPECTED_PGVECTOR_VERSION" ]] ||
  die 'candidate does not expose the expected vector extension'
docker exec "$candidate_container" createdb -U noosphere rehearsal_vector
docker exec "$candidate_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d rehearsal_vector -c \
  "CREATE EXTENSION vector; SELECT extversion FROM pg_extension WHERE extname = 'vector'; CREATE TABLE vectors (v vector(3)); INSERT INTO vectors VALUES ('[1,2,3]'); SELECT v <-> '[1,2,4]' FROM vectors;" |
  grep -x "$EXPECTED_PGVECTOR_VERSION" >/dev/null || die 'vector extension scratch-database verification failed'
docker exec "$candidate_container" dropdb -U noosphere rehearsal_vector
stop_and_assert_clean "$candidate_container" "$physical_volume" "$initial_checksums"

log 'proving physical rollback with the pinned source image'
start_database "$rollback_container" "$SOURCE_IMAGE" "$physical_volume"
run_migrations "$rollback_container"
assert_database_contract "$rollback_container" "$initial_identity" "$initial_checksums" "$physical_volume"
assert_integrity "$rollback_container" "$initial_schema"
stop_and_assert_clean "$rollback_container" "$physical_volume" "$initial_checksums"

log 'restoring the logical backup into a clean candidate-image volume'
start_database "$candidate_restore_container" "$CANDIDATE_IMAGE" "$candidate_restore_volume" read
restore_backup "$candidate_restore_container"
run_migrations "$candidate_restore_container"
assert_database_contract "$candidate_restore_container" "$initial_identity" "$initial_checksums" "$candidate_restore_volume"
assert_integrity "$candidate_restore_container" "$initial_schema"
stop_and_assert_clean "$candidate_restore_container" "$candidate_restore_volume" "$initial_checksums"

log 'restoring the logical backup into a clean source-image volume'
start_database "$source_restore_container" "$SOURCE_IMAGE" "$source_restore_volume" read
restore_backup "$source_restore_container"
run_migrations "$source_restore_container"
assert_database_contract "$source_restore_container" "$initial_identity" "$initial_checksums" "$source_restore_volume"
assert_integrity "$source_restore_container" "$initial_schema"
stop_and_assert_clean "$source_restore_container" "$source_restore_volume" "$initial_checksums"

log "PASS: backup, physical copy, candidate startup, rollback, and source/candidate restores preserved $initial_integrity"
