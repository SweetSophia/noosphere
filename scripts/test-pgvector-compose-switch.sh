#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$ROOT_DIR/docker/postgres-pgvector/rehearsal.env"

PLATFORM=${1:-linux/amd64}
[[ "$PLATFORM" =~ ^linux/(amd64|arm64)$ ]] || {
  echo "Unsupported platform: $PLATFORM" >&2
  exit 2
}

slug=${PLATFORM#linux/}
run_id=${PGVECTOR_SWITCH_TEST_RUN_ID:-local-$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}
safe_id=${run_id//[^A-Za-z0-9]/-}
project="noosphere-a2b-test-$safe_id"
db_container="$project-db"
app_container="$project-app"
volume="noosphere_a2b_test_${safe_id//-/_}"
probe_volume="${volume}_mount_probe"
authorization_volume="${volume}_authorization"
new_db_container="$project-new-db"
new_app_container="$project-new-app"
new_volume="${volume}_new"
new_authorization_volume="${new_volume}_authorization"
tmp_dir=$(mktemp -d)
compose_file="$tmp_dir/docker-compose.yml"
target_compose="$tmp_dir/target-compose.yml"
backup_dir="$tmp_dir/backups"
log_file="$tmp_dir/switch.log"
mkdir -m 700 "$backup_dir"

cleanup() {
  local status=$? id
  for id in $(docker ps -aq --filter "label=io.noosphere.pgvector-switch-run" --filter "name=noosphere-a2b"); do
    [[ $(docker inspect "$id" --format '{{index .Config.Labels "io.noosphere.pgvector-switch-run"}}' 2>/dev/null || true) == "$run_id" ]] || continue
    docker stop --time 10 "$id" >/dev/null 2>&1 || true
    docker rm "$id" >/dev/null 2>&1 || true
  done
  docker rm -f "$db_container" "$app_container" "$new_db_container" "$new_app_container" >/dev/null 2>&1 || true
  for id in $(docker volume ls -q --filter "label=io.noosphere.pgvector-switch-run=$run_id"); do
    docker volume rm "$id" >/dev/null 2>&1 || true
  done
  if [[ -n ${interrupted_restore_volume:-} ]]; then
    docker volume rm "$interrupted_restore_volume" >/dev/null 2>&1 || true
  fi
  docker volume rm "$volume" "$probe_volume" "$authorization_volume" "$new_volume" "$new_authorization_volume" >/dev/null 2>&1 || true
  docker network rm "${project}_default" >/dev/null 2>&1 || true
  if [[ "$status" == 0 ]]; then
    rm -rf "$tmp_dir"
  else
    echo "Switch-test evidence retained after failure: $tmp_dir" >&2
    [[ ! -f "$log_file" ]] || tail -200 "$log_file" >&2
  fi
}
trap cleanup EXIT INT TERM

cat > "$compose_file" <<YAML
name: $project

services:
  db:
    image: $SOURCE_IMAGE
    platform: $PLATFORM
    container_name: $db_container
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_USER: noosphere
      POSTGRES_DB: noosphere
    volumes:
      - $volume:/var/lib/postgresql/data
      - $probe_volume:/var/lib/noosphere-a2b-mount-probe
    healthcheck:
      test: ["CMD-SHELL", "[ \"\$\$(cat /proc/1/comm 2>/dev/null)\" = postgres ] && [ \"\$\$(psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null)\" = 1 ]"]
      interval: 2s
      timeout: 2s
      retries: 60
  app:
    image: $SOURCE_IMAGE
    platform: $PLATFORM
    container_name: $app_container
    command: ["/bin/sh", "-ceu", "trap 'exit 0' TERM INT; while :; do sleep 1; done"]
    depends_on:
      db:
        condition: service_healthy

volumes:
  $volume:
    name: $volume
    driver: local
  $probe_volume:
    name: $probe_volume
    driver: local
YAML

docker compose -f "$compose_file" up -d
for _ in $(seq 1 180); do
  ready=$(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null || true)
  if [[ $(docker exec "$db_container" cat /proc/1/comm 2>/dev/null || true) == postgres && "$ready" == 1 ]]; then
    break
  fi
  [[ $(docker inspect "$db_container" --format '{{.State.Running}}' 2>/dev/null || true) == true ]] || {
    docker logs "$db_container" --tail 100 >&2 || true
    echo 'Fixture database exited before final readiness' >&2
    exit 1
  }
  sleep 1
done
[[ $(docker exec "$db_container" cat /proc/1/comm 2>/dev/null || true) == postgres ]]
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;') == 1 ]]

docker exec -i "$db_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere <<'SQL'
CREATE TABLE "_prisma_migrations" (
  migration_name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_steps_count integer NOT NULL,
  finished_at timestamptz,
  rolled_back_at timestamptz
);
INSERT INTO "_prisma_migrations"
  (migration_name, checksum, applied_steps_count, finished_at, rolled_back_at)
VALUES ('20260717_phase_a2b_fixture', 'fixture-checksum', 1, '2026-07-17 00:00:00+00', NULL);
CREATE TABLE "Topic" (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE "Article" (id text PRIMARY KEY, title text NOT NULL, "deletedAt" timestamptz);
CREATE TABLE "ApiKey" (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO "Topic" VALUES ('topic-1', 'Phase A2b');
INSERT INTO "Article" VALUES ('article-1', 'Guarded switch', NULL);
INSERT INTO "ApiKey" VALUES ('key-1', 'Fixture key');
SQL

switch_args=(
  --compose-file "$compose_file"
  --db-container "$db_container"
  --app-container "$app_container"
  --volume "$volume"
  --backup-dir "$backup_dir"
  --platform "$PLATFORM"
)

remote_log="$tmp_dir/remote-endpoint.log"
if DOCKER_HOST=tcp://127.0.0.1:1 \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" > "$remote_log" 2>&1; then
  echo 'Guarded switch accepted a remote Docker endpoint override' >&2
  exit 1
fi
[[ $(<"$remote_log") == *'refusing non-local Docker endpoint: tcp://127.0.0.1:1'* ]] || {
  cat "$remote_log" >&2
  echo 'Guarded switch did not fail at the remote Docker endpoint boundary' >&2
  exit 1
}

mount_log="$tmp_dir/mount-contract.log"
mount_backup="$tmp_dir/mount-contract-backups"
mkdir -m 700 "$mount_backup"
if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" \
  --compose-file "$compose_file" \
  --db-container "$db_container" \
  --app-container "$app_container" \
  --volume "$probe_volume" \
  --backup-dir "$mount_backup" \
  --platform "$PLATFORM" > "$mount_log" 2>&1; then
  echo 'Guarded switch accepted a named volume mounted outside PostgreSQL data' >&2
  exit 1
fi
[[ $(<"$mount_log") == *"must mount only named volume $probe_volume read-write at /var/lib/postgresql/data"* ]] || {
  cat "$mount_log" >&2
  echo 'Guarded switch did not fail at the PostgreSQL data-mount boundary' >&2
  exit 1
}
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]
docker start "$app_container" >/dev/null

# A legacy source Compose file cannot be promoted by image-line substitution
# alone. Refuse it before writing any transition journal or touching the source
# database, then let the caller publish the fail-closed target template.
legacy_gate_log="$tmp_dir/legacy-gate.log"
if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" > "$legacy_gate_log" 2>&1; then
  echo 'Guarded switch accepted a Compose file without candidate authorization' >&2
  exit 1
fi
[[ $(<"$legacy_gate_log") == *"Compose must contain the exact external authorization gate for $CANDIDATE_IMAGE"* ]]
[[ ! -f "$backup_dir/$volume.phase-a2b.json" ]]
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]
docker start "$app_container" >/dev/null

# Model an operator checking out the candidate revision while the existing
# exact-source container is still running. The guard must derive a restartable
# source desired state from this candidate-gated Compose file.
cat > "$compose_file" <<YAML
name: $project

services:
  db:
    image: $CANDIDATE_IMAGE
    platform: $PLATFORM
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/candidate-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != '$CANDIDATE_IMAGE' ]; then
            echo 'PostgreSQL candidate authorization is missing' >&2
            exit 78
          fi
          exec /usr/local/bin/docker-entrypoint.sh "\$\$@"
      - --
    command: ["postgres"]
    container_name: $db_container
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_USER: noosphere
      POSTGRES_DB: noosphere
    volumes:
      - $volume:/var/lib/postgresql/data
      - $probe_volume:/var/lib/noosphere-a2b-mount-probe
      - $authorization_volume:/run/noosphere-pgvector:ro
    healthcheck:
      test: ["CMD-SHELL", "[ \"\$\$(cat /proc/1/comm 2>/dev/null)\" = postgres ] && [ \"\$\$(psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null)\" = 1 ]"]
      interval: 2s
      timeout: 2s
      retries: 60
  app:
    image: $SOURCE_IMAGE
    platform: $PLATFORM
    container_name: $app_container
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/writer-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != '$CANDIDATE_IMAGE' ]; then
            echo 'Noosphere writer authorization is incomplete' >&2
            exit 78
          fi
          exec "\$\$@"
      - --
    command: ["/bin/sh", "-ceu", "trap 'exit 0' TERM INT; while :; do sleep 1; done"]
    volumes:
      - $authorization_volume:/run/noosphere-pgvector:ro
    depends_on:
      db:
        condition: service_healthy

volumes:
  $volume:
    name: $volume
    driver: local
  $probe_volume:
    name: $probe_volume
    driver: local
  $authorization_volume:
    name: $authorization_volume
    external: true
YAML

install -m "$(stat -c '%a' "$compose_file")" "$compose_file" "$target_compose"
journal="$backup_dir/$volume.phase-a2b.json"

# Kill after the earliest durable journal, before the normal app stop. A
# fault at the recovery writer boundary must prove the app is stopped while
# the exact source database remains online and untouched.
NOOSPHERE_A2B_PAUSE_AFTER_PHASE=preparing \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" > "$log_file" 2>&1 &
switch_pid=$!
for _ in $(seq 1 240); do
  rg -F 'test pause injected after journal phase preparing' "$log_file" >/dev/null 2>&1 && break
  kill -0 "$switch_pid" 2>/dev/null || {
    cat "$log_file" >&2
    echo 'Guarded switch exited before the preparing SIGKILL checkpoint' >&2
    exit 1
  }
  sleep 1
done
rg -F 'test pause injected after journal phase preparing' "$log_file" >/dev/null
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
kill -KILL "$switch_pid"
wait "$switch_pid" 2>/dev/null || true
[[ -f "$journal" && $(jq -r '.phase' "$journal") == preparing ]]
probe=$(jq -r '.probeDatabase' "$journal")

# Model a power loss after the claimed CREATE DATABASE but before DROP. The
# active journal is the durable ownership proof recovery requires.
docker exec "$db_container" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d postgres \
  -c "CREATE DATABASE \"$probe\" TEMPLATE template0;"
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d postgres \
  -c "SELECT count(*) FROM pg_database WHERE datname = '$probe';") == 1 ]]

# Simulate a kill during restore testing: recovery must remove the exact
# run-labeled volume containing a private logical-backup copy.
active_run=$(jq -r '.runId' "$journal")
interrupted_restore_volume="noosphere_a2b_restore_${active_run//-/_}"
docker volume create --driver local --label "io.noosphere.pgvector-switch-run=$active_run" \
  "$interrupted_restore_volume" >/dev/null
docker run --rm --network none --platform "$PLATFORM" \
  --mount "type=volume,source=$interrupted_restore_volume,target=/private-copy" \
  --entrypoint sh "$CANDIDATE_IMAGE" -ceu 'printf private-data > /private-copy/sentinel'

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=recovery-writer-stopped \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Recovery writer-boundary fault unexpectedly reported success' >&2
  exit 1
fi
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
[[ -f "$journal" && $(jq -r '.phase' "$journal") == preparing ]]

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=recovered \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Early recovered-journal checkpoint unexpectedly reported switch success' >&2
  exit 1
fi
[[ $(jq -r '.phase + "|" + .recoveredFromPhase' "$journal") == 'recovered|preparing' ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]

if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Preparing-journal recovery unexpectedly reported switch success' >&2
  exit 1
fi
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d postgres \
  -c "SELECT count(*) FROM pg_database WHERE datname = '$probe';") == 0 ]]
[[ ! -f "$journal" ]]
compgen -G "$journal.recovered-*" >/dev/null

# Republish the already-verified target gate before retrying. The recovered
# source marker keeps ordinary candidate startup blocked in this interval.
install -m "$(stat -c '%a' "$compose_file")" "$target_compose" "$compose_file"

# Prove that an untrappable SIGKILL leaves enough durable state for the next
# invocation to restore the exact source before any writer is restarted.
NOOSPHERE_A2B_PAUSE_AFTER_PHASE=candidate-authorized \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" > "$log_file" 2>&1 &
switch_pid=$!
for _ in $(seq 1 240); do
  if [[ -f "$journal" ]] && [[ $(jq -r '.phase' "$journal") == candidate-authorized ]]; then
    break
  fi
  kill -0 "$switch_pid" 2>/dev/null || {
    cat "$log_file" >&2
    echo 'Guarded switch exited before the SIGKILL checkpoint' >&2
    exit 1
  }
  sleep 1
done
[[ -f "$journal" && $(jq -r '.phase' "$journal") == candidate-authorized ]] || {
  cat "$log_file" >&2
  echo 'Timed out waiting for the SIGKILL checkpoint' >&2
  exit 1
}
other_backup="$tmp_dir/other-backups"
mkdir -m 700 "$other_backup"
if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" \
  --compose-file "$compose_file" \
  --db-container "$db_container" \
  --app-container "$app_container" \
  --volume "$volume" \
  --backup-dir "$other_backup" \
  --platform "$PLATFORM" >> "$log_file" 2>&1; then
  echo 'Concurrent switch with a different backup root bypassed the volume lock' >&2
  exit 1
fi
kill -KILL "$switch_pid"
wait "$switch_pid" 2>/dev/null || true

# Refuse inconsistent recovery evidence without starting either database image
# or any writer. Restore the byte-identical journal only inside this disposable
# test before exercising the legitimate recovery path.
saved_journal="$tmp_dir/journal.saved.json"
install -m 600 "$journal" "$saved_journal"
tampered_journal="$tmp_dir/journal.tampered.json"
jq '.originalComposeSha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$journal" > "$tampered_journal"
install -m 600 "$tampered_journal" "$journal"
if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Guarded switch accepted tampered crash-recovery evidence' >&2
  exit 1
fi
[[ -f "$journal" ]]
if docker inspect "$app_container" >/dev/null 2>&1; then
  [[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]
fi
install -m 600 "$saved_journal" "$journal"

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=recovered \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Recovery checkpoint fault unexpectedly reported switch success' >&2
  exit 1
fi
[[ $(jq -r '.phase' "$journal") == recovered ]]
! docker volume inspect "$interrupted_restore_volume" >/dev/null 2>&1
if docker inspect "$app_container" >/dev/null 2>&1; then
  [[ $(docker inspect "$app_container" --format '{{.State.Running}}') == false ]]
fi
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
[[ $(docker run --rm --network none --platform "$PLATFORM" \
  --mount "type=volume,source=$authorization_volume,target=/authorization,readonly" \
  --mount type=tmpfs,destination=/var/lib/postgresql/data \
  --entrypoint sh "$CANDIDATE_IMAGE" -ceu 'cat /authorization/candidate-authorized 2>/dev/null || true') == "$SOURCE_IMAGE" ]]
[[ $(docker run --rm --network none --platform "$PLATFORM" \
  --mount "type=volume,source=$authorization_volume,target=/authorization,readonly" \
  --mount type=tmpfs,destination=/var/lib/postgresql/data \
  --entrypoint sh "$CANDIDATE_IMAGE" -ceu 'cat /authorization/writer-authorized 2>/dev/null || true') == "$SOURCE_IMAGE" ]]
[[ $(docker compose -f "$compose_file" config --format json | jq -r '.services.db.image') == "$SOURCE_IMAGE" ]]
rg -F "actual\" != '$SOURCE_IMAGE'" "$compose_file" >/dev/null

# The restored source gate must remain restartable after recovery. This catches
# a crash-safe marker change that would otherwise strand the source on its next
# ordinary Compose restart.
docker stop --time 60 "$db_container" >/dev/null
docker rm "$db_container" >/dev/null
docker compose -f "$compose_file" up -d db
for _ in $(seq 1 180); do
  [[ $(docker inspect "$db_container" --format '{{.State.Health.Status}}' 2>/dev/null || true) == healthy ]] && break
  sleep 1
done
[[ $(docker inspect "$db_container" --format '{{.State.Health.Status}}') == healthy ]]

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=recovery-writer-restarted \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Recovery post-restart checkpoint unexpectedly reported switch success' >&2
  exit 1
fi
[[ $(jq -r '.phase' "$journal") == recovered ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c \
  "INSERT INTO \"Topic\" VALUES ('topic-recovery-write', 'Write after recovered handoff');" >/dev/null

if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1; then
  echo 'Recovery invocation unexpectedly reported switch success' >&2
  exit 1
fi
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
[[ $(docker exec "$db_container" psql -XAtq -U noosphere -d noosphere -c \
  "SELECT count(*) FROM \"Topic\" WHERE id = 'topic-recovery-write';") == 1 ]]
docker inspect "$app_container" | jq -e --arg source "$SOURCE_IMAGE" '
  .[0].Config.Entrypoint | any(type == "string" and contains("writer-authorized") and contains($source))
' >/dev/null
[[ ! -f "$journal" ]]
compgen -G "$journal.recovered-*" >/dev/null

install -m "$(stat -c '%a' "$compose_file")" "$target_compose" "$compose_file"
"$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1
[[ $(jq -r '.phase' "$journal") == complete ]]
[[ $(jq -r '.authorizationVolume' "$journal") == "$authorization_volume" ]]
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$CANDIDATE_IMAGE" ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
[[ $(docker compose -f "$compose_file" config --format json | jq -r '.services.db.image') == "$CANDIDATE_IMAGE" ]]
[[ $(docker exec "$db_container" cat /run/noosphere-pgvector/writer-authorized) == "$CANDIDATE_IMAGE" ]]
docker inspect "$app_container" | jq -e --arg candidate "$CANDIDATE_IMAGE" '
  .[0].Config.Entrypoint | any(type == "string" and contains("writer-authorized") and contains($candidate))
' >/dev/null

# Completed evidence is tied to the immutable volume fingerprint, not to stale
# application row counts: legitimate writes after commit must not be rolled back.
docker exec "$db_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c \
  "INSERT INTO \"Topic\" VALUES ('topic-2', 'Post-commit write');" >/dev/null
"$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${switch_args[@]}" >> "$log_file" 2>&1
[[ $(docker exec "$db_container" psql -XAtq -U noosphere -d noosphere -c 'SELECT count(*) FROM "Topic";') == 3 ]]

# A candidate that already contains an upgraded source volume cannot be blessed
# as a new install without a durable absent-volume claim.
unclaimed_backup="$tmp_dir/unclaimed-new-install"
mkdir -m 700 "$unclaimed_backup"
if "$ROOT_DIR/scripts/switch-pgvector-compose.sh" --record-new-install \
  --compose-file "$compose_file" \
  --db-container "$db_container" \
  --app-container "$app_container" \
  --volume "$volume" \
  --backup-dir "$unclaimed_backup" \
  --platform "$PLATFORM" >> "$log_file" 2>&1; then
  echo 'New-install finalization blessed a pre-existing candidate volume' >&2
  exit 1
fi

# Exercise every fresh-install crash boundary with a distinct absent volume.
new_compose_file="$tmp_dir/docker-compose-new-install.yml"
new_install_backup="$tmp_dir/new-install-evidence"
mkdir -m 700 "$new_install_backup"
cat > "$new_compose_file" <<YAML
name: $project-new

services:
  db:
    image: $CANDIDATE_IMAGE
    platform: $PLATFORM
    container_name: $new_db_container
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/candidate-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != '$CANDIDATE_IMAGE' ]; then
            echo 'PostgreSQL candidate authorization is missing' >&2
            exit 78
          fi
          exec /usr/local/bin/docker-entrypoint.sh "\$\$@"
      - --
    command: ["postgres"]
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
      POSTGRES_USER: noosphere
      POSTGRES_DB: noosphere
    volumes:
      - $new_volume:/var/lib/postgresql/data
      - $new_authorization_volume:/run/noosphere-pgvector:ro
  app:
    image: $CANDIDATE_IMAGE
    platform: $PLATFORM
    container_name: $new_app_container
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/writer-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != '$CANDIDATE_IMAGE' ]; then
            echo 'Noosphere writer authorization is incomplete' >&2
            exit 78
          fi
          exec "\$\$@"
      - --
    command: ["/bin/sh", "-ceu", "trap 'exit 0' TERM INT; while :; do sleep 1; done"]
    volumes:
      - $new_authorization_volume:/run/noosphere-pgvector:ro
    depends_on:
      - db

volumes:
  $new_volume:
    name: $new_volume
    driver: local
  $new_authorization_volume:
    name: $new_authorization_volume
    external: true

networks:
  default:
    name: ${project}_default
    external: true
YAML

# The checked-in candidate shape refuses ordinary Compose startup before the
# external guard-created authorization volume exists.
new_gate_log="$tmp_dir/new-install-gate.log"
if docker compose -f "$new_compose_file" up -d db > "$new_gate_log" 2>&1; then
  echo 'Candidate Compose started without guarded volume authorization' >&2
  exit 1
fi
rg -F "external volume \"$new_authorization_volume\" not found" "$new_gate_log" >/dev/null
docker rm -f "$new_db_container" >/dev/null 2>&1 || true
docker volume rm "$new_volume" >/dev/null 2>&1 || true

new_install_args=(
  --compose-file "$new_compose_file"
  --db-container "$new_db_container"
  --app-container "$new_app_container"
  --volume "$new_volume"
  --backup-dir "$new_install_backup"
  --platform "$PLATFORM"
)
new_install_journal="$new_install_backup/$new_volume.phase-a2b.json"

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=claim-created \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" --prepare-new-install "${new_install_args[@]}" >> "$log_file" 2>&1; then
  echo 'New-install preparation ignored the durable-claim fault injection' >&2
  exit 1
fi
[[ $(jq -r '.phase + "|" + .mode' "$new_install_journal") == 'claim-created|new-install' ]]
if docker volume inspect "$new_volume" >/dev/null 2>&1; then
  echo 'New-install volume was created before its durable claim checkpoint' >&2
  exit 1
fi

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=new-install-volume-created \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" --prepare-new-install "${new_install_args[@]}" >> "$log_file" 2>&1; then
  echo 'New-install preparation ignored the post-volume-create fault injection' >&2
  exit 1
fi
[[ $(jq -r '.phase' "$new_install_journal") == claim-created ]]
[[ $(docker volume inspect "$new_volume" --format "{{index .Labels \"io.noosphere.pgvector-new-install-run\"}}") == \
   "$(jq -r '.runId' "$new_install_journal")" ]]

if NOOSPHERE_A2B_FAIL_AFTER_PHASE=new-install-authorization-created \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" --prepare-new-install "${new_install_args[@]}" >> "$log_file" 2>&1; then
  echo 'New-install preparation ignored the post-authorization fault injection' >&2
  exit 1
fi
[[ $(jq -r '.phase' "$new_install_journal") == claim-created ]]
[[ $(docker volume inspect "$new_authorization_volume" --format "{{index .Labels \"io.noosphere.pgvector-authorization-run\"}}") == \
   "$(jq -r '.runId' "$new_install_journal")" ]]

"$ROOT_DIR/scripts/switch-pgvector-compose.sh" --prepare-new-install "${new_install_args[@]}" >> "$log_file" 2>&1
[[ $(jq -r '.phase + "|" + .mode + "|" + .platform' "$new_install_journal") == "provisioning|new-install|$PLATFORM" ]]
[[ $(jq -r '.authorizationVolume' "$new_install_journal") == "$new_authorization_volume" ]]

docker compose -f "$new_compose_file" up -d db
for _ in $(seq 1 180); do
  ready=$(docker exec "$new_db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null || true)
  if [[ $(docker exec "$new_db_container" cat /proc/1/comm 2>/dev/null || true) == postgres && "$ready" == 1 ]]; then
    break
  fi
  [[ $(docker inspect "$new_db_container" --format '{{.State.Running}}' 2>/dev/null || true) == true ]] || {
    docker logs "$new_db_container" --tail 100 >&2 || true
    echo 'Fresh-install candidate exited before final readiness' >&2
    exit 1
  }
  sleep 1
done
[[ $(docker exec "$new_db_container" cat /proc/1/comm) == postgres ]]
[[ $(docker exec "$new_db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;') == 1 ]]

docker exec -i "$new_db_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere <<'SQL'
CREATE TABLE "_prisma_migrations" (
  migration_name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_steps_count integer NOT NULL,
  finished_at timestamptz,
  rolled_back_at timestamptz
);
INSERT INTO "_prisma_migrations"
  (migration_name, checksum, applied_steps_count, finished_at, rolled_back_at)
VALUES ('20260717_phase_a2b_new_install', 'new-install-checksum', 1, '2026-07-17 00:00:00+00', NULL);
CREATE TABLE "Topic" (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO "Topic" VALUES ('new-topic-1', 'Fresh candidate');
SQL

# Direct Compose may create the app container, but the missing completion marker
# must make its entrypoint fail before any writer starts.
docker compose -f "$new_compose_file" up -d app >> "$log_file" 2>&1 || true
for _ in $(seq 1 30); do
  if docker inspect "$new_app_container" >/dev/null 2>&1 &&
     [[ $(docker inspect "$new_app_container" --format '{{.State.Running}}') == false ]]; then
    break
  fi
  sleep 1
done
[[ $(docker inspect "$new_app_container" --format '{{.State.Running}}') == false ]]
[[ $(docker inspect "$new_app_container" --format '{{.State.ExitCode}}') == 78 ]]
if docker exec "$new_db_container" test -e /run/noosphere-pgvector/writer-authorized; then
  echo 'Writer authorization existed before new-install completion' >&2
  exit 1
fi

# A crash after the durable complete journal but before writer authorization is
# resumable and remains fail closed.
if NOOSPHERE_A2B_FAIL_AFTER_PHASE=complete \
  "$ROOT_DIR/scripts/switch-pgvector-compose.sh" --record-new-install "${new_install_args[@]}" >> "$log_file" 2>&1; then
  echo 'New-install finalization ignored the complete-journal fault injection' >&2
  exit 1
fi
[[ $(jq -r '.phase + "|" + .mode + "|" + .platform' "$new_install_journal") == "complete|new-install|$PLATFORM" ]]
if docker exec "$new_db_container" test -e /run/noosphere-pgvector/writer-authorized; then
  echo 'Writer authorization was published after an interrupted completion' >&2
  exit 1
fi

"$ROOT_DIR/scripts/switch-pgvector-compose.sh" --record-new-install "${new_install_args[@]}" >> "$log_file" 2>&1
[[ $(docker exec "$new_db_container" cat /run/noosphere-pgvector/writer-authorized) == "$CANDIDATE_IMAGE" ]]
docker compose -f "$new_compose_file" up -d app
for _ in $(seq 1 30); do
  [[ $(docker inspect "$new_app_container" --format '{{.State.Running}}') == true ]] && break
  sleep 1
done
[[ $(docker inspect "$new_app_container" --format '{{.State.Running}}') == true ]]
"$ROOT_DIR/scripts/switch-pgvector-compose.sh" "${new_install_args[@]}" >> "$log_file" 2>&1
[[ $(docker inspect "$new_app_container" --format '{{.State.Running}}') == true ]]

printf 'PostgreSQL Compose switch test passed: platform=%s journal=%s\n' "$PLATFORM" "$journal"
