#!/usr/bin/env bash
set -Eeuo pipefail

# Phase A2b only supports artifacts that completed the repository's A2
# rehearsal. Keep these constants synchronized with rehearsal.env; CI enforces
# that invariant.
SOURCE_IMAGE='postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
CANDIDATE_IMAGE='ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292'
EXPECTED_POSTGRES_VERSION='16.14'
EXPECTED_SOURCE_ALPINE_VERSION='3.23.4'
EXPECTED_CANDIDATE_ALPINE_VERSION='3.24.1'
EXPECTED_PGVECTOR_VERSION='0.8.1'
LABEL_KEY='io.noosphere.pgvector-switch-run'
NEW_INSTALL_LABEL_KEY='io.noosphere.pgvector-new-install-run'
NEW_INSTALL_IMAGE_LABEL_KEY='io.noosphere.pgvector-new-install-image'
AUTH_DATA_LABEL_KEY='io.noosphere.pgvector-authorization-data'
AUTH_RUN_LABEL_KEY='io.noosphere.pgvector-authorization-run'
AUTH_IMAGE_LABEL_KEY='io.noosphere.pgvector-authorization-image'
AUTH_MARKER='candidate-authorized'
WRITER_MARKER='writer-authorized'

mode='switch'
compose_file=''
env_file=''
db_service='db'
db_container=''
app_container=''
volume='noosphere_postgres_data'
authorization_volume=''
backup_dir=''
platform=''
app_was_running=false
restart_app_after_switch=true
rollback_active=false
operation_complete=false
journal=''
journal_phase=''
journal_mode=''
journal_validated=false
run_id=''
probe_database=''
run_dir=''
original_compose=''
candidate_compose=''
source_override=''
backup_file=''
fail_closed_on_die=false

usage() {
  cat <<'USAGE'
Usage:
  switch-pgvector-compose.sh --compose-file FILE --db-container NAME \
    --app-container NAME --backup-dir DIR [options]
  switch-pgvector-compose.sh --record-new-install --compose-file FILE \
    --db-container NAME --app-container NAME --backup-dir DIR [options]
  switch-pgvector-compose.sh --prepare-new-install --compose-file FILE \
    --db-container NAME --app-container NAME --backup-dir DIR [options]
  switch-pgvector-compose.sh --authorize-writer --compose-file FILE \
    --db-container NAME --app-container NAME --backup-dir DIR [options]

Options:
  --env-file FILE          Compose environment file
  --db-service NAME        Compose database service (default: db)
  --volume NAME            Expected local PostgreSQL volume
  --authorization-volume NAME  External candidate-authorization volume
  --platform OS/ARCH       Explicit platform (default: running image platform)
  --prepare-new-install    Durably claim and create an absent candidate volume
  --record-new-install     Finalize a prepared new-volume claim before app start
  --authorize-writer       Publish writer authorization inside an inherited installer lock
  --defer-app-restart      Keep the app stopped for an inherited installer transaction
  --help                   Show this help

The switch mode is intentionally offline. It stops the named app, isolates the
database volume in networkless containers, proves backup restoration, rehearses
source -> candidate -> source -> candidate, and promotes Compose only after all
invariants pass. A privileged Docker administrator remains an explicit trust
boundary and must not start competing containers during this operation.
USAGE
}

log() {
  printf '[pgvector-switch] %s\n' "$*"
}

die() {
  printf '[pgvector-switch] ERROR: %s\n' "$*" >&2
  if [[ "$fail_closed_on_die" == true && -n "$app_container" ]]; then
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
  fi
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

while (($# > 0)); do
  case "$1" in
    --compose-file) compose_file=${2:?missing value}; shift 2 ;;
    --env-file) env_file=${2:?missing value}; shift 2 ;;
    --db-service) db_service=${2:?missing value}; shift 2 ;;
    --db-container) db_container=${2:?missing value}; shift 2 ;;
    --app-container) app_container=${2:?missing value}; shift 2 ;;
    --volume) volume=${2:?missing value}; shift 2 ;;
    --authorization-volume) authorization_volume=${2:?missing value}; shift 2 ;;
    --backup-dir) backup_dir=${2:?missing value}; shift 2 ;;
    --platform) platform=${2:?missing value}; shift 2 ;;
    --prepare-new-install) mode='prepare-new-install'; shift ;;
    --record-new-install) mode='record-new-install'; shift ;;
    --authorize-writer) mode='authorize-writer'; shift ;;
    --defer-app-restart) restart_app_after_switch=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for command in docker jq sha256sum flock realpath readlink install awk sed node; do
  need "$command"
done
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'

[[ -n "$compose_file" && -f "$compose_file" ]] || die '--compose-file must name an existing file'
[[ -n "$db_container" ]] || die '--db-container is required'
[[ -n "$app_container" ]] || die '--app-container is required'
[[ -n "$backup_dir" ]] || die '--backup-dir is required'
[[ -z "$env_file" || -f "$env_file" ]] || die '--env-file must name an existing file'
[[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'invalid volume name'
if [[ -z "$authorization_volume" ]]; then
  if [[ "$volume" == *_data ]]; then
    authorization_volume="${volume%_data}_authorization"
  else
    authorization_volume="${volume}_authorization"
  fi
fi
[[ "$authorization_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'invalid authorization volume name'
[[ "$authorization_volume" != "$volume" ]] || die 'authorization volume must differ from the PostgreSQL data volume'
[[ "$db_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'invalid database container name'
[[ "$app_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'invalid app container name'

compose_file=$(realpath "$compose_file")
[[ -z "$env_file" ]] || env_file=$(realpath "$env_file")

docker_host=''
if [[ -n ${DOCKER_CONTEXT:-} ]]; then
  docker_context=$DOCKER_CONTEXT
  docker_host=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}') ||
    die "could not inspect Docker context $docker_context"
elif [[ -n ${DOCKER_HOST:-} ]]; then
  docker_host=$DOCKER_HOST
else
  docker_context=$(docker context show) || die 'could not determine the active Docker context'
  docker_host=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}') ||
    die "could not inspect Docker context $docker_context"
fi
[[ "$docker_host" == unix://* ]] || die "refusing non-local Docker endpoint: $docker_host"
docker_socket=${docker_host#unix://}
[[ "$docker_socket" == /* ]] || die "Docker Unix endpoint must use an absolute path: $docker_host"
docker_host="unix://$(realpath -m "$docker_socket")"

reject_symlink_components() {
  local target=$1 current='/' component
  IFS='/' read -r -a components <<< "${target#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    [[ ! -L "$current" ]] || die "backup path traverses a symlink: $current"
  done
}

backup_dir=$(realpath -m "$backup_dir")
[[ "$backup_dir" == /* ]] || die 'backup directory must resolve to an absolute path'
reject_symlink_components "$backup_dir"
install -d -m 700 "$backup_dir"
[[ $(stat -c '%u' "$backup_dir") == "$(id -u)" ]] || die 'backup directory must be owned by the current user'
[[ $(stat -c '%a' "$backup_dir") == '700' ]] || die 'backup directory mode must be 0700'
umask 077

# Lock by Docker engine and volume, not by the caller-selected backup root.
# Otherwise two invocations could pick different backup directories and race.
lock_root=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
[[ "$lock_root" == /* && -d "$lock_root" && ! -L "$lock_root" ]] ||
  die "runtime lock directory is unavailable or unsafe: $lock_root"
[[ $(stat -c '%u' "$lock_root") == "$(id -u)" ]] || die 'runtime lock directory is not owned by the current user'
engine_id=$(docker info --format '{{.ID}}') || die 'could not determine the Docker engine ID'
[[ -n "$engine_id" ]] || die 'Docker engine ID is empty'
lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
lock_path="$lock_root/noosphere-pgvector-switch-$lock_key.lock"
if [[ -n ${NOOSPHERE_A2B_LOCK_FD:-} ]]; then
  [[ "$NOOSPHERE_A2B_LOCK_FD" =~ ^[0-9]+$ ]] || die 'invalid inherited operation-lock descriptor'
  inherited_path=$(readlink "/proc/$$/fd/$NOOSPHERE_A2B_LOCK_FD" 2>/dev/null || true)
  [[ "$inherited_path" == "$lock_path" && ${NOOSPHERE_A2B_LOCK_PATH:-} == "$lock_path" ]] ||
    die 'inherited operation lock does not match this Docker volume'
  flock -n "$NOOSPHERE_A2B_LOCK_FD" || die 'inherited PostgreSQL operation lock is not held'
else
  exec 9>"$lock_path"
  # A shell killed during an external command can leave the inherited file
  # descriptor alive briefly in that child. Allow that bounded handoff window;
  # a genuinely concurrent transaction remains fail-closed.
  flock -w 5 9 || die "another pgvector switch is active for Docker volume $volume"
fi
[[ "$restart_app_after_switch" == true || -n ${NOOSPHERE_A2B_LOCK_FD:-} ]] ||
  die '--defer-app-restart is allowed only inside an inherited installer transaction'
[[ "$mode" != authorize-writer || -n ${NOOSPHERE_A2B_LOCK_FD:-} ]] ||
  die '--authorize-writer is allowed only inside an inherited installer transaction'

journal="$backup_dir/${volume}.phase-a2b.json"

fsync_path() {
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const fd = fs.openSync(path, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

write_json_atomic() {
  local target=$1 source=$2 temp
  temp=$(mktemp "${target}.tmp.XXXXXX")
  install -m 600 "$source" "$temp"
  fsync_path "$temp"
  mv -f "$temp" "$target"
  fsync_path "$(dirname "$target")"
}

phase_checkpoint() {
  local phase=$1
  log "journal phase: $phase"
  if [[ ${NOOSPHERE_A2B_FAIL_AFTER_PHASE:-} == "$phase" ]]; then
    log "test fault injected after journal phase $phase"
    return 97
  fi
  if [[ ${NOOSPHERE_A2B_PAUSE_AFTER_PHASE:-} == "$phase" ]]; then
    log "test pause injected after journal phase $phase"
    while :; do sleep 1; done
  fi
}

update_journal() {
  local phase=$1 temp
  temp=$(mktemp "$backup_dir/.journal.XXXXXX")
  if [[ "$phase" == recovered ]]; then
    jq --arg phase "$phase" \
      'if .phase == $phase then . else .recoveredFromPhase = .phase | .phase = $phase end' \
      "$journal" > "$temp"
  else
    jq --arg phase "$phase" '.phase = $phase' "$journal" > "$temp"
  fi
  write_json_atomic "$journal" "$temp"
  rm -f "$temp"
  journal_phase=$phase
  phase_checkpoint "$phase"
}

compose_args() {
  COMPOSE_ARGS=(-f "$1")
  [[ -z "$env_file" ]] || COMPOSE_ARGS+=(--env-file "$env_file")
}

compose_db_image() {
  compose_args "$1"
  docker compose "${COMPOSE_ARGS[@]}" config --format json | jq -er --arg service "$db_service" '.services[$service].image'
}

probe_database_for_run() {
  local digest
  digest=$(printf '%s' "$1" | sha256sum | awk '{print $1}')
  printf 'noosphere_a2b_template0_%s\n' "${digest:0:24}"
}

assert_compose_authorization_gate() {
  local expected_image=$1
  compose_args "$compose_file"
  docker compose "${COMPOSE_ARGS[@]}" config --format json | jq -e \
    --arg service "$db_service" \
    --arg expected "$expected_image" \
    --arg authorization "$authorization_volume" \
    --arg marker "/run/noosphere-pgvector/$AUTH_MARKER" '
      .services[$service] as $db |
      .services.app as $app |
      ([$db.volumes[]? | select(.target == "/run/noosphere-pgvector")]) as $mounts |
      ([$app.volumes[]? | select(.target == "/run/noosphere-pgvector")]) as $appMounts |
      ($mounts[0].source // "") as $logicalVolume |
      $db.image == $expected and
      $db.command == ["postgres"] and
      ([$db.entrypoint[]? | select(
        type == "string" and contains($marker) and contains($expected) and
        contains("/usr/local/bin/docker-entrypoint.sh")
      )] | length == 1) and
      ($mounts | length == 1) and
      ($appMounts | length == 1) and
      $mounts[0].type == "volume" and
      $mounts[0].read_only == true and
      $appMounts[0].type == "volume" and
      $appMounts[0].read_only == true and
      $appMounts[0].source == $logicalVolume and
      ([$app.entrypoint[]? | select(
        type == "string" and contains("/run/noosphere-pgvector/writer-authorized") and contains($expected)
      )] | length == 1) and
      .volumes[$logicalVolume].external == true and
      .volumes[$logicalVolume].name == $authorization
    ' >/dev/null || die "Compose must contain the exact external authorization gate for $expected_image"
}

assert_candidate_authorization_gate() {
  assert_compose_authorization_gate "$CANDIDATE_IMAGE"
}

assert_owned_regular_file() {
  local path=$1
  [[ -f "$path" && ! -L "$path" ]] || die "required evidence file is missing or unsafe: $path"
  [[ $(stat -c '%u' "$path") == "$(id -u)" ]] || die "evidence file is not owned by the current user: $path"
}

validate_journal() {
  local stored_volume stored_source stored_candidate stored_platform stored_authorization expected_run_dir
  local stored_engine_id stored_docker_endpoint
  local stored_original stored_candidate_compose stored_source_override stored_backup
  local stored_original_sha stored_candidate_sha stored_override_sha stored_backup_sha
  local evidence_file signature evidence_phase

  assert_owned_regular_file "$journal"
  [[ $(stat -c '%a' "$journal") == 600 ]] || die 'transition journal mode must be 0600'
  jq -e 'type == "object"' "$journal" >/dev/null || die 'transition journal must contain one JSON object'

  journal_phase=$(jq -er '.phase' "$journal")
  journal_mode=$(jq -er '.mode' "$journal")
  stored_volume=$(jq -er '.volume' "$journal")
  stored_candidate=$(jq -er '.candidateImage' "$journal")
  stored_platform=$(jq -er '.platform' "$journal")
  stored_authorization=$(jq -er '.authorizationVolume' "$journal")
  stored_engine_id=$(jq -er '.dockerEngineId' "$journal")
  stored_docker_endpoint=$(jq -er '.dockerEndpoint' "$journal")
  run_id=$(jq -er '.runId' "$journal")
  probe_database=$(jq -er '.probeDatabase' "$journal")

  [[ "$stored_volume" == "$volume" ]] || die 'transition journal names another PostgreSQL volume'
  [[ "$stored_candidate" == "$CANDIDATE_IMAGE" ]] || die 'transition journal names another candidate image'
  [[ "$stored_authorization" == "$authorization_volume" ]] || die 'transition journal names another authorization volume'
  [[ "$stored_engine_id" == "$engine_id" ]] || die 'transition journal names another Docker engine'
  [[ "$stored_docker_endpoint" == "$docker_host" ]] || die 'transition journal names another Docker endpoint'
  [[ "$stored_platform" =~ ^linux/(amd64|arm64)$ ]] || die 'transition journal contains an invalid platform'
  [[ -z "$platform" || "$stored_platform" == "$platform" ]] || die 'transition journal names another platform'
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$ ]] || die 'transition journal contains an invalid run ID'
  [[ "$probe_database" == "$(probe_database_for_run "$run_id")" ]] ||
    die 'transition journal contains an invalid template0 probe claim'
  case "$journal_mode" in
    new-install)
      case "$journal_phase" in
        claim-created|provisioning|complete) ;;
        *) die "new-install evidence contains an invalid phase: $journal_phase" ;;
      esac
      [[ $(jq -r '.composeFile' "$journal") == "$compose_file" ]] || die 'new-install evidence names another Compose file'
      [[ $(jq -r '.dbService' "$journal") == "$db_service" ]] || die 'new-install evidence names another database service'
      [[ $(jq -r '.dbContainer' "$journal") == "$db_container" ]] || die 'new-install evidence names another database container'
      [[ $(jq -r '.appContainer' "$journal") == "$app_container" ]] || die 'new-install evidence names another app container'
      assert_owned_regular_file "$compose_file"
      [[ $(compose_db_image "$compose_file") == "$CANDIDATE_IMAGE" ]] || die 'new-install Compose does not resolve to the candidate image'
      if [[ "$journal_phase" == claim-created ]]; then
        jq -e 'has("volumeFingerprint") | not' "$journal" >/dev/null ||
          die 'unprovisioned new-install claim unexpectedly contains a volume fingerprint'
        if docker volume inspect "$volume" >/dev/null 2>&1; then
          assert_new_install_volume_claim '' >/dev/null
          assert_volume_consumers
        fi
        if docker volume inspect "$authorization_volume" >/dev/null 2>&1; then
          assert_authorization_volume '' false "$stored_platform" >/dev/null
          [[ -z $(authorization_volume_consumers) ]] || die 'unprovisioned authorization volume has an unexpected consumer'
        fi
      else
        jq -e '.volumeFingerprint | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
          die 'new-install evidence contains an invalid volume fingerprint'
        assert_new_install_volume_claim "$(jq -er '.volumeFingerprint' "$journal")" >/dev/null
        jq -e '.authorizationVolumeFingerprint | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
          die 'new-install evidence contains an invalid authorization volume fingerprint'
        assert_authorization_volume "$(jq -er '.authorizationVolumeFingerprint' "$journal")" true "$stored_platform" >/dev/null
      fi
      if [[ "$journal_phase" == complete ]]; then
        for signature in dataSignature schemaSignature migrationSignature; do
          jq -e --arg signature "$signature" '.[$signature] | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
            die "new-install evidence contains an invalid $signature"
        done
        jq -e '.databaseIdentity | type == "string" and length > 0' "$journal" >/dev/null ||
          die 'new-install evidence contains an invalid database identity'
      fi
      ;;
    switch)
      jq -e '.volumeFingerprint | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
        die 'transition journal contains an invalid volume fingerprint'
      case "$journal_phase" in
        preparing|baseline-recorded|backup-restored|candidate-verified|source-rollback-verified|final-candidate-maintenance-verified|candidate-authorized|candidate-online-verified|recovered|complete) ;;
        *) die "transition journal contains an invalid phase: $journal_phase" ;;
      esac
      evidence_phase="$journal_phase"
      if [[ "$journal_phase" == recovered ]]; then
        evidence_phase=$(jq -er '.recoveredFromPhase' "$journal")
        case "$evidence_phase" in
          preparing|baseline-recorded|backup-restored|candidate-verified|source-rollback-verified|final-candidate-maintenance-verified|candidate-authorized|candidate-online-verified) ;;
          *) die "recovered journal names an invalid prior phase: $evidence_phase" ;;
        esac
      fi
      stored_source=$(jq -er '.sourceImage' "$journal")
      [[ "$stored_source" == "$SOURCE_IMAGE" ]] || die 'transition journal names another source image'
      [[ $(jq -r '.composeFile' "$journal") == "$compose_file" ]] || die 'transition journal names another Compose file'
      [[ $(jq -r '.dbService' "$journal") == "$db_service" ]] || die 'transition journal names another database service'
      [[ $(jq -r '.dbContainer' "$journal") == "$db_container" ]] || die 'transition journal names another database container'
      [[ $(jq -r '.appContainer' "$journal") == "$app_container" ]] || die 'transition journal names another app container'
      jq -e '.appWasRunning | type == "boolean"' "$journal" >/dev/null || die 'transition journal has invalid app state'

      expected_run_dir="$backup_dir/phase-a2b-$run_id"
      stored_original=$(jq -er '.originalCompose' "$journal")
      stored_candidate_compose=$(jq -er '.candidateCompose' "$journal")
      stored_source_override=$(jq -er '.sourceOverride' "$journal")
      [[ "$stored_original" == "$expected_run_dir/original-compose.yml" ]] || die 'transition journal has an invalid source Compose path'
      [[ "$stored_candidate_compose" == "$expected_run_dir/candidate-compose.yml" ]] || die 'transition journal has an invalid candidate Compose path'
      [[ "$stored_source_override" == "$expected_run_dir/source-override.yml" ]] || die 'transition journal has an invalid source override path'
      stored_original_sha=$(jq -er '.originalComposeSha256' "$journal")
      stored_candidate_sha=$(jq -er '.candidateComposeSha256' "$journal")
      stored_override_sha=$(jq -er '.sourceOverrideSha256' "$journal")
      [[ "$stored_original_sha" =~ ^[a-f0-9]{64}$ && "$stored_candidate_sha" =~ ^[a-f0-9]{64}$ && "$stored_override_sha" =~ ^[a-f0-9]{64}$ ]] ||
        die 'transition journal contains an invalid Compose evidence digest'

      if [[ "$journal_phase" != complete ]]; then
        for evidence_file in "$stored_original" "$stored_candidate_compose" "$stored_source_override"; do
          assert_owned_regular_file "$evidence_file"
        done
        [[ $(sha256_file "$stored_original") == "$stored_original_sha" ]] || die 'source Compose evidence digest changed'
        [[ $(sha256_file "$stored_candidate_compose") == "$stored_candidate_sha" ]] || die 'candidate Compose evidence digest changed'
        [[ $(sha256_file "$stored_source_override") == "$stored_override_sha" ]] || die 'source override evidence digest changed'
        [[ $(compose_db_image "$stored_original") == "$SOURCE_IMAGE" ]] || die 'source Compose evidence no longer resolves to the source image'
        [[ $(compose_db_image "$stored_candidate_compose") == "$CANDIDATE_IMAGE" ]] || die 'candidate Compose evidence no longer resolves to the candidate image'
      fi

      if [[ "$evidence_phase" != preparing ]]; then
        for signature in dataSignature schemaSignature migrationSignature backupSha256; do
          jq -e --arg signature "$signature" '.[$signature] | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
            die "transition journal contains an invalid $signature"
        done
        jq -e '.databaseIdentity | type == "string" and length > 0' "$journal" >/dev/null ||
          die 'transition journal contains an invalid database identity'
        stored_backup=$(jq -er '.backup' "$journal")
        stored_backup_sha=$(jq -er '.backupSha256' "$journal")
        [[ "$stored_backup" == "$expected_run_dir/noosphere.dump" ]] || die 'transition journal has an invalid backup path'
        if [[ "$journal_phase" != complete ]]; then
          assert_owned_regular_file "$stored_backup"
          [[ $(sha256_file "$stored_backup") == "$stored_backup_sha" ]] || die 'logical backup digest changed'
        fi
      fi
      case "$evidence_phase" in
        candidate-authorized|candidate-online-verified|complete)
          jq -e '.authorizationVolumeFingerprint | type == "string" and test("^[a-f0-9]{64}$")' "$journal" >/dev/null ||
            die 'transition journal contains an invalid authorization volume fingerprint'
          ;;
      esac
      if [[ "$journal_phase" == complete ]]; then
        assert_authorization_volume "$(jq -er '.authorizationVolumeFingerprint' "$journal")" true "$stored_platform" >/dev/null
      fi
      ;;
    *) die "transition journal contains an invalid mode: $journal_mode" ;;
  esac
  journal_validated=true
}

stage_compose_image() {
  local source=$1 target=$2 image=$3 count_file
  [[ "$image" == "$SOURCE_IMAGE" || "$image" == "$CANDIDATE_IMAGE" ]] || die 'refusing unsupported staged image'
  count_file=$(mktemp "$backup_dir/.image-count.XXXXXX")
  awk -v image="$image" -v source_image="$SOURCE_IMAGE" -v candidate_image="$CANDIDATE_IMAGE" \
    -v count_file="$count_file" '
    BEGIN { in_db = 0; in_app = 0; count = 0 }
    /^  db:[[:space:]]*$/ { in_db = 1; in_app = 0; print; next }
    /^  app:[[:space:]]*$/ { in_db = 0; in_app = 1; print; next }
    (in_db || in_app) && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { in_db = 0; in_app = 0 }
    in_db && /^    image:[[:space:]]*/ {
      print "    image: " image
      count += 1
      next
    }
    (in_db || (in_app && $0 !~ /^    image:/)) && image == source_image {
      # A checked-in candidate Compose file gates PostgreSQL with the exact
      # candidate digest. The rollback desired state must gate the exact
      # source digest instead, or a later source restart would fail closed.
      gsub(candidate_image, source_image)
    }
    (in_db || (in_app && $0 !~ /^    image:/)) && image == candidate_image {
      # A recovered source Compose file carries the source authorization gate.
      # A later guarded retry must restore both the candidate image and the
      # candidate marker expectation, never only the image field.
      gsub(source_image, candidate_image)
    }
    { print }
    END { print count > count_file }
  ' "$source" > "$target"
  [[ $(<"$count_file") == 1 ]] || die 'Compose must contain exactly one db image field'
  rm -f "$count_file"
  chmod --reference="$source" "$target"
  compose_args "$target"
  docker compose "${COMPOSE_ARGS[@]}" config -q
  [[ $(compose_db_image "$target") == "$image" ]] || die 'staged Compose did not resolve to the requested image'
}

write_override() {
  local target=$1 image=$2
  [[ "$image" == "$SOURCE_IMAGE" || "$image" == "$CANDIDATE_IMAGE" ]] || die 'refusing unsupported image override'
  {
    printf 'services:\n'
    printf '  %s:\n' "$db_service"
    printf '    image: %s\n' "$image"
  } > "$target"
  chmod 600 "$target"
  fsync_path "$target"
}

volume_fingerprint() {
  docker volume inspect "$volume" | jq -Sc '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' | sha256sum | awk '{print $1}'
}

authorization_volume_fingerprint() {
  docker volume inspect "$authorization_volume" | jq -Sc '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' | sha256sum | awk '{print $1}'
}

authorization_volume_consumers() {
  docker ps -aq --no-trunc --filter "volume=$authorization_volume" | sort -u
}

assert_authorization_consumers_managed() {
  local actual id db_id app_id
  actual=$(authorization_volume_consumers)
  db_id=$(docker inspect "$db_container" --format '{{.Id}}' 2>/dev/null || true)
  app_id=$(docker inspect "$app_container" --format '{{.Id}}' 2>/dev/null || true)
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    [[ "$id" == "$db_id" || "$id" == "$app_id" ]] ||
      die 'candidate-authorization volume has an unexpected consumer'
  done <<< "$actual"
}

assert_authorization_volume() {
  local expected_fingerprint=${1:-} require_marker=${2:-true} target_platform=${3:-${platform:-}} labels fingerprint marker actual
  [[ $(docker volume inspect "$authorization_volume" --format '{{.Driver}}') == local ]] ||
    die "$authorization_volume must use the local volume driver"
  labels=$(docker volume inspect "$authorization_volume" --format '{{json .Labels}}')
  jq -e --arg data "$volume" --arg run "$run_id" --arg image "$CANDIDATE_IMAGE" \
    --arg dataKey "$AUTH_DATA_LABEL_KEY" --arg runKey "$AUTH_RUN_LABEL_KEY" --arg imageKey "$AUTH_IMAGE_LABEL_KEY" \
    '.[$dataKey] == $data and .[$runKey] == $run and .[$imageKey] == $image' >/dev/null <<< "$labels" ||
    die 'candidate-authorization volume does not match this guarded transaction'
  fingerprint=$(authorization_volume_fingerprint)
  [[ -z "$expected_fingerprint" || "$fingerprint" == "$expected_fingerprint" ]] ||
    die 'candidate-authorization volume fingerprint changed'
  if [[ "$require_marker" == true ]]; then
    [[ "$target_platform" =~ ^linux/(amd64|arm64)$ ]] || die 'authorization marker platform is invalid'
    marker=$(docker run --rm --network none --platform "$target_platform" \
      --mount "type=volume,source=$authorization_volume,target=/authorization,readonly" \
      --mount type=tmpfs,destination=/var/lib/postgresql/data \
      --entrypoint sh "$CANDIDATE_IMAGE" -ceu "cat /authorization/$AUTH_MARKER") ||
      die 'candidate-authorization marker is missing'
    [[ "$marker" == "$CANDIDATE_IMAGE" ]] || die 'candidate-authorization marker names another image'
  fi
  printf '%s' "$fingerprint"
}

create_authorization_volume() {
  if docker volume inspect "$authorization_volume" >/dev/null 2>&1; then
    assert_authorization_volume '' false "${platform:-$(engine_platform)}" >/dev/null
  else
    docker volume create --driver local \
      --label "$AUTH_DATA_LABEL_KEY=$volume" \
      --label "$AUTH_RUN_LABEL_KEY=$run_id" \
      --label "$AUTH_IMAGE_LABEL_KEY=$CANDIDATE_IMAGE" \
      "$authorization_volume" >/dev/null
  fi
  [[ -z $(authorization_volume_consumers) ]] || die 'candidate-authorization volume has an unexpected consumer'
  docker run --rm --network none --platform "${platform:-$(engine_platform)}" \
    --label "$LABEL_KEY=$run_id" \
    --mount "type=volume,source=$authorization_volume,target=/authorization" \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    --entrypoint sh "$CANDIDATE_IMAGE" -ceu \
    "umask 077; rm -f /authorization/$WRITER_MARKER; printf '%s\\n' '$CANDIDATE_IMAGE' > /authorization/$AUTH_MARKER.tmp; sync; mv -f /authorization/$AUTH_MARKER.tmp /authorization/$AUTH_MARKER; sync"
  assert_authorization_volume '' true "${platform:-$(engine_platform)}"
}

authorize_writer_marker() {
  assert_authorization_volume '' true "${platform:-$(engine_platform)}" >/dev/null
  assert_authorization_consumers_managed
  docker run --rm --network none --platform "${platform:-$(engine_platform)}" \
    --label "$LABEL_KEY=$run_id" \
    --mount "type=volume,source=$authorization_volume,target=/authorization" \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    --entrypoint sh "$CANDIDATE_IMAGE" -ceu \
    "umask 077; printf '%s\\n' '$CANDIDATE_IMAGE' > /authorization/$WRITER_MARKER.tmp; sync; mv -f /authorization/$WRITER_MARKER.tmp /authorization/$WRITER_MARKER; sync"
}

revoke_writer_marker() {
  assert_authorization_volume '' true "${platform:-$(engine_platform)}" >/dev/null
  assert_authorization_consumers_managed
  docker run --rm --network none --platform "${platform:-$(engine_platform)}" \
    --label "$LABEL_KEY=$run_id" \
    --mount "type=volume,source=$authorization_volume,target=/authorization" \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    --entrypoint sh "$CANDIDATE_IMAGE" -ceu \
    "rm -f /authorization/$WRITER_MARKER; sync"
}

assert_stale_authorization_volume() {
  local expect_writer=${1:-true} labels marker writer_marker target_platform=${platform:-$(engine_platform)}
  [[ $(docker volume inspect "$authorization_volume" --format '{{.Driver}}') == local ]] ||
    die "$authorization_volume must use the local volume driver"
  labels=$(docker volume inspect "$authorization_volume" --format '{{json .Labels}}')
  jq -e --arg data "$volume" --arg image "$CANDIDATE_IMAGE" \
    --arg dataKey "$AUTH_DATA_LABEL_KEY" --arg runKey "$AUTH_RUN_LABEL_KEY" --arg imageKey "$AUTH_IMAGE_LABEL_KEY" '
      .[$dataKey] == $data and .[$imageKey] == $image and
      (.[$runKey] | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$"))
    ' >/dev/null <<< "$labels" || die 'stale authorization volume has invalid ownership labels'
  marker=$(docker run --rm --network none --platform "$target_platform" \
    --mount "type=volume,source=$authorization_volume,target=/authorization,readonly" \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    --entrypoint sh "$CANDIDATE_IMAGE" -ceu "cat /authorization/$AUTH_MARKER 2>/dev/null || true")
  [[ "$marker" == "$SOURCE_IMAGE" ]] ||
    die 'authorization volume is not safely rebound to the exact source image'
  writer_marker=$(docker run --rm --network none --platform "$target_platform" \
    --mount "type=volume,source=$authorization_volume,target=/authorization,readonly" \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    --entrypoint sh "$CANDIDATE_IMAGE" -ceu "cat /authorization/$WRITER_MARKER 2>/dev/null || true")
  if [[ "$expect_writer" == true ]]; then
    [[ "$writer_marker" == "$SOURCE_IMAGE" ]] ||
      die 'writer authorization is not safely rebound to the exact source image'
  else
    [[ -z "$writer_marker" ]] || die 'deferred source recovery unexpectedly published writer authorization'
  fi
  assert_authorization_consumers_managed
}

authorize_source_marker() {
  local labels
  if ! docker volume inspect "$authorization_volume" >/dev/null 2>&1; then
    docker volume create --driver local \
      --label "$AUTH_DATA_LABEL_KEY=$volume" \
      --label "$AUTH_RUN_LABEL_KEY=$run_id" \
      --label "$AUTH_IMAGE_LABEL_KEY=$CANDIDATE_IMAGE" \
      "$authorization_volume" >/dev/null
  fi
  labels=$(docker volume inspect "$authorization_volume" --format '{{json .Labels}}')
  if ! jq -e --arg run "$run_id" --arg runKey "$AUTH_RUN_LABEL_KEY" '.[$runKey] == $run' >/dev/null <<< "$labels"; then
    assert_stale_authorization_volume "$restart_app_after_switch"
    return 0
  fi
  assert_authorization_volume '' false "${platform:-$(engine_platform)}" >/dev/null
  assert_authorization_consumers_managed
  if [[ "$restart_app_after_switch" == true ]]; then
    docker run --rm --network none --platform "${platform:-$(engine_platform)}" \
      --label "$LABEL_KEY=$run_id" \
      --mount "type=volume,source=$authorization_volume,target=/authorization" \
      --mount type=tmpfs,destination=/var/lib/postgresql/data \
      --entrypoint sh "$CANDIDATE_IMAGE" -ceu \
      "umask 077; printf '%s\\n' '$SOURCE_IMAGE' > /authorization/$AUTH_MARKER.source-$run_id.tmp; printf '%s\\n' '$SOURCE_IMAGE' > /authorization/$WRITER_MARKER.source-$run_id.tmp; sync; mv -f /authorization/$AUTH_MARKER.source-$run_id.tmp /authorization/$AUTH_MARKER; mv -f /authorization/$WRITER_MARKER.source-$run_id.tmp /authorization/$WRITER_MARKER; sync"
  else
    docker run --rm --network none --platform "${platform:-$(engine_platform)}" \
      --label "$LABEL_KEY=$run_id" \
      --mount "type=volume,source=$authorization_volume,target=/authorization" \
      --mount type=tmpfs,destination=/var/lib/postgresql/data \
      --entrypoint sh "$CANDIDATE_IMAGE" -ceu \
      "umask 077; rm -f /authorization/$WRITER_MARKER; printf '%s\\n' '$SOURCE_IMAGE' > /authorization/$AUTH_MARKER.source-$run_id.tmp; sync; mv -f /authorization/$AUTH_MARKER.source-$run_id.tmp /authorization/$AUTH_MARKER; sync"
  fi
}

engine_platform() {
  local architecture
  architecture=$(docker info --format '{{.Architecture}}')
  case "$architecture" in
    x86_64|amd64) printf 'linux/amd64\n' ;;
    aarch64|arm64) printf 'linux/arm64\n' ;;
    *) die "Docker engine reported unsupported architecture: $architecture" ;;
  esac
}

assert_new_install_volume_claim() {
  local expected_fingerprint=${1:-} labels fingerprint
  labels=$(docker volume inspect "$volume" --format '{{json .Labels}}') ||
    die "prepared PostgreSQL volume does not exist: $volume"
  jq -e --arg run "$run_id" --arg image "$CANDIDATE_IMAGE" \
    --arg runKey "$NEW_INSTALL_LABEL_KEY" --arg imageKey "$NEW_INSTALL_IMAGE_LABEL_KEY" \
    '.[$runKey] == $run and .[$imageKey] == $image' >/dev/null <<< "$labels" ||
    die 'PostgreSQL volume does not carry the durable new-install claim'
  fingerprint=$(assert_volume_contract)
  [[ -z "$expected_fingerprint" || "$fingerprint" == "$expected_fingerprint" ]] ||
    die 'prepared PostgreSQL volume fingerprint changed'
  printf '%s' "$fingerprint"
}

assert_container_volume_mount() {
  local container=$1 mounts
  mounts=$(docker inspect "$container" | jq -c --arg volume "$volume" '
    .[0].Mounts as $mounts |
    {
      data: [$mounts[] | select(.Destination == "/var/lib/postgresql/data")],
      named: [$mounts[] | select(.Name == $volume)]
    }
  ')
  jq -e --arg volume "$volume" '
    (.data | length) == 1 and
    (.named | length) == 1 and
    .data[0].Type == "volume" and
    .data[0].Name == $volume and
    .data[0].RW == true and
    .named[0].Destination == "/var/lib/postgresql/data"
  ' >/dev/null <<< "$mounts" ||
    die "$container must mount only named volume $volume read-write at /var/lib/postgresql/data"
}

assert_volume_contract() {
  local expected=${1:-} driver mountpoint fingerprint
  driver=$(docker volume inspect "$volume" --format '{{.Driver}}')
  [[ "$driver" == local ]] || die "$volume uses unsupported driver $driver"
  mountpoint=$(docker volume inspect "$volume" --format '{{.Mountpoint}}' | xargs realpath -m)
  [[ "$backup_dir" != "$mountpoint" && "$backup_dir" != "$mountpoint/"* ]] ||
    die 'backup directory must not be inside the PostgreSQL volume'
  fingerprint=$(volume_fingerprint)
  [[ -z "$expected" || "$fingerprint" == "$expected" ]] || die 'PostgreSQL volume fingerprint changed'
  printf '%s' "$fingerprint"
}

volume_consumers() {
  # docker inspect returns 64-character IDs, so consumer discovery must disable
  # Docker's default 12-character truncation before exact comparison.
  docker ps -aq --no-trunc --filter "volume=$volume" | sort -u
}

assert_volume_consumers() {
  local expected=${1:-} actual
  actual=$(volume_consumers)
  if [[ -z "$expected" ]]; then
    [[ -z "$actual" ]] || die "unexpected container consumes $volume: $(tr '\n' ' ' <<< "$actual")"
    return
  fi
  [[ "$actual" == "$(docker inspect "$expected" --format '{{.Id}}')" ]] ||
    die "unexpected or missing volume consumer for $volume"
}

wait_postgres() {
  local container=$1 ready
  for _ in $(seq 1 120); do
    ready=$(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null || true)
    if [[ $(docker exec "$container" cat /proc/1/comm 2>/dev/null || true) == postgres && "$ready" == 1 ]]; then
      return 0
    fi
    if [[ $(docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null || true) != true ]]; then
      docker logs "$container" --tail 100 >&2 || true
      die "$container exited before readiness"
    fi
    sleep 1
  done
  docker logs "$container" --tail 100 >&2 || true
  die "$container did not become ready"
}

sql() {
  local container=$1 database=$2 query=$3
  docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d "$database" -c "$query"
}

assert_cluster_vector_absent() {
  local container=$1 db installed databases probe=$probe_database
  [[ -n "$probe" && -f "$journal" ]] || die 'template0 probe requires a durable journal claim'
  [[ $(jq -er '.probeDatabase' "$journal") == "$probe" ]] ||
    die 'template0 probe does not match durable journal ownership'

  # CREATE DATABASE cannot run in a transaction. A power loss can therefore
  # strand the probe after creation; the journal records the previously absent
  # high-entropy name before any writer is stopped or the database is created.
  # Recovery may therefore remove only this exact claimed database.
  if [[ $(sql "$container" postgres "SELECT count(*) FROM pg_database WHERE datname = '$probe';") == 1 ]]; then
    sql "$container" postgres "DROP DATABASE \"$probe\" WITH (FORCE);" >/dev/null
  fi
  databases=$(sql "$container" postgres "SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname;")
  while IFS= read -r db; do
    [[ -n "$db" ]] || continue
    installed=$(sql "$container" "$db" "SELECT count(*) FROM pg_extension WHERE extname = 'vector';")
    [[ "$installed" == 0 ]] || die "vector is installed in database $db"
  done <<< "$databases"

  sql "$container" postgres "CREATE DATABASE \"$probe\" TEMPLATE template0;" >/dev/null
  phase_checkpoint template0-probe-created
  if ! installed=$(sql "$container" "$probe" "SELECT count(*) FROM pg_extension WHERE extname = 'vector';"); then
    sql "$container" postgres "DROP DATABASE \"$probe\";" >/dev/null 2>&1 || true
    die 'failed to inspect template0 for vector'
  fi
  sql "$container" postgres "DROP DATABASE \"$probe\";" >/dev/null
  [[ "$installed" == 0 ]] || die 'vector is installed in template0'

  [[ $(sql "$container" postgres "SELECT count(*) FROM pg_database WHERE NOT datallowconn AND datname <> 'template0';") == 0 ]] ||
    die 'cannot verify vector absence in a non-connectable database'
}

normalized_dump() {
  local container=$1 section=$2
  docker exec "$container" pg_dump -U noosphere -d noosphere "$section" --no-owner --no-privileges --inserts 2>/dev/null |
    sed -E '/^\\(un)?restrict /d'
}

data_signature() {
  normalized_dump "$1" --data-only | sha256sum | awk '{print $1}'
}

schema_signature() {
  normalized_dump "$1" --schema-only | sha256sum | awk '{print $1}'
}

migration_signature() {
  sql "$1" noosphere "
    SELECT migration_name || '|' || checksum || '|' || applied_steps_count || '|' ||
           coalesce(finished_at::text, '<null>') || '|' || coalesce(rolled_back_at::text, '<null>')
    FROM \"_prisma_migrations\" ORDER BY migration_name;" | sha256sum | awk '{print $1}'
}

database_identity() {
  sql "$1" noosphere "
    SELECT current_database() || '|' || current_user || '|' ||
           current_setting('server_version') || '|' || current_setting('data_checksums') || '|' ||
           datcollate || '|' || datctype || '|' || coalesce(datcollversion, '<null>') || '|' ||
           coalesce(pg_database_collation_actual_version(oid), '<null>')
    FROM pg_database WHERE datname = current_database();"
}

container_platform() {
  local machine
  machine=$(docker exec "$1" uname -m)
  case "$machine" in
    x86_64) printf 'linux/amd64\n' ;;
    aarch64) printf 'linux/arm64\n' ;;
    *) die "$1 reported unsupported runtime architecture: $machine" ;;
  esac
}

assert_image_identity() {
  local container=$1 image=$2 kind=$3 check_cluster=${4:-true}
  local actual_platform image_id repo_digests configured
  actual_platform=$(container_platform "$container")
  [[ -z "$platform" || "$actual_platform" == "$platform" ]] || die "$container platform is $actual_platform, expected $platform"
  image_id=$(docker inspect "$container" --format '{{.Image}}')
  repo_digests=$(docker image inspect "$image_id" --format '{{json .RepoDigests}}')
  configured=$(docker inspect "$container" --format '{{.Config.Image}}')
  # Docker resolves this immutable digest when the container is created. Keep
  # recovery entirely local: the configured reference or the local image's
  # RepoDigests must name that exact artifact, and the runtime checks below
  # authenticate its architecture and PostgreSQL/Alpine/pgvector contract.
  # A privileged Docker administrator remains the explicit trust boundary.
  if [[ "$configured" != "$image" ]] &&
     ! jq -e --arg image "$image" 'index($image) != null' >/dev/null <<< "$repo_digests"; then
    die "$container does not resolve to the allowed $kind image"
  fi

  [[ $(sql "$container" noosphere 'SHOW server_version;') == "$EXPECTED_POSTGRES_VERSION" ]] ||
    die "$container PostgreSQL version mismatch"
  local alpine
  alpine=$(docker exec "$container" cat /etc/alpine-release)
  if [[ "$kind" == candidate ]]; then
    [[ "$alpine" == "$EXPECTED_CANDIDATE_ALPINE_VERSION" ]] || die "$container Alpine version mismatch"
    [[ $(sql "$container" noosphere "SELECT default_version FROM pg_available_extensions WHERE name='vector';") == "$EXPECTED_PGVECTOR_VERSION" ]] ||
      die "$container pgvector availability mismatch"
  else
    [[ "$alpine" == "$EXPECTED_SOURCE_ALPINE_VERSION" ]] || die "$container source Alpine version mismatch"
    [[ -z $(sql "$container" noosphere "SELECT default_version FROM pg_available_extensions WHERE name='vector';") ]] ||
      die "$container source image unexpectedly provides pgvector"
  fi
  [[ "$check_cluster" == false ]] || assert_cluster_vector_absent "$container"
}

assert_baseline() {
  local container=$1 expected_volume=$2 expected_data=$3 expected_schema=$4 expected_migrations=$5 expected_database=$6
  assert_volume_contract "$expected_volume" >/dev/null
  assert_volume_consumers "$container"
  assert_container_volume_mount "$container"
  [[ $(data_signature "$container") == "$expected_data" ]] || die "$container data digest changed"
  [[ $(schema_signature "$container") == "$expected_schema" ]] || die "$container schema digest changed"
  [[ $(migration_signature "$container") == "$expected_migrations" ]] || die "$container migration history changed"
  [[ $(database_identity "$container") == "$expected_database" ]] || die "$container database identity changed"
}

start_maintenance() {
  local container=$1 image=$2
  assert_volume_consumers
  docker run -d --name "$container" --label "$LABEL_KEY=$run_id" --platform "$platform" --network none \
    -v "$volume:/var/lib/postgresql/data" "$image" >/dev/null
  wait_postgres "$container"
  assert_volume_consumers "$container"
}

stop_remove() {
  local container=$1
  docker inspect "$container" >/dev/null 2>&1 || return 0
  [[ $(docker inspect "$container" --format "{{index .Config.Labels \"$LABEL_KEY\"}}") == "$run_id" ]] ||
    die "refusing unlabelled container removal: $container"
  docker stop --time 60 "$container" >/dev/null
  docker rm "$container" >/dev/null
  assert_volume_consumers
}

compose_up_db() {
  local base=$1 override=${2:-}
  compose_args "$base"
  [[ -z "$override" ]] || COMPOSE_ARGS+=(-f "$override")
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --force-recreate "$db_service"
  wait_postgres "$db_container"
  assert_volume_consumers "$db_container"
}

restart_app() {
  [[ "$app_was_running" == true ]] || return 0
  compose_args "$compose_file"
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --force-recreate app >/dev/null
  for _ in $(seq 1 45); do
    status=$(docker inspect "$app_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
    [[ "$status" == healthy || "$status" == running ]] && return 0
    sleep 2
  done
  die "$app_container did not recover"
}

load_journal_baseline() {
  expected_volume=$(jq -er '.volumeFingerprint' "$journal")
  expected_data=$(jq -r '.dataSignature // empty' "$journal")
  expected_schema=$(jq -r '.schemaSignature // empty' "$journal")
  expected_migrations=$(jq -r '.migrationSignature // empty' "$journal")
  expected_database=$(jq -r '.databaseIdentity // empty' "$journal")
  original_compose=$(jq -r '.originalCompose // empty' "$journal")
  candidate_compose=$(jq -r '.candidateCompose // empty' "$journal")
  source_override=$(jq -r '.sourceOverride // empty' "$journal")
  run_id=$(jq -er '.runId' "$journal")
  probe_database=$(jq -er '.probeDatabase' "$journal")
  app_was_running=$(jq -r '.appWasRunning // false' "$journal")
}

attempt_source_recovery() (
  trap - ERR
  set -Eeuo pipefail
  load_journal_baseline
  local maintenance="noosphere-a2b-source-${run_id}" current staged recovery_restore_volume labels

  # `recovered` is the durable rollback commit boundary. The source database,
  # marker, and desired state were already authenticated before this phase was
  # written. A writer may have accepted legitimate data after its restart, so a
  # resume verifies identities only and must never compare stale pre-restart
  # content signatures or restore the old backup.
  if [[ "$journal_phase" == recovered ]]; then
    if docker inspect "$app_container" >/dev/null 2>&1 &&
       [[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]; then
      docker stop --time 60 "$app_container" >/dev/null
    fi
    [[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] ||
      die 'recovered source database is not running'
    assert_volume_contract "$expected_volume" >/dev/null
    assert_volume_consumers "$db_container"
    assert_container_volume_mount "$db_container"
    assert_image_identity "$db_container" "$SOURCE_IMAGE" source false
    assert_compose_authorization_gate "$SOURCE_IMAGE"
    assert_stale_authorization_volume "$restart_app_after_switch"
    if [[ "$restart_app_after_switch" == true ]]; then
      restart_app
      phase_checkpoint recovery-writer-restarted || return $?
    elif docker inspect "$app_container" >/dev/null 2>&1; then
      [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
        die 'deferred source app writer restarted unexpectedly'
    fi
    return 0
  fi

  if docker inspect "$app_container" >/dev/null 2>&1; then
    if [[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]]; then
      if ! docker stop --time 60 "$app_container" >/dev/null; then
        docker kill "$app_container" >/dev/null 2>&1 || true
      fi
    fi
    [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
      die 'app writer remained running at the recovery boundary'
  fi
  phase_checkpoint recovery-writer-stopped || return $?
  if docker inspect "$db_container" >/dev/null 2>&1; then
    assert_volume_contract "$expected_volume" >/dev/null
    assert_volume_consumers "$db_container"
    assert_container_volume_mount "$db_container"
    docker stop --time 60 "$db_container" >/dev/null
    docker rm "$db_container" >/dev/null
  fi
  for current in $(docker ps -aq --filter "label=$LABEL_KEY=$run_id"); do
    docker stop --time 60 "$current" >/dev/null 2>&1
    docker rm "$current" >/dev/null 2>&1
  done
  recovery_restore_volume="noosphere_a2b_restore_${run_id//-/_}"
  if docker volume inspect "$recovery_restore_volume" >/dev/null 2>&1; then
    labels=$(docker volume inspect "$recovery_restore_volume" --format '{{json .Labels}}')
    jq -e --arg key "$LABEL_KEY" --arg run "$run_id" '.[$key] == $run' >/dev/null <<< "$labels" ||
      die 'restore-test volume has invalid recovery ownership'
    [[ -z $(docker ps -aq --no-trunc --filter "volume=$recovery_restore_volume") ]] ||
      die 'restore-test volume still has a recovery consumer'
    docker volume rm "$recovery_restore_volume" >/dev/null
  fi
  start_maintenance "$maintenance" "$SOURCE_IMAGE"
  assert_image_identity "$maintenance" "$SOURCE_IMAGE" source
  if [[ -n "${expected_data:-}" ]]; then
    assert_baseline "$maintenance" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
  fi
  stop_remove "$maintenance"
  # Rebind the shared authorization marker before starting the restored
  # Compose desired state. Candidate Compose still rejects this source digest,
  # while a source-staged gate remains restartable after recovery.
  authorize_source_marker
  compose_up_db "$original_compose" "$source_override"
  assert_image_identity "$db_container" "$SOURCE_IMAGE" source
  if [[ -n "${expected_data:-}" ]]; then
    assert_baseline "$db_container" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
  fi
  # Restore the source desired state if the interruption happened after the
  # candidate Compose file was promoted.
  staged="$compose_file.phase-a2b-recovery-$run_id"
  install -m "$(stat -c '%a' "$compose_file")" "$original_compose" "$staged"
  fsync_path "$staged"
  mv -f "$staged" "$compose_file"
  fsync_path "$(dirname "$compose_file")"
  update_journal recovered || return $?
  if [[ "$restart_app_after_switch" == true ]]; then
    restart_app
    if [[ "$app_was_running" == true ]]; then
      [[ $(docker inspect "$app_container" --format '{{.State.Running}}') == true ]] ||
        die 'source app writer did not restart after verified recovery'
    fi
    phase_checkpoint recovery-writer-restarted || return $?
  elif docker inspect "$app_container" >/dev/null 2>&1; then
    [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
      die 'deferred source app writer restarted unexpectedly'
  fi
)

recover_source() {
  local reason=$1 recovery_ok=false recovery_run_id recovered_journal
  rollback_active=true
  app_was_running=$(jq -r '.appWasRunning // false' "$journal" 2>/dev/null || printf false)
  recovery_run_id=$(jq -r '.runId // "unknown"' "$journal" 2>/dev/null || printf unknown)
  log "recovering exact source after: $reason"
  if attempt_source_recovery; then
    recovery_ok=true
  fi
  if [[ "$recovery_ok" == true ]]; then
    recovered_journal="$journal.recovered-$recovery_run_id"
    mv -f "$journal" "$recovered_journal"
    fsync_path "$(dirname "$journal")"
    log "source rollback verified; rerun the guarded switch from a fresh journal"
    log "recovery evidence: $recovered_journal"
  else
    log 'source rollback could not be verified; database mutation did not proceed without a proven writer stop'
    log "manual recovery evidence: $journal"
  fi
  exit 1
}

on_error() {
  local line=$1 status=$2 durable_phase=$journal_phase
  [[ "$operation_complete" == true || "$rollback_active" == true || ! -f "$journal" ]] && exit "$status"
  durable_phase=$(jq -r '.phase // empty' "$journal" 2>/dev/null || printf '%s' "$journal_phase")
  if [[ "$durable_phase" == complete ]]; then
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
    log "completed evidence could not be re-verified; app writer remains stopped (failure near line $line)"
    exit "$status"
  fi
  if [[ "$mode" != switch || "$journal_mode" == new-install ]]; then
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
    log "new-install evidence remains incomplete; app writer remains stopped (failure near line $line)"
    exit "$status"
  fi
  if [[ "$journal_validated" != true ]]; then
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
    log "transition evidence could not be validated; app writer remains stopped (failure near line $line)"
    exit "$status"
  fi
  recover_source "failure near line $line (exit $status)"
}
trap 'on_error "$LINENO" "$?"' ERR
fail_closed_on_die=true

if [[ -f "$journal" ]]; then
  validate_journal
  if [[ "$journal_mode" == switch ]]; then
    [[ "$mode" == switch || "$mode" == authorize-writer ]] ||
      die 'switch evidence cannot be used by a new-install operation'
    if [[ "$journal_phase" != complete ]]; then
      [[ "$mode" == switch ]] || die 'writer authorization requires complete switch evidence'
      recover_source "incomplete prior journal phase $journal_phase"
    fi
    assert_candidate_authorization_gate
    current_app_was_running=false
    if docker inspect "$app_container" >/dev/null 2>&1; then
      current_app_was_running=$(docker inspect "$app_container" --format '{{.State.Running}}')
    fi
    [[ "$mode" != authorize-writer || "$current_app_was_running" == false ]] ||
      die 'writer authorization requires the app container to remain stopped'
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
    if docker inspect "$app_container" >/dev/null 2>&1; then
      [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
        die 'app writer remained running during completed-evidence verification'
    fi
    revoke_writer_marker
    load_journal_baseline
    assert_volume_contract "$expected_volume" >/dev/null
    [[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] || die 'completed evidence exists but database is not running'
    assert_image_identity "$db_container" "$CANDIDATE_IMAGE" candidate false
    assert_volume_consumers "$db_container"
    assert_container_volume_mount "$db_container"
    if [[ "$mode" == authorize-writer || "$restart_app_after_switch" == true ]]; then
      authorize_writer_marker
    fi
    operation_complete=true
    trap - ERR
    [[ "$mode" == authorize-writer ]] || app_was_running=$current_app_was_running
    [[ "$mode" == authorize-writer || "$restart_app_after_switch" == false ]] || restart_app
    log "existing candidate matches completed evidence: $journal"
    exit 0
  fi

  if [[ "$journal_phase" == complete ]]; then
    [[ "$mode" == switch || "$mode" == record-new-install || "$mode" == authorize-writer ]] ||
      die 'completed new-install evidence cannot be used by this operation'
    assert_candidate_authorization_gate
    current_app_was_running=false
    if docker inspect "$app_container" >/dev/null 2>&1; then
      current_app_was_running=$(docker inspect "$app_container" --format '{{.State.Running}}')
    fi
    [[ "$mode" != authorize-writer || "$current_app_was_running" == false ]] ||
      die 'writer authorization requires the app container to remain stopped'
    [[ "$mode" != switch ]] || app_was_running=$current_app_was_running
    docker stop --time 60 "$app_container" >/dev/null 2>&1 || true
    if docker inspect "$app_container" >/dev/null 2>&1; then
      [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
        die 'app writer remained running during completed new-install verification'
    fi
    revoke_writer_marker
    [[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] || die 'completed new-install evidence exists but database is not running'
    assert_image_identity "$db_container" "$CANDIDATE_IMAGE" candidate false
    assert_volume_consumers "$db_container"
    assert_container_volume_mount "$db_container"
    if [[ "$mode" == authorize-writer || "$restart_app_after_switch" == true ]]; then
      authorize_writer_marker
    fi
    operation_complete=true
    trap - ERR
    if [[ "$mode" == switch ]]; then
      [[ "$restart_app_after_switch" == false ]] || restart_app
    fi
    log "existing candidate matches completed new-install evidence: $journal"
    exit 0
  fi
fi

if [[ "$mode" == prepare-new-install ]]; then
  assert_candidate_authorization_gate
  if [[ ! -f "$journal" ]]; then
    docker inspect "$db_container" >/dev/null 2>&1 && die 'new-install database container already exists without a durable claim'
    docker inspect "$app_container" >/dev/null 2>&1 && die 'new-install app container already exists without a durable claim'
    docker volume inspect "$volume" >/dev/null 2>&1 && die 'PostgreSQL volume already exists without a durable new-install claim'
    docker volume inspect "$authorization_volume" >/dev/null 2>&1 &&
      die 'candidate-authorization volume already exists without a durable new-install claim'
    [[ $(compose_db_image "$compose_file") == "$CANDIDATE_IMAGE" ]] || die 'new-install Compose must resolve to the candidate image'
    platform=${platform:-$(engine_platform)}
    [[ "$platform" =~ ^linux/(amd64|arm64)$ ]] || die "unsupported platform: $platform"
    run_id="new-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    probe_database=$(probe_database_for_run "$run_id")
    temp=$(mktemp "$backup_dir/.new-install-claim.XXXXXX")
    jq -n --arg phase claim-created --arg mode new-install --arg runId "$run_id" \
      --arg volume "$volume" --arg candidateImage "$CANDIDATE_IMAGE" --arg platform "$platform" \
      --arg authorizationVolume "$authorization_volume" \
      --arg dockerEngineId "$engine_id" --arg dockerEndpoint "$docker_host" \
      --arg probeDatabase "$probe_database" \
      --arg composeFile "$compose_file" --arg dbService "$db_service" \
      --arg dbContainer "$db_container" --arg appContainer "$app_container" \
      '{phase:$phase,mode:$mode,runId:$runId,volume:$volume,authorizationVolume:$authorizationVolume,candidateImage:$candidateImage,
        platform:$platform,dockerEngineId:$dockerEngineId,dockerEndpoint:$dockerEndpoint,
        probeDatabase:$probeDatabase,composeFile:$composeFile,dbService:$dbService,
        dbContainer:$dbContainer,appContainer:$appContainer}' > "$temp"
    write_json_atomic "$journal" "$temp"
    rm -f "$temp"
    validate_journal
    phase_checkpoint claim-created
  fi

  [[ "$journal_mode" == new-install ]] || die 'new-install preparation found evidence for another operation'
  [[ "$journal_phase" == claim-created || "$journal_phase" == provisioning ]] ||
    die "new-install preparation cannot resume phase $journal_phase"
  run_id=$(jq -er '.runId' "$journal")
  if [[ "$journal_phase" == claim-created ]]; then
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume create --driver local \
        --label "$NEW_INSTALL_LABEL_KEY=$run_id" \
        --label "$NEW_INSTALL_IMAGE_LABEL_KEY=$CANDIDATE_IMAGE" \
        "$volume" >/dev/null
      phase_checkpoint new-install-volume-created
    fi
    expected_volume=$(assert_new_install_volume_claim '')
    assert_volume_consumers
    expected_authorization=$(create_authorization_volume)
    phase_checkpoint new-install-authorization-created
    temp=$(mktemp "$backup_dir/.new-install-provisioning.XXXXXX")
    jq --arg phase provisioning --arg volumeFingerprint "$expected_volume" \
      --arg authorizationVolumeFingerprint "$expected_authorization" \
      '.phase=$phase | .volumeFingerprint=$volumeFingerprint |
        .authorizationVolumeFingerprint=$authorizationVolumeFingerprint' "$journal" > "$temp"
    write_json_atomic "$journal" "$temp"
    rm -f "$temp"
    validate_journal
    phase_checkpoint provisioning
  fi

  if docker inspect "$app_container" >/dev/null 2>&1; then
    [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
      die 'app writer must remain stopped until new-install evidence is complete'
  fi
  if docker inspect "$db_container" >/dev/null 2>&1; then
    [[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] ||
      die 'prepared new-install database container exists but is not running'
    assert_image_identity "$db_container" "$CANDIDATE_IMAGE" candidate
    assert_volume_consumers "$db_container"
    assert_container_volume_mount "$db_container"
  else
    assert_volume_consumers
  fi
  operation_complete=true
  trap - ERR
  log "new-install volume claim prepared: $journal"
  exit 0
fi

if [[ "$mode" == record-new-install ]]; then
  assert_candidate_authorization_gate
  [[ -f "$journal" && "$journal_mode" == new-install && "$journal_phase" == provisioning ]] ||
    die 'new-install finalization requires prepared provisioning evidence'
  if docker inspect "$app_container" >/dev/null 2>&1; then
    [[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
      die 'app writer must remain stopped until new-install evidence is complete'
  fi
  [[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] || die 'new-install database is not running'
  platform=$(jq -er '.platform' "$journal")
  expected_volume=$(jq -er '.volumeFingerprint' "$journal")
  assert_new_install_volume_claim "$expected_volume" >/dev/null
  assert_volume_consumers "$db_container"
  assert_container_volume_mount "$db_container"
  assert_image_identity "$db_container" "$CANDIDATE_IMAGE" candidate
  data=$(data_signature "$db_container")
  schema=$(schema_signature "$db_container")
  migrations=$(migration_signature "$db_container")
  database=$(database_identity "$db_container")
  temp=$(mktemp "$backup_dir/.new-install.XXXXXX")
  jq --arg phase complete --arg dataSignature "$data" --arg schemaSignature "$schema" \
    --arg migrationSignature "$migrations" --arg databaseIdentity "$database" \
    '.phase=$phase | .dataSignature=$dataSignature | .schemaSignature=$schemaSignature |
      .migrationSignature=$migrationSignature | .databaseIdentity=$databaseIdentity' "$journal" > "$temp"
  write_json_atomic "$journal" "$temp"
  rm -f "$temp"
  validate_journal
  phase_checkpoint complete
  [[ "$restart_app_after_switch" == false ]] || authorize_writer_marker
  operation_complete=true
  trap - ERR
  log "new-install evidence recorded: $journal"
  exit 0
fi

[[ "$mode" == switch ]] || die "unsupported operation mode: $mode"

[[ ! -f "$journal" ]] || die 'completed evidence exists; current state should have returned earlier'
[[ $(docker inspect "$db_container" --format '{{.State.Running}}') == true ]] || die 'source database must be running'
docker inspect "$app_container" >/dev/null 2>&1 || die 'managed app container must exist before the switch'
app_was_running=$(docker inspect "$app_container" --format '{{.State.Running}}')
[[ "$app_was_running" == true || "$app_was_running" == false ]] || die 'app container has an invalid running state'
platform=${platform:-$(container_platform "$db_container")}
[[ "$platform" =~ ^linux/(amd64|arm64)$ ]] || die "unsupported platform: $platform"
assert_container_volume_mount "$db_container"
assert_image_identity "$db_container" "$SOURCE_IMAGE" source false
expected_volume=$(assert_volume_contract)
assert_volume_consumers "$db_container"
assert_candidate_authorization_gate
stale_authorization_volume=false
if docker volume inspect "$authorization_volume" >/dev/null 2>&1; then
  # A stopped managed writer may legitimately be resuming an installer-owned
  # deferred recovery, where the source gate is present but writer permission
  # intentionally is not. Bind the stale-marker expectation to observed app
  # state instead of accidentally re-authorizing it here.
  assert_stale_authorization_volume "$app_was_running"
  stale_authorization_volume=true
fi

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
probe_database=$(probe_database_for_run "$run_id")
[[ $(sql "$db_container" postgres "SELECT count(*) FROM pg_database WHERE datname = '$probe_database';") == 0 ]] ||
  die 'generated template0 probe claim collides with an existing database'
run_dir="$backup_dir/phase-a2b-$run_id"
install -d -m 700 "$run_dir"
original_compose="$run_dir/original-compose.yml"
candidate_compose="$run_dir/candidate-compose.yml"
source_override="$run_dir/source-override.yml"
backup_file="$run_dir/noosphere.dump"
# Normalize both desired states to immutable references. Legacy installs may
# still contain the old mutable source tag; a rollback must never restore that
# ambiguity after the running source artifact has been authenticated.
stage_compose_image "$compose_file" "$original_compose" "$SOURCE_IMAGE"
stage_compose_image "$compose_file" "$candidate_compose" "$CANDIDATE_IMAGE"
write_override "$source_override" "$SOURCE_IMAGE"
fsync_path "$run_dir"
original_compose_sha=$(sha256_file "$original_compose")
candidate_compose_sha=$(sha256_file "$candidate_compose")
source_override_sha=$(sha256_file "$source_override")

temp=$(mktemp "$backup_dir/.journal.XXXXXX")
jq -n --arg phase preparing --arg mode switch --arg runId "$run_id" --arg volume "$volume" \
  --arg volumeFingerprint "$expected_volume" --arg sourceImage "$SOURCE_IMAGE" --arg candidateImage "$CANDIDATE_IMAGE" \
  --arg originalCompose "$original_compose" --arg candidateCompose "$candidate_compose" --arg sourceOverride "$source_override" \
  --arg originalComposeSha256 "$original_compose_sha" --arg candidateComposeSha256 "$candidate_compose_sha" \
  --arg sourceOverrideSha256 "$source_override_sha" --arg composeFile "$compose_file" --arg dbService "$db_service" \
  --arg dbContainer "$db_container" --arg appContainer "$app_container" --arg platform "$platform" \
  --arg authorizationVolume "$authorization_volume" --arg probeDatabase "$probe_database" \
  --arg dockerEngineId "$engine_id" --arg dockerEndpoint "$docker_host" \
  --argjson appWasRunning "$app_was_running" \
  '{phase:$phase,mode:$mode,runId:$runId,volume:$volume,appWasRunning:$appWasRunning,volumeFingerprint:$volumeFingerprint,
    sourceImage:$sourceImage,candidateImage:$candidateImage,originalCompose:$originalCompose,
    candidateCompose:$candidateCompose,sourceOverride:$sourceOverride,originalComposeSha256:$originalComposeSha256,
    candidateComposeSha256:$candidateComposeSha256,sourceOverrideSha256:$sourceOverrideSha256,composeFile:$composeFile,
    dbService:$dbService,dbContainer:$dbContainer,appContainer:$appContainer,platform:$platform,
    dockerEngineId:$dockerEngineId,dockerEndpoint:$dockerEndpoint,probeDatabase:$probeDatabase,
    authorizationVolume:$authorizationVolume}' > "$temp"
write_json_atomic "$journal" "$temp"
rm -f "$temp"
validate_journal
phase_checkpoint preparing

if [[ "$app_was_running" == true ]]; then
  docker stop --time 60 "$app_container" >/dev/null
fi
[[ $(docker inspect "$app_container" --format '{{.State.Running}}') != true ]] ||
  die 'app writer remained running before offline database verification'
assert_image_identity "$db_container" "$SOURCE_IMAGE" source
docker stop --time 60 "$db_container" >/dev/null
docker rm "$db_container" >/dev/null
assert_volume_consumers
if [[ "$stale_authorization_volume" == true ]]; then
  if docker inspect "$app_container" >/dev/null 2>&1 &&
     docker inspect "$app_container" | jq -e --arg authorization "$authorization_volume" \
       '[.[0].Mounts[] | select(.Type == "volume" and .Name == $authorization)] | length == 1' >/dev/null; then
    docker rm "$app_container" >/dev/null
  fi
  [[ -z $(authorization_volume_consumers) ]] || die 'stale authorization volume remained consumed after database stop'
  docker volume rm "$authorization_volume" >/dev/null
fi

source_maintenance="noosphere-a2b-source-$run_id"
candidate_maintenance="noosphere-a2b-candidate-$run_id"
rollback_maintenance="noosphere-a2b-rollback-$run_id"
final_maintenance="noosphere-a2b-final-$run_id"
restore_container="noosphere-a2b-restore-$run_id"
restore_volume="noosphere_a2b_restore_${run_id//-/_}"

start_maintenance "$source_maintenance" "$SOURCE_IMAGE"
assert_image_identity "$source_maintenance" "$SOURCE_IMAGE" source
expected_data=$(data_signature "$source_maintenance")
expected_schema=$(schema_signature "$source_maintenance")
expected_migrations=$(migration_signature "$source_maintenance")
expected_database=$(database_identity "$source_maintenance")

backup_temp="$run_dir/.noosphere.dump.tmp"
docker exec "$source_maintenance" pg_dump -U noosphere -d noosphere -Fc --no-owner --no-privileges > "$backup_temp"
[[ -s "$backup_temp" ]] || die 'logical backup is empty'
docker exec -i "$source_maintenance" pg_restore --list < "$backup_temp" >/dev/null
fsync_path "$backup_temp"
mv "$backup_temp" "$backup_file"
fsync_path "$run_dir"
backup_sha=$(sha256sum "$backup_file" | awk '{print $1}')

temp=$(mktemp "$backup_dir/.journal.XXXXXX")
jq --arg phase baseline-recorded --arg data "$expected_data" --arg schema "$expected_schema" \
  --arg migrations "$expected_migrations" --arg database "$expected_database" --arg backup "$backup_file" \
  --arg backupSha256 "$backup_sha" \
  '.phase=$phase | .dataSignature=$data | .schemaSignature=$schema | .migrationSignature=$migrations |
   .databaseIdentity=$database | .backup=$backup | .backupSha256=$backupSha256' "$journal" > "$temp"
write_json_atomic "$journal" "$temp"
rm -f "$temp"
[[ $(sha256_file "$backup_file") == "$backup_sha" ]] || die 'logical backup digest changed before restore test'
stop_remove "$source_maintenance"

docker volume create --driver local --label "$LABEL_KEY=$run_id" "$restore_volume" >/dev/null
docker run -d --name "$restore_container" --label "$LABEL_KEY=$run_id" --platform "$platform" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=noosphere -e POSTGRES_DB=noosphere \
  -v "$restore_volume:/var/lib/postgresql/data" "$CANDIDATE_IMAGE" >/dev/null
wait_postgres "$restore_container"
assert_image_identity "$restore_container" "$CANDIDATE_IMAGE" candidate
docker exec -i "$restore_container" pg_restore -U noosphere -d noosphere --clean --if-exists --no-owner --no-privileges < "$backup_file"
[[ $(data_signature "$restore_container") == "$expected_data" ]] || die 'restored backup data digest mismatch'
[[ $(schema_signature "$restore_container") == "$expected_schema" ]] || die 'restored backup schema digest mismatch'
[[ $(migration_signature "$restore_container") == "$expected_migrations" ]] || die 'restored backup migration mismatch'
[[ $(database_identity "$restore_container") == "$expected_database" ]] || die 'restored backup database identity mismatch'
docker stop --time 60 "$restore_container" >/dev/null
docker rm "$restore_container" >/dev/null
docker volume rm "$restore_volume" >/dev/null
update_journal backup-restored

start_maintenance "$candidate_maintenance" "$CANDIDATE_IMAGE"
assert_image_identity "$candidate_maintenance" "$CANDIDATE_IMAGE" candidate
assert_baseline "$candidate_maintenance" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
stop_remove "$candidate_maintenance"
update_journal candidate-verified

start_maintenance "$rollback_maintenance" "$SOURCE_IMAGE"
assert_image_identity "$rollback_maintenance" "$SOURCE_IMAGE" source
assert_baseline "$rollback_maintenance" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
stop_remove "$rollback_maintenance"
update_journal source-rollback-verified

start_maintenance "$final_maintenance" "$CANDIDATE_IMAGE"
assert_image_identity "$final_maintenance" "$CANDIDATE_IMAGE" candidate
assert_baseline "$final_maintenance" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
stop_remove "$final_maintenance"
update_journal final-candidate-maintenance-verified

authorization_fingerprint=$(create_authorization_volume)
temp=$(mktemp "$backup_dir/.journal.XXXXXX")
jq --arg phase candidate-authorized --arg authorizationVolumeFingerprint "$authorization_fingerprint" \
  '.phase=$phase | .authorizationVolumeFingerprint=$authorizationVolumeFingerprint' "$journal" > "$temp"
write_json_atomic "$journal" "$temp"
rm -f "$temp"
validate_journal
phase_checkpoint candidate-authorized

compose_up_db "$candidate_compose"
assert_image_identity "$db_container" "$CANDIDATE_IMAGE" candidate
assert_baseline "$db_container" "$expected_volume" "$expected_data" "$expected_schema" "$expected_migrations" "$expected_database"
update_journal candidate-online-verified

staged="$compose_file.phase-a2b-$run_id"
install -m "$(stat -c '%a' "$compose_file")" "$candidate_compose" "$staged"
fsync_path "$staged"
mv -f "$staged" "$compose_file"
fsync_path "$(dirname "$compose_file")"
log "promoted candidate Compose: $compose_file"

# Commit while writers are stopped. Future legitimate writes may change the
# baseline digests, so reruns trust this durable proof plus the bound volume and
# exact candidate image rather than comparing stale application data.
update_journal complete
[[ "$restart_app_after_switch" == false ]] || authorize_writer_marker

operation_complete=true
trap - ERR
[[ "$restart_app_after_switch" == false ]] || restart_app
log "PASS: source -> candidate -> source -> candidate preserved the live volume"
log "backup: $backup_file"
log "evidence: $journal"
