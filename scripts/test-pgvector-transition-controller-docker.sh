#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTROLLER_SOURCE="$ROOT_DIR/scripts/run-pgvector-transition-controller.sh"
GUARD_SOURCE="$ROOT_DIR/scripts/switch-pgvector-compose.sh"
VERIFIER_SOURCE="$ROOT_DIR/scripts/verify-deploy.sh"

cleanup_state_authority_record() {
  local runtime_root=$1 authority=$2
  case "$authority" in
    "$runtime_root"/noosphere-pgvector-state-*.json) ;;
    *) echo "Refusing unexpected rehearsal authority path: $authority" >&2; return 1 ;;
  esac
  if [[ -e "$authority" ]]; then
    [[ -f "$authority" && ! -L "$authority" ]] || {
      echo "Rehearsal authority record is not a safe regular file: $authority" >&2
      return 1
    }
    rm -f -- "$authority"
  fi
  [[ ! -e "$authority" ]] || {
    echo "Rehearsal authority record remains after cleanup: $authority" >&2
    return 1
  }
}

PLATFORM=${1:-linux/amd64}
SOURCE_IMAGE='postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
CANDIDATE_IMAGE='ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292'

[[ "$PLATFORM" == linux/amd64 ]] || {
  echo 'The controller Docker rehearsal currently supports linux/amd64 only.' >&2
  exit 1
}
for path in "$CONTROLLER_SOURCE" "$GUARD_SOURCE" "$VERIFIER_SOURCE"; do
  [[ -x "$path" && -f "$path" && ! -L "$path" ]] || {
    echo "Required executable is missing or unsafe: $path" >&2
    exit 1
  }
done
for command in curl docker jq loginctl python3 sha256sum systemctl systemd-run; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done
systemctl --user show-environment >/dev/null
[[ $(loginctl show-user "$(id -u)" -p Linger --value) == yes ]] || {
  echo 'Persistent user manager is required for the controller Docker rehearsal.' >&2
  exit 1
}
docker image inspect "$SOURCE_IMAGE" >/dev/null
docker image inspect "$CANDIDATE_IMAGE" >/dev/null

run_id="controller-docker-$BASHPID-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
safe_id=${run_id//[^A-Za-z0-9]/-}
safe_id=${safe_id,,}
project="noosphere-a2b-$safe_id"
db_container="$project-db"
app_container="$project-app"
volume="noosphere_a2b_${safe_id//-/_}"
probe_volume="${volume}_mount_probe"
authorization_volume="${volume}_authorization"
tmp_dir=$(mktemp -d)
# Isolate durable state-authority records from the invoking user's real XDG
# state namespace; the controller honors XDG_STATE_HOME, so the rehearsal's
# durable claims live inside the disposable tmp_dir and are removed with it.
XDG_STATE_HOME="$tmp_dir/xdg-state-home"
install -d -m 700 "$XDG_STATE_HOME"
export XDG_STATE_HOME
live_compose="$tmp_dir/docker-compose.yml"
source_snapshot="$tmp_dir/source-compose.yml"
candidate_compose="$tmp_dir/candidate-compose.yml"
env_file="$tmp_dir/runtime.env"
backup_dir="$tmp_dir/backups"
controller_home="$tmp_dir/home"
manifest="$tmp_dir/manifest.json"
state="$tmp_dir/controller.json"
unit_base="noosphere-pgvector-controller-docker-$BASHPID-$RANDOM"
unit="$unit_base.service"
interruption_runner_pid=''
recovery_state="$tmp_dir/recovery-incident.json"
runtime_root=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
docker_path=$(command -v docker)
compose_plugin_path=$(docker info --format '{{json .ClientInfo.Plugins}}' |
  jq -er '[.[] | select(.Name == "compose") | .Path] | if length == 1 then .[0] else error("Compose plugin identity is ambiguous") end')
engine_id=$(docker info --format '{{.ID}}')
docker_context=$(docker context show)
docker_endpoint=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}')
docker_endpoint="unix://$(realpath -m "${docker_endpoint#unix://}")"
lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
lock_path="$runtime_root/noosphere-pgvector-switch-$lock_key.lock"
state_authority_path="$runtime_root/noosphere-pgvector-state-$lock_key.json"
app_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
app_url="http://127.0.0.1:$app_port"
guard_run_id=''

mkdir -m 700 "$backup_dir" "$controller_home" "$controller_home/docker"
printf 'NOOSPHERE_STAGE6B=1\n' > "$env_file"
printf '{}\n' > "$controller_home/docker/config.json"
chmod 0600 "$env_file" "$controller_home/docker/config.json"

unit_load_state() {
  local queried_unit=${1:-$unit}
  systemctl --user show "$queried_unit" -p LoadState --value 2>/dev/null || printf 'not-found\n'
}

cleanup_successfully() {
  local id
  if [[ -f "$backup_dir/$volume.phase-a2b.json" ]]; then
    guard_run_id=$(jq -r '.runId // empty' "$backup_dir/$volume.phase-a2b.json")
  fi
  if [[ $(unit_load_state) != not-found ]]; then
    systemctl --user stop "$unit"
  fi
  if [[ -n "$guard_run_id" ]]; then
    while IFS= read -r id; do
      [[ -z "$id" ]] || docker rm -f "$id" >/dev/null
    done < <(docker ps -aq --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id")
    while IFS= read -r id; do
      [[ -z "$id" ]] || docker volume rm "$id" >/dev/null
    done < <(docker volume ls -q --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id")
  fi
  docker compose --env-file "$env_file" -f "$live_compose" down --remove-orphans --volumes >/dev/null
  for id in "$db_container" "$app_container"; do
    docker container inspect "$id" >/dev/null 2>&1 || continue
    docker rm -f "$id" >/dev/null
  done
  for id in "$volume" "$probe_volume" "$authorization_volume"; do
    docker volume inspect "$id" >/dev/null 2>&1 || continue
    docker volume rm "$id" >/dev/null
  done
  if docker network inspect "${project}_default" >/dev/null 2>&1; then
    docker network rm "${project}_default" >/dev/null
  fi
  case "$lock_path" in
    "$runtime_root"/noosphere-pgvector-switch-*.lock) rm -f -- "$lock_path" ;;
    *) echo "Refusing unexpected fixture lock path: $lock_path" >&2; return 1 ;;
  esac
  cleanup_state_authority_record "$runtime_root" "$state_authority_path"
}

verify_zero_residue() {
  local id
  [[ $(unit_load_state) == not-found ]] || {
    echo "Transient rehearsal unit remains after cleanup: $unit" >&2
    return 1
  }
  for id in "$db_container" "$app_container"; do
    ! docker container inspect "$id" >/dev/null 2>&1 || {
      echo "Controller rehearsal container remains after cleanup: $id" >&2
      return 1
    }
  done
  for id in "$volume" "$probe_volume" "$authorization_volume"; do
    ! docker volume inspect "$id" >/dev/null 2>&1 || {
      echo "Controller rehearsal volume remains after cleanup: $id" >&2
      return 1
    }
  done
  ! docker network inspect "${project}_default" >/dev/null 2>&1 || {
    echo "Controller rehearsal network remains after cleanup: ${project}_default" >&2
    return 1
  }
  if [[ -n "$guard_run_id" ]]; then
    [[ -z $(docker ps -aq --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id") ]] || {
      echo "Guard-labeled container residue remains for run $guard_run_id" >&2
      return 1
    }
    [[ -z $(docker volume ls -q --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id") ]] || {
      echo "Guard-labeled volume residue remains for run $guard_run_id" >&2
      return 1
    }
  fi
  [[ ! -e "$lock_path" ]] || {
    echo "Controller rehearsal lock remains after cleanup: $lock_path" >&2
    return 1
  }
  [[ ! -e "$state_authority_path" ]] || {
    echo "Controller rehearsal authority remains after cleanup: $state_authority_path" >&2
    return 1
  }
}

cleanup() {
  local status=$? id
  trap - EXIT INT TERM
  if [[ -f "$backup_dir/$volume.phase-a2b.json" ]]; then
    guard_run_id=$(jq -r '.runId // empty' "$backup_dir/$volume.phase-a2b.json" 2>/dev/null || true)
  fi
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  [[ -z "$interruption_runner_pid" ]] || wait "$interruption_runner_pid" >/dev/null 2>&1 || true
  if [[ -n "$guard_run_id" ]]; then
    for id in $(docker ps -aq --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id"); do
      docker rm -f "$id" >/dev/null 2>&1 || true
    done
    for id in $(docker volume ls -q --filter "label=io.noosphere.pgvector-switch-run=$guard_run_id"); do
      docker volume rm "$id" >/dev/null 2>&1 || true
    done
  fi
  if [[ -f "$live_compose" ]]; then
    docker compose --env-file "$env_file" -f "$live_compose" down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker rm -f "$db_container" "$app_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$probe_volume" "$authorization_volume" >/dev/null 2>&1 || true
  docker network rm "${project}_default" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  [[ "$lock_path" == "$runtime_root"/noosphere-pgvector-switch-*.lock ]] && rm -f -- "$lock_path"
  cleanup_state_authority_record "$runtime_root" "$state_authority_path" || {
    echo "Controller Docker rehearsal authority cleanup failed." >&2
    status=1
  }
  if ((status == 0)); then
    case "$tmp_dir" in
      /tmp/tmp.*)
        rm -rf -- "$tmp_dir"
        # The isolated durable-authority root lives inside tmp_dir, so its
        # removal must actually land before the rehearsal counts as clean.
        [[ ! -e "$tmp_dir" ]] || {
          echo "Controller rehearsal state root remains after cleanup: $tmp_dir" >&2
          return 1
        }
        ;;
      *) echo "Refusing unexpected fixture cleanup path: $tmp_dir" >&2; return 1 ;;
    esac
  else
    echo "Controller Docker rehearsal evidence retained after failure: $tmp_dir" >&2
    [[ ! -f "${state%.json}.guard.stderr.log" ]] || tail -100 "${state%.json}.guard.stderr.log" >&2
    [[ ! -f "${state%.json}.verify.stderr.log" ]] || tail -100 "${state%.json}.verify.stderr.log" >&2
  fi
  return "$status"
}
trap cleanup EXIT INT TERM

[[ $(unit_load_state) == not-found ]] || {
  echo "Transient rehearsal unit already exists: $unit" >&2
  exit 1
}

# Model the intended installed-artifact execution boundary instead of binding
# mutable checkout artifacts directly. Shared Git repositories commonly create
# executable files as 0775 under umask 0002. The current public installer stages
# the guard and verifier, while controller integration remains downstream Task 7;
# this rehearsal pre-stages all three verified bytes with private modes so the
# controller boundary itself is deterministic without claiming installer coverage.
execution_artifact_dir="$tmp_dir/execution-artifacts"
install -d -m 700 "$execution_artifact_dir"
CONTROLLER="$execution_artifact_dir/run-pgvector-transition-controller.sh"
GUARD="$execution_artifact_dir/switch-pgvector-compose.sh"
VERIFIER="$execution_artifact_dir/verify-deploy.sh"
install -m 700 "$CONTROLLER_SOURCE" "$CONTROLLER"
install -m 700 "$GUARD_SOURCE" "$GUARD"
install -m 700 "$VERIFIER_SOURCE" "$VERIFIER"

for path in "$CONTROLLER" "$GUARD" "$VERIFIER"; do
  mode=$(stat -c '%a' "$path")
  [[ -x "$path" && -f "$path" && ! -L "$path" ]] || {
    echo "Installed execution artifact is missing or unsafe: $path" >&2
    exit 1
  }
  [[ $(stat -c '%u' "$path") == "$(id -u)" ]] || {
    echo "Installed execution artifact has the wrong owner: $path" >&2
    exit 1
  }
  (( (8#$mode & 8#022) == 0 )) || {
    echo "Installed execution artifact permits group/world writes: $path" >&2
    exit 1
  }
done
cmp -s "$CONTROLLER_SOURCE" "$CONTROLLER"
cmp -s "$GUARD_SOURCE" "$GUARD"
cmp -s "$VERIFIER_SOURCE" "$VERIFIER"

cat > "$live_compose" <<YAML
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
    user: "1001:1001"
    container_name: $app_container
    command:
      - /bin/sh
      - -ceu
      - |
          cat > /tmp/noosphere-health-handler.sh <<'HANDLER'
          #!/bin/sh
          printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"status":"ok"}\n'
          HANDLER
          chmod 0700 /tmp/noosphere-health-handler.sh
          exec nc -lk -p 8080 -e /tmp/noosphere-health-handler.sh
    ports:
      - "127.0.0.1:$app_port:8080"
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
install -m 600 "$live_compose" "$source_snapshot"

cat > "$candidate_compose" <<YAML
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
    user: "1001:1001"
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
    command:
      - /bin/sh
      - -ceu
      - |
          cat > /tmp/noosphere-health-handler.sh <<'HANDLER'
          #!/bin/sh
          printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"status":"ok"}\n'
          HANDLER
          chmod 0700 /tmp/noosphere-health-handler.sh
          exec nc -lk -p 8080 -e /tmp/noosphere-health-handler.sh
    ports:
      - "127.0.0.1:$app_port:8080"
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
chmod 0600 "$live_compose" "$source_snapshot" "$candidate_compose"

docker compose --env-file "$env_file" -f "$live_compose" up -d
for _ in $(seq 1 180); do
  ready=$(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null || true)
  [[ "$ready" == 1 ]] && break
  [[ $(docker inspect "$db_container" --format '{{.State.Running}}' 2>/dev/null || true) == true ]] || {
    docker logs "$db_container" --tail 100 >&2 || true
    echo 'Disposable source database exited before readiness.' >&2
    exit 1
  }
  sleep 1
done
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;') == 1 ]]
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 "$app_url/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS --max-time 5 "$app_url/api/health" >/dev/null

docker exec -i "$db_container" psql -X -v ON_ERROR_STOP=1 -U noosphere -d noosphere <<'SQL'
CREATE ROLE noosphere_migrator LOGIN NOSUPERUSER;
ALTER DATABASE noosphere OWNER TO noosphere_migrator;
ALTER SCHEMA public OWNER TO noosphere_migrator;
SET ROLE noosphere_migrator;
CREATE TABLE "_prisma_migrations" (
  migration_name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_steps_count integer NOT NULL,
  finished_at timestamptz,
  rolled_back_at timestamptz
);
INSERT INTO "_prisma_migrations"
  (migration_name, checksum, applied_steps_count, finished_at, rolled_back_at)
VALUES ('20260811_controller_stage6b', 'controller-stage6b-checksum', 1, '2026-08-11 00:00:00+00', NULL);
CREATE TABLE "Topic" (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE "Article" (id text PRIMARY KEY, title text NOT NULL, "deletedAt" timestamptz);
CREATE TABLE "ApiKey" (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO "Topic" VALUES ('topic-1', 'Controller Stage 6B');
INSERT INTO "Article" VALUES ('article-1', 'Pinned guard rehearsal', NULL);
INSERT INTO "ApiKey" VALUES ('key-1', 'Fixture key');
CREATE TABLE "MemoryCapture" (
  id text PRIMARY KEY,
  "userText" text NOT NULL,
  "assistantText" text NOT NULL,
  CONSTRAINT "MemoryCapture_bounded_content"
    CHECK (
      octet_length("userText") BETWEEN 1 AND 12000
      AND octet_length("assistantText") BETWEEN 1 AND 12000
      AND octet_length("userText") + octet_length("assistantText") <= 20000
    )
);
INSERT INTO "MemoryCapture" VALUES ('capture-1', 'fixture user text', 'fixture assistant text');
RESET ROLE;
SQL

guard_journal="$backup_dir/$volume.phase-a2b.json"
docker_compose_version_sha=$(docker compose version --short | sha256sum | awk '{print $1}')
effective_compose_sha=$(docker compose --env-file "$env_file" -f "$candidate_compose" config --no-interpolate | sha256sum | awk '{print $1}')

jq -n \
  --arg engineId "$engine_id" \
  --arg dockerEndpoint "$docker_endpoint" \
  --arg volume "$volume" \
  --arg liveCompose "$live_compose" \
  --arg sourceSnapshot "$source_snapshot" \
  --arg sourceSnapshotSha256 "$(sha256sum "$source_snapshot" | awk '{print $1}')" \
  --arg candidateCompose "$candidate_compose" \
  --arg candidateComposeSha256 "$(sha256sum "$candidate_compose" | awk '{print $1}')" \
  --arg envFile "$env_file" \
  --arg envFileSha256 "$(sha256sum "$env_file" | awk '{print $1}')" \
  --arg guard "$GUARD" \
  --arg guardSha256 "$(sha256sum "$GUARD" | awk '{print $1}')" \
  --arg controllerPath "$(realpath "$CONTROLLER")" \
  --arg controllerSha256 "$(sha256sum "$CONTROLLER" | awk '{print $1}')" \
  --arg verifier "$VERIFIER" \
  --arg verifierSha256 "$(sha256sum "$VERIFIER" | awk '{print $1}')" \
  --arg dockerPath "$docker_path" \
  --arg dockerSha256 "$(sha256sum "$docker_path" | awk '{print $1}')" \
  --arg dockerComposeVersionSha256 "$docker_compose_version_sha" \
  --arg composePluginPath "$compose_plugin_path" \
  --arg composePluginSha256 "$(sha256sum "$compose_plugin_path" | awk '{print $1}')" \
  --arg dockerConfigSha256 "$(sha256sum "$controller_home/docker/config.json" | awk '{print $1}')" \
  --arg effectiveComposeSha256 "$effective_compose_sha" \
  --arg backupDir "$backup_dir" \
  --arg lockRoot "$runtime_root" \
  --arg controllerHome "$controller_home" \
  --arg dbContainer "$db_container" \
  --arg appContainer "$app_container" \
  --arg authorizationVolume "$authorization_volume" \
  --arg guardJournal "$guard_journal" \
  --arg appUrl "$app_url" \
  --arg platform "$PLATFORM" '
    {
      version:1, phase:"prepared", engineId:$engineId,
      dockerEndpoint:$dockerEndpoint, volume:$volume,
      liveCompose:$liveCompose, sourceSnapshot:$sourceSnapshot,
      sourceSnapshotSha256:$sourceSnapshotSha256,
      candidateCompose:$candidateCompose, candidateComposeSha256:$candidateComposeSha256,
      envFile:$envFile, envFileSha256:$envFileSha256,
      guard:$guard, guardSha256:$guardSha256,
      controllerPath:$controllerPath, controllerSha256:$controllerSha256,
      guardArgs:[
        "--compose-file",$liveCompose,
        "--env-file",$envFile,
        "--db-container",$dbContainer,
        "--app-container",$appContainer,
        "--volume",$volume,
        "--authorization-volume",$authorizationVolume,
        "--backup-dir",$backupDir,
        "--platform",$platform,
        "--defer-app-restart"
      ],
      verifier:$verifier, verifierSha256:$verifierSha256,
      dockerPath:$dockerPath, dockerSha256:$dockerSha256,
      dockerComposeVersionSha256:$dockerComposeVersionSha256,
      composePluginPath:$composePluginPath, composePluginSha256:$composePluginSha256,
      dockerConfigSha256:$dockerConfigSha256,
      effectiveComposeSha256:$effectiveComposeSha256,
      backupDir:$backupDir, lockRoot:$lockRoot, controllerHome:$controllerHome,
      fixedPath:"/usr/local/bin:/usr/bin:/bin",
      dbContainer:$dbContainer, appContainer:$appContainer,
      authorizationVolume:$authorizationVolume, platform:$platform,
      guardJournal:$guardJournal, appUrl:$appUrl
    }
  ' > "$manifest"
chmod 0600 "$manifest"

"$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
cmp -s "$live_compose" "$source_snapshot"

# Interrupt a real pinned-guard invocation after candidate publication while
# its guard process group is stopped. TERM is delivered to the systemd MainPID,
# forwarded by the controller, and released with CONT so the child is reaped
# and its truthful interrupted evidence becomes durable.
interruption_args=(
  systemd-run
  --user
  --unit="$unit_base"
  --wait
  --collect
  --quiet
  --setenv="CONTROLLER_UNIT=$unit"
  --setenv="XDG_STATE_HOME=$XDG_STATE_HOME"
)
while IFS= read -r property; do
  interruption_args+=(--property="$property")
done < <(bash -c 'source "$1"; systemd_properties "$2"' -- "$CONTROLLER" "$tmp_dir")
interruption_args+=("$CONTROLLER" --execute --state "$state")
"${interruption_args[@]}" >"$tmp_dir/interruption.out" 2>"$tmp_dir/interruption.err" &
interruption_runner_pid=$!

controller_main_pid=''
guard_process_group=''
for _ in $(seq 1 1200); do
  controller_main_pid=$(systemctl --user show "$unit" -p MainPID --value 2>/dev/null || true)
  if [[ "$controller_main_pid" =~ ^[1-9][0-9]*$ &&
        $(jq -r '.phase // empty' "$state" 2>/dev/null || true) == candidate-published ]]; then
    children_path="/proc/$controller_main_pid/task/$controller_main_pid/children"
    if [[ -r "$children_path" ]]; then
      for child_pid in $(<"$children_path"); do
        child_pgid=$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ' || true)
        if [[ "$child_pgid" == "$child_pid" ]]; then
          guard_process_group=$child_pgid
          break 2
        fi
      done
    fi
  fi
  sleep 0.01
done
[[ "$guard_process_group" =~ ^[1-9][0-9]*$ ]] || {
  echo 'Real-Docker interruption rehearsal did not capture the pinned guard process group.' >&2
  exit 1
}
kill -STOP -- "-$guard_process_group"
systemctl --user kill --kill-whom=main --signal=TERM "$unit"
kill -CONT -- "-$guard_process_group"
interruption_rc=0
wait "$interruption_runner_pid" || interruption_rc=$?
interruption_runner_pid=''
[[ "$interruption_rc" == 143 ]] || {
  echo "Interrupted real-Docker controller exited $interruption_rc instead of 143." >&2
  exit 1
}
jq -e '
  .phase == "guard-exited" and
  .lastInterruption.signal == "TERM" and
  (.guardEvidence.sha256 | test("^[a-f0-9]{64}$"))
' "$state" >/dev/null
for _ in $(seq 1 100); do
  [[ $(unit_load_state) == not-found ]] && break
  sleep 0.05
done
[[ $(unit_load_state) == not-found ]] || {
  echo "Interrupted transient rehearsal unit still exists after --collect: $unit" >&2
  exit 1
}

# A second real transient invocation owns recovery. With no completed guard
# journal, guard-exited recovery verifies the source database, restores the
# prepared source Compose bytes, and commits a terminal recovery incident.
unit_base="noosphere-pgvector-controller-docker-recovery-$BASHPID-$RANDOM"
unit="$unit_base.service"
recovery_args=(
  systemd-run
  --user
  --unit="$unit_base"
  --wait
  --collect
  --quiet
  --setenv="CONTROLLER_UNIT=$unit"
  --setenv="XDG_STATE_HOME=$XDG_STATE_HOME"
)
while IFS= read -r property; do
  recovery_args+=(--property="$property")
done < <(bash -c 'source "$1"; systemd_properties "$2"' -- "$CONTROLLER" "$tmp_dir")
recovery_args+=("$CONTROLLER" --execute --state "$state")
recovery_rc=0
"${recovery_args[@]}" >"$tmp_dir/recovery.out" 2>"$tmp_dir/recovery.err" || recovery_rc=$?
[[ "$recovery_rc" != 0 ]] || {
  echo 'Interrupted real-Docker controller unexpectedly reported recovery as transition success.' >&2
  exit 1
}
jq -e '
  .phase == "incident" and
  .incidentClass == "pre-journal-source-restored" and
  (.sourceRecoveryEvidence.sha256 | test("^[a-f0-9]{64}$"))
' "$state" >/dev/null
cmp -s "$live_compose" "$source_snapshot"
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$SOURCE_IMAGE" ]]
mv "$state" "$recovery_state"
for _ in $(seq 1 100); do
  [[ $(unit_load_state) == not-found ]] && break
  sleep 0.05
done
[[ $(unit_load_state) == not-found ]] || {
  echo "Recovery transient rehearsal unit still exists after --collect: $unit" >&2
  exit 1
}
echo 'Real-Docker interruption recovery rehearsal passed.'

# Re-prepare the now-restored source model and prove the ordinary transition
# still completes under a third, identity-distinct transient invocation.
"$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
unit_base="noosphere-pgvector-controller-docker-success-$BASHPID-$RANDOM"
unit="$unit_base.service"
systemd_args=(
  systemd-run
  --user
  --unit="$unit_base"
  --wait
  --collect
  --quiet
  --setenv="CONTROLLER_UNIT=$unit"
  --setenv="XDG_STATE_HOME=$XDG_STATE_HOME"
)
while IFS= read -r property; do
  systemd_args+=(--property="$property")
done < <(bash -c 'source "$1"; systemd_properties "$2"' -- "$CONTROLLER" "$tmp_dir")
systemd_args+=("$CONTROLLER" --execute --state "$state")
"${systemd_args[@]}"

jq -e '
  .phase == "complete" and
  (.guardEvidence.sha256 | test("^[a-f0-9]{64}$")) and
  (.closureEvidence.sha256 | test("^[a-f0-9]{64}$"))
' "$state" >/dev/null
jq -e '.phase == "complete" and .mode == "switch"' "$guard_journal" >/dev/null
[[ $(jq -er '.exitCode' "$(jq -er '.guardEvidence.path' "$state")") == 0 ]]
[[ $(jq -er '.exitCode' "$(jq -er '.closureEvidence.path' "$state")") == 0 ]]
cmp -s "$live_compose" "$candidate_compose"
[[ $(docker inspect "$db_container" --format '{{.Config.Image}}') == "$CANDIDATE_IMAGE" ]]
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]
[[ $(docker inspect "$db_container" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}') == "$volume" ]]
[[ $(docker exec "$db_container" cat /run/noosphere-pgvector/candidate-authorized) == "$CANDIDATE_IMAGE" ]]
[[ $(docker exec "$db_container" cat /run/noosphere-pgvector/writer-authorized) == "$CANDIDATE_IMAGE" ]]
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT count(*) FROM "Topic";') == 1 ]]
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT count(*) FROM "Article" WHERE "deletedAt" IS NULL;') == 1 ]]
[[ $(docker exec "$db_container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT count(*) FROM "ApiKey";') == 1 ]]
curl -fsS --max-time 5 "$app_url/api/health" | jq -e '.status == "ok"' >/dev/null

for _ in $(seq 1 50); do
  [[ $(unit_load_state) == not-found ]] && break
  sleep 0.05
done
[[ $(unit_load_state) == not-found ]] || {
  echo "Transient rehearsal unit still exists after --collect: $unit" >&2
  exit 1
}

cleanup_successfully
verify_zero_residue
case "$tmp_dir" in
  /tmp/tmp.*) rm -rf -- "$tmp_dir" ;;
  *) echo "Refusing unexpected fixture cleanup path: $tmp_dir" >&2; exit 1 ;;
esac
trap - EXIT INT TERM
echo 'PostgreSQL transition controller pinned-guard Docker rehearsal passed.'
