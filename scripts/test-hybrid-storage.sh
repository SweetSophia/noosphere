#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock_file="$repo_root/docker/postgres-pgvector/rehearsal.env"
test_label_key=io.noosphere.hybrid-storage-test
run_id="$(date -u +%Y%m%d%H%M%S)-$$"
source_container="noosphere-hybrid-source-$run_id"
candidate_container="noosphere-hybrid-candidate-$run_id"
source_volume="noosphere-hybrid-source-$run_id"
candidate_volume="noosphere-hybrid-candidate-$run_id"

die() {
  printf '[hybrid-storage-test] ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

for command_name in base64 docker grep node npx patch psql sed sha256sum xxd; do
  need "$command_name"
done
[[ -f "$lock_file" ]] || die "missing image lock: $lock_file"
# shellcheck disable=SC1090
source "$lock_file"
[[ "$SOURCE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || die 'SOURCE_IMAGE is not immutable'
[[ "$CANDIDATE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || die 'CANDIDATE_IMAGE is not immutable'

cleanup_container() {
  local name=$1
  local actual_label
  if ! docker container inspect "$name" >/dev/null 2>&1; then
    return
  fi
  actual_label=$(docker container inspect "$name" --format "{{ index .Config.Labels \"$test_label_key\" }}")
  [[ "$actual_label" == "$run_id" ]] || die "refusing cleanup of unowned container $name"
  docker rm -f "$name" >/dev/null
}

cleanup_volume() {
  local name=$1
  local actual_label
  if ! docker volume inspect "$name" >/dev/null 2>&1; then
    return
  fi
  actual_label=$(docker volume inspect "$name" --format "{{ index .Labels \"$test_label_key\" }}")
  [[ "$actual_label" == "$run_id" ]] || die "refusing cleanup of unowned volume $name"
  docker volume rm "$name" >/dev/null
}

close_write_fd() {
  local descriptor=${1:-}
  [[ "$descriptor" =~ ^[0-9]+$ ]] || return 0
  exec {descriptor}>&- 2>/dev/null || true
}

close_read_fd() {
  local descriptor=${1:-}
  [[ "$descriptor" =~ ^[0-9]+$ ]] || return 0
  exec {descriptor}<&- 2>/dev/null || true
}

cleanup_process() {
  local pid=${1:-}
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "${phase_c_restore_extension_owner_elevated:-false}" == true ]] \
    && [[ -n "${candidate_bootstrap:-}" ]]; then
    psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
      -c 'ALTER ROLE noosphere_hybrid_extension_owner NOSUPERUSER' \
      >/dev/null 2>&1 || true
  fi
  if [[ "${phase_b_v1_restore_extension_owner_elevated:-false}" == true ]] \
    && [[ -n "${candidate_bootstrap:-}" ]]; then
    psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
      -c 'ALTER ROLE noosphere_hybrid_extension_owner NOSUPERUSER' \
      >/dev/null 2>&1 || true
  fi
  close_write_fd "${read_committed_writer_in:-}"
  close_write_fd "${phase_b_consent_writer_in:-}"
  close_write_fd "${phase_b_authorize_worker_in:-}"
  close_write_fd "${phase_c_auth_in:-}"
  close_write_fd "${phase_c_profile_writer_in:-}"
  close_write_fd "${phase_b_v1_upgrade_locker_in:-}"
  cleanup_process "${read_committed_claim_pid:-}"
  cleanup_process "${read_committed_writer_pid:-}"
  cleanup_process "${phase_b_publish_pid:-}"
  cleanup_process "${phase_b_consent_writer_pid:-}"
  cleanup_process "${phase_b_authorize_worker_pid:-}"
  cleanup_process "${phase_b_content_update_pid:-}"
  cleanup_process "${phase_c_auth_pid:-}"
  cleanup_process "${phase_c_revoke_pid:-}"
  cleanup_process "${phase_c_profile_writer_pid:-}"
  cleanup_process "${phase_c_profile_create_pid:-}"
  cleanup_process "${phase_b_v1_upgrade_locker_pid:-}"
  cleanup_process "${phase_b_v1_upgrade_activation_pid:-}"
  cleanup_process "${phase_b_v1_legacy_profile_pid:-}"
  cleanup_process "${fixture_pid:-}"
  close_read_fd "${read_committed_writer_out:-}"
  close_read_fd "${phase_b_consent_writer_out:-}"
  close_read_fd "${phase_b_authorize_worker_out:-}"
  close_read_fd "${phase_c_auth_out:-}"
  close_read_fd "${phase_c_profile_writer_out:-}"
  close_read_fd "${phase_b_v1_upgrade_locker_out:-}"
  if [[ -n "${read_committed_claim_output:-}" && -f "$read_committed_claim_output" ]]; then
    rm -f -- "$read_committed_claim_output"
  fi
  if [[ -n "${phase_b_publish_output:-}" && -f "$phase_b_publish_output" ]]; then
    rm -f -- "$phase_b_publish_output"
  fi
  if [[ -n "${phase_c_profile_create_output:-}" && -f "$phase_c_profile_create_output" ]]; then
    rm -f -- "$phase_c_profile_create_output"
  fi
  if [[ -n "${phase_b_v1_upgrade_activation_output:-}" && -f "$phase_b_v1_upgrade_activation_output" ]]; then
    rm -f -- "$phase_b_v1_upgrade_activation_output"
  fi
  if [[ -n "${phase_b_v1_legacy_profile_output:-}" && -f "$phase_b_v1_legacy_profile_output" ]]; then
    rm -f -- "$phase_b_v1_legacy_profile_output"
  fi
  if [[ -n "${fixture_log:-}" && -f "$fixture_log" ]]; then
    rm -f -- "$fixture_log"
  fi
  if [[ -n "${phase_b_v1_fixture_dir:-}" && -d "$phase_b_v1_fixture_dir" ]]; then
    rm -rf -- "$phase_b_v1_fixture_dir"
  fi
  for temporary_file in \
    "${phase_c_dump_file:-}" \
    "${phase_c_restore_toc_file:-}" \
    "${phase_c_restore_filtered_toc_file:-}" \
    "${phase_b_v1_dump_file:-}" \
    "${phase_b_v1_restore_toc_file:-}" \
    "${phase_b_v1_restore_filtered_toc_file:-}"; do
    if [[ -n "$temporary_file" && -f "$temporary_file" ]]; then
      rm -f -- "$temporary_file"
    fi
  done
  if [[ -n "${worker_health_file:-}" && -f "$worker_health_file" ]]; then
    rm -f -- "$worker_health_file"
  fi
  if [[ -n "${worker_log:-}" && -f "$worker_log" ]]; then
    rm -f -- "$worker_log"
  fi
  for temporary_file in \
    "${invalid_lease_log:-}" \
    "${terminal_health_file:-}" \
    "${terminal_worker_log:-}"; do
    if [[ -n "$temporary_file" && -f "$temporary_file" ]]; then
      rm -f -- "$temporary_file"
    fi
  done
  if [[ -n "${phase_b_content_update_output:-}" && -f "$phase_b_content_update_output" ]]; then
    rm -f -- "$phase_b_content_update_output"
  fi
  if [[ -n "${phase_c_auth_output:-}" && -f "$phase_c_auth_output" ]]; then
    rm -f -- "$phase_c_auth_output"
  fi
  if [[ -n "${phase_c_revoke_output:-}" && -f "$phase_c_revoke_output" ]]; then
    rm -f -- "$phase_c_revoke_output"
  fi
  if [[ -n "${candidate_bootstrap:-}" ]]; then
    for temporary_database in \
      "${phase_b_upgrade_database:-}" \
      "${phase_b_v1_restore_database:-}" \
      "${phase_c_restore_database:-}"; do
      if [[ "$temporary_database" =~ ^[a-z0-9_]+$ ]]; then
        psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
          -c "DROP DATABASE IF EXISTS \"$temporary_database\" WITH (FORCE)" \
          >/dev/null 2>&1 || true
      fi
    done
  fi
  cleanup_container "$source_container"
  cleanup_container "$candidate_container"
  cleanup_volume "$source_volume"
  cleanup_volume "$candidate_volume"
  exit "$status"
}
trap cleanup EXIT INT TERM

for name in "$source_container" "$candidate_container"; do
  ! docker container inspect "$name" >/dev/null 2>&1 || die "container already exists: $name"
done
for name in "$source_volume" "$candidate_volume"; do
  ! docker volume inspect "$name" >/dev/null 2>&1 || die "volume already exists: $name"
  docker volume create --label "$test_label_key=$run_id" "$name" >/dev/null
done

start_database() {
  local name=$1
  local volume=$2
  local image=$3
  local password=$4
  docker run -d \
    --name "$name" \
    --label "$test_label_key=$run_id" \
    -e POSTGRES_USER=noosphere_bootstrap \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=noosphere \
    -p 127.0.0.1::5432 \
    -v "$volume:/var/lib/postgresql/data" \
    "$image" >/dev/null
}

wait_database() {
  local name=$1
  local password=$2
  local attempt
  for attempt in $(seq 1 90); do
    if [[ "$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || true)" == running ]] \
      && [[ "$(docker exec "$name" sh -c 'cat /proc/1/comm' 2>/dev/null || true)" == postgres ]] \
      && docker exec -e PGPASSWORD="$password" "$name" \
        psql -XAtq -U noosphere_bootstrap -d noosphere -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      return
    fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  die "database did not become ready: $name"
}

database_port() {
  docker port "$1" 5432/tcp | sed -n 's/.*://p'
}

expect_sql_failure() {
  local label=$1
  local url=$2
  local statement=$3
  if psql "$url" -XAtq -v ON_ERROR_STOP=1 -c "$statement" >/dev/null 2>&1; then
    die "$label unexpectedly succeeded"
  fi
}

assert_equals() {
  local expected=$1
  local actual=$2
  local label=$3
  [[ "$actual" == "$expected" ]] || die "$label: expected '$expected', got '$actual'"
}

artifact_set_sha256() {
  local artifact
  for artifact in "$@"; do
    sha256sum "$artifact" | awk '{print $1}'
  done | sha256sum | awk '{print $1}'
}

database_url_for() {
  local url=$1
  local database=$2
  printf '%s/%s' "${url%/*}" "$database"
}

activate_candidate() {
  NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_DB_CONTAINER="$candidate_container" \
    "$repo_root/scripts/activate-hybrid-storage.sh"
}

activate_phase_b() {
  NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
    "$repo_root/scripts/activate-hybrid-worker.sh"
}

activate_phase_c() {
  NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
    "$repo_root/scripts/activate-hybrid-retrieval.sh"
}

expect_activation_failure() {
  local label=$1
  if activate_candidate >/dev/null 2>&1; then
    die "$label unexpectedly passed exact repeat activation"
  fi
}

start_database "$source_container" "$source_volume" "$SOURCE_IMAGE" source-bootstrap-password
start_database "$candidate_container" "$candidate_volume" "$CANDIDATE_IMAGE" candidate-bootstrap-password
wait_database "$source_container" source-bootstrap-password
wait_database "$candidate_container" candidate-bootstrap-password

source_port=$(database_port "$source_container")
candidate_port=$(database_port "$candidate_container")
[[ -n "$source_port" && -n "$candidate_port" ]] || die 'failed to resolve database ports'

source_bootstrap="postgresql://noosphere_bootstrap:source-bootstrap-password@127.0.0.1:$source_port/noosphere"
source_migrator="postgresql://noosphere_migrator:source-migrator-password@127.0.0.1:$source_port/noosphere"
source_app="postgresql://noosphere_app:source-app-password@127.0.0.1:$source_port/noosphere"
source_shadow="postgresql://noosphere_migrator:source-migrator-password@127.0.0.1:$source_port/noosphere_shadow"
candidate_bootstrap="postgresql://noosphere_bootstrap:candidate-bootstrap-password@127.0.0.1:$candidate_port/noosphere"
candidate_migrator="postgresql://noosphere_migrator:candidate-migrator-password@127.0.0.1:$candidate_port/noosphere"
candidate_app="postgresql://noosphere_app:candidate-app-password@127.0.0.1:$candidate_port/noosphere"
candidate_admin="postgresql://noosphere_hybrid_admin_login:candidate-admin-password@127.0.0.1:$candidate_port/noosphere"
candidate_worker="postgresql://noosphere_hybrid_worker_login:candidate-worker-password@127.0.0.1:$candidate_port/noosphere"
candidate_shadow="postgresql://noosphere_migrator:candidate-migrator-password@127.0.0.1:$candidate_port/noosphere_shadow"

if NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
  DATABASE_URL="$source_migrator" \
  NOOSPHERE_APP_DATABASE_URL="postgresql://noosphere_app:source-bootstrap-password@127.0.0.1:$source_port/noosphere" \
  node "$repo_root/docker/provision-database-roles.mjs" >/dev/null 2>&1; then
  die 'bootstrap/application password reuse unexpectedly passed provisioning'
fi

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
DATABASE_URL="$source_migrator" \
NOOSPHERE_APP_DATABASE_URL="$source_app" \
  node "$repo_root/docker/provision-database-roles.mjs"

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
DATABASE_URL="$candidate_migrator" \
NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs"

# A pre-migration pass may omit routines whose owning migration has not run.
# Once that migration is recorded as complete, every callable signature must
# resolve; otherwise the post-migration pass would silently ship a broken app.
psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public._prisma_migrations (
  migration_name text PRIMARY KEY,
  finished_at timestamptz,
  rolled_back_at timestamptz
);
INSERT INTO public._prisma_migrations (migration_name, finished_at, rolled_back_at)
VALUES ('20260715132950_automatic_memory_phase_a', pg_catalog.clock_timestamp(), NULL);
SQL
if NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
  DATABASE_URL="$source_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$source_app" \
  node "$repo_root/docker/provision-database-roles.mjs" >/dev/null 2>&1; then
  die 'applied migration with missing application-callable routines unexpectedly passed provisioning'
fi
psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'DROP TABLE public._prisma_migrations'

# Provisioning must distinguish the valid pre-activation phase (zero capability
# roles) from a partial attacker/pre-created capability phase.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'CREATE ROLE noosphere_hybrid_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
if NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs" >/dev/null 2>&1; then
  die 'partial hybrid capability phase unexpectedly passed provisioning'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'DROP ROLE noosphere_hybrid_admin'

DATABASE_URL="$source_migrator" npx prisma migrate deploy
DATABASE_URL="$candidate_migrator" npx prisma migrate deploy
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
DATABASE_URL="$source_migrator" \
NOOSPHERE_APP_DATABASE_URL="$source_app" \
  node "$repo_root/docker/provision-database-roles.mjs"
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
DATABASE_URL="$candidate_migrator" \
NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs"

# Installer-managed rotation must update the live login roles before a worker is
# recreated with the newly persisted secrets.
printf -v rotated_candidate_admin_password '%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
printf -v rotated_candidate_worker_password '%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
rotated_candidate_admin="postgresql://noosphere_hybrid_admin_login:$rotated_candidate_admin_password@127.0.0.1:$candidate_port/noosphere"
rotated_candidate_worker="postgresql://noosphere_hybrid_worker_login:$rotated_candidate_worker_password@127.0.0.1:$candidate_port/noosphere"
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
DATABASE_URL="$candidate_migrator" \
NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$rotated_candidate_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$rotated_candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs"
if psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
  die 'old Phase B administrator password survived rotation'
fi
if psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
  die 'old Phase B worker password survived rotation'
fi
assert_equals noosphere_hybrid_admin_login "$(psql "$rotated_candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT current_user')" \
  'rotated Phase B administrator login'
assert_equals noosphere_hybrid_worker_login "$(psql "$rotated_candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT current_user')" \
  'rotated Phase B worker login'
candidate_admin=$rotated_candidate_admin
candidate_worker=$rotated_candidate_worker

application_function_audit=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
WITH expected(signature) AS (
  VALUES
    ('public.prevent_api_key_agent_principal_rebind()'),
    ('public.prevent_memory_principal_scope_rebind()'),
    ('public.validate_memory_capture_identity_scope()'),
    ('public.validate_memory_candidate_identity_scope()'),
    ('public.prevent_active_memory_capture_delete()'),
    ('public.assert_memory_capture_has_source(text)'),
    ('public.validate_memory_capture_source()'),
    ('public.memory_candidate_source_is_valid(text)'),
    ('public.assert_memory_candidate_has_source(text)'),
    ('public.validate_memory_candidate_source()'),
    ('public.assert_memory_capture_group_candidates_have_source(text,text,text,integer)'),
    ('public.validate_memory_candidate_source_edge()')
), resolved AS (
  SELECT signature, pg_catalog.to_regprocedure(signature) AS oid
  FROM expected
), unexpected AS (
  SELECT procedure.oid
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND pg_catalog.has_function_privilege('noosphere_app', procedure.oid, 'EXECUTE')
    AND procedure.oid <> ALL (
      ARRAY(SELECT oid FROM resolved WHERE oid IS NOT NULL)
    )
)
SELECT
  pg_catalog.count(*) FILTER (WHERE oid IS NULL) || ':' ||
  pg_catalog.count(*) FILTER (
    WHERE oid IS NOT NULL
      AND NOT pg_catalog.has_function_privilege('noosphere_app', oid, 'EXECUTE')
  ) || ':' ||
  (SELECT pg_catalog.count(*) FROM unexpected)
FROM resolved;
SQL
)
assert_equals '0:0:0' "$application_function_audit" \
  'application public-function EXECUTE allowlist'
psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE noosphere_shadow OWNER noosphere_migrator'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE noosphere_shadow OWNER noosphere_migrator'

# Extension-less matrix: every Prisma command must leave optional storage absent.
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" npx prisma migrate deploy
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" npx prisma db push
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" \
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-config-datasource \
    --exit-code
source_feature_count=$(psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname IN ('noosphere_vector','noosphere_crypto','noosphere_hybrid')")
source_extension_count=$(psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ('vector','pgcrypto')")
assert_equals 0 "$source_feature_count" 'extension-less Prisma matrix created a feature schema'
assert_equals 0 "$source_extension_count" 'extension-less Prisma matrix installed an optional extension'
expect_sql_failure 'application DDL privilege' "$source_app" 'CREATE TABLE public.application_must_not_create_ddl(id integer)'
expect_sql_failure 'application migration-ledger read' "$source_app" 'SELECT * FROM public._prisma_migrations'
expect_sql_failure 'application migration-ledger mutation' "$source_app" "DELETE FROM public._prisma_migrations WHERE migration_name='never'"

# Activate the candidate fixture, then prove Prisma preserves every optional object.
activate_candidate
assert_equals '160014:160014' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT postgresql_server_version_num || ':' || pg_catalog.current_setting('server_version_num') FROM noosphere_hybrid.feature_state WHERE singleton")" \
  'activation PostgreSQL runtime provenance'

# Invoke the SQL directly so provisioning failures cannot satisfy this oracle.
# Phase C must fail with the documented prerequisite message on an A3-only
# database before the versioned upgrader reads any Phase B row type.
candidate_a3_source_sha256=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT activation_sql_sha256 FROM noosphere_hybrid.feature_state WHERE singleton')
zero_source_sha256=$(printf '0%.0s' {1..64})
if phase_c_without_b_output=$(psql "$candidate_bootstrap" -X -v ON_ERROR_STOP=1 \
  -v a3_source_sha256="$candidate_a3_source_sha256" \
  -v phase_b_source_sha256="$zero_source_sha256" \
  -v phase_c_source_sha256="$zero_source_sha256" \
  -f "$repo_root/docker/hybrid-storage/activate-phase-c.sql" 2>&1); then
  die 'Phase C activation unexpectedly accepted an A3-only database'
fi
[[ "$phase_c_without_b_output" == *'exact Phase B activation is required before Phase C'* ]] ||
  die "Phase C missing-Phase-B failure was not operator-readable: $phase_c_without_b_output"

# Deployment provisioning must reject any extra member of a hybrid capability,
# not only drift attached to the four expected runtime logins.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE hybrid_membership_attacker NOLOGIN;
   GRANT noosphere_hybrid_worker TO hybrid_membership_attacker" >/dev/null
if NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs" >/dev/null 2>&1; then
  die 'unexpected hybrid capability member passed deployment provisioning'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE noosphere_hybrid_worker FROM hybrid_membership_attacker; DROP ROLE hybrid_membership_attacker' >/dev/null

before_signature=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT oid FROM pg_catalog.pg_extension WHERE extname='vector') || ':' ||
          (SELECT oid FROM pg_catalog.pg_class WHERE oid='noosphere_hybrid.embedding_job'::pg_catalog.regclass) || ':' ||
          (SELECT activation_sql_sha256 FROM noosphere_hybrid.feature_state WHERE singleton)")

DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" npx prisma migrate deploy
DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" npx prisma db push
candidate_diff=$(DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" \
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-config-datasource \
    --script)
[[ "$candidate_diff" != *'DROP EXTENSION'* && "$candidate_diff" != *'DROP SCHEMA'* ]] ||
  die 'activated migrate diff proposed destructive optional-feature DDL'

activate_candidate
after_signature=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT oid FROM pg_catalog.pg_extension WHERE extname='vector') || ':' ||
          (SELECT oid FROM pg_catalog.pg_class WHERE oid='noosphere_hybrid.embedding_job'::pg_catalog.regclass) || ':' ||
          (SELECT activation_sql_sha256 FROM noosphere_hybrid.feature_state WHERE singleton)")
assert_equals "$before_signature" "$after_signature" 'activated Prisma matrix changed optional object identity'

# Repeat activation is validation-only. It must reject unexpected direct and
# default ACL grantees, direct-login privilege drift, and trigger semantic drift
# instead of silently repairing any of them.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE hybrid_direct_grant_attacker LOGIN;
GRANT USAGE ON SCHEMA noosphere_hybrid TO hybrid_direct_grant_attacker;
GRANT EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs(integer, integer)
  TO hybrid_direct_grant_attacker;
SQL
assert_equals 'true:true' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT pg_catalog.has_schema_privilege('hybrid_direct_grant_attacker', 'noosphere_hybrid', 'USAGE') || ':' || pg_catalog.has_function_privilege('hybrid_direct_grant_attacker', 'noosphere_hybrid.claim_jobs(integer,integer)', 'EXECUTE')")" \
  'arbitrary login direct hybrid ACL fixture'
expect_activation_failure 'arbitrary direct hybrid ACL grantee drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
REVOKE EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs(integer, integer)
  FROM hybrid_direct_grant_attacker;
REVOKE USAGE ON SCHEMA noosphere_hybrid FROM hybrid_direct_grant_attacker;
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_hybrid_owner GRANT EXECUTE ON FUNCTIONS TO hybrid_direct_grant_attacker'
expect_activation_failure 'arbitrary hybrid default ACL grantee drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE noosphere_hybrid_owner
  REVOKE EXECUTE ON FUNCTIONS FROM hybrid_direct_grant_attacker;
DROP ROLE hybrid_direct_grant_attacker;
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT UPDATE, DELETE ON noosphere_hybrid.embedding_job TO noosphere_hybrid_admin_login'
expect_activation_failure 'direct hybrid login grant drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE UPDATE, DELETE ON noosphere_hybrid.embedding_job FROM noosphere_hybrid_admin_login'
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER noosphere_hybrid_article_dirty ON public."Article";
CREATE TRIGGER noosphere_hybrid_article_dirty
AFTER INSERT ON public."Article"
FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.article_dirty_trigger();
SQL
expect_activation_failure 'hybrid trigger event drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER noosphere_hybrid_article_dirty ON public."Article";
CREATE TRIGGER noosphere_hybrid_article_dirty
AFTER INSERT OR UPDATE OF title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags"
ON public."Article"
FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.article_dirty_trigger();
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION noosphere_hybrid.bump_search_cache_epoch()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT 1::bigint $function$;
SQL
expect_activation_failure 'hybrid routine body drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION noosphere_hybrid.bump_search_cache_epoch()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE noosphere_hybrid.search_cache_epoch
  SET epoch = epoch + 1
  WHERE singleton
  RETURNING epoch
$function$;
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON public."Article" TO noosphere_hybrid_admin'
expect_activation_failure 'hybrid administrator public-table grant drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE SELECT ON public."Article" FROM noosphere_hybrid_admin'
activate_candidate >/dev/null

# Effective privileges: each runtime credential receives one bounded capability.
role_audit=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT string_agg(rolname || ':' || rolsuper || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolbypassrls, ',' ORDER BY rolname)
   FROM pg_catalog.pg_roles
   WHERE rolname IN ('noosphere_app','noosphere_migrator','noosphere_hybrid_admin_login','noosphere_hybrid_worker_login')")
assert_equals 'noosphere_app:false:false:false:false,noosphere_hybrid_admin_login:false:false:false:false,noosphere_hybrid_worker_login:false:false:false:false,noosphere_migrator:false:false:false:false' "$role_audit" 'runtime role attributes'
expect_sql_failure 'worker base Article read' "$candidate_worker" 'SELECT "restrictedTags" FROM public."Article"'
expect_sql_failure 'worker base feature-table read' "$candidate_worker" 'SELECT * FROM noosphere_hybrid.embedding_job'
expect_sql_failure 'administrator supply-evidence mutation' "$candidate_admin" "UPDATE noosphere_hybrid.feature_state SET source_url='tampered'"
expect_sql_failure 'application feature-schema read' "$candidate_app" 'SELECT * FROM noosphere_hybrid.feature_state'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Topic" (id, name, slug, "createdAt", "updatedAt")
VALUES ('hybrid-topic', 'Hybrid topic', 'hybrid-topic', clock_timestamp(), clock_timestamp());
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, "topicId", status,
  "createdAt", "updatedAt", "restrictedTags", "memoryRevocationGeneration"
)
VALUES (
  'hybrid-article', 'Café', 'hybrid-article', E'line1\r\nline2', 'Résumé',
  'hybrid-topic', 'published', clock_timestamp(), clock_timestamp(), ARRAY[]::text[], 0
);
SQL

profile_id=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.create_profile(
     'openai-compatible','local','fixture-model','fixture-revision',3,
     'cosine','none',1048576,decode(repeat('11',32),'hex'))")
[[ "$profile_id" =~ ^[a-f0-9-]{36}$ ]] || die "invalid profile id: $profile_id"
profile_state=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state FROM noosphere_hybrid.embedding_profile WHERE id='$profile_id'")
assert_equals inactive "$profile_state" 'new profile lifecycle state'
expect_sql_failure 'premature preparing transition' "$candidate_admin" \
  "SELECT noosphere_hybrid.set_profile_state('$profile_id','preparing')"
expect_sql_failure 'profile identity mutation' "$candidate_bootstrap" \
  "SET ROLE noosphere_hybrid_owner; UPDATE noosphere_hybrid.embedding_profile SET dimensions=4 WHERE id='$profile_id'"
expect_sql_failure 'zero maxInputBytes' "$candidate_admin" \
  "SELECT noosphere_hybrid.create_profile('openai-compatible','local','bad','zero',3,'cosine','none',0,decode(repeat('22',32),'hex'))"
expect_sql_failure 'oversized maxInputBytes' "$candidate_admin" \
  "SELECT noosphere_hybrid.create_profile('openai-compatible','local','bad','large',3,'cosine','none',1048577,decode(repeat('22',32),'hex'))"

canonical_hex=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT encode(noosphere_hybrid.canonical_document('Café','Résumé',E'line1\\r\\nline2',1048576),'hex')")
expected_hex=$(printf 'noosphere-article-v1\nTITLE\nCafé\nEXCERPT\nRésumé\nCONTENT\nline1\nline2\n' | xxd -p -c 1000000)
assert_equals "$expected_hex" "$canonical_hex" 'canonical document bytes'
truncated_hex=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT encode(noosphere_hybrid.truncate_utf8_prefix('A😀B',3),'hex')")
assert_equals 41 "$truncated_hex" 'code-point-safe UTF-8 truncation'

# Phase A3 deliberately keeps preparing/serving unreachable. Set the fixture
# state as the locked owner to exercise the already-installed queue contract.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SET ROLE noosphere_hybrid_owner; UPDATE noosphere_hybrid.embedding_profile SET state='preparing' WHERE id='$profile_id'" >/dev/null
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='revision one', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null

expect_sql_failure 'worker direct eligibility-view read' "$candidate_worker" \
  "SELECT count(*) FROM noosphere_hybrid.worker_eligibility WHERE article_id='hybrid-article'"

# Until Phase B installs worker scopes and consent, restricted articles must
# expose neither canonical bytes nor identifiers and must not be claimable.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY['financial'], \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 0 "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) FROM noosphere_hybrid.claim_jobs(1,60)')" \
  'restricted article claim count'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY[]::text[], \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 0 "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) FROM noosphere_hybrid.claim_jobs(0,60)')" \
  'unrestricted article zero-limit claim probe'

# At PostgreSQL's default READ COMMITTED isolation, a restriction that commits
# after claim_jobs takes its statement snapshot must be followed through the
# Article row lock and rechecked by EvalPlanQual. Disable triggers only inside
# this disposable writer transaction so a zero result proves the row-lock
# eligibility recheck rather than job cleanup.
coproc READ_COMMITTED_RESTRICTION_WRITER {
  psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 2>&1
}
read_committed_writer_out=${READ_COMMITTED_RESTRICTION_WRITER[0]}
read_committed_writer_in=${READ_COMMITTED_RESTRICTION_WRITER[1]}
read_committed_writer_pid=$READ_COMMITTED_RESTRICTION_WRITER_PID
printf '%s\n' \
  'BEGIN;' \
  'SET LOCAL session_replication_role = replica;' \
  'UPDATE public."Article" SET "restrictedTags"=ARRAY['\''financial'\''], "updatedAt"=clock_timestamp() WHERE id='\''hybrid-article'\'';' \
  'SELECT '\''restriction-ready'\'';' >&"$read_committed_writer_in"
IFS= read -r read_committed_writer_marker <&"$read_committed_writer_out"
assert_equals restriction-ready "$read_committed_writer_marker" \
  'read-committed restriction writer readiness'

read_committed_claim_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-read-committed-race \
  psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 \
    -c 'SELECT count(*) FROM noosphere_hybrid.claim_jobs(1,60)' \
    >"$read_committed_claim_output" 2>&1 &
read_committed_claim_pid=$!
read_committed_claim_blocked=false
for attempt in $(seq 1 100); do
  claim_wait=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') FROM pg_catalog.pg_stat_activity WHERE application_name='noosphere-hybrid-read-committed-race'")
  if [[ "$claim_wait" == Lock:* ]]; then
    read_committed_claim_blocked=true
    break
  fi
  kill -0 "$read_committed_claim_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$read_committed_claim_blocked" == true ]] ||
  die "read-committed claim did not block on the concurrent restriction: ${claim_wait:-absent}"

printf '%s\n' 'COMMIT;' >&"$read_committed_writer_in"
exec {read_committed_writer_in}>&-
read_committed_writer_in=
read_committed_writer_tail=$(cat <&"$read_committed_writer_out")
exec {read_committed_writer_out}<&-
read_committed_writer_out=
read_committed_writer_failed=false
if ! wait "$read_committed_writer_pid"; then
  read_committed_writer_failed=true
fi
read_committed_writer_pid=
if [[ "$read_committed_writer_failed" == true ]]; then
  die "read-committed restriction writer failed: $read_committed_writer_tail"
fi
read_committed_claim_failed=false
if ! wait "$read_committed_claim_pid"; then
  read_committed_claim_failed=true
fi
read_committed_claim_pid=
if [[ "$read_committed_claim_failed" == true ]]; then
  read_committed_claim_failure=$(cat "$read_committed_claim_output")
  rm -f -- "$read_committed_claim_output"
  read_committed_claim_output=
  die "read-committed claim failed instead of rechecking eligibility: $read_committed_claim_failure"
fi
read_committed_claim_count=$(cat "$read_committed_claim_output")
rm -f -- "$read_committed_claim_output"
read_committed_claim_output=
assert_equals 0 "$read_committed_claim_count" \
  'read-committed concurrent restriction claim count'
assert_equals 1 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article' AND state='queued'")" \
  'read-committed denial preserved the queued job fixture'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY[]::text[], \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null

# A worker cannot pin an old MVCC snapshot while an article is unrestricted,
# wait for a restriction commit, then read the old identifier/bytes. The
# Article FOR SHARE lock in claim_jobs converts that stale snapshot into a
# serialization failure.
coproc SNAPSHOT_WORKER { psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 2>&1; }
snapshot_worker_out=${SNAPSHOT_WORKER[0]}
snapshot_worker_in=${SNAPSHOT_WORKER[1]}
snapshot_worker_pid=$SNAPSHOT_WORKER_PID
printf '%s\n' \
  'BEGIN ISOLATION LEVEL REPEATABLE READ;' \
  'SELECT pg_catalog.pg_current_snapshot();' >&"$snapshot_worker_in"
IFS= read -r snapshot_marker <&"$snapshot_worker_out"
[[ -n "$snapshot_marker" ]] || die 'worker repeatable-read snapshot was not established'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY['financial'], \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
printf '%s\n' 'SELECT count(*) FROM noosphere_hybrid.claim_jobs(1,60);' >&"$snapshot_worker_in"
exec {snapshot_worker_in}>&-
snapshot_failure=$(cat <&"$snapshot_worker_out")
if wait "$snapshot_worker_pid"; then
  die 'repeatable-read worker snapshot returned bytes after restriction commit'
fi
[[ "$snapshot_failure" == *'could not serialize access due to concurrent update'* ]] ||
  die "repeatable-read restriction gate failed for an unexpected reason: $snapshot_failure"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY[]::text[], \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null

claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE embedding_job(id integer);
CREATE TEMP TABLE embedding_profile(id integer);
CREATE TEMP TABLE worker_eligibility(id integer);
SELECT job_id, lease_token, lease_generation, claimed_revision, encode(claimed_content_hash,'hex')
FROM noosphere_hybrid.claim_jobs(1, 60);
SQL
)
IFS='|' read -r job_id lease_token lease_generation claimed_revision claimed_hash <<<"$claim"
[[ "$job_id" =~ ^[a-f0-9-]{36}$ && "$lease_token" =~ ^[a-f0-9-]{36}$ ]] || die 'worker claim did not return a lease'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='revision two', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article';
   UPDATE public.\"Article\" SET content='revision three', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
stale_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$job_id','$lease_token',$lease_generation,$claimed_revision,decode('$claimed_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$stale_publish" 'stale completion compare-and-swap result'
queued_after_stale=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state || ':' || (desired_revision > $claimed_revision) FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")
assert_equals 'queued:true' "$queued_after_stale" 'newer desired revision after stale completion'

claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,1)")
IFS='|' read -r job_id lease_token lease_generation claimed_revision claimed_hash <<<"$claim"
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT pg_sleep(1.1)' >/dev/null
expired_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$job_id','$lease_token',$lease_generation,$claimed_revision,decode('$claimed_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$expired_publish" 'expired lease publication'
expired_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r expired_job expired_token expired_generation expired_revision expired_hash <<<"$expired_claim"
assert_equals "$job_id" "$expired_job" 'lease-expiry reclaim job id'
[[ "$expired_generation" -gt "$lease_generation" ]] || die 'lease generation did not advance on reclaim'
published=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$expired_job','$expired_token',$expired_generation,$expired_revision,decode('$expired_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals t "$published" 'current embedding publication'
ready=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT dimensions || ':' || revision FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article' AND profile_id='$profile_id'")
assert_equals "3:$expired_revision" "$ready" 'ready vector dimensions and revision'

# Privacy quarantine is a stronger eligibility boundary than ordinary scope
# filtering: it cancels a live lease, removes the ready vector, rejects late
# publication, and only requeues after explicit release from quarantine.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='quarantine candidate', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r quarantine_job quarantine_token quarantine_generation quarantine_revision quarantine_hash <<<"$claim"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"recallQuarantinedAt\"=clock_timestamp(), \"recallQuarantineReason\"='hybrid test', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'privacy quarantine cleanup'
late_quarantine_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$quarantine_job','$quarantine_token',$quarantine_generation,$quarantine_revision,decode('$quarantine_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$late_quarantine_publish" 'privacy-quarantined late publication'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"recallQuarantinedAt\"=NULL, \"recallQuarantineReason\"=NULL, \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'privacy quarantine release queue state'

# Terminal failure must be superseded by a later article revision.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='terminal candidate', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r job_id lease_token lease_generation <<<"$claim"
failed=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.fail_job('$job_id','$lease_token',$lease_generation,'provider_timeout',clock_timestamp(),true)")
assert_equals t "$failed" 'terminal failure acknowledgement'
assert_equals failed "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")" 'terminal job state'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='newer after terminal', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 'queued:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state || ':' || attempt_count FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")" 'new revision after terminal failure'

# Soft-delete cancels a live lease and hard-deletes vectors. Writes while still
# deleted never enqueue; restore creates a new revision; physical delete cascades.
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r job_id lease_token lease_generation <<<"$claim"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=clock_timestamp(), \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'soft-delete cleanup'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='changed while deleted', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 0 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'deleted article enqueue count'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=NULL, \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'restore queue state'

epoch_before=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public."Article" SET status='reviewed', "updatedAt"=clock_timestamp() WHERE id='hybrid-article';
INSERT INTO public."Tag" (id,name,slug,"createdAt") VALUES ('hybrid-tag','Hybrid tag','hybrid-tag',clock_timestamp());
INSERT INTO public."ArticleTag" ("articleId","tagId") VALUES ('hybrid-article','hybrid-tag');
UPDATE public."Topic" SET description='changed', "updatedAt"=clock_timestamp() WHERE id='hybrid-topic';
SQL
epoch_after=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $((epoch_after - epoch_before)) -ge 4 ]] || die 'cache epoch did not cover Article, Tag, ArticleTag, and Topic mutations'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.article_embedding_state WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'physical-delete cascade'
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.set_profile_state('$profile_id','inactive')" >/dev/null

# Reconstruct the exact Phase B v1 artifacts from the PR base, activate them in
# an A3 database clone, and prove the current Phase C driver performs the
# versioned v1 -> v2 upgrade before installing C.
phase_b_upgrade_database="noosphere_phase_b_upgrade_${run_id//[^a-zA-Z0-9]/_}"
[[ "$phase_b_upgrade_database" =~ ^[a-z0-9_]+$ ]] ||
  die 'generated Phase B upgrade database name is unsafe'
psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$phase_b_upgrade_database\" TEMPLATE noosphere" >/dev/null
phase_b_upgrade_bootstrap=$(database_url_for "$candidate_bootstrap" "$phase_b_upgrade_database")
phase_b_upgrade_migrator=$(database_url_for "$candidate_migrator" "$phase_b_upgrade_database")
phase_b_upgrade_app=$(database_url_for "$candidate_app" "$phase_b_upgrade_database")
phase_b_upgrade_admin=$(database_url_for "$candidate_admin" "$phase_b_upgrade_database")
phase_b_upgrade_worker=$(database_url_for "$candidate_worker" "$phase_b_upgrade_database")

# Establish the canonical current Phase B state independently of the legacy
# clone. Both direct and restored v1 upgrades must converge on these hashes.
activate_phase_b >/dev/null
phase_b_fresh_manifest_sha256=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT manifest_sha256 FROM noosphere_hybrid_b.feature_state WHERE singleton')
phase_b_fresh_structure_sha256=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT structure_sha256 FROM noosphere_hybrid_b.feature_state WHERE singleton')

phase_b_v1_fixture_dir=$(mktemp -d)
cp "$repo_root/docker/hybrid-storage/activate-phase-b.sql" \
  "$repo_root/docker/hybrid-storage/phase-b-schema.sql" \
  "$repo_root/docker/hybrid-storage/validate-phase-b.sql" \
  "$repo_root/docker/hybrid-storage/validate.sql" \
  "$phase_b_v1_fixture_dir/"
base64 --decode "$repo_root/src/__tests__/fixtures/hybrid-storage/phase-b-v1.patch" \
  | patch -s -d "$phase_b_v1_fixture_dir" -p0
patch -s -d "$phase_b_v1_fixture_dir" -p0 \
  <"$repo_root/src/__tests__/fixtures/hybrid-storage/phase-b-v1-structural-manifest.patch"

phase_b_v1_source_sha256=$(artifact_set_sha256 \
  "$phase_b_v1_fixture_dir/phase-b-schema.sql" \
  "$phase_b_v1_fixture_dir/activate-phase-b.sql" \
  "$phase_b_v1_fixture_dir/validate-phase-b.sql")
assert_equals \
  '5a5cb62c29deceb44b91c0a0252607ce9460b2761dbeca7724963ad7043fca98' \
  "$phase_b_v1_source_sha256" \
  'Phase B v1 fixture artifact hash'
a3_source_sha256=$(artifact_set_sha256 \
  "$repo_root/docker/hybrid-storage/activate.sql" \
  "$repo_root/docker/hybrid-storage/feature-schema.sql" \
  "$repo_root/docker/hybrid-storage/validate.sql")
psql "$phase_b_upgrade_bootstrap" -X -v ON_ERROR_STOP=1 \
  -v a3_source_sha256="$a3_source_sha256" \
  -v phase_b_source_sha256="$phase_b_v1_source_sha256" \
  -f "$phase_b_v1_fixture_dir/activate-phase-b.sql" >/dev/null
assert_equals 1 "$(psql "$phase_b_upgrade_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT feature_version FROM noosphere_hybrid_b.feature_state WHERE singleton')" \
  'Phase B historical fixture activates as v1'

# Preserve an exact v1 logical backup before upgrading the direct clone. The
# restored copy below must pass the stable v1 catalog validator even when the
# historical pg_get_functiondef representation changes.
phase_b_v1_dump_file=$(mktemp)
docker exec "$candidate_container" \
  pg_dump -U noosphere_bootstrap -d "$phase_b_upgrade_database" --format=custom \
  >"$phase_b_v1_dump_file"

# Hold a lock compatible with the upgrader's SHARE lock but incompatible with
# Phase C's trigger installation. This leaves the activation transaction open
# after it has fenced legacy INSERTs, giving the old A3 create_profile call a
# deterministic chance to queue behind the migration boundary.
coproc PHASE_B_V1_UPGRADE_LOCKER {
  PGAPPNAME=noosphere-hybrid-phase-b-v1-locker \
    psql "$phase_b_upgrade_bootstrap" -XAtq -v ON_ERROR_STOP=1 2>&1
}
phase_b_v1_upgrade_locker_out=${PHASE_B_V1_UPGRADE_LOCKER[0]}
phase_b_v1_upgrade_locker_in=${PHASE_B_V1_UPGRADE_LOCKER[1]}
phase_b_v1_upgrade_locker_pid=$PHASE_B_V1_UPGRADE_LOCKER_PID
printf '%s\n' \
  'BEGIN;' \
  'LOCK TABLE noosphere_hybrid.embedding_profile IN SHARE MODE;' \
  'SELECT '\''phase-b-v1-locker-ready'\'';' >&"$phase_b_v1_upgrade_locker_in"
IFS= read -r phase_b_v1_upgrade_locker_marker <&"$phase_b_v1_upgrade_locker_out"
assert_equals phase-b-v1-locker-ready "$phase_b_v1_upgrade_locker_marker" \
  'Phase B v1 upgrade lock fixture readiness'

phase_b_v1_upgrade_activation_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-phase-b-v1-upgrade \
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$phase_b_upgrade_bootstrap" \
DATABASE_URL="$phase_b_upgrade_migrator" \
NOOSPHERE_APP_DATABASE_URL="$phase_b_upgrade_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$phase_b_upgrade_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$phase_b_upgrade_worker" \
  "$repo_root/scripts/activate-hybrid-retrieval.sh" \
  >"$phase_b_v1_upgrade_activation_output" 2>&1 &
phase_b_v1_upgrade_activation_pid=$!
phase_b_v1_upgrade_fenced=false
for attempt in $(seq 1 100); do
  phase_b_v1_upgrade_lock_state=$(psql "$phase_b_upgrade_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT
       pg_catalog.bool_or(lock_record.mode = 'ShareLock' AND lock_record.granted)::text
       || ':' || coalesce(activity.wait_event_type, '')
     FROM pg_catalog.pg_stat_activity AS activity
     LEFT JOIN pg_catalog.pg_locks AS lock_record
       ON lock_record.pid = activity.pid
      AND lock_record.relation = 'noosphere_hybrid.embedding_profile'::pg_catalog.regclass
     WHERE activity.application_name = 'noosphere-hybrid-phase-b-v1-upgrade'
     GROUP BY activity.wait_event_type")
  if [[ "$phase_b_v1_upgrade_lock_state" == true:Lock ]]; then
    phase_b_v1_upgrade_fenced=true
    break
  fi
  kill -0 "$phase_b_v1_upgrade_activation_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$phase_b_v1_upgrade_fenced" == true ]] ||
  die "Phase B v1 upgrade did not hold the legacy INSERT fence while Phase C waited: ${phase_b_v1_upgrade_lock_state:-absent}"

phase_b_v1_legacy_profile_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-phase-b-v1-legacy-profile \
  psql "$phase_b_upgrade_admin" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT noosphere_hybrid.create_profile(
       'openai-compatible','local','legacy-upgrade-race','r1',3,
       'cosine','none',32768,decode(repeat('88',32),'hex'))" \
    >"$phase_b_v1_legacy_profile_output" 2>&1 &
phase_b_v1_legacy_profile_pid=$!
phase_b_v1_legacy_profile_blocked=false
for attempt in $(seq 1 100); do
  phase_b_v1_legacy_profile_wait=$(psql "$phase_b_upgrade_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
     FROM pg_catalog.pg_stat_activity
     WHERE application_name='noosphere-hybrid-phase-b-v1-legacy-profile'")
  if [[ "$phase_b_v1_legacy_profile_wait" == Lock:* ]]; then
    phase_b_v1_legacy_profile_blocked=true
    break
  fi
  kill -0 "$phase_b_v1_legacy_profile_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$phase_b_v1_legacy_profile_blocked" == true ]] ||
  die "legacy profile creation did not serialize behind the v1 upgrade: ${phase_b_v1_legacy_profile_wait:-absent}"

printf '%s\n' 'COMMIT;' >&"$phase_b_v1_upgrade_locker_in"
exec {phase_b_v1_upgrade_locker_in}>&-
phase_b_v1_upgrade_locker_in=
phase_b_v1_upgrade_locker_tail=$(cat <&"$phase_b_v1_upgrade_locker_out")
exec {phase_b_v1_upgrade_locker_out}<&-
phase_b_v1_upgrade_locker_out=
if ! wait "$phase_b_v1_upgrade_locker_pid"; then
  die "Phase B v1 upgrade lock fixture failed: $phase_b_v1_upgrade_locker_tail"
fi
phase_b_v1_upgrade_locker_pid=
if ! wait "$phase_b_v1_upgrade_activation_pid"; then
  phase_b_v1_upgrade_activation_failure=$(tail -80 "$phase_b_v1_upgrade_activation_output")
  die "Phase B v1 activation failed: $phase_b_v1_upgrade_activation_failure"
fi
phase_b_v1_upgrade_activation_pid=
rm -f -- "$phase_b_v1_upgrade_activation_output"
phase_b_v1_upgrade_activation_output=
if ! wait "$phase_b_v1_legacy_profile_pid"; then
  phase_b_v1_legacy_profile_failure=$(cat "$phase_b_v1_legacy_profile_output")
  die "serialized legacy profile creation failed: $phase_b_v1_legacy_profile_failure"
fi
phase_b_v1_legacy_profile_pid=
phase_b_v1_legacy_profile_id=$(cat "$phase_b_v1_legacy_profile_output")
rm -f -- "$phase_b_v1_legacy_profile_output"
phase_b_v1_legacy_profile_output=
assert_equals t "$(psql "$phase_b_upgrade_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT snapshot.eligible_count = exact.eligible_count
          AND snapshot.ready_count = exact.ready_count
   FROM noosphere_hybrid_c.query_profile_snapshot('$phase_b_v1_legacy_profile_id') AS snapshot
   CROSS JOIN noosphere_hybrid_c.query_profile_coverage('$phase_b_v1_legacy_profile_id') AS exact")" \
  'legacy profile coverage after concurrent v1 upgrade'

phase_b_v2_source_sha256=$(artifact_set_sha256 \
  "$repo_root/docker/hybrid-storage/phase-b-schema.sql" \
  "$repo_root/docker/hybrid-storage/phase-b-routine-manifest.sql" \
  "$repo_root/docker/hybrid-storage/activate-phase-b.sql" \
  "$repo_root/docker/hybrid-storage/upgrade-phase-b-v1-to-v2.sql" \
  "$repo_root/docker/hybrid-storage/validate-phase-b-v1.sql" \
  "$repo_root/docker/hybrid-storage/validate-phase-b.sql")
assert_equals "2:$phase_b_v2_source_sha256:t:f:t" "$(
  psql "$phase_b_upgrade_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
    "SELECT state.feature_version,
            state.source_sha256,
            pg_catalog.has_function_privilege(
              'noosphere_hybrid_admin',
              'noosphere_hybrid_b.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)',
              'EXECUTE'
            ),
            pg_catalog.has_function_privilege(
              'noosphere_hybrid_admin',
              'noosphere_hybrid.create_profile(text,noosphere_hybrid.profile_locality,text,text,integer,noosphere_hybrid.distance_metric,noosphere_hybrid.normalization_policy,integer,bytea)',
              'EXECUTE'
            ),
            c.phase_b_source_sha256 = state.source_sha256
     FROM noosphere_hybrid_b.feature_state AS state
     CROSS JOIN noosphere_hybrid_c.feature_state AS c
     WHERE state.singleton AND c.singleton"
)" 'Phase C upgrades exact Phase B v1 before activation'
assert_equals "$phase_b_fresh_manifest_sha256:$phase_b_fresh_structure_sha256" "$(
  psql "$phase_b_upgrade_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
    'SELECT manifest_sha256, structure_sha256
     FROM noosphere_hybrid_b.feature_state WHERE singleton'
)" 'direct Phase B v1 upgrade converges on fresh v2 state'

# Restore the untouched historical v1 dump into a clean database and upgrade
# it through the same current Phase C driver. The persisted historical
# pg_get_functiondef hash is deliberately not trusted after this round trip;
# the pinned stable v1 catalog fingerprint must authenticate the installation.
phase_b_v1_restore_database="noosphere_phase_b_v1_restore_${run_id//[^a-zA-Z0-9]/_}"
[[ "$phase_b_v1_restore_database" =~ ^[a-z0-9_]+$ ]] ||
  die 'generated Phase B v1 restore database name is unsafe'
psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$phase_b_v1_restore_database\" TEMPLATE template0" >/dev/null
phase_b_v1_restore_bootstrap=$(database_url_for "$candidate_bootstrap" "$phase_b_v1_restore_database")
phase_b_v1_restore_migrator=$(database_url_for "$candidate_migrator" "$phase_b_v1_restore_database")
phase_b_v1_restore_app=$(database_url_for "$candidate_app" "$phase_b_v1_restore_database")
phase_b_v1_restore_admin=$(database_url_for "$candidate_admin" "$phase_b_v1_restore_database")
phase_b_v1_restore_worker=$(database_url_for "$candidate_worker" "$phase_b_v1_restore_database")
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE noosphere_hybrid_extension_owner SUPERUSER' >/dev/null
phase_b_v1_restore_extension_owner_elevated=true
phase_b_v1_restore_pgvector_version=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c "SELECT extversion FROM pg_catalog.pg_extension WHERE extname='vector'")
psql "$phase_b_v1_restore_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SET ROLE noosphere_hybrid_extension_owner;
   CREATE SCHEMA noosphere_vector AUTHORIZATION noosphere_hybrid_extension_owner;
   CREATE EXTENSION vector WITH SCHEMA noosphere_vector
     VERSION '$phase_b_v1_restore_pgvector_version';
   CREATE SCHEMA noosphere_crypto AUTHORIZATION noosphere_hybrid_extension_owner;
   CREATE EXTENSION pgcrypto WITH SCHEMA noosphere_crypto;
   RESET ROLE" >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE noosphere_hybrid_extension_owner NOSUPERUSER' >/dev/null
phase_b_v1_restore_extension_owner_elevated=false

phase_b_v1_dump_container_path="/tmp/noosphere-phase-b-v1-$run_id.dump"
phase_b_v1_restore_toc_container_path="/tmp/noosphere-phase-b-v1-$run_id.list"
phase_b_v1_restore_toc_file=$(mktemp)
phase_b_v1_restore_filtered_toc_file=$(mktemp)
docker cp "$phase_b_v1_dump_file" "$candidate_container:$phase_b_v1_dump_container_path"
docker exec "$candidate_container" pg_restore -l "$phase_b_v1_dump_container_path" \
  >"$phase_b_v1_restore_toc_file"
sed -E \
  -e '/ (SCHEMA|EXTENSION) - (noosphere_crypto|noosphere_vector|pgcrypto|vector) /d' \
  -e '/ COMMENT - EXTENSION (pgcrypto|vector) /d' \
  "$phase_b_v1_restore_toc_file" >"$phase_b_v1_restore_filtered_toc_file"
docker cp "$phase_b_v1_restore_filtered_toc_file" \
  "$candidate_container:$phase_b_v1_restore_toc_container_path"
docker exec "$candidate_container" \
  pg_restore -U noosphere_bootstrap -d "$phase_b_v1_restore_database" \
    --exit-on-error --use-list="$phase_b_v1_restore_toc_container_path" \
    "$phase_b_v1_dump_container_path"
docker exec "$candidate_container" unlink "$phase_b_v1_dump_container_path"
docker exec "$candidate_container" unlink "$phase_b_v1_restore_toc_container_path"

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$phase_b_v1_restore_bootstrap" \
DATABASE_URL="$phase_b_v1_restore_migrator" \
NOOSPHERE_APP_DATABASE_URL="$phase_b_v1_restore_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$phase_b_v1_restore_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$phase_b_v1_restore_worker" \
  "$repo_root/scripts/activate-hybrid-retrieval.sh" >/dev/null
assert_equals "2:$phase_b_v2_source_sha256:$phase_b_fresh_manifest_sha256:$phase_b_fresh_structure_sha256" "$(
  psql "$phase_b_v1_restore_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
    'SELECT feature_version, source_sha256, manifest_sha256, structure_sha256
     FROM noosphere_hybrid_b.feature_state WHERE singleton'
)" 'restored Phase B v1 upgrades to canonical v2 state'

psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$phase_b_v1_restore_database\" WITH (FORCE)" >/dev/null
phase_b_v1_restore_database=
rm -f -- "$phase_b_v1_dump_file"
phase_b_v1_dump_file=
rm -f -- "$phase_b_v1_restore_toc_file" "$phase_b_v1_restore_filtered_toc_file"
phase_b_v1_restore_toc_file=
phase_b_v1_restore_filtered_toc_file=

psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$phase_b_upgrade_database\" WITH (FORCE)" >/dev/null
phase_b_upgrade_database=
rm -rf -- "$phase_b_v1_fixture_dir"
phase_b_v1_fixture_dir=

# Phase B is a separately evidenced layer. It must activate and repeat exactly
# without weakening the immutable A3 validator underneath it.
activate_phase_b >/dev/null
assert_equals 'f:f:f:f' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT pg_catalog.has_function_privilege('noosphere_hybrid_admin','noosphere_hybrid.set_profile_state(uuid,noosphere_hybrid.profile_state)','EXECUTE'),
          pg_catalog.has_function_privilege('noosphere_hybrid_worker','noosphere_hybrid.claim_jobs(integer,integer)','EXECUTE'),
          pg_catalog.has_function_privilege('noosphere_hybrid_worker','noosphere_hybrid.publish_embedding(uuid,uuid,bigint,bigint,bytea,noosphere_vector.vector)','EXECUTE'),
          pg_catalog.has_function_privilege('noosphere_hybrid_worker','noosphere_hybrid.fail_job(uuid,uuid,bigint,text,timestamptz,boolean)','EXECUTE')")" \
  'Phase B legacy A3 execution surface withdrawal'

phase_b_database_source=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT source_sha256 FROM noosphere_hybrid_b.feature_state WHERE singleton')
if psql "$candidate_bootstrap" -X -v ON_ERROR_STOP=1 \
  -v a3_source_sha256="$(printf '0%.0s' {1..64})" \
  -v phase_b_source_sha256="$phase_b_database_source" \
  -f "$repo_root/docker/hybrid-storage/activate-phase-b.sql" >/dev/null 2>&1; then
  die 'Phase B activation accepted A3 source bytes that do not match persisted provenance'
fi

# B activation re-runs A3's exact validator inside the same transaction before
# restoring the B-only ACL. Drift in an unrelated A3 routine grant must block B.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "GRANT EXECUTE ON FUNCTION noosphere_hybrid.canonical_document(text,text,text,integer) TO noosphere_hybrid_admin" >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted drift in its A3 base'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "REVOKE EXECUTE ON FUNCTION noosphere_hybrid.canonical_document(text,text,text,integer) FROM noosphere_hybrid_admin" >/dev/null
activate_phase_b >/dev/null

# The B structural fingerprint covers table columns/defaults/constraints,
# indexes, and every B-owned Article trigger, not only routine text.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'ALTER TABLE noosphere_hybrid_b.embedding_consent DROP CONSTRAINT embedding_consent_restricted_requires_remote' >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted a dropped consent invariant'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'ALTER TABLE noosphere_hybrid_b.embedding_consent ADD CONSTRAINT embedding_consent_restricted_requires_remote CHECK (NOT restricted_remote_egress OR remote_egress)' >/dev/null
activate_phase_b >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'CREATE TRIGGER noosphere_hybrid_b_unexpected_guard BEFORE UPDATE ON public."Article" FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid_b.article_write_guard()' >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted an unexpected B-owned Article trigger'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'DROP TRIGGER noosphere_hybrid_b_unexpected_guard ON public."Article"' >/dev/null
activate_phase_b >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE hybrid_phase_b_acl_attacker NOLOGIN;
   GRANT USAGE ON SCHEMA noosphere_hybrid_b TO hybrid_phase_b_acl_attacker;
   GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.profile_status(uuid) TO hybrid_phase_b_acl_attacker" >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted an ACL grantee outside the exact capability allowlist'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "REVOKE ALL ON FUNCTION noosphere_hybrid_b.profile_status(uuid) FROM hybrid_phase_b_acl_attacker;
   REVOKE ALL ON SCHEMA noosphere_hybrid_b FROM hybrid_phase_b_acl_attacker;
   DROP ROLE hybrid_phase_b_acl_attacker" >/dev/null
activate_phase_b >/dev/null

# Repeat activation must reject missing positive capability grants as well as
# unexpected grants. These are the entry points the admin/worker CLIs require.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE USAGE ON SCHEMA noosphere_hybrid_b FROM noosphere_hybrid_worker' >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted missing worker schema usage'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT USAGE ON SCHEMA noosphere_hybrid_b TO noosphere_hybrid_worker;
   REVOKE EXECUTE ON FUNCTION noosphere_hybrid_b.queue_health() FROM noosphere_hybrid_admin' >/dev/null
if activate_phase_b >/dev/null 2>&1; then
  die 'Phase B activation accepted missing administrator queue health execution'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT EXECUTE ON FUNCTION noosphere_hybrid_b.queue_health() TO noosphere_hybrid_admin' >/dev/null
activate_phase_b >/dev/null
expect_sql_failure 'application Phase B schema read' "$candidate_app" \
  'SELECT * FROM noosphere_hybrid_b.feature_state'
expect_sql_failure 'worker Phase B consent read' "$candidate_worker" \
  'SELECT * FROM noosphere_hybrid_b.embedding_consent'
expect_sql_failure 'administrator Phase B consent mutation' "$candidate_admin" \
  'UPDATE noosphere_hybrid_b.embedding_consent SET remote_egress=true'

fixture_endpoint='http://127.0.0.1:19876/v1/embeddings'
fixture_endpoint_sha=$(printf '%s' "$fixture_endpoint" | sha256sum | awk '{print $1}')
local_profile=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.create_profile(
     'openai-compatible','local','fixture-model','fixture-r1',3,
     'cosine','none',32768,decode('$fixture_endpoint_sha','hex'))")
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$local_profile','preparing')" >/dev/null
assert_equals '1:f' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT generation,completed FROM noosphere_hybrid_b.profile_backfill_state WHERE profile_id='$local_profile'")" \
  'Phase B prepare creates a durable incomplete backfill generation'
expect_sql_failure 'Phase B serving before durable backfill completion' "$candidate_admin" \
  "SELECT noosphere_hybrid_b.set_profile_state('$local_profile','serving')"
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$local_profile',1000)" >/dev/null
assert_equals '1:t' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT generation,completed FROM noosphere_hybrid_b.profile_backfill_state WHERE profile_id='$local_profile'")" \
  'Phase B durable backfill completion'

# Local embeddings accept restricted content by default. A3's fail-closed
# trigger runs first; the Phase B trigger then re-enqueues only the newly
# authorized local profile from the same monotonic revision.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, status, confidence, "topicId",
  "restrictedTags", "createdAt", "updatedAt"
) VALUES (
  'phase-b-restricted', 'Phase B restricted', 'phase-b-restricted',
  'restricted local bytes', '', 'published', 'high', 'hybrid-topic',
  ARRAY['financial'], clock_timestamp(), clock_timestamp()
);
SQL
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state FROM noosphere_hybrid.embedding_job WHERE article_id='phase-b-restricted' AND profile_id='$local_profile'")" \
  'Phase B local restricted enqueue'

# The standalone worker must use the worker login, call the authenticated
# provider boundary, validate the response, and publish through the CAS routine.
fixture_log=$(mktemp)
HYBRID_FIXTURE_PORT=19876 node "$repo_root/scripts/hybrid-embedding-fixture-server.mjs" >"$fixture_log" 2>&1 &
fixture_pid=$!
for _ in $(seq 1 50); do
  grep -q '^ready$' "$fixture_log" && break
  kill -0 "$fixture_pid" 2>/dev/null || die 'hybrid embedding fixture server exited early'
  sleep 0.1
done
grep -q '^ready$' "$fixture_log" || die 'hybrid embedding fixture server did not become ready'
provider_config=$(printf '[{"profileId":"%s","locality":"local","endpoint":"%s","apiKey":""}]' \
  "$local_profile" "$fixture_endpoint")
invalid_lease_log=$(mktemp)
if NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$(printf '%s' "$provider_config" | base64 -w0)" \
  NOOSPHERE_HYBRID_LEASE_SECONDS=30 \
  NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS=120000 \
    node "$repo_root/scripts/hybrid-worker.mjs" --once >"$invalid_lease_log" 2>&1; then
  die 'Phase B worker accepted a provider timeout longer than its lease'
fi
grep -q 'must outlive' "$invalid_lease_log" || {
  cat "$invalid_lease_log" >&2
  die 'Phase B invalid lease-window diagnostic missing'
}
rm -f -- "$invalid_lease_log"
invalid_lease_log=
worker_health_file=$(mktemp)
worker_log=$(mktemp)
phase_b_epoch_before_publish=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
if ! NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$(printf '%s' "$provider_config" | base64 -w0)" \
  NOOSPHERE_HYBRID_WORKER_CONCURRENCY=1 \
  NOOSPHERE_HYBRID_WORKER_HEALTH_FILE="$worker_health_file" \
    node "$repo_root/scripts/hybrid-worker.mjs" --once >"$worker_log" 2>&1; then
  cat "$worker_log" >&2
  die 'Phase B standalone worker failed'
fi
phase_b_epoch_after_publish=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $phase_b_epoch_after_publish -gt $phase_b_epoch_before_publish ]] ||
  die 'Phase B vector publication did not advance the cache epoch'
rm -f -- "$worker_log"
worker_log=
assert_equals 1 "$(grep -c '^request$' "$fixture_log")" \
  'Phase B provider fixture request count after local publication'
assert_equals 1 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='phase-b-restricted' AND profile_id='$local_profile'")" \
  'Phase B worker publication'
assert_equals 0 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE profile_id='$local_profile'")" \
  'Phase B local queue after publication'
assert_equals '1:1:1.00000000000000000000' "$(psql "$candidate_admin" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT eligible_count,ready_count,coverage FROM noosphere_hybrid_b.profile_coverage('$local_profile')")" \
  'Phase B local coverage'
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$local_profile','serving')" >/dev/null

# A worker crash after dispatch must not bypass the durable attempt cap. Expire
# two simulated crash leases, then prove recovery terminalizes instead of
# issuing a third claim.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.\"Article\" (
     id,title,slug,content,excerpt,status,confidence,\"topicId\",\"restrictedTags\",\"createdAt\",\"updatedAt\"
   ) VALUES (
     'phase-b-crash-cap','Crash cap','phase-b-crash-cap','crash cap bytes','',
     'published','high','hybrid-topic',ARRAY[]::text[],clock_timestamp(),clock_timestamp()
   )" >/dev/null
crash_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,attempt_count FROM noosphere_hybrid_b.claim_jobs(1,30,2,ARRAY['$local_profile']::uuid[])")
IFS='|' read -r crash_job crash_token crash_generation crash_attempt <<<"$crash_claim"
[[ "$crash_job" =~ ^[a-f0-9-]{36}$ ]] || die 'Phase B crash-cap first claim missing'
assert_equals 1 "$crash_attempt" 'Phase B crash-cap first durable attempt'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='crash cap bytes revised', \"updatedAt\"=clock_timestamp() WHERE id='phase-b-crash-cap'" >/dev/null
assert_equals "leased:1:$crash_token:$crash_generation" "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT state,attempt_count,lease_token,lease_generation FROM noosphere_hybrid.embedding_job WHERE id='$crash_job'")" \
  'Phase B active lease preserves monotonic attempts across revision coalescing'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE noosphere_hybrid.embedding_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='$crash_job'" >/dev/null
crash_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_generation,attempt_count FROM noosphere_hybrid_b.claim_jobs(1,30,2,ARRAY['$local_profile']::uuid[])")
IFS='|' read -r crash_job crash_generation crash_attempt <<<"$crash_claim"
assert_equals 2 "$crash_generation" 'Phase B crash-cap second lease generation'
assert_equals 2 "$crash_attempt" 'Phase B crash-cap second durable attempt'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE noosphere_hybrid.embedding_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='$crash_job'" >/dev/null
assert_equals 0 "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid_b.claim_jobs(1,30,2,ARRAY['$local_profile']::uuid[])")" \
  'Phase B crash-cap third claim denial'
assert_equals 'failed:2:lease_expired_max_attempts' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT state,attempt_count,last_error_code FROM noosphere_hybrid.embedding_job WHERE id='$crash_job'")" \
  'Phase B crash-cap durable terminal state'
terminal_health_file=$(mktemp)
terminal_worker_log=$(mktemp)
if ! NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$(printf '%s' "$provider_config" | base64 -w0)" \
  NOOSPHERE_HYBRID_WORKER_CONCURRENCY=1 \
  NOOSPHERE_HYBRID_WORKER_HEALTH_FILE="$terminal_health_file" \
    node "$repo_root/scripts/hybrid-worker.mjs" --once >"$terminal_worker_log" 2>&1; then
  cat "$terminal_worker_log" >&2
  die 'Phase B terminal-failure health worker run failed'
fi
assert_equals critical "$(node -e \
  "const fs=require('node:fs'); const h=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(h.status)" "$terminal_health_file")" \
  'Phase B terminal failure queue severity'
if NOOSPHERE_HYBRID_WORKER_HEALTH_FILE="$terminal_health_file" \
  node "$repo_root/scripts/check-hybrid-worker-health.mjs"; then
  die 'Phase B health checker accepted terminal job failure'
fi
rm -f -- "$terminal_health_file" "$terminal_worker_log"
terminal_health_file=
terminal_worker_log=
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id='phase-b-crash-cap'" >/dev/null

# Publication must preserve newer coalesced work and reject leases invalidated
# by soft deletion or profile deactivation.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"restrictedTags\"=ARRAY['hr'], \"updatedAt\"=clock_timestamp() WHERE id='phase-b-restricted'" >/dev/null
local_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex')
   FROM noosphere_hybrid_b.claim_jobs(1,120,8,ARRAY['$local_profile']::uuid[])")
IFS='|' read -r local_job local_token local_generation local_revision local_hash <<<"$local_claim"
# Authorization-first and mutation-first are both linearized by the same short
# advisory lock. Hold the authorization transaction open, prove the Article
# update blocks, then commit and let the newer revision coalesce.
coproc PHASE_B_AUTHORIZE_WORKER { psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 2>&1; }
phase_b_authorize_worker_out=${PHASE_B_AUTHORIZE_WORKER[0]}
phase_b_authorize_worker_in=${PHASE_B_AUTHORIZE_WORKER[1]}
phase_b_authorize_worker_pid=$PHASE_B_AUTHORIZE_WORKER_PID
printf '%s\n' \
  'BEGIN;' \
  "SELECT noosphere_hybrid_b.authorize_dispatch('$local_job','$local_token',$local_generation);" \
  >&"$phase_b_authorize_worker_in"
IFS= read -r phase_b_authorized <&"$phase_b_authorize_worker_out"
assert_equals t "$phase_b_authorized" 'Phase B authorization-first readiness'
phase_b_content_update_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-phase-b-content-race \
  psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
    "UPDATE public.\"Article\" SET content='newer restricted local bytes', \"updatedAt\"=clock_timestamp() WHERE id='phase-b-restricted'" \
    >"$phase_b_content_update_output" 2>&1 &
phase_b_content_update_pid=$!
phase_b_content_update_blocked=false
for attempt in $(seq 1 100); do
  phase_b_content_update_wait=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
     FROM pg_catalog.pg_stat_activity
     WHERE application_name='noosphere-hybrid-phase-b-content-race'")
  if [[ "$phase_b_content_update_wait" == Lock:* ]]; then
    phase_b_content_update_blocked=true
    break
  fi
  kill -0 "$phase_b_content_update_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$phase_b_content_update_blocked" == true ]] ||
  die "Phase B Article update did not block behind dispatch authorization: ${phase_b_content_update_wait:-absent}"
printf '%s\n' 'COMMIT;' >&"$phase_b_authorize_worker_in"
exec {phase_b_authorize_worker_in}>&-
phase_b_authorize_worker_in=
phase_b_authorize_tail=$(cat <&"$phase_b_authorize_worker_out")
exec {phase_b_authorize_worker_out}<&-
phase_b_authorize_worker_out=
if ! wait "$phase_b_authorize_worker_pid"; then
  die "Phase B authorization transaction failed: $phase_b_authorize_tail"
fi
phase_b_authorize_worker_pid=
if ! wait "$phase_b_content_update_pid"; then
  phase_b_content_update_failure=$(cat "$phase_b_content_update_output")
  rm -f -- "$phase_b_content_update_output"
  phase_b_content_update_output=
  die "Phase B blocked Article update failed: $phase_b_content_update_failure"
fi
phase_b_content_update_pid=
rm -f -- "$phase_b_content_update_output"
phase_b_content_update_output=
assert_equals f "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.authorize_dispatch('$local_job','$local_token',$local_generation)")" \
  'Phase B dispatch authorization rejects a coalesced newer revision'
assert_equals t "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.release_stale_job('$local_job','$local_token',$local_generation,8)")" \
  'Phase B stale dispatch releases its exact lease'
assert_equals 'queued:t' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT state,lease_token IS NULL FROM noosphere_hybrid.embedding_job WHERE id='$local_job'")" \
  'Phase B stale dispatch lease release state'
local_stale_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.publish_embedding(
     '$local_job','$local_token',$local_generation,$local_revision,
     decode('$local_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$local_stale_publish" 'Phase B stale publication after content change'
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state FROM noosphere_hybrid.embedding_job
   WHERE article_id='phase-b-restricted' AND profile_id='$local_profile'
     AND desired_revision > $local_revision")" \
  'Phase B newer desired revision survives stale publication'

local_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex')
   FROM noosphere_hybrid_b.claim_jobs(1,120,8,ARRAY['$local_profile']::uuid[])")
IFS='|' read -r local_job local_token local_generation local_revision local_hash <<<"$local_claim"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=clock_timestamp(), \"updatedAt\"=clock_timestamp() WHERE id='phase-b-restricted'" >/dev/null
assert_equals f "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.publish_embedding(
     '$local_job','$local_token',$local_generation,$local_revision,
     decode('$local_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")" \
  'Phase B late publication after soft delete'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=NULL, \"updatedAt\"=clock_timestamp() WHERE id='phase-b-restricted'" >/dev/null

local_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex')
   FROM noosphere_hybrid_b.claim_jobs(1,120,8,ARRAY['$local_profile']::uuid[])")
IFS='|' read -r local_job local_token local_generation local_revision local_hash <<<"$local_claim"
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$local_profile','inactive')" >/dev/null
assert_equals f "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.publish_embedding(
     '$local_job','$local_token',$local_generation,$local_revision,
     decode('$local_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")" \
  'Phase B late publication after profile deactivation'

# Prove the serving boundary exactly: 94/100 is rejected atomically, while
# 95/100 is accepted. Vector readiness and the successful lifecycle transition
# must each advance the durable cache epoch.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, status, confidence, "topicId",
  "restrictedTags", "createdAt", "updatedAt"
)
SELECT
  'phase-b-threshold-' || pg_catalog.lpad(series::text, 3, '0'),
  'Phase B threshold ' || series,
  'phase-b-threshold-' || pg_catalog.lpad(series::text, 3, '0'),
  'threshold content ' || series,
  '', 'published', 'high', 'hybrid-topic', ARRAY[]::text[],
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
FROM pg_catalog.generate_series(1, 99) AS series;
SQL
threshold_profile=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.create_profile(
     'openai-compatible','local','threshold-model','threshold-r1',3,
     'cosine','none',32768,decode(repeat('55',32),'hex'))")
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$threshold_profile','preparing');
   SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$threshold_profile',1000)" >/dev/null
phase_b_epoch_before_vectors=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO noosphere_hybrid.article_embedding (
     article_id, profile_id, revision, content_hash, dimensions, embedding
   )
   SELECT article.id, '$threshold_profile', state.revision,
          noosphere_hybrid.canonical_hash(article.title,article.excerpt,article.content,32768),
          3, '[1,2,3]'::noosphere_vector.vector
   FROM public.\"Article\" AS article
   JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id=article.id
   ORDER BY article.id
   LIMIT 94" >/dev/null
assert_equals '100:94:0.94' "$(psql "$candidate_admin" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT eligible_count,ready_count,round(coverage,2) FROM noosphere_hybrid_b.profile_coverage('$threshold_profile')")" \
  'Phase B 94 percent serving boundary fixture'
phase_b_epoch_after_vectors=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $phase_b_epoch_after_vectors -gt $phase_b_epoch_before_vectors ]] ||
  die 'Phase B vector readiness did not advance the cache epoch'
expect_sql_failure 'Phase B serving below 95 percent' "$candidate_admin" \
  "SELECT noosphere_hybrid_b.set_profile_state('$threshold_profile','serving')"
assert_equals "preparing:$phase_b_epoch_after_vectors" "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT profile.state,epoch.epoch FROM noosphere_hybrid.embedding_profile AS profile
   CROSS JOIN noosphere_hybrid.search_cache_epoch AS epoch
   WHERE profile.id='$threshold_profile' AND epoch.singleton")" \
  'Phase B failed serving transition atomicity'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO noosphere_hybrid.article_embedding (
     article_id, profile_id, revision, content_hash, dimensions, embedding
   )
   SELECT article.id, '$threshold_profile', state.revision,
          noosphere_hybrid.canonical_hash(article.title,article.excerpt,article.content,32768),
          3, '[1,2,3]'::noosphere_vector.vector
   FROM public.\"Article\" AS article
   JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id=article.id
   WHERE NOT EXISTS (
     SELECT 1 FROM noosphere_hybrid.article_embedding AS embedding
     WHERE embedding.article_id=article.id AND embedding.profile_id='$threshold_profile'
   )
   ORDER BY article.id
   LIMIT 1" >/dev/null
assert_equals '100:95:0.95' "$(psql "$candidate_admin" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT eligible_count,ready_count,round(coverage,2) FROM noosphere_hybrid_b.profile_coverage('$threshold_profile')")" \
  'Phase B 95 percent serving boundary fixture'
phase_b_epoch_before_serve=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$threshold_profile','serving')" >/dev/null
phase_b_epoch_after_serve=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $phase_b_epoch_after_serve -gt $phase_b_epoch_before_serve ]] ||
  die 'Phase B serving transition did not advance the cache epoch'
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$threshold_profile','inactive')" >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM noosphere_hybrid.article_embedding WHERE profile_id='$threshold_profile'" >/dev/null
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id LIKE 'phase-b-threshold-%'" >/dev/null

# Remote profiles require explicit general consent; restricted remote content
# requires the second consent. Revocation hard-deletes the remote artifact,
# cancels work, demotes the profile, and defeats a late publication attempt.
remote_fixture_endpoint='https://127.0.0.1:19876/v1/embeddings'
remote_fixture_endpoint_sha=$(printf '%s' "$remote_fixture_endpoint" | sha256sum | awk '{print $1}')
remote_profile=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.create_profile(
     'openai-compatible','remote','fixture-model','fixture-r1',3,
     'cosine','none',32768,decode('$remote_fixture_endpoint_sha','hex'))")
expect_sql_failure 'Phase B remote prepare without consent' "$candidate_admin" \
  "SELECT noosphere_hybrid_b.set_profile_state('$remote_profile','preparing')"
phase_b_epoch_before_consent=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_embedding_consent(true,false);
   SELECT noosphere_hybrid_b.set_profile_state('$remote_profile','preparing');
   SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$remote_profile',1000);
   SELECT noosphere_hybrid_b.set_profile_state('$remote_profile','serving');
   SELECT noosphere_hybrid_b.set_embedding_consent(true,true)" >/dev/null
assert_equals 'preparing:2:f' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT profile.state,backfill.generation,backfill.completed
   FROM noosphere_hybrid.embedding_profile AS profile
   JOIN noosphere_hybrid_b.profile_backfill_state AS backfill ON backfill.profile_id=profile.id
   WHERE profile.id='$remote_profile'")" \
  'Phase B restricted consent expansion starts a fresh complete backfill'
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$remote_profile',1000)" >/dev/null
phase_b_epoch_after_consent=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $phase_b_epoch_after_consent -gt $phase_b_epoch_before_consent ]] ||
  die 'Phase B consent/profile activation did not advance the cache epoch'
assert_equals "0:1" "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE profile_id='$local_profile'),
          (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE profile_id='$remote_profile')")" \
  'Phase B backfill queue isolation'
remote_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,profile_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex')
   FROM noosphere_hybrid_b.claim_jobs(1,120,8,ARRAY['$remote_profile']::uuid[])")
IFS='|' read -r remote_job claimed_profile remote_token remote_generation remote_revision remote_hash <<<"$remote_claim"
[[ "$remote_job" =~ ^[a-f0-9-]{36}$ ]] || die 'Phase B remote worker did not claim restricted work'
assert_equals "$remote_profile" "$claimed_profile" 'Phase B remote claim profile identity'

# If revocation commits before dispatch authorization, the worker must make no
# provider request. This is distinct from merely rejecting a late publication.
phase_b_epoch_before_revocation=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT noosphere_hybrid_b.set_embedding_consent(true,false)' >/dev/null
phase_b_epoch_after_revocation=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $phase_b_epoch_after_revocation -gt $phase_b_epoch_before_revocation ]] ||
  die 'Phase B consent revocation did not advance the cache epoch'
assert_equals f "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "BEGIN; SELECT noosphere_hybrid_b.authorize_dispatch('$remote_job','$remote_token',$remote_generation); ROLLBACK")" \
  'Phase B dispatch authorization after committed consent revocation'
printf -v remote_provider_api_key '%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
remote_provider_config=$(printf '[{"profileId":"%s","locality":"remote","endpoint":"%s","apiKey":"%s"}]' \
  "$remote_profile" "$remote_fixture_endpoint" "$remote_provider_api_key")
fixture_requests_before_revoked_worker=$(grep -c '^request$' "$fixture_log")
worker_log=$(mktemp)
if ! NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$(printf '%s' "$remote_provider_config" | base64 -w0)" \
  NOOSPHERE_HYBRID_WORKER_CONCURRENCY=1 \
  NOOSPHERE_HYBRID_WORKER_HEALTH_FILE="$worker_health_file" \
    node "$repo_root/scripts/hybrid-worker.mjs" --once >"$worker_log" 2>&1; then
  cat "$worker_log" >&2
  die 'Phase B revoked-consent worker check failed'
fi
rm -f -- "$worker_log"
worker_log=
assert_equals "$fixture_requests_before_revoked_worker" "$(grep -c '^request$' "$fixture_log")" \
  'Phase B provider requests after consent revoked first'
kill "$fixture_pid" 2>/dev/null || true
wait "$fixture_pid" 2>/dev/null || true
fixture_pid=
rm -f -- "$fixture_log"
fixture_log=

# Re-consent does not reactivate the profile. Prepare/backfill explicitly so a
# second claim can prove publication also serializes behind a live revocation.
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_embedding_consent(true,true);
   SELECT noosphere_hybrid_b.set_profile_state('$remote_profile','preparing');
   SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$remote_profile',1000)" >/dev/null
assert_equals '3:t' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT generation,completed FROM noosphere_hybrid_b.profile_backfill_state WHERE profile_id='$remote_profile'")" \
  'Phase B re-prepare creates and completes a fresh backfill generation'
remote_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,profile_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex')
   FROM noosphere_hybrid_b.claim_jobs(1,120,8,ARRAY['$remote_profile']::uuid[])")
IFS='|' read -r remote_job claimed_profile remote_token remote_generation remote_revision remote_hash <<<"$remote_claim"
[[ "$remote_job" =~ ^[a-f0-9-]{36}$ ]] || die 'Phase B remote worker did not reclaim restricted work'

coproc PHASE_B_CONSENT_WRITER { psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 2>&1; }
phase_b_consent_writer_out=${PHASE_B_CONSENT_WRITER[0]}
phase_b_consent_writer_in=${PHASE_B_CONSENT_WRITER[1]}
phase_b_consent_writer_pid=$PHASE_B_CONSENT_WRITER_PID
printf '%s\n' \
  'BEGIN;' \
  "SELECT 'consent-ready' FROM (SELECT noosphere_hybrid_b.set_embedding_consent(true,false)) AS applied;" \
  >&"$phase_b_consent_writer_in"
IFS= read -r phase_b_consent_marker <&"$phase_b_consent_writer_out"
assert_equals consent-ready "$phase_b_consent_marker" 'Phase B consent writer readiness'

phase_b_publish_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-phase-b-consent-race \
  psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT noosphere_hybrid_b.publish_embedding(
       '$remote_job','$remote_token',$remote_generation,$remote_revision,
       decode('$remote_hash','hex'),'[1,2,3]'::noosphere_vector.vector)" \
    >"$phase_b_publish_output" 2>&1 &
phase_b_publish_pid=$!
phase_b_publish_blocked=false
for attempt in $(seq 1 100); do
  phase_b_publish_wait=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
     FROM pg_catalog.pg_stat_activity
     WHERE application_name='noosphere-hybrid-phase-b-consent-race'")
  if [[ "$phase_b_publish_wait" == Lock:* ]]; then
    phase_b_publish_blocked=true
    break
  fi
  kill -0 "$phase_b_publish_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$phase_b_publish_blocked" == true ]] ||
  die "Phase B publication did not block behind consent revocation: ${phase_b_publish_wait:-absent}"

printf '%s\n' 'COMMIT;' >&"$phase_b_consent_writer_in"
exec {phase_b_consent_writer_in}>&-
phase_b_consent_writer_in=
phase_b_consent_writer_tail=$(cat <&"$phase_b_consent_writer_out")
exec {phase_b_consent_writer_out}<&-
phase_b_consent_writer_out=
if ! wait "$phase_b_consent_writer_pid"; then
  die "Phase B consent writer failed: $phase_b_consent_writer_tail"
fi
phase_b_consent_writer_pid=
if ! wait "$phase_b_publish_pid"; then
  phase_b_publish_failure=$(cat "$phase_b_publish_output")
  rm -f -- "$phase_b_publish_output"
  phase_b_publish_output=
  die "Phase B publication failed instead of rejecting revoked consent: $phase_b_publish_failure"
fi
phase_b_publish_pid=
remote_late_publish=$(cat "$phase_b_publish_output")
rm -f -- "$phase_b_publish_output"
phase_b_publish_output=
assert_equals f "$remote_late_publish" 'Phase B late publication after consent revocation'
assert_equals 'inactive:0:0' "$(psql "$candidate_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT profile.state,
          (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE profile_id=profile.id),
          (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE profile_id=profile.id)
   FROM noosphere_hybrid.embedding_profile AS profile WHERE profile.id='$remote_profile'")" \
  'Phase B restricted consent revocation cleanup'

# Re-consent never restores serving. Inactive profiles receive no incremental
# work until an administrator explicitly transitions and backfills them.
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_embedding_consent(true,true)" >/dev/null
assert_equals inactive "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state FROM noosphere_hybrid.embedding_profile WHERE id='$remote_profile'")" \
  'Phase B re-consent profile state'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='restricted changed while remote inactive', \"updatedAt\"=clock_timestamp() WHERE id='phase-b-restricted'" >/dev/null
assert_equals 0 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='phase-b-restricted' AND profile_id='$remote_profile'")" \
  'Phase B inactive profile incremental work'
assert_equals '0:0:0:0' "$(psql "$candidate_worker" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  'SELECT pending_depth,oldest_pending_age_seconds,leased_count,failed_count FROM noosphere_hybrid_b.queue_health()')" \
  'Phase B queue health after completion'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id='phase-b-restricted'" >/dev/null

# Phase C adds an independently evidenced, application-only content-free
# retrieval capability. It must preserve both exact prerequisite validators,
# reject ACL drift, and enforce serving/current-vector behavior.
activate_phase_c >/dev/null
activate_phase_c >/dev/null

# A same-signature body replacement preserves the routine identity and ACLs,
# so the catalog manifest itself must reject it. Keep the tamper transactional
# and then revalidate the untouched installation to prove the failed probe did
# not leave state behind.
if phase_c_tamper_output=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
SELECT pg_catalog.set_config(
         'noosphere.phase_a3.source_sha256', state.a3_source_sha256, true
       ),
       pg_catalog.set_config(
         'noosphere.phase_b.source_sha256', state.phase_b_source_sha256, true
       ),
       pg_catalog.set_config(
         'noosphere.phase_c.source_sha256', state.source_sha256, true
       )
FROM noosphere_hybrid_c.feature_state AS state
WHERE state.singleton;
SET LOCAL ROLE noosphere_hybrid_owner;
CREATE OR REPLACE FUNCTION noosphere_hybrid_c.vector_candidates(
  target_profile_id uuid,
  query_embedding_text text,
  candidate_article_ids text[]
)
RETURNS TABLE (article_id text, distance double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS \$tamper\$
BEGIN
  RETURN;
END;
\$tamper\$;
RESET ROLE;
\i $repo_root/docker/hybrid-storage/validate-phase-c.sql
ROLLBACK;
SQL
); then
  die 'Phase C same-signature routine body tamper unexpectedly validated'
fi
[[ "$phase_c_tamper_output" == *'Phase C routine manifest drifted'* ]] ||
  die "Phase C same-signature routine body tamper returned the wrong diagnostic: $phase_c_tamper_output"
activate_phase_c >/dev/null

# Catalog-based routine manifests must survive a custom-format logical
# backup/restore exactly. Re-run the complete current activation on the
# restored database so both provenance validators exercise the round trip.
phase_b_manifest_before_dump=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT manifest_sha256 FROM noosphere_hybrid_b.feature_state WHERE singleton')
phase_c_manifest_before_dump=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT manifest_sha256 FROM noosphere_hybrid_c.feature_state WHERE singleton')
phase_c_dump_file=$(mktemp)
docker exec "$candidate_container" \
  pg_dump -U noosphere_bootstrap -d noosphere --format=custom >"$phase_c_dump_file"

phase_c_restore_database="noosphere_phase_c_restore_${run_id//[^a-zA-Z0-9]/_}"
[[ "$phase_c_restore_database" =~ ^[a-z0-9_]+$ ]] ||
  die 'generated Phase C restore database name is unsafe'
psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$phase_c_restore_database\" TEMPLATE template0" >/dev/null
phase_c_restore_bootstrap=$(database_url_for "$candidate_bootstrap" "$phase_c_restore_database")
phase_c_restore_migrator=$(database_url_for "$candidate_migrator" "$phase_c_restore_database")
phase_c_restore_app=$(database_url_for "$candidate_app" "$phase_c_restore_database")
phase_c_restore_admin=$(database_url_for "$candidate_admin" "$phase_c_restore_database")
phase_c_restore_worker=$(database_url_for "$candidate_worker" "$phase_c_restore_database")
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE noosphere_hybrid_extension_owner SUPERUSER' >/dev/null
phase_c_restore_extension_owner_elevated=true
phase_c_restore_pgvector_version=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c "SELECT extversion FROM pg_catalog.pg_extension WHERE extname='vector'")
psql "$phase_c_restore_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SET ROLE noosphere_hybrid_extension_owner;
   CREATE SCHEMA noosphere_vector AUTHORIZATION noosphere_hybrid_extension_owner;
   CREATE EXTENSION vector WITH SCHEMA noosphere_vector
     VERSION '$phase_c_restore_pgvector_version';
   CREATE SCHEMA noosphere_crypto AUTHORIZATION noosphere_hybrid_extension_owner;
   CREATE EXTENSION pgcrypto WITH SCHEMA noosphere_crypto;
   RESET ROLE" >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE noosphere_hybrid_extension_owner NOSUPERUSER' >/dev/null
phase_c_restore_extension_owner_elevated=false

phase_c_dump_container_path="/tmp/noosphere-phase-c-$run_id.dump"
phase_c_restore_toc_container_path="/tmp/noosphere-phase-c-$run_id.list"
phase_c_restore_toc_file=$(mktemp)
phase_c_restore_filtered_toc_file=$(mktemp)
docker cp "$phase_c_dump_file" "$candidate_container:$phase_c_dump_container_path"
docker exec "$candidate_container" pg_restore -l "$phase_c_dump_container_path" \
  >"$phase_c_restore_toc_file"
sed -E \
  -e '/ (SCHEMA|EXTENSION) - (noosphere_crypto|noosphere_vector|pgcrypto|vector) /d' \
  -e '/ COMMENT - EXTENSION (pgcrypto|vector) /d' \
  "$phase_c_restore_toc_file" >"$phase_c_restore_filtered_toc_file"
docker cp "$phase_c_restore_filtered_toc_file" \
  "$candidate_container:$phase_c_restore_toc_container_path"
docker exec "$candidate_container" \
  pg_restore -U noosphere_bootstrap -d "$phase_c_restore_database" \
    --exit-on-error --use-list="$phase_c_restore_toc_container_path" \
    "$phase_c_dump_container_path"
docker exec "$candidate_container" unlink "$phase_c_dump_container_path"
docker exec "$candidate_container" unlink "$phase_c_restore_toc_container_path"

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$phase_c_restore_bootstrap" \
DATABASE_URL="$phase_c_restore_migrator" \
NOOSPHERE_APP_DATABASE_URL="$phase_c_restore_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$phase_c_restore_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$phase_c_restore_worker" \
  "$repo_root/scripts/activate-hybrid-retrieval.sh" >/dev/null
assert_equals "$phase_b_manifest_before_dump:$phase_c_manifest_before_dump" "$(
  psql "$phase_c_restore_bootstrap" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
    'SELECT b.manifest_sha256, c.manifest_sha256
     FROM noosphere_hybrid_b.feature_state AS b
     CROSS JOIN noosphere_hybrid_c.feature_state AS c
     WHERE b.singleton AND c.singleton'
)" 'Phase B and C routine manifests survive custom dump and restore'

psql "${candidate_bootstrap%/*}/postgres" -XAtq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$phase_c_restore_database\" WITH (FORCE)" >/dev/null
phase_c_restore_database=
rm -f -- "$phase_c_dump_file"
phase_c_dump_file=
rm -f -- "$phase_c_restore_toc_file" "$phase_c_restore_filtered_toc_file"
phase_c_restore_toc_file=
phase_c_restore_filtered_toc_file=

expect_sql_failure 'administrator unsynchronized A3 profile creation' "$candidate_admin" \
  "SELECT noosphere_hybrid.create_profile(
     'openai-compatible','local','forbidden-direct','r1',3,
     'cosine','none',32768,decode(repeat('77',32),'hex'))"

# Profile creation and Article mutation both change the exact profile/article
# eligibility product. Hold an Article transaction after its coverage trigger,
# prove the Phase B profile wrapper waits on the shared advisory lock, then
# require the post-commit materialization to equal a fresh full recomputation.
coproc PHASE_C_PROFILE_ARTICLE_WRITER { psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 2>&1; }
phase_c_profile_writer_out=${PHASE_C_PROFILE_ARTICLE_WRITER[0]}
phase_c_profile_writer_in=${PHASE_C_PROFILE_ARTICLE_WRITER[1]}
phase_c_profile_writer_pid=$PHASE_C_PROFILE_ARTICLE_WRITER_PID
printf '%s\n' \
  'BEGIN;' \
  'INSERT INTO public."Article" (id,title,slug,content,excerpt,status,confidence,"topicId","restrictedTags","createdAt","updatedAt") VALUES ('\''phase-c-profile-race'\'','\''Profile race'\'','\''phase-c-profile-race'\'','\''serialized coverage'\'','\'''\'','\''published'\'','\''high'\'','\''hybrid-topic'\'',ARRAY[]::text[],clock_timestamp(),clock_timestamp());' \
  'SELECT '\''profile-race-writer-ready'\'';' >&"$phase_c_profile_writer_in"
IFS= read -r phase_c_profile_writer_marker <&"$phase_c_profile_writer_out"
assert_equals profile-race-writer-ready "$phase_c_profile_writer_marker" \
  'Phase C profile/article race writer readiness'

phase_c_profile_create_output=$(mktemp)
PGAPPNAME=noosphere-hybrid-phase-c-profile-race \
  psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT noosphere_hybrid_b.create_profile(
       'openai-compatible','local','coverage-race-model','r1',3,
       'cosine','none',32768,decode(repeat('77',32),'hex'))" \
    >"$phase_c_profile_create_output" 2>&1 &
phase_c_profile_create_pid=$!
phase_c_profile_create_blocked=false
for attempt in $(seq 1 100); do
  phase_c_profile_create_wait=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '')
     FROM pg_catalog.pg_stat_activity
     WHERE application_name='noosphere-hybrid-phase-c-profile-race'")
  if [[ "$phase_c_profile_create_wait" == Lock:* ]]; then
    phase_c_profile_create_blocked=true
    break
  fi
  kill -0 "$phase_c_profile_create_pid" >/dev/null 2>&1 || break
  sleep 0.1
done
[[ "$phase_c_profile_create_blocked" == true ]] ||
  die "Phase C profile creation did not serialize behind Article mutation: ${phase_c_profile_create_wait:-absent}"

printf '%s\n' 'COMMIT;' >&"$phase_c_profile_writer_in"
exec {phase_c_profile_writer_in}>&-
phase_c_profile_writer_in=
phase_c_profile_writer_tail=$(cat <&"$phase_c_profile_writer_out")
exec {phase_c_profile_writer_out}<&-
phase_c_profile_writer_out=
if ! wait "$phase_c_profile_writer_pid"; then
  die "Phase C profile/article race writer failed: $phase_c_profile_writer_tail"
fi
phase_c_profile_writer_pid=
if ! wait "$phase_c_profile_create_pid"; then
  phase_c_profile_create_failure=$(cat "$phase_c_profile_create_output")
  rm -f -- "$phase_c_profile_create_output"
  phase_c_profile_create_output=
  die "Phase C serialized profile creation failed: $phase_c_profile_create_failure"
fi
phase_c_profile_create_pid=
phase_c_profile_race_id=$(cat "$phase_c_profile_create_output")
rm -f -- "$phase_c_profile_create_output"
phase_c_profile_create_output=
assert_equals t "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT snapshot.eligible_count = exact.eligible_count
          AND snapshot.ready_count = exact.ready_count
   FROM noosphere_hybrid_c.query_profile_snapshot('$phase_c_profile_race_id') AS snapshot
   CROSS JOIN noosphere_hybrid_c.query_profile_coverage('$phase_c_profile_race_id') AS exact")" \
  'Phase C serialized profile coverage equality'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM noosphere_hybrid.embedding_profile WHERE id='$phase_c_profile_race_id'" >/dev/null
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id='phase-c-profile-race'" >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'ALTER TABLE public."Article" DISABLE TRIGGER zz_noosphere_hybrid_c_article_coverage' >/dev/null
if activate_phase_c >/dev/null 2>&1; then
  die 'Phase C activation accepted a disabled coverage-maintenance trigger'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'ALTER TABLE public."Article" ENABLE TRIGGER zz_noosphere_hybrid_c_article_coverage' >/dev/null
activate_phase_c >/dev/null
expect_sql_failure 'application Phase C feature-state read' "$candidate_app" \
  'SELECT * FROM noosphere_hybrid_c.feature_state'
expect_sql_failure 'application Phase C structural manifest execution' "$candidate_app" \
  'SELECT noosphere_hybrid_c.structural_manifest()'
expect_sql_failure 'administrator Phase C schema usage' "$candidate_admin" \
  'SELECT noosphere_hybrid_c.query_profile_snapshot(gen_random_uuid())'

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.structural_manifest() TO noosphere_app' >/dev/null
if activate_phase_c >/dev/null 2>&1; then
  die 'Phase C activation accepted an extra application routine grant'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE EXECUTE ON FUNCTION noosphere_hybrid_c.structural_manifest() FROM noosphere_app' >/dev/null
activate_phase_c >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE EXECUTE ON FUNCTION noosphere_hybrid_c.current_vector_membership(uuid,text[]) FROM noosphere_app' >/dev/null
if activate_phase_c >/dev/null 2>&1; then
  die 'Phase C activation accepted a missing application routine grant'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.current_vector_membership(uuid,text[]) TO noosphere_app' >/dev/null
activate_phase_c >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT USAGE ON SCHEMA noosphere_hybrid_c TO noosphere_app WITH GRANT OPTION' >/dev/null
if activate_phase_c >/dev/null 2>&1; then
  die 'Phase C activation accepted application schema USAGE with grant option'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE GRANT OPTION FOR USAGE ON SCHEMA noosphere_hybrid_c FROM noosphere_app' >/dev/null
activate_phase_c >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.authorize_query_dispatch(uuid) TO noosphere_app WITH GRANT OPTION' >/dev/null
if activate_phase_c >/dev/null 2>&1; then
  die 'Phase C activation accepted application routine EXECUTE with grant option'
fi
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION noosphere_hybrid_c.authorize_query_dispatch(uuid) FROM noosphere_app' >/dev/null
activate_phase_c >/dev/null

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, status, confidence, "topicId",
  "restrictedTags", "createdAt", "updatedAt"
) VALUES
  ('phase-c-public-a', 'Phase C exact recall', 'phase-c-public-a',
   'hybrid recall alpha', 'alpha', 'published', 'high', 'hybrid-topic',
   ARRAY[]::text[], clock_timestamp(), clock_timestamp()),
  ('phase-c-public-b', 'Phase C lexical recall', 'phase-c-public-b',
   'hybrid recall beta', 'beta', 'reviewed', 'medium', 'hybrid-topic',
   ARRAY[]::text[], clock_timestamp(), clock_timestamp()),
  ('phase-c-financial', 'Phase C financial recall', 'phase-c-financial',
   'hybrid recall financial', 'financial', 'published', 'high', 'hybrid-topic',
   ARRAY['financial'], clock_timestamp(), clock_timestamp()),
  ('phase-c-private', 'Phase C private recall', 'phase-c-private',
   'hybrid recall private', 'private', 'draft', 'low', 'hybrid-topic',
   ARRAY['private'], clock_timestamp(), clock_timestamp());
SQL

fixture_log=$(mktemp)
HYBRID_FIXTURE_PORT=19876 node "$repo_root/scripts/hybrid-embedding-fixture-server.mjs" >"$fixture_log" 2>&1 &
fixture_pid=$!
for _ in $(seq 1 50); do
  grep -q '^ready$' "$fixture_log" && break
  kill -0 "$fixture_pid" 2>/dev/null || die 'Phase C embedding fixture server exited early'
  sleep 0.1
done
grep -q '^ready$' "$fixture_log" || die 'Phase C embedding fixture server did not become ready'
phase_c_fixture_endpoint='http://127.0.0.1:19876/v1/embeddings'
phase_c_fixture_endpoint_sha=$(printf '%s' "$phase_c_fixture_endpoint" | sha256sum | awk '{print $1}')

phase_c_profile=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.create_profile(
     'openai-compatible','local','fixture-model','fixture-r1',3,
     'cosine','none',32768,decode('$phase_c_fixture_endpoint_sha','hex'))")
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$phase_c_profile','preparing');
   SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill('$phase_c_profile',1000)" >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO noosphere_hybrid.article_embedding (
     article_id, profile_id, revision, content_hash, dimensions, embedding
   )
   SELECT article.id, '$phase_c_profile', state.revision,
          noosphere_hybrid.canonical_hash(article.title,article.excerpt,article.content,32768),
          3,
          CASE article.id
            WHEN 'phase-c-public-a' THEN '[1,0,0]'::noosphere_vector.vector
            WHEN 'phase-c-financial' THEN '[0.9,0.1,0]'::noosphere_vector.vector
            WHEN 'phase-c-public-b' THEN '[0,1,0]'::noosphere_vector.vector
            ELSE '[-1,0,0]'::noosphere_vector.vector
          END
   FROM public.\"Article\" AS article
   JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id=article.id
   WHERE article.id LIKE 'phase-c-%'" >/dev/null
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$phase_c_profile','serving')" >/dev/null

assert_equals 'fixture-model:serving:1.00' "$(psql "$candidate_app" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT model_identifier,profile_state,round(coverage,2)
   FROM noosphere_hybrid_c.query_profile_snapshot('$phase_c_profile')")" \
  'Phase C application profile snapshot'
assert_equals f "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT pg_catalog.pg_get_functiondef(
      'noosphere_hybrid_c.query_profile_snapshot(uuid)'::pg_catalog.regprocedure
    ) ~ 'query_profile_coverage|public\.\"Article\"'")" \
  'Phase C profile snapshot has no corpus scan on its request path'
assert_equals t "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_c.authorize_query_dispatch('$phase_c_profile')")" \
  'Phase C local query dispatch authorization'
assert_equals 'phase-c-public-a:phase-c-financial:phase-c-public-b' "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT pg_catalog.string_agg(article_id, ':' ORDER BY distance, article_id)
   FROM noosphere_hybrid_c.vector_candidates(
     '$phase_c_profile','[1,0,0]',
     ARRAY['phase-c-public-a','phase-c-public-b','phase-c-financial']::text[]
   )")" 'Phase C deterministic content-free vector candidates'

# Equal-distance truncation must use the exact same updatedAt/id tie-break as
# vector rank assignment. With 201 candidates, the oldest row is outside the
# fixed 200-depth set while the newest remains present.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, status, confidence, "topicId",
  "restrictedTags", "createdAt", "updatedAt"
)
SELECT
  'phase-c-tie-' || pg_catalog.lpad(series.value::text, 3, '0'),
  'Phase C tied vector candidate',
  'phase-c-tie-' || pg_catalog.lpad(series.value::text, 3, '0'),
  'equal distance candidate',
  'tie',
  'published',
  'high',
  'hybrid-topic',
  ARRAY[]::text[],
  '2026-01-01 00:00:00+00'::timestamptz + series.value * interval '1 second',
  '2026-01-01 00:00:00+00'::timestamptz + series.value * interval '1 second'
FROM pg_catalog.generate_series(1, 201) AS series(value);
SQL
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO noosphere_hybrid.article_embedding (
     article_id, profile_id, revision, content_hash, dimensions, embedding
   )
   SELECT article.id, '$phase_c_profile', state.revision,
          noosphere_hybrid.canonical_hash(article.title,article.excerpt,article.content,32768),
          3, '[0,1,0]'::noosphere_vector.vector
   FROM public.\"Article\" AS article
   JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id=article.id
   WHERE article.id LIKE 'phase-c-tie-%'" >/dev/null
assert_equals '200:f:t' "$(psql "$candidate_app" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT pg_catalog.count(*),
          pg_catalog.bool_or(article_id='phase-c-tie-001'),
          pg_catalog.bool_or(article_id='phase-c-tie-201')
   FROM noosphere_hybrid_c.vector_candidates(
     '$phase_c_profile','[1,0,0]',
     ARRAY(
       SELECT id FROM public.\"Article\"
       WHERE id LIKE 'phase-c-tie-%' ORDER BY id
     )
   )")" 'Phase C vector depth uses rank-consistent tie order'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id LIKE 'phase-c-tie-%'" >/dev/null

expect_sql_failure 'Phase C query dimension mismatch' "$candidate_app" \
  "SELECT * FROM noosphere_hybrid_c.vector_candidates('$phase_c_profile','[1,0]',ARRAY['phase-c-public-a']::text[])"
expect_sql_failure 'Phase C cosine zero query vector' "$candidate_app" \
  "SELECT * FROM noosphere_hybrid_c.vector_candidates('$phase_c_profile','[0,0,0]',ARRAY['phase-c-public-a']::text[])"
expect_sql_failure 'Phase C vector authorization batch limit' "$candidate_app" \
  "SELECT * FROM noosphere_hybrid_c.vector_candidates(
     '$phase_c_profile','[1,0,0]',ARRAY(
       SELECT 'phase-c-overflow-' || value::text
       FROM pg_catalog.generate_series(1,1001) AS series(value)
     ))"

# Query egress uses the same short Phase B eligibility lock as consent and
# lifecycle mutation. If authorization wins, revocation waits behind the
# committed dispatch point; if revocation commits first, no query is authorized.
phase_c_remote_dispatch_profile=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.create_profile(
     'openai-compatible','remote','fixture-query-model','fixture-query-r1',3,
     'cosine','none',32768,decode('$phase_c_fixture_endpoint_sha','hex'))")
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE noosphere_hybrid.embedding_profile SET state='serving'
   WHERE id='$phase_c_remote_dispatch_profile'" >/dev/null
assert_equals t "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_c.authorize_query_dispatch('$phase_c_remote_dispatch_profile')")" \
  'Phase C remote query dispatch with consent'
phase_c_revoke_output=$(mktemp)
coproc PHASE_C_AUTH {
  PGAPPNAME=noosphere-phase-c-query-authorization \
    psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 2>&1
}
phase_c_auth_out=${PHASE_C_AUTH[0]}
phase_c_auth_in=${PHASE_C_AUTH[1]}
phase_c_auth_pid=$PHASE_C_AUTH_PID
printf '%s\n' \
  'BEGIN;' \
  "SELECT 'authorization-ready:' || noosphere_hybrid_c.authorize_query_dispatch('$phase_c_remote_dispatch_profile');" \
  >&"$phase_c_auth_in"
IFS= read -r phase_c_auth_marker <&"$phase_c_auth_out"
assert_equals authorization-ready:true "$phase_c_auth_marker" \
  'Phase C query authorization readiness'
PGAPPNAME=noosphere-phase-c-consent-revocation \
  psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT noosphere_hybrid_b.set_embedding_consent(false,false)' >"$phase_c_revoke_output" 2>&1 &
phase_c_revoke_pid=$!
phase_c_revoke_wait=
for _ in $(seq 1 100); do
  phase_c_revoke_wait=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
    "SELECT wait_event_type FROM pg_catalog.pg_stat_activity
     WHERE application_name='noosphere-phase-c-consent-revocation'")
  [[ "$phase_c_revoke_wait" == Lock ]] && break
  kill -0 "$phase_c_revoke_pid" 2>/dev/null || break
  sleep 0.05
done
[[ "$phase_c_revoke_wait" == Lock ]] || die 'Phase C consent revocation did not serialize behind query authorization'
printf '%s\n' 'COMMIT;' >&"$phase_c_auth_in"
exec {phase_c_auth_in}>&-
phase_c_auth_in=
phase_c_auth_tail=$(cat <&"$phase_c_auth_out")
exec {phase_c_auth_out}<&-
phase_c_auth_out=
wait "$phase_c_auth_pid" || die "Phase C query authorization failed: $phase_c_auth_tail"
phase_c_auth_pid=
wait "$phase_c_revoke_pid" || die "Phase C consent revocation failed: $(cat "$phase_c_revoke_output")"
phase_c_revoke_pid=
rm -f -- "$phase_c_revoke_output"
phase_c_revoke_output=
assert_equals f "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_c.authorize_query_dispatch('$phase_c_remote_dispatch_profile')")" \
  'Phase C remote query dispatch after committed consent revocation'
psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  'SELECT noosphere_hybrid_b.set_embedding_consent(true,true)' >/dev/null

phase_c_cache_key_b64="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
DATABASE_URL="$candidate_app" \
NOOSPHERE_PHASE_C_ADMIN_DATABASE_URL="$candidate_admin" \
NOOSPHERE_PHASE_C_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
REDIS_URL= \
NOOSPHERE_PHASE_C_TEST_PROFILE_ID="$phase_c_profile" \
NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=true \
NOOSPHERE_HYBRID_QUERY_PROFILE_ID="$phase_c_profile" \
NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION=v1 \
NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64="$(printf '{"v1":"%s"}' "$phase_c_cache_key_b64" | base64 -w0)" \
NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64="$(printf '[{"profileId":"%s","locality":"local","endpoint":"%s","apiKey":""}]' "$phase_c_profile" "$phase_c_fixture_endpoint" | base64 -w0)" \
  node --import tsx "$repo_root/scripts/hybrid-retrieval-smoke.ts"
unset phase_c_cache_key_b64
assert_equals 1 "$(grep -c '^request$' "$fixture_log")" 'Phase C query embedding provider request count'
kill "$fixture_pid" 2>/dev/null || true
wait "$fixture_pid" 2>/dev/null || true
fixture_pid=
rm -f -- "$fixture_log"
fixture_log=

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='changed bytes', \"updatedAt\"=clock_timestamp()
   WHERE id='phase-c-public-a'" >/dev/null
assert_equals '2:t' "$(psql "$candidate_app" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT eligible_count-ready_count,coverage < 1
   FROM noosphere_hybrid_c.query_profile_snapshot('$phase_c_profile')")" \
  'Phase C materialized coverage refreshes after an article revision becomes stale'
assert_equals t "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT snapshot.eligible_count = exact.eligible_count
      AND snapshot.ready_count = exact.ready_count
      AND snapshot.coverage = exact.coverage
   FROM noosphere_hybrid_c.profile_coverage_snapshot AS snapshot
   CROSS JOIN noosphere_hybrid_c.query_profile_coverage('$phase_c_profile') AS exact
   WHERE snapshot.profile_id='$phase_c_profile'")" \
  'Phase C incremental coverage equals an exact corpus recomputation'
assert_equals 0 "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid_c.current_vector_membership(
     '$phase_c_profile',ARRAY['phase-c-public-a']::text[])")" \
  'Phase C stale revision membership rejection'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=clock_timestamp(), \"updatedAt\"=clock_timestamp()
   WHERE id='phase-c-public-b'" >/dev/null
assert_equals 0 "$(psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid_c.current_vector_membership(
     '$phase_c_profile',ARRAY['phase-c-public-b']::text[])")" \
  'Phase C deleted article membership rejection'

psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid_b.set_profile_state('$phase_c_profile','inactive')" >/dev/null
expect_sql_failure 'Phase C inactive profile query' "$candidate_app" \
  "SELECT * FROM noosphere_hybrid_c.vector_candidates(
     '$phase_c_profile','[1,0,0]',ARRAY['phase-c-financial']::text[])"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id LIKE 'phase-c-%'" >/dev/null
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM noosphere_hybrid.embedding_profile
   WHERE id='$phase_c_remote_dispatch_profile'" >/dev/null

printf '[hybrid-storage-test] PASS: A3 storage, Phase B provider/worker, and Phase C retrieval capability matrices.\n'
