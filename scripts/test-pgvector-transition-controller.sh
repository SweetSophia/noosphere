#!/usr/bin/env bash
set -Eeuo pipefail
# Keep synthetic fixture inputs deterministic across interactive shells and
# user-manager supervisors. Security-negative owners set unsafe modes explicitly.
umask 0022
# A failed unguarded command under `set -e` aborts the whole suite silently;
# surface the exact offending command instead (R3-6 reconciliation).
trap 'printf "fixture: unguarded command failed: %s (rc=%d)\n" "$BASH_COMMAND" "$?" >&2' ERR

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTROLLER=${PGVECTOR_CONTROLLER_FIXTURE_SCRIPT:-"$ROOT_DIR/scripts/run-pgvector-transition-controller.sh"}
SYSTEMD_FIXTURE="$ROOT_DIR/scripts/test-pgvector-transition-controller-systemd.sh"
DOCKER_FIXTURE="$ROOT_DIR/scripts/test-pgvector-transition-controller-docker.sh"

[[ -f "$CONTROLLER" ]] || {
  echo "Missing transition controller: $CONTROLLER" >&2
  exit 1
}

# Isolate durable state-authority records from the invoking user's real XDG
# state namespace: the controller honors XDG_STATE_HOME, so every fixture in
# this suite claims and reclaims authority inside this disposable root.
XDG_STATE_HOME=$(mktemp -d)
export XDG_STATE_HOME
trap 'rm -rf -- "$XDG_STATE_HOME"' EXIT

extract_function() {
  local name=$1 definition
  definition=$(
    awk -v signature="${name}() {" '
      $0 == signature { emit = 1 }
      emit { print }
      emit && $0 == "}" { exit }
    ' "$CONTROLLER"
  )
  [[ -n "$definition" ]] || {
    echo "Missing controller helper: $name" >&2
    exit 1
  }
  printf '%s\n' "$definition"
}

cleanup_state_authority_record() {
  local runtime_root=$1 authority=$2
  case "$authority" in
    "$runtime_root"/noosphere-pgvector-state-*.json) ;;
    *) echo "Refusing unexpected fixture authority path: $authority" >&2; return 1 ;;
  esac
  if [[ -e "$authority" ]]; then
    [[ -f "$authority" && ! -L "$authority" ]] || {
      echo "Fixture authority record is not a safe regular file: $authority" >&2
      return 1
    }
    rm -f -- "$authority"
  fi
  [[ ! -e "$authority" ]] || {
    echo "Fixture authority record remains after cleanup: $authority" >&2
    return 1
  }
}

test_atomic_controller_state() (
  local fixture_dir state temp fsync_log
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  temp="$fixture_dir/state.tmp"
  fsync_log="$fixture_dir/fsync.log"

  eval "$(extract_function path_present)"
  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function write_controller_state_atomic)"

  fsync_path() {
    printf '%s\n' "$1" >> "$fsync_log"
  }
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }

  printf '{"phase":"prepared"}\n' > "$temp"
  write_controller_state_atomic "$state" "$temp"

  [[ $(stat -c '%a' "$state") == 600 ]]
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(sed -n '1p' "$fsync_log") == "$state.tmp" || -s "$fsync_log" ]]
  [[ $(tail -n 1 "$fsync_log") == "$fixture_dir" ]]
)

test_source_restore_without_guard_journal() (
  local fixture_dir live source expected_source
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  printf 'candidate\n' > "$live"
  printf 'source\n' > "$source"
  chmod 0644 "$live" "$source"
  expected_source=$(sha256sum "$source" | awk '{print $1}')

  eval "$(extract_function path_present)"
  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function sha256_file)"
  eval "$(extract_function restore_source_without_guard_journal)"

  fsync_path() { :; }
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }
  assert_source_state_unchanged() { :; }

  restore_source_without_guard_journal "$live" "$source" "$expected_source"
  [[ $(<"$live") == source ]]
  [[ $(stat -c '%a' "$live") == 644 ]]
)

test_execution_environment_is_hermetic() (
  eval "$(extract_function sanitize_execution_environment)"

  export DOCKER_CONTEXT=hostile DOCKER_CONFIG=/tmp/hostile
  export COMPOSE_FILE=wrong.yml COMPOSE_PROJECT_NAME=wrong
  export COMPOSE_PROFILES=hybrid COMPOSE_ENV_FILES=wrong.env
  export COMPOSE_PROJECT_DIR=/tmp/wrong COMPOSE_PATH_SEPARATOR=';'

  sanitize_execution_environment \
    unix:///var/run/docker.sock /opt/noosphere-tools /tmp/controller-home

  [[ ${DOCKER_HOST:-} == unix:///var/run/docker.sock ]]
  [[ -z ${DOCKER_CONTEXT:-} ]]
  [[ ${DOCKER_CONFIG:-} == /tmp/controller-home/docker ]]
  [[ ${COMPOSE_DISABLE_ENV_FILE:-} == 1 ]]
  [[ -z ${COMPOSE_FILE:-}${COMPOSE_PROJECT_NAME:-}${COMPOSE_PROFILES:-} ]]
  [[ -z ${COMPOSE_ENV_FILES:-}${COMPOSE_PROJECT_DIR:-}${COMPOSE_PATH_SEPARATOR:-} ]]
  [[ $PATH == /opt/noosphere-tools ]]
)

test_closure_failure_classification() (
  eval "$(extract_function classify_closure_failure)"

  [[ $(classify_closure_failure app-health 0) == completed-journal-revalidate ]]
  [[ $(classify_closure_failure identity 0) == incident-stop-app ]]
  [[ $(classify_closure_failure extension 0) == incident-stop-app ]]
  [[ $(classify_closure_failure counts 0) == incident-stop-app ]]
  [[ $(classify_closure_failure infrastructure 0) == incident-stop-app ]]
  [[ $(classify_closure_failure app-health 1) == incident-stop-app ]]
)

test_signal_handler_is_idempotent() (
  local fixture_dir count_file
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  count_file="$fixture_dir/cleanup-count"
  printf '0\n' > "$count_file"

  eval "$(extract_function forward_latched_signal_to_active_child)"
  eval "$(extract_function handle_controller_signal)"

  controller_signal_active=false
  controller_signal=''
  guard_pid=''
  persist_interrupted_state() {
    local count
    count=$(<"$count_file")
    printf '%s\n' "$((count + 1))" > "$count_file"
  }

  handle_controller_signal TERM
  handle_controller_signal TERM
  [[ $(<"$count_file") == 1 ]]
  [[ "$controller_signal" == TERM ]] || {
    echo 'signal handler did not latch the first signal for phase-boundary enforcement' >&2
    exit 1
  }
)

write_fixture_controller_state() {
  local target=$1 phase=$2 live_compose=$3 source_snapshot=$4 source_sha=$5 guard_journal=$6
  local candidate_sha
  if [[ -f "$live_compose" ]]; then
    candidate_sha=$(sha256sum "$live_compose" | awk '{print $1}')
  else
    candidate_sha=$(printf 'c%.0s' {1..64})
  fi
  jq -n \
    --arg phase "$phase" \
    --arg liveCompose "$live_compose" \
    --arg sourceSnapshot "$source_snapshot" \
    --arg sourceSnapshotSha256 "$source_sha" \
    --arg candidateComposeSha256 "$candidate_sha" \
    --arg guardJournal "$guard_journal" \
    '{
      version: 1,
      phase: $phase,
      engineId: "fixture-engine",
      dockerEndpoint: "unix:///fixture/docker.sock",
      volume: "fixture-volume",
      appContainer: "fixture-app",
      liveCompose: $liveCompose,
      sourceSnapshot: $sourceSnapshot,
      sourceSnapshotSha256: $sourceSnapshotSha256,
      candidateComposeSha256: $candidateComposeSha256,
      guardJournal: $guardJournal
    }' > "$target"
  chmod 0600 "$target"
}

test_reboot_recovers_prejournal_candidate_publication() (
  local fixture_dir state live source guard_journal source_sha
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  printf 'candidate\n' > "$live"
  printf 'source\n' > "$source"
  chmod 0644 "$live" "$source"
  source_sha=$(sha256sum "$source" | awk '{print $1}')
  write_fixture_controller_state "$state" candidate-published "$live" "$source" "$source_sha" "$guard_journal"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    restore_source_without_guard_journal restore_source_compose_snapshot resume_controller_state; do
    eval "$(extract_function "$helper")"
  done

  fsync_path() { :; }
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }
  assert_source_state_unchanged() { :; }
  run_source_recovery_verifier_with_evidence() { :; }
  delegate_to_guard_journal() {
    echo 'Unexpected guard-journal delegation' >&2
    exit 1
  }

  resume_controller_state "$state"
  [[ $(<"$live") == source ]]
  [[ $(jq -er '.phase' "$state") == incident ]]
  [[ $(jq -er '.incidentClass' "$state") == pre-journal-source-restored ]]
)

test_valid_guard_journal_suppresses_outer_restore() (
  local fixture_dir state live source guard_journal source_sha delegated
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  delegated="$fixture_dir/delegated"
  printf 'candidate\n' > "$live"
  printf 'source\n' > "$source"
  printf '{"phase":"preparing"}\n' > "$guard_journal"
  chmod 0644 "$live" "$source"
  chmod 0600 "$guard_journal"
  source_sha=$(sha256sum "$source" | awk '{print $1}')
  write_fixture_controller_state "$state" candidate-published "$live" "$source" "$source_sha" "$guard_journal"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    restore_source_without_guard_journal restore_source_compose_snapshot resume_controller_state; do
    eval "$(extract_function "$helper")"
  done

  fsync_path() { :; }
  die() { exit 1; }
  assert_source_state_unchanged() { exit 1; }
  delegate_to_guard_journal() { : > "$delegated"; }

  resume_controller_state "$state"
  [[ -e "$delegated" ]]
  [[ $(<"$live") == candidate ]]
  [[ $(jq -er '.phase' "$state") == candidate-published ]]
)

test_shared_lock_is_inherited() (
  local fixture_dir manifest lock_root lock_path expected_key inherited child_marker
  fixture_dir=$(mktemp -d)
  trap 'exec 8>&-; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  lock_root="$fixture_dir/locks"

  eval "$(extract_function path_present)"
  eval "$(extract_function fsync_path)"
  eval "$(extract_function ensure_regular_lock_file)"
  eval "$(extract_function acquire_operation_lock)"
  eval "$(extract_function assert_operation_lock_held)"
  eval "$(extract_function child_path_for_state)"
  eval "$(extract_function assert_recorded_docker_resolution)"
  eval "$(extract_function forward_latched_signal_to_active_child)"
  eval "$(extract_function wait_for_child_exit)"
  eval "$(extract_function wait_for_process_group_empty)"
  eval "$(extract_function run_guard_with_inherited_lock)"
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }

  active_child_pid=''
  guard_pid=''
  last_guard_pid=0
  acquire_operation_lock fixture-engine fixture-volume "$lock_root"
  expected_key=$(printf '%s\0%s' fixture-engine fixture-volume | sha256sum | awk '{print $1}')
  lock_path="$lock_root/noosphere-pgvector-switch-$expected_key.lock"
  [[ ${NOOSPHERE_A2B_LOCK_FD:-} == 8 ]]
  [[ ${NOOSPHERE_A2B_LOCK_PATH:-} == "$lock_path" ]]
  inherited=$(readlink "/proc/$BASHPID/fd/8")
  [[ "$inherited" == "$lock_path" ]]
  if (exec 9>"$lock_path"; flock -n 9); then
    echo 'Second controller acquired the active engine-volume lock' >&2
    exit 1
  fi
  child_marker="$fixture_dir/child-saw-lock"
  run_guard_with_inherited_lock "$manifest" fixture-engine fixture-volume "$lock_root" \
    bash -c '[[ ${NOOSPHERE_A2B_LOCK_FD:-} == 8 ]] && [[ $(readlink /proc/$$/fd/8) == "$1" ]] && : > "$2"' \
    bash "$lock_path" "$child_marker"
  [[ -e "$child_marker" ]]
)

test_candidate_publication_intent_is_recoverable() (
  local fixture_dir state live source candidate guard_journal source_sha candidate_sha
  fixture_dir=$(mktemp -d)
  trap 'exec 8>&-; rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  candidate="$fixture_dir/candidate-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  printf 'source\n' > "$live"
  printf 'source\n' > "$source"
  printf 'candidate\n' > "$candidate"
  chmod 0644 "$live" "$source" "$candidate"
  source_sha=$(sha256sum "$source" | awk '{print $1}')
  candidate_sha=$(sha256sum "$candidate" | awk '{print $1}')
  write_fixture_controller_state "$state" prepared "$live" "$source" "$source_sha" "$guard_journal"
  jq --arg digest "$candidate_sha" '.candidateComposeSha256 = $digest' "$state" > "$state.next"
  mv "$state.next" "$state"
  chmod 0600 "$state"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    ensure_regular_lock_file acquire_operation_lock assert_operation_lock_held publish_compose_atomic \
    publish_candidate_under_lock; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  acquire_operation_lock fixture-engine fixture-volume "$fixture_dir"
  export NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT=1
  if (publish_candidate_under_lock "$state" "$candidate" "$fixture_dir"); then
    echo 'Injected publication interruption unexpectedly succeeded' >&2
    exit 1
  fi
  [[ $(jq -er '.phase' "$state") == candidate-published ]]
  [[ $(<"$live") == source ]]
)

test_systemd_contract_has_no_automatic_kill() (
  local properties
  eval "$(extract_function systemd_properties)"
  properties=$(systemd_properties /srv/noosphere-controller)
  for required in \
    Type=exec RemainAfterExit=no Restart=no KillMode=mixed \
    TimeoutStartSec=infinity TimeoutStopSec=infinity RuntimeMaxSec=infinity \
    UMask=0077 WorkingDirectory=/srv/noosphere-controller; do
    printf '%s\n' "$properties" | grep -Fx "$required" >/dev/null || {
      echo "Missing systemd property: $required" >&2
      exit 1
    }
  done
)

test_process_evidence_is_bounded_and_hashed() (
  local fixture_dir evidence stdout_file stderr_file stdout_sha stderr_sha
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  evidence="$fixture_dir/process-evidence.json"
  stdout_file="$fixture_dir/stdout.log"
  stderr_file="$fixture_dir/stderr.log"
  printf 'guard output\n' > "$stdout_file"
  printf 'guard diagnostic\n' > "$stderr_file"
  chmod 0600 "$stdout_file" "$stderr_file"
  stdout_sha=$(sha256sum "$stdout_file" | awk '{print $1}')
  stderr_sha=$(sha256sum "$stderr_file" | awk '{print $1}')

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic write_process_evidence_atomic; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { exit 1; }

  write_process_evidence_atomic "$evidence" guard-exited 17 \
    "$stdout_file" "$stderr_file" invocation123 boot456 700 789 \
    2026-08-10T00:00:00Z 2026-08-10T00:01:00Z cursor-start cursor-end

  [[ $(stat -c '%a' "$evidence") == 600 ]]
  [[ $(jq -er '.phase' "$evidence") == guard-exited ]]
  [[ $(jq -er '.exitCode' "$evidence") == 17 ]]
  [[ $(jq -er '.stdoutSha256' "$evidence") == "$stdout_sha" ]]
  [[ $(jq -er '.stderrSha256' "$evidence") == "$stderr_sha" ]]
  [[ $(jq -er '.controllerMainPid' "$evidence") == 700 ]]
  [[ $(jq -er '.childPid' "$evidence") == 789 ]]
  [[ $(jq -er '.startCursor' "$evidence") == cursor-start ]]
  [[ $(jq -er '.endCursor' "$evidence") == cursor-end ]]
)

test_closure_outcome_never_false_completes() (
  local fixture_dir state live source guard_journal source_sha evidence stdout_file stderr_file
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  evidence="$fixture_dir/evidence.json"
  stdout_file="$fixture_dir/stdout.log"
  stderr_file="$fixture_dir/stderr.log"
  printf 'source\n' > "$live"
  printf 'source\n' > "$source"
  printf 'verify failed\n' > "$stdout_file"
  printf 'identity mismatch\n' > "$stderr_file"
  chmod 0644 "$live" "$source"
  chmod 0600 "$stdout_file" "$stderr_file"
  source_sha=$(sha256sum "$source" | awk '{print $1}')
  write_fixture_controller_state "$state" closure-running "$live" "$source" "$source_sha" "$guard_journal"
  # A real closure-running state carries the proofs of every phase its
  # mechanism has passed: the guard ran (guardEvidence), authorization
  # succeeded (authorizationEvidence), and the writer was stopped with a
  # verified stop before closure could be retried (writerStopEvidence).
  # Real evidence bytes: every bound proof must exist on disk as an owned
  # 0600 evidence object whose digest matches the binding, mirroring what the
  # controller itself persists for guard, authorization, and writer stop.
  make_fixture_evidence() {
    local target=$1 phase=$2 container=${3:-}
    if [[ -n "$container" ]]; then
      jq -n --arg phase "$phase" --arg container "$container" \
        '{version:1,phase:$phase,container:$container,stopExitCode:0,
          inspectRunning:false}' > "$target"
    else
      jq -n --arg phase "$phase" '{version:1,phase:$phase}' > "$target"
    fi
    chmod 0600 "$target"
  }
  make_fixture_evidence "$fixture_dir/authorization-evidence.json" authorization-running
  make_fixture_evidence "$fixture_dir/guard-evidence.json" guard-exited
  make_fixture_evidence "$fixture_dir/writer-stop-evidence.json" closure-stop-pending \
    "$(jq -er '.appContainer // "fixture-app"' "$state")"
  jq --arg apath "$fixture_dir/authorization-evidence.json" \
     --arg asha "$(sha256sum "$fixture_dir/authorization-evidence.json" | awk '{print $1}')" \
     --arg gpath "$fixture_dir/guard-evidence.json" \
     --arg gsha "$(sha256sum "$fixture_dir/guard-evidence.json" | awk '{print $1}')" \
     --arg wpath "$fixture_dir/writer-stop-evidence.json" \
     --arg wsha "$(sha256sum "$fixture_dir/writer-stop-evidence.json" | awk '{print $1}')" \
    '.authorizationEvidence = {path:$apath,sha256:$asha} |
     .guardEvidence = {path:$gpath,sha256:$gsha} |
     .writerStopEvidence = {path:$wpath,sha256:$wsha}' \
    "$state" > "$state.next"
  install -m 600 "$state.next" "$state"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    write_process_evidence_atomic validate_process_evidence classify_closure_failure \
    bind_process_evidence_to_state begin_closure_incident begin_closure_evidence_pending \
    complete_closure_evidence_pending complete_closure_stop_pending \
    commit_closure_outcome; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  stop_application_fail_closed() { : > "$fixture_dir/app-stopped"; }
  revalidate_completed_guard_journal() { exit 1; }

  write_process_evidence_atomic "$evidence" closure-running 17 \
    "$stdout_file" "$stderr_file" invocation123 boot456 700 789 \
    2026-08-10T00:00:00Z 2026-08-10T00:01:00Z cursor-start cursor-end
  commit_closure_outcome "$state" "$evidence" identity 1
  [[ $(jq -er '.phase' "$state") == incident ]]
  [[ $(jq -er '.incidentClass' "$state") == closure-identity ]]
  [[ -e "$fixture_dir/app-stopped" ]]
)

write_execution_fixture() {
  local fixture_dir=$1 manifest=$2 guard_mode=${3:-complete} verifier_mode=${4:-success}
  local engine_id=${5:-fixture-engine} volume=${6:-fixture-volume}
  local live="$fixture_dir/docker-compose.yml" source="$fixture_dir/source-compose.yml"
  local candidate="$fixture_dir/candidate-compose.yml" env_file="$fixture_dir/runtime.env"
  local fake_docker="$fixture_dir/docker" guard="$fixture_dir/guard" verifier="$fixture_dir/verifier"
  local compose_plugin="$fixture_dir/docker-compose-plugin" config_file="$fixture_dir/home/docker/config.json"
  local backup="$fixture_dir/backup" lock_root="$fixture_dir/locks" controller_home="$fixture_dir/home"
  local guard_journal="$backup/$volume.phase-a2b.json"
  mkdir -p "$backup" "$lock_root" "$controller_home/docker"
  chmod 0700 "$fixture_dir" "$backup" "$lock_root" "$controller_home" "$controller_home/docker"
  printf '%s\n' "$engine_id" > "$fixture_dir/engine-id"
  jq -n --arg volume "$volume" '[{
    Name:$volume,
    Driver:"local",
    Mountpoint:("/var/lib/docker/volumes/" + $volume + "/_data"),
    CreatedAt:"2026-08-15T00:00:00Z",
    Scope:"local",
    Labels:{fixture:"original"},
    Options:null
  }]' > "$fixture_dir/volume-inspect.json"
  printf 'source model\n' > "$live"
  printf 'source model\n' > "$source"
  printf 'candidate model\n' > "$candidate"
  printf 'DATABASE_URL=fixture\n' > "$env_file"
  printf '%s\n' "$guard_mode" > "$fixture_dir/guard-mode"
  printf '#!/usr/bin/env bash\nprintf "fixture compose plugin\\n"\n' > "$compose_plugin"
  printf '{}\n' > "$config_file"
  chmod 0644 "$live" "$source" "$candidate"
  chmod 0600 "$env_file" "$config_file"
  chmod 0700 "$compose_plugin"

  {
    printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
    cat <<'DOCKER'
set -euo pipefail
root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
operation_lock_state=unheld
if [[ ${NOOSPHERE_A2B_LOCK_FD:-} =~ ^[0-9]+$ && -n ${NOOSPHERE_A2B_LOCK_PATH:-} &&
      $(readlink "/proc/$$/fd/$NOOSPHERE_A2B_LOCK_FD" 2>/dev/null || true) == "$NOOSPHERE_A2B_LOCK_PATH" ]]; then
  exec 9<>"$NOOSPHERE_A2B_LOCK_PATH"
  if ! flock -n 9; then
    operation_lock_state=held
  fi
  exec 9>&-
fi
if [[ -e "$root/pause-engine-info" && ! -e "$root/pause-engine-info-consumed" &&
      ${DOCKER_CONFIG:-} == *.inputs.* &&
      ${1:-} == info && ${*:-} == *ClientInfo.Plugins* ]]; then
  : > "$root/pause-engine-info-consumed"
  : > "$root/engine-info-paused"
  while [[ ! -e "$root/release-engine-info" ]]; do sleep 0.02; done
fi
if [[ -e "$root/pause-next-docker" && ! -e "$root/pause-consumed" ]]; then
  : > "$root/pause-consumed"
  : > "$root/docker-paused"
  while [[ ! -e "$root/release-docker" ]]; do sleep 0.02; done
fi
if [[ ${1:-} == info ]]; then
  printf 'info:%s\n' "$operation_lock_state" >> "$root/live-identity.log"
  if [[ ${*:-} == *ClientInfo.Plugins* ]]; then
    plugin="$DOCKER_CONFIG/cli-plugins/docker-compose"
    [[ -f "$plugin" ]] || plugin="$root/docker-compose-plugin"
    printf '[{"Name":"compose","Path":"%s","Version":"v2.fixture"}]\n' "$plugin"
  else
    : > "$root/engine-info-seen"
    cat "$root/engine-id"
  fi
elif [[ ${1:-} == volume && ${2:-} == inspect ]]; then
  printf 'volume-inspect:%s\n' "$operation_lock_state" >> "$root/live-identity.log"
  : > "$root/volume-inspect-seen"
  cat "$root/volume-inspect.json"
elif [[ ${1:-} == compose && ${2:-} == version ]]; then
  printf 'compose-version:%s\n' "$operation_lock_state" >> "$root/live-identity.log"
  printf 'v2.fixture\n'
elif [[ ${1:-} == compose ]]; then
  project_directory=''
  compose_file=''
  if [[ -e "$root/require-live-project-directory" ]]; then
    compose_args=("$@")
    for ((compose_index = 0; compose_index < ${#compose_args[@]}; compose_index++)); do
      case ${compose_args[$compose_index]} in
        --project-directory)
          project_directory=${compose_args[$((compose_index + 1))]}
          ;;
        -f)
          compose_file=${compose_args[$((compose_index + 1))]}
          ;;
      esac
    done
    if [[ -z "$project_directory" && -n "$compose_file" ]]; then
      project_directory=$(dirname "$compose_file")
    fi
    printf '%s\n' "$project_directory" >> "$root/compose-project-directories.log"
  fi
  if [[ " $* " == *" config "* ]]; then
    printf 'compose-config:%s\n' "$operation_lock_state" >> "$root/live-identity.log"
    if [[ -e "$root/require-live-project-directory" ]]; then
      printf 'candidate model:%s\n' "$project_directory"
    else
      printf 'candidate model\n'
    fi
  elif [[ " $* " == *" up "* && " $* " == *" app "* ]]; then
    if [[ -e "$root/require-bundle-docker-config-on-activation" ]]; then
      expected_config=$(<"$root/expected-activation-docker-config")
      selected_plugin="$DOCKER_CONFIG/cli-plugins/docker-compose"
      printf '%s\n' "$DOCKER_CONFIG" > "$root/activation-docker-config"
      printf '%s\n' "$selected_plugin" > "$root/activation-compose-plugin"
      [[ "$DOCKER_CONFIG" == "$expected_config" ]]
      cmp -s "$DOCKER_CONFIG/config.json" "$root/expected-bundle-docker-config.json"
      cmp -s "$selected_plugin" "$root/expected-bundle-compose-plugin"
    fi
    printf 'activate\n' >> "$root/lifecycle.log"
    [[ -e "$root/writer-authorized" ]]
    [[ ! -e "$root/fail-activation" ]] || exit 71
    : > "$root/app-started"
    rm -f "$root/app-stopped"
    if [[ -e "$root/signal-after-activation" ]]; then
      kill -TERM "$PPID"
    fi
  else
    printf 'unexpected fake Docker Compose arguments: %s\n' "$*" >&2
    exit 1
  fi
elif [[ ${1:-} == stop ]]; then
  if [[ -e "$root/kill-controller-if-incident-before-stop" &&
        $(jq -er '.phase' "$root/controller.json") == incident ]]; then
    : > "$root/incident-persisted-before-stop"
    kill -KILL "$PPID"
    exit 137
  fi
  if [[ -e "$root/fail-closure-stop-once" &&
        ! -e "$root/closure-stop-failure-consumed" ]]; then
    : > "$root/closure-stop-failure-consumed"
    exit 76
  fi
  printf 'stop\n' >> "$root/app-control.log"
  : > "$root/app-stopped"
  exit 0
elif [[ ${1:-} == inspect ]]; then
  if [[ -e "$root/fail-initial-activation-inspect" &&
        -e "$root/writer-authorized" &&
        ${@: -1} == fixture-app &&
        ! -e "$root/initial-activation-inspect-failure-consumed" &&
        ! -e "$root/app-started" ]]; then
    : > "$root/initial-activation-inspect-failure-consumed"
    exit 75
  fi
  if [[ -e "$root/app-stopped" ]]; then
    printf 'inspect:false\n' >> "$root/app-control.log"
    printf 'false\n'
  else
    printf 'inspect:true\n' >> "$root/app-control.log"
    printf 'true\n'
  fi
else
  printf 'unexpected fake Docker arguments: %s\n' "$*" >&2
  exit 1
fi
DOCKER
  } > "$fake_docker"
  {
    printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
    cat <<'GUARD'
set -euo pipefail
root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
[[ ${NOOSPHERE_A2B_LOCK_FD:-} == 8 ]]
[[ -e /proc/$$/fd/8 ]]
backup=''
volume=''
compose_file=''
authorize_writer=false
fixture_mode=$(<"$root/guard-mode")
while (($# > 0)); do
  case "$1" in
    --backup-dir) backup=$2; shift 2 ;;
    --compose-file) compose_file=$2; shift 2 ;;
    --volume) volume=$2; shift 2 ;;
    --authorize-writer) authorize_writer=true; shift ;;
    *) shift ;;
  esac
done
[[ -n "$backup" && -n "$volume" ]]
if [[ "$authorize_writer" == true ]]; then
  printf 'authorize\n' >> "$root/lifecycle.log"
  [[ -e "$root/app-stopped" ]]
  [[ -f "$backup/$volume.phase-a2b.json" ]]
  : > "$root/writer-authorized"
  exit 0
fi
printf 'transition\n' >> "$root/lifecycle.log"
: > "$root/app-stopped"
case "$fixture_mode" in
  prejournal-fail) exit 23 ;;
  third-state-fail)
    [[ -n "$compose_file" ]]
    printf 'unexpected third state\n' > "$compose_file"
    exit 23
    ;;
  journal-fail)
    printf '{"phase":"preparing","mode":"switch"}\n' > "$backup/$volume.phase-a2b.json"
    chmod 0600 "$backup/$volume.phase-a2b.json"
    exit 24
    ;;
  sleep)
    : > "$root/guard-running"
    sleep 3600 &
    sleeper=$!
    trap 'kill "$sleeper" >/dev/null 2>&1 || true; printf "1\n" > "$root/guard-term-count"; exit 143' TERM INT HUP
    wait "$sleeper"
    ;;
  delayed-term)
    printf '%s\n' "$$" > "$root/guard-pid"
    : > "$root/guard-running"
    trap 'printf "1\n" > "$root/guard-term-count"; sleep 1; : > "$root/guard-delay-complete"; exit 143' TERM INT HUP
    while :; do sleep 0.1; done
    ;;
  descendant-term)
    printf '%s\n' "$$" > "$root/guard-pid"
    : > "$root/guard-running"
    (
      trap '' TERM INT HUP
      printf '%s\n' "$BASHPID" > "$root/guard-descendant-pid"
      [[ -e "/proc/$BASHPID/fd/8" ]]
      : > "$root/guard-descendant-running"
      sleep 1
      : > "$root/guard-descendant-complete"
    ) &
    descendant=$!
    trap 'exit 143' TERM INT HUP
    wait "$descendant"
    ;;
  env-check)
    [[ -z ${HOSTILE_CHILD_ENV:-} ]]
    [[ $(basename "$(command -v docker)") == docker ]]
    [[ ${DOCKER_HOST:-} == unix:///fixture/docker.sock ]]
    printf '{"phase":"complete","mode":"switch"}\n' > "$backup/$volume.phase-a2b.json"
    chmod 0600 "$backup/$volume.phase-a2b.json"
    ;;
  complete)
    printf '{"phase":"complete","mode":"switch"}\n' > "$backup/$volume.phase-a2b.json"
    chmod 0600 "$backup/$volume.phase-a2b.json"
    ;;
  *) exit 25 ;;
esac
GUARD
  } > "$guard"
  if [[ "$verifier_mode" == success ]]; then
    {
      printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
case ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} in
  source)
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    : > "$root/source-verifier-succeeded"
    printf 'source verified\n'
    ;;
  candidate)
    [[ -f ${NOOSPHERE_POSTGRES_EVIDENCE:-} ]]
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    [[ -e "$root/app-started" ]]
    printf 'verify\n' >> "$root/lifecycle.log"
    if [[ -e "$root/pause-candidate-verifier" ]]; then
      : > "$root/candidate-verifier-paused"
      while [[ ! -e "$root/release-candidate-verifier" ]]; do sleep 0.02; done
    fi
    printf 'candidate verified\n'
    ;;
  *) exit 41 ;;
esac
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == env-check ]]; then
    {
      printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
[[ -z ${HOSTILE_CHILD_ENV:-} ]]
[[ $(basename "$(command -v docker)") == docker ]]
[[ ${DOCKER_HOST:-} == unix:///fixture/docker.sock ]]
[[ ${NOOSPHERE_APP_URL:-} == http://127.0.0.1:16578 ]]
case ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} in
  source) printf 'source verified\n' ;;
  candidate)
    [[ -f ${NOOSPHERE_POSTGRES_EVIDENCE:-} ]]
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    [[ -e "$root/app-started" ]]
    printf 'verify\n' >> "$root/lifecycle.log"
    printf 'candidate verified\n'
    ;;
  *) exit 41 ;;
esac
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == mutate-journal ]]; then
    cat > "$verifier" <<'VERIFIER'
#!/usr/bin/env bash
set -euo pipefail
[[ ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} == candidate ]]
[[ -f ${NOOSPHERE_POSTGRES_EVIDENCE:-} ]]
printf '{"phase":"complete","mode":"switch","mutatedAfterVerification":true}\n' \
  > "$NOOSPHERE_POSTGRES_EVIDENCE"
chmod 0600 "$NOOSPHERE_POSTGRES_EVIDENCE"
printf 'candidate verified before journal mutation\n'
VERIFIER
  elif [[ "$verifier_mode" == sleep ]]; then
    {
      printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
case ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} in
  source)
    printf 'source verified\n'
    ;;
  candidate)
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    : > "$root/verifier-running"
    sleep 3600 &
    sleeper=$!
    trap 'kill "$sleeper" >/dev/null 2>&1 || true; printf "1\n" > "$root/verifier-term-count"; exit 143' TERM INT HUP
    wait "$sleeper"
    ;;
  *) exit 41 ;;
esac
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == delayed-term ]]; then
    {
      printf '#!/usr/bin/env -S --default-signal=TERM --default-signal=INT --default-signal=HUP bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
mode=${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-missing}
root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
trap 'printf "1\n" > "$root/'"$mode"'-verifier-term-count"; printf "source verifier interrupted\n" >&2; deadline=$((SECONDS + 1)); while ((SECONDS < deadline)); do :; done; : > "$root/'"$mode"'-verifier-delay-complete"; exit 143' TERM INT HUP
printf '%s\n' "$$" > "$root/$mode-verifier-pid"
: > "$root/$mode-verifier-running"
while :; do :; done
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == signal-zero ]]; then
    {
      printf '#!/usr/bin/env -S --default-signal=TERM --default-signal=INT --default-signal=HUP bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
case ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} in
  source)
    printf 'source verified\n'
    ;;
  candidate)
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    [[ -f ${NOOSPHERE_POSTGRES_EVIDENCE:-} ]]
    [[ -e "$root/app-started" ]]
    printf 'verify\n' >> "$root/lifecycle.log"
    trap ': > "$root/candidate-verifier-signal-zero"; sleep 1; : > "$root/candidate-verifier-signal-zero-complete"; exit 0' TERM INT HUP
    printf '%s\n' "$$" > "$root/candidate-verifier-pid"
    : > "$root/candidate-verifier-running"
    while :; do sleep 0.1; done
    ;;
  *) exit 41 ;;
esac
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == fail ]]; then
    {
      printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
if [[ ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} == source ]]; then
  printf 'source verified\n'
  exit 0
fi
root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
[[ -e "$root/app-started" ]]
printf 'verify\n' >> "$root/lifecycle.log"
printf 'candidate verification failed\n' >&2
exit 31
VERIFIER
    } > "$verifier"
  elif [[ "$verifier_mode" == source-fail ]]; then
    {
      printf '#!/usr/bin/env bash\nfixture_root=%q\n' "$fixture_dir"
      cat <<'VERIFIER'
set -euo pipefail
case ${NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE:-} in
  source)
    root=${NOOSPHERE_CONTROLLER_FIXTURE_ROOT:-$fixture_root}
    printf '%s\n' "$$" > "$root/source-verifier-pid"
    : > "$root/source-verifier-running"
    printf 'source verification failed\n' >&2
    exit 42
    ;;
  candidate)
    [[ -f ${NOOSPHERE_POSTGRES_EVIDENCE:-} ]]
    printf 'candidate verified\n'
    ;;
  *) exit 41 ;;
esac
VERIFIER
    } > "$verifier"
  else
    echo "Invalid fixture verifier mode: $verifier_mode" >&2
    return 1
  fi
  chmod 0700 "$fake_docker" "$guard" "$verifier"

  jq -n \
    --arg liveCompose "$live" \
    --arg sourceSnapshot "$source" \
    --arg sourceSnapshotSha256 "$(sha256sum "$source" | awk '{print $1}')" \
    --arg candidateCompose "$candidate" \
    --arg candidateComposeSha256 "$(sha256sum "$candidate" | awk '{print $1}')" \
    --arg envFile "$env_file" \
    --arg envFileSha256 "$(sha256sum "$env_file" | awk '{print $1}')" \
    --arg guard "$guard" \
    --arg guardSha256 "$(sha256sum "$guard" | awk '{print $1}')" \
    --arg controllerPath "$(realpath "$CONTROLLER")" \
    --arg controllerSha256 "$(sha256sum "$CONTROLLER" | awk '{print $1}')" \
    --arg verifier "$verifier" \
    --arg verifierSha256 "$(sha256sum "$verifier" | awk '{print $1}')" \
    --arg dockerPath "$fake_docker" \
    --arg dockerSha256 "$(sha256sum "$fake_docker" | awk '{print $1}')" \
    --arg engineId "$engine_id" \
    --arg volume "$volume" \
    --arg volumeFingerprint "$("$fake_docker" volume inspect "$volume" | jq -Sc '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' | sha256sum | awk '{print $1}')" \
    --arg dockerComposeVersionSha256 "$("$fake_docker" compose version --short | sha256sum | awk '{print $1}')" \
    --arg composePluginPath "$compose_plugin" \
    --arg composePluginSha256 "$(sha256sum "$compose_plugin" | awk '{print $1}')" \
    --arg dockerConfigSha256 "$(sha256sum "$config_file" | awk '{print $1}')" \
    --arg effectiveComposeSha256 "$("$fake_docker" compose --project-directory "$(dirname "$live")" --env-file "$env_file" -f "$candidate" config --no-interpolate | sha256sum | awk '{print $1}')" \
    --arg backupDir "$backup" \
    --arg lockRoot "$lock_root" \
    --arg controllerHome "$controller_home" \
    --arg guardJournal "$guard_journal" \
    '{
      version:1, phase:"prepared", engineId:$engineId,
      dockerEndpoint:"unix:///fixture/docker.sock", volume:$volume,
      volumeFingerprint:$volumeFingerprint,
      liveCompose:$liveCompose, sourceSnapshot:$sourceSnapshot,
      sourceSnapshotSha256:$sourceSnapshotSha256,
      candidateCompose:$candidateCompose, candidateComposeSha256:$candidateComposeSha256,
      envFile:$envFile, envFileSha256:$envFileSha256,
      guard:$guard, guardSha256:$guardSha256,
      controllerPath:$controllerPath, controllerSha256:$controllerSha256,
      guardArgs:[
        "--compose-file",$liveCompose,
        "--env-file",$envFile,
        "--db-container","fixture-db",
        "--app-container","fixture-app",
        "--volume",$volume,
        "--authorization-volume","fixture-authorization",
        "--backup-dir",$backupDir,
        "--platform","linux/amd64",
        "--defer-app-restart"
      ],
      verifier:$verifier, verifierSha256:$verifierSha256,
      dockerPath:$dockerPath, dockerSha256:$dockerSha256,
      dockerComposeVersionSha256:$dockerComposeVersionSha256,
      composePluginPath:$composePluginPath, composePluginSha256:$composePluginSha256,
      dockerConfigSha256:$dockerConfigSha256,
      effectiveComposeSha256:$effectiveComposeSha256,
      backupDir:$backupDir, lockRoot:$lockRoot, controllerHome:$controllerHome,
      fixedPath:"/usr/bin:/bin", dbContainer:"fixture-db", appContainer:"fixture-app",
      authorizationVolume:"fixture-authorization", platform:"linux/amd64",
      appUrl:"http://127.0.0.1:16578",
      guardJournal:$guardJournal
    }' > "$manifest"
  chmod 0600 "$manifest"
}

test_complete_entrypoint_with_disposable_commands() (
  local fixture_dir manifest state live shim
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  INVOCATION_ID=0123456789abcdef0123456789abcdef \
    CONTROLLER_UNIT=noosphere-pgvector-transition.service \
    NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot \
    NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor \
    "$shim" --execute --state "$state"

  [[ $(jq -er '.phase' "$state") == complete ]]
  [[ $(<"$live") == 'candidate model' ]]
  [[ $(jq -er '.exitCode' "${state%.json}.guard.evidence.json") == 0 ]]
  [[ $(jq -er '.exitCode' "${state%.json}.verify.evidence.json") == 0 ]]
)

test_manifest_mutation_fails_before_publication() (
  local fixture_dir manifest state live env_file shim
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  env_file="$fixture_dir/runtime.env"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  printf 'MUTATED=1\n' >> "$env_file"

  if INVOCATION_ID=0123456789abcdef0123456789abcdef \
    CONTROLLER_UNIT=noosphere-pgvector-transition.service \
    NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot \
    NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor \
    "$shim" --execute --state "$state" >/dev/null 2>&1; then
    echo 'Mutated execution manifest unexpectedly reached publication' >&2
    exit 1
  fi
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_execution_requires_systemd_identity() (
  local fixture_dir manifest state live shim
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  if env -u INVOCATION_ID -u CONTROLLER_UNIT \
    "$shim" --execute --state "$state" >/dev/null 2>&1; then
    echo 'Controller executed outside systemd identity boundary' >&2
    exit 1
  fi
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

write_systemd_identity_shim() {
  local fixture_dir=$1 test_hooks=${2:-enabled} shim="$fixture_dir/controller-exec"
  {
    printf '#!/usr/bin/env bash\nset -Eeuo pipefail\nsource "%s"\n' "$CONTROLLER"
    if [[ "$test_hooks" == enabled ]]; then
      printf 'controller_test_hooks_enabled=true\n'
      printf 'controller_fixture_root=%q\n' "$fixture_dir"
    fi
    cat <<'SHIM'
query_systemd_unit_identity() {
  printf '%s\n' \
    ActiveState=active \
    "InvocationID=${INVOCATION_ID:-missing}" \
    "MainPID=$$" \
    Type=exec \
    RemainAfterExit=no \
    Restart=no \
    KillMode=mixed \
    TimeoutStartUSec=infinity \
    TimeoutStopUSec=infinity \
    RuntimeMaxUSec=infinity \
    UMask=0077 \
    Transient=yes \
    "WorkingDirectory=$(dirname "$(jq -er '.liveCompose' "$controller_state")")"
}
query_user_linger() {
  printf 'yes\n'
}
capture_journal_cursor() {
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        -e "$controller_fixture_root/fail-cursor-after-successful-verifier" &&
        ! -e "$controller_fixture_root/cursor-failure-consumed" &&
        -f "$controller_fixture_root/lifecycle.log" &&
        $(tail -n 1 "$controller_fixture_root/lifecycle.log") == verify ]]; then
    : > "$controller_fixture_root/cursor-failure-consumed"
    return 74
  fi
  journalctl --user -n 0 --show-cursor --no-pager |
    sed -n 's/^-- cursor: //p' | tail -1
}
main "$@"
SHIM
  } > "$shim"
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_activation_bundle_namespace_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f create_execution_bundle | sed '1s/create_execution_bundle/original_create_execution_bundle/')"
create_execution_bundle() {
  local state=$1 original_home original_plugin
  original_create_execution_bundle "$@"
  cp -- "$execution_controller_home/docker/config.json" \
    "$controller_fixture_root/expected-bundle-docker-config.json"
  cp -- "$execution_compose_plugin" \
    "$controller_fixture_root/expected-bundle-compose-plugin"
  printf '%s\n' "$execution_controller_home/docker" > \
    "$controller_fixture_root/expected-activation-docker-config"

  original_home=$(jq -er '.controllerHome' "$state")
  original_plugin=$(jq -er '.composePluginPath' "$state")
  mkdir -p -- "$original_home/docker/cli-plugins"
  printf '{"cliPluginsExtraDirs":["/tmp/post-bundle-mutation"]}\n' > \
    "$original_home/docker/config.json"
  printf '#!/usr/bin/env bash\nprintf "mutated original plugin\\n"\n' > \
    "$original_home/docker/cli-plugins/docker-compose"
  printf '# post-bundle original plugin mutation\n' >> "$original_plugin"
  chmod 0600 "$original_home/docker/config.json"
  chmod 0700 "$original_home/docker/cli-plugins/docker-compose" "$original_plugin"
  : > "$controller_fixture_root/require-bundle-docker-config-on-activation"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_guard_journal_race_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
mv() {
  local source=${@: -2:1} target=${@: -1} publish_complete=false
  if [[ -e "$controller_fixture_root/mutate-journal-before-complete-write" &&
        "$target" == "$controller_state" &&
        -f "$source" &&
        $(jq -r '.phase // empty' "$source") == complete ]]; then
    : > "$controller_fixture_root/cooperative-mutator-attempted-at-complete-write"
    (
      exec 9<>"$NOOSPHERE_A2B_LOCK_PATH"
      if flock -n 9; then
        : > "$controller_fixture_root/cooperative-mutator-acquired-at-complete-write"
      else
        : > "$controller_fixture_root/cooperative-mutator-blocked-at-complete-write"
      fi
    )
    publish_complete=true
  fi
  command mv "$@"
  if [[ "$publish_complete" == true && -f "$target" &&
        $(jq -r '.phase // empty' "$target") == complete ]]; then
    : > "$controller_fixture_root/complete-state-published"
  fi
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_complete_state_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f write_controller_state_atomic | sed '1s/write_controller_state_atomic/original_write_controller_state_atomic/')"
write_controller_state_atomic() {
  local target=$1 source=$2
  if [[ -e "$controller_fixture_root/fail-complete-state-write" &&
        "$target" == "$controller_state" &&
        $(jq -r '.phase // empty' "$source") == complete ]]; then
    : > "$controller_fixture_root/complete-state-write-failure-consumed"
    return 74
  fi
  original_write_controller_state_atomic "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_post_authorization_artifact_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
install() {
  local source=${@: -2:1}
  if [[ -e "$controller_fixture_root/fail-next-artifact-storage-after-authorization" &&
        ! -e "$controller_fixture_root/post-authorization-artifact-failure-consumed" &&
        "$source" == /dev/null &&
        -f "$controller_fixture_root/lifecycle.log" &&
        $(tail -n 1 "$controller_fixture_root/lifecycle.log") == authorize &&
        ! -e "$controller_fixture_root/app-started" ]]; then
    : > "$controller_fixture_root/post-authorization-artifact-failure-consumed"
    return 74
  fi
  command install "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}


write_source_recovery_evidence_publication_crash_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f write_process_evidence_atomic | sed '1s/write_process_evidence_atomic/original_write_process_evidence_atomic/')"
write_process_evidence_atomic() {
  local target=$1 phase=$2
  original_write_process_evidence_atomic "$@"
  if [[ "$phase" == source-recovery-running &&
        -e "$controller_fixture_root/crash-after-source-evidence-publication" &&
        ! -e "$controller_fixture_root/source-evidence-publication-crash-consumed" ]]; then
    printf '%s\n' "$target" > "$controller_fixture_root/unbound-source-evidence-path"
    : > "$controller_fixture_root/source-evidence-publication-crash-consumed"
    exit 86
  fi
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_authorization_postprocessing_non_die_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f fsync_path | sed '1s/fsync_path/original_fsync_path/')"
fsync_path() {
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        -e "$controller_fixture_root/fail-authorization-postprocessing-fsync" &&
        ! -e "$controller_fixture_root/authorization-postprocessing-fsync-failure-consumed" &&
        -f "$controller_fixture_root/lifecycle.log" &&
        $(tail -n 1 "$controller_fixture_root/lifecycle.log") == authorize ]]; then
    : > "$controller_fixture_root/authorization-postprocessing-fsync-failure-consumed"
    return 74
  fi
  original_fsync_path "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_writer_stop_evidence_fsync_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f fsync_path | sed '1s/fsync_path/original_fsync_path/')"
fsync_path() {
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        "$1" == */.writer-stop-evidence.* &&
        ! -e "$controller_fixture_root/writer-stop-evidence-fsync-failure-consumed" ]]; then
    : > "$controller_fixture_root/writer-stop-evidence-fsync-failure-consumed"
    return 74
  fi
  original_fsync_path "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_writer_stop_postrename_fsync_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f fsync_path | sed '1s/fsync_path/original_fsync_path/')"
fsync_path() {
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        "$1" == "$controller_fixture_root" &&
        ! -e "$controller_fixture_root/writer-stop-postrename-fsync-failure-consumed" ]] &&
     compgen -G "${controller_state%.json}.writer-stop*.evidence.json" >/dev/null; then
    : > "$controller_fixture_root/writer-stop-postrename-fsync-failure-consumed"
    return 74
  fi
  original_fsync_path "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_authorization_evidence_late_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f bind_process_evidence_to_state | sed '1s/bind_process_evidence_to_state/original_bind_process_evidence_to_state/')"
bind_process_evidence_to_state() {
  local key=$2
  original_bind_process_evidence_to_state "$@"
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        "$key" == authorizationEvidence &&
        ! -e "$controller_fixture_root/authorization-evidence-late-failure-consumed" ]]; then
    : > "$controller_fixture_root/authorization-evidence-late-failure-consumed"
    return 74
  fi
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_closure_intent_fsync_failure_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f write_controller_state_atomic | sed '1s/write_controller_state_atomic/original_write_controller_state_atomic/')"
write_controller_state_atomic() {
  local source=$2
  if [[ ${controller_test_hooks_enabled:-false} == true &&
        $(jq -r '.phase // empty' "$source") == closure-stop-pending &&
        ! -e "$controller_fixture_root/closure-intent-fsync-failure-consumed" ]]; then
    : > "$controller_fixture_root/closure-intent-fsync-failure-consumed"
    return 73
  fi
  original_write_controller_state_atomic "$@"
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

write_phase_snapshot_shim() {
  local fixture_dir=$1 shim
  shim=$(write_systemd_identity_shim "$fixture_dir")
  sed -i '$d' "$shim"
  cat >> "$shim" <<'SHIM'
eval "$(declare -f update_controller_phase | sed '1s/update_controller_phase/original_update_controller_phase/')"
update_controller_phase() {
  local state=$1 phase=$2 incident_class=${3:-}
  original_update_controller_phase "$@"
  if [[ ${NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE:-} == "$phase" &&
        ( -z ${NOOSPHERE_CONTROLLER_TEST_CAPTURE_INCIDENT_CLASS:-} ||
          ${NOOSPHERE_CONTROLLER_TEST_CAPTURE_INCIDENT_CLASS:-} == "$incident_class" ) ]]; then
    : > "$controller_fixture_root/controller-phase-snapshot-captured"
    exit 86
  fi
}
main "$@"
SHIM
  chmod 0700 "$shim"
  printf '%s\n' "$shim"
}

run_fixture_controller() {
  local state=$1 controller_exec=$2
  shift 2
  INVOCATION_ID=${NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID:-0123456789abcdef0123456789abcdef} \
    CONTROLLER_UNIT=noosphere-pgvector-transition.service \
    NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot \
    NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor \
    "$@" "$controller_exec" --execute --state "$state"
}

# Background variant for signal-delivery tests: the backgrounded subshell
# execs the controller, so the recorded $! is the controller process itself.
# Backgrounding run_fixture_controller (a function) instead leaves $! as a
# wrapper subshell; kill -TERM then reaps the wrapper and orphans the live
# controller, which later writes durable state after its test completed —
# observed as whole-suite nondeterminism. Bash cannot exec with leading
# environment assignments, so they are exported inside the subshell first;
# the export side effects never reach the parent shell. `env` (passed via
# "$@") execs the target without forking, preserving the PID.
background_fixture_controller() {
  local state=$1 controller_exec=$2
  shift 2
  export INVOCATION_ID=${NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID:-0123456789abcdef0123456789abcdef}
  export CONTROLLER_UNIT=noosphere-pgvector-transition.service
  export NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot
  export NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor
  exec "$@" "$controller_exec" --execute --state "$state"
}

terminate_fixture_process() {
  local pid=${1:-} i
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.02
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    for i in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.02
    done
  fi
  wait "$pid" 2>/dev/null || true
}

wait_fixture_process_bounded() {
  local pid=$1 limit=${2:-750} i state
  for i in $(seq 1 "$limit"); do
    if [[ ! -r "/proc/$pid/stat" ]]; then
      if wait "$pid"; then return 0; else return $?; fi
    fi
    state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)
    if [[ "$state" == Z ]]; then
      if wait "$pid"; then return 0; else return $?; fi
    fi
    sleep 0.02
  done
  return 124
}

test_guard_failure_before_journal_restores_source() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" prejournal-fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env || rc=$?
  [[ "$rc" == 23 ]]
  [[ $(jq -er '.phase' "$state") == incident ]]
  [[ $(jq -er '.incidentClass' "$state") == pre-journal-source-restored ]]
  [[ $(<"$live") == 'source model' ]]
)

test_guard_journal_prevents_outer_restore() (
  local fixture_dir manifest state live journal shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  journal="$fixture_dir/backup/fixture-volume.phase-a2b.json"
  write_execution_fixture "$fixture_dir" "$manifest" journal-fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env || rc=$?
  [[ "$rc" == 24 ]]
  [[ $(jq -er '.phase' "$state") == guard-exited ]]
  [[ $(jq -er '.phase' "$journal") == preparing ]]
  [[ $(<"$live") == 'candidate model' ]]
)

test_verifier_failure_commits_incident_and_stops_app() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env || rc=$?
  [[ "$rc" == 31 ]]
  [[ $(jq -er '.phase' "$state") == incident ]]
  [[ $(jq -er '.incidentClass' "$state") == closure-verification ]]
  [[ -e "$fixture_dir/app-stopped" ]]
  [[ $(<"$live") == 'candidate model' ]]
)

test_evidence_failure_cannot_complete() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=guard-exited || rc=$?
  ((rc != 0))
  [[ $(jq -er '.phase' "$state") == candidate-published ]]
  [[ $(jq -er '.phase' "$fixture_dir/backup/fixture-volume.phase-a2b.json") == complete ]]
  [[ $(<"$live") == 'candidate model' ]]
)

test_term_during_guard_records_and_recovers() (
  local fixture_dir manifest state live shim controller_pid rc=0 resume_rc=0 i
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" sleep
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/guard-running" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.1
  done
  # Load-tolerant bounded wait (60s): under heavy host load the controller's
  # pre-guard verification chain can exceed the old 5s window, and TERMing a
  # controller that has not reached the guard phase corrupts the assertion.
  [[ -e "$fixture_dir/guard-running" ]] || {
    echo 'guard never reported running before the signal was sent' >&2
    exit 1
  }
  kill -TERM "$controller_pid"
  wait "$controller_pid" || rc=$?
  controller_pid=''
  [[ "$rc" == 143 ]] || { echo "controller did not exit with signal-derived status after TERM (rc=$rc)" >&2; exit 1; }
  # The backgrounded fixture wrapper can return 143 before the controller
  # process has completed its final durable write, so an immediate single
  # read races the state file. The controller contract guarantees
  # phase=guard-exited after TERM-during-guard; poll the durable state with a
  # bounded settle window instead of asserting one instantaneous read.
  settled=''
  phase_now=''
  for i in $(seq 1 600); do
    phase_now=$(jq -er '.phase // empty' "$state" 2>/dev/null || true)
    if [[ "$phase_now" == guard-exited ]]; then settled=true; break; fi
    sleep 0.1
  done
  [[ "$settled" == true ]] || {
    echo "controller state never settled on guard-exited after TERM (last=${phase_now:-unreadable})" >&2
    exit 1
  }
  jq -e '
    .guardEvidence.path | type == "string" and startswith("/")
  ' "$state" >/dev/null
  [[ $(jq -er '.lastInterruption.signal' "$state") == TERM ]]
  [[ $(<"$live") == 'candidate model' ]]

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env || resume_rc=$?
  ((resume_rc != 0))
  [[ $(jq -er '.phase' "$state") == incident ]]
  [[ $(jq -er '.incidentClass' "$state") == pre-journal-source-restored ]]
  [[ $(<"$live") == 'source model' ]]
)


test_terminal_states_never_delegate_to_a_stale_guard_journal() (
  local fixture_dir state live source guard_journal source_sha delegated terminal_phase
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  delegated="$fixture_dir/delegated"
  printf 'candidate\n' > "$live"
  printf 'source\n' > "$source"
  printf '{"phase":"complete","mode":"switch"}\n' > "$guard_journal"
  chmod 0644 "$live" "$source"
  chmod 0600 "$guard_journal"
  source_sha=$(sha256sum "$source" | awk '{print $1}')

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    restore_source_without_guard_journal restore_source_compose_snapshot resume_controller_state; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  assert_source_state_unchanged() { :; }
  delegate_to_guard_journal() { : > "$delegated"; }

  for terminal_phase in incident complete; do
    state="$fixture_dir/controller-$terminal_phase.json"
    write_fixture_controller_state "$state" "$terminal_phase" "$live" "$source" "$source_sha" "$guard_journal"
    if (resume_controller_state "$state"); then
      echo "terminal phase $terminal_phase resumed through the stale guard journal" >&2
      exit 1
    fi
    [[ ! -e "$delegated" ]] || {
      echo "terminal phase $terminal_phase reached guard-journal delegation" >&2
      exit 1
    }
    [[ $(jq -er '.phase' "$state") == "$terminal_phase" ]]
    [[ $(<"$live") == candidate ]]
  done
)

test_systemd_identity_is_queried_not_asserted() (
  local fixture_dir state
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  printf '{"liveCompose":"%s/docker-compose.yml"}\n' "$fixture_dir" > "$state"
  chmod 0600 "$state"
  eval "$(extract_function require_systemd_execution_context)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  export INVOCATION_ID=0123456789abcdef0123456789abcdef
  export CONTROLLER_UNIT=noosphere-pgvector-transition.service
  controller_state=$state
  query_user_linger() { printf 'yes\n'; }

  query_systemd_unit_identity() {
    printf '%s\n' ActiveState=active InvocationID=ffffffffffffffffffffffffffffffff \
      "MainPID=$$" Type=exec RemainAfterExit=no Restart=no KillMode=mixed \
      TimeoutStartUSec=infinity TimeoutStopUSec=infinity RuntimeMaxUSec=infinity \
      UMask=0077 Transient=yes "WorkingDirectory=$fixture_dir"
  }
  if (require_systemd_execution_context); then
    echo 'systemd identity accepted from the environment despite a queried mismatch' >&2
    exit 1
  fi

  query_systemd_unit_identity() {
    printf '%s\n' ActiveState=active "InvocationID=$INVOCATION_ID" \
      "MainPID=$$" Type=exec RemainAfterExit=no Restart=no KillMode=mixed \
      TimeoutStartUSec=infinity TimeoutStopUSec=infinity RuntimeMaxUSec=infinity \
      UMask=0077 Transient=yes "WorkingDirectory=$fixture_dir"
  }
  (require_systemd_execution_context) || {
    echo 'matching queried systemd identity was refused' >&2
    exit 1
  }

  query_systemd_unit_identity() {
    printf '%s\n' ActiveState=inactive "InvocationID=$INVOCATION_ID" \
      "MainPID=$$" Type=exec RemainAfterExit=no Restart=no KillMode=mixed \
      TimeoutStartUSec=infinity TimeoutStopUSec=infinity RuntimeMaxUSec=infinity \
      UMask=0077 Transient=yes "WorkingDirectory=$fixture_dir"
  }
  if (require_systemd_execution_context); then
    echo 'inactive systemd unit identity was accepted' >&2
    exit 1
  fi
)

test_prepare_refuses_to_overwrite_active_or_terminal_state() (
  local fixture_dir manifest state phase state_inode
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  for helper in path_present assert_owned_regular_file assert_owned_private_directory \
    sha256_file write_controller_state_atomic validate_controller_state \
    ensure_regular_lock_file acquire_preparation_lock after_preparation_lock \
    acquire_operation_lock assert_operation_lock_held claim_authoritative_state_path \
    query_postgres_volume_fingerprint \
    assert_trusted_fixed_path assert_guard_journal_path \
    query_local_ipv4_addresses assert_local_verification_url \
    validate_execution_manifest validate_guard_arguments query_compose_plugin_path \
    assert_private_docker_config compose_model_signature verify_execution_inputs \
    assert_controller_execution_identity \
    assert_live_engine_binding assert_controller_artifact_paths_separate \
    sanitize_execution_environment prepare_execution_state; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  query_live_engine_id() { printf 'fixture-engine\n'; }
  CONTROLLER_EXECUTABLE_PATH=$(jq -er '.controllerPath' "$manifest")

  # Complete-state evidence has its own exact durable-validation fixtures.
  # This preparation guard covers active phases plus the incident terminal.
  for phase in candidate-published guard-exited closure-running incident; do
    jq --arg phase "$phase" '
      .phase = $phase |
      if $phase == "incident" then
        .incidentClass = "fixture-terminal-state"
      else . end
    ' "$manifest" > "$state"
    chmod 0600 "$state"
    if (prepare_execution_state "$manifest" "$state"); then
      echo "preparation overwrote $phase controller state" >&2
      exit 1
    fi
    [[ $(jq -er '.phase' "$state") == "$phase" ]]
  done

  rm -f "$state"
  (prepare_execution_state "$manifest" "$state")
  state_inode=$(stat -c '%i' "$state")
  (prepare_execution_state "$manifest" "$state") || {
    echo 'idempotent re-preparation in prepared state was refused' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(stat -c '%i' "$state") == "$state_inode" ]]
)

test_engine_identity_is_rebound_to_the_live_daemon() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  printf 'mutated-engine\n' > "$fixture_dir/engine-id"
  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  [[ "$rc" != 0 ]] || {
    echo 'controller proceeded with a stale Docker engine identity' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_lock_root_must_match_the_guard_lock_contract() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  mkdir -p "$fixture_dir/other-root"
  chmod 0700 "$fixture_dir/other-root"
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  if INVOCATION_ID=0123456789abcdef0123456789abcdef \
    CONTROLLER_UNIT=noosphere-pgvector-transition.service \
    NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot \
    NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor \
    XDG_RUNTIME_DIR="$fixture_dir/other-root" \
    "$shim" --execute --state "$state" >/dev/null 2>&1; then
    echo 'controller accepted a lock root outside the guard contract' >&2
    exit 1
  fi
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_child_process_environment_and_docker_resolution_are_hermetic() (
  local fixture_dir manifest state shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" env-check env-check
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env HOSTILE_CHILD_ENV=present || rc=$?
  [[ "$rc" == 0 ]] || {
    echo 'guard/verifier child inherited hostile state or resolved another Docker executable' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == complete ]]
)

test_latched_signal_before_guard_cannot_be_ignored() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD=TERM || rc=$?
  [[ "$rc" == 143 ]] || {
    echo "latched pre-guard TERM was ignored (exit=$rc)" >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == candidate-published ]]
  [[ $(jq -er '.lastInterruption.signal' "$state") == TERM ]]
  [[ ! -e "$fixture_dir/backup/fixture-volume.phase-a2b.json" ]]
  [[ $(<"$live") == 'candidate model' ]]
)

test_verifier_evidence_failure_stops_writer_before_storage() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running || rc=$?
  ((rc != 0))
  [[ $(jq -er '.phase' "$state") == closure-evidence-pending ]] || {
    echo 'verifier failure did not remain resumable after writer stop' >&2
    exit 1
  }
  [[ $(jq -er '.incidentClass' "$state") == closure-verification ]]
  [[ -e "$fixture_dir/app-stopped" ]] || {
    echo 'verifier evidence failure left the app writer running' >&2
    exit 1
  }
  [[ $(<"$live") == 'candidate model' ]]
)

test_process_logs_are_fsynced_before_evidence_binding() (
  local fixture_dir evidence stdout_file stderr_file fsync_log first second
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  evidence="$fixture_dir/process-evidence.json"
  stdout_file="$fixture_dir/stdout.log"
  stderr_file="$fixture_dir/stderr.log"
  fsync_log="$fixture_dir/fsync.log"
  printf 'output\n' > "$stdout_file"
  printf 'diagnostic\n' > "$stderr_file"
  chmod 0600 "$stdout_file" "$stderr_file"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic write_process_evidence_atomic; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { printf '%s\n' "$1" >> "$fsync_log"; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  write_process_evidence_atomic "$evidence" closure-running 0 \
    "$stdout_file" "$stderr_file" invocation123 boot456 700 789 \
    2026-08-10T00:00:00Z 2026-08-10T00:01:00Z cursor-start cursor-end
  first=$(sed -n '1p' "$fsync_log")
  second=$(sed -n '2p' "$fsync_log")
  [[ "$first" == "$stdout_file" && "$second" == "$stderr_file" ]] || {
    echo 'process logs were hashed/bound before both log files were fsynced' >&2
    exit 1
  }
)

test_complete_state_binds_guard_and_closure_evidence() (
  local fixture_dir manifest state shim
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env

  jq -e '
    .phase == "complete" and
    (.guardEvidence.path | endswith(".guard.evidence.json")) and
    (.guardEvidence.sha256 | test("^[a-f0-9]{64}$")) and
    (.closureEvidence.path | endswith(".verify.evidence.json")) and
    (.closureEvidence.sha256 | test("^[a-f0-9]{64}$")) and
    (.guardEvidence.stdout.sha256 | test("^[a-f0-9]{64}$")) and
    (.guardEvidence.stderr.sha256 | test("^[a-f0-9]{64}$")) and
    (.closureEvidence.stdout.sha256 | test("^[a-f0-9]{64}$")) and
    (.closureEvidence.stderr.sha256 | test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null || {
    echo 'complete state does not durably bind guard and closure evidence/logs' >&2
    exit 1
  }
)

test_systemd_safety_properties_and_linger_are_queried() (
  local fixture_dir state
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  printf '{"liveCompose":"%s/docker-compose.yml"}\n' "$fixture_dir" > "$state"
  chmod 0600 "$state"

  eval "$(extract_function require_systemd_execution_context)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  export INVOCATION_ID=0123456789abcdef0123456789abcdef
  export CONTROLLER_UNIT=noosphere-pgvector-transition.service
  controller_state=$state

  query_user_linger() { printf 'yes\n'; }
  query_systemd_unit_identity() {
    printf '%s\n' \
      ActiveState=active \
      "InvocationID=$INVOCATION_ID" \
      "MainPID=$$" \
      Type=exec \
      RemainAfterExit=no \
      Restart=always \
      KillMode=control-group \
      TimeoutStartUSec=5s \
      TimeoutStopUSec=5s \
      RuntimeMaxUSec=5s \
      UMask=0022 \
      "WorkingDirectory=$fixture_dir"
  }
  if (require_systemd_execution_context); then
    echo 'unsafe systemd unit properties were accepted' >&2
    exit 1
  fi

  query_systemd_unit_identity() {
    printf '%s\n' \
      ActiveState=active \
      "InvocationID=$INVOCATION_ID" \
      "MainPID=$$" \
      Type=exec \
      RemainAfterExit=no \
      Restart=no \
      KillMode=mixed \
      TimeoutStartUSec=infinity \
      TimeoutStopUSec=infinity \
      RuntimeMaxUSec=infinity \
      UMask=0077 \
      "WorkingDirectory=$fixture_dir"
  }
  query_user_linger() { printf 'no\n'; }
  if (require_systemd_execution_context); then
    echo 'non-persistent user manager was accepted' >&2
    exit 1
  fi
)

test_signals_cannot_cross_spawn_or_complete_boundaries() (
  local fixture_dir manifest state shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN=TERM || rc=$?
  [[ "$rc" == 143 ]] || {
    echo "TERM latched across guard spawn was ignored (exit=$rc)" >&2
    exit 1
  }
  [[ $(jq -er '.lastInterruption.signal' "$state") == TERM ]]
  [[ $(jq -er '.phase' "$state") != complete ]]

  rm -f -- "$state" "$fixture_dir/backup/fixture-volume.phase-a2b.json"
  printf 'source model\n' > "$fixture_dir/docker-compose.yml"
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  rc=0
  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE=TERM || rc=$?
  [[ "$rc" == 143 ]] || {
    echo "TERM before complete was ignored (exit=$rc)" >&2
    exit 1
  }
  [[ $(jq -er '.lastInterruption.signal' "$state") == TERM ]]
  [[ $(jq -er '.phase' "$state") != complete ]]
)

test_source_recovery_verifier_is_hermetic_and_target_bound() (
  local fixture_dir manifest
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete env-check

  for helper in child_path_for_state assert_recorded_docker_resolution \
    forward_latched_signal_to_active_child wait_for_child_exit wait_for_process_group_empty \
    run_source_verifier_hermetic \
    assert_source_state_unchanged; do
    eval "$(extract_function "$helper")"
  done
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  controller_state=$manifest
  export HOSTILE_CHILD_ENV=present
  export NOOSPHERE_APP_URL=http://127.0.0.1:6578

  (assert_source_state_unchanged) || {
    echo 'source recovery verifier inherited hostile inputs or missed the recorded endpoint' >&2
    exit 1
  }
)

test_complete_state_binds_immutable_guard_journal() (
  local fixture_dir manifest state shim journal expected_sha rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  journal="$fixture_dir/backup/fixture-volume.phase-a2b.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env
  expected_sha=$(sha256sum "$journal" | awk '{print $1}')
  jq -e --arg path "$journal" --arg sha "$expected_sha" '
    .phase == "complete" and
    .guardJournalEvidence.path == $path and
    .guardJournalEvidence.phase == "complete" and
    .guardJournalEvidence.sha256 == $sha
  ' "$state" >/dev/null || {
    echo 'complete state does not bind the durable complete guard journal' >&2
    exit 1
  }

  rm -f -- "$state" "$journal"
  printf 'source model\n' > "$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" complete mutate-journal
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env || rc=$?
  ((rc != 0)) || {
    echo 'controller completed after the bound guard journal changed' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") != complete ]]
)

test_process_evidence_separates_controller_and_child_identity() (
  local fixture_dir manifest state shim guard_evidence closure_evidence
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env
  guard_evidence="${state%.json}.guard.evidence.json"
  closure_evidence="${state%.json}.verify.evidence.json"

  jq -e --arg invocation 0123456789abcdef0123456789abcdef '
    .phase == "guard-exited" and
    .invocationId == $invocation and
    (.controllerMainPid | type == "number" and . > 0) and
    (.childPid | type == "number" and . > 0) and
    .controllerMainPid != .childPid
  ' "$guard_evidence" >/dev/null || {
    echo 'guard evidence does not separate controller MainPID from child PID' >&2
    exit 1
  }
  jq -e --arg invocation 0123456789abcdef0123456789abcdef \
    --argjson controller_pid "$(jq -er '.controllerMainPid' "$guard_evidence")" '
    .phase == "closure-running" and
    .invocationId == $invocation and
    .controllerMainPid == $controller_pid and
    (.childPid | type == "number" and . > 0) and
    .controllerMainPid != .childPid
  ' "$closure_evidence" >/dev/null || {
    echo 'closure evidence is not bound to the same systemd controller identity' >&2
    exit 1
  }
)

test_guard_arguments_are_semantically_bound_to_manifest() (
  local fixture_dir manifest state
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  jq '.guardArgs = [
    "--record-new-install",
    "--compose-file", .liveCompose,
    "--db-container", .dbContainer,
    "--app-container", .appContainer,
    "--volume", .volume,
    "--backup-dir", .backupDir,
    "--platform", .platform
  ]' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    echo 'source-transition controller accepted --record-new-install guard mode' >&2
    exit 1
  fi

  rm -f -- "$state"
  write_execution_fixture "$fixture_dir" "$manifest"
  jq '.guardArgs = [
    "--compose-file", "/tmp/not-the-recorded-compose.yml",
    "--env-file", .envFile,
    "--db-container", .dbContainer,
    "--app-container", .appContainer,
    "--volume", .volume,
    "--authorization-volume", .authorizationVolume,
    "--backup-dir", .backupDir,
    "--platform", .platform
  ]' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    echo 'guard arguments were not tied to the recorded Compose path' >&2
    exit 1
  fi
)

test_compose_plugin_and_docker_config_identity_are_bound() (
  local fixture_dir manifest state live shim plugin config_file rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  plugin="$fixture_dir/docker-compose-plugin"
  config_file="$fixture_dir/home/docker/config.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  printf '#!/usr/bin/env bash\nprintf "fixture compose plugin\\n"\n' > "$plugin"
  chmod 0700 "$plugin"
  printf '{}\n' > "$config_file"
  chmod 0600 "$config_file"
  jq \
    --arg plugin "$plugin" \
    --arg pluginSha256 "$(sha256sum "$plugin" | awk '{print $1}')" \
    --arg configSha256 "$(sha256sum "$config_file" | awk '{print $1}')" '
      .composePluginPath = $plugin |
      .composePluginSha256 = $pluginSha256 |
      .dockerConfigSha256 = $configSha256
    ' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  printf '# changed plugin\n' >> "$plugin"
  printf '{"cliPluginsExtraDirs":["/tmp/hostile"]}\n' > "$config_file"
  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'controller accepted changed Compose plugin and Docker config identities' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_activation_uses_invocation_private_docker_bundle() (
  local fixture_dir manifest state shim rc=0 expected_config actual_config expected_plugin actual_plugin
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_activation_bundle_namespace_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc == 0)) || {
    echo 'activation did not retain the invocation-private Docker namespace after original-input mutation' >&2
    sed 's/^/  controller.err: /' "$fixture_dir/controller.err" >&2 || true
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == complete ]] || {
    echo 'bundle-bound activation did not complete the controller lifecycle' >&2
    exit 1
  }
  expected_config=$(<"$fixture_dir/expected-activation-docker-config")
  actual_config=$(<"$fixture_dir/activation-docker-config")
  expected_plugin="$expected_config/cli-plugins/docker-compose"
  actual_plugin=$(<"$fixture_dir/activation-compose-plugin")
  [[ "$actual_config" == "$expected_config" && "$actual_plugin" == "$expected_plugin" ]] || {
    printf 'activation escaped its invocation bundle: config=%s plugin=%s\n' \
      "$actual_config" "$actual_plugin" >&2
    exit 1
  }
  cmp -s "$actual_config/config.json" "$fixture_dir/expected-bundle-docker-config.json"
  cmp -s "$actual_plugin" "$fixture_dir/expected-bundle-compose-plugin"
)

test_candidate_model_uses_activation_project_directory() (
  local fixture_dir manifest state shim fake_docker env_file candidate live candidate_dir rc=0
  local effective_sha expected_project unique_projects
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  fake_docker=$(jq -er '.dockerPath' "$manifest")
  env_file=$(jq -er '.envFile' "$manifest")
  candidate=$(jq -er '.candidateCompose' "$manifest")
  live=$(jq -er '.liveCompose' "$manifest")
  expected_project=$(dirname "$live")
  candidate_dir="$fixture_dir/candidate-input"
  mkdir -m 700 "$candidate_dir"
  mv -- "$candidate" "$candidate_dir/candidate-compose.yml"
  candidate="$candidate_dir/candidate-compose.yml"
  : > "$fixture_dir/require-live-project-directory"
  effective_sha=$("$fake_docker" compose --project-directory "$expected_project" \
    --env-file "$env_file" -f "$candidate" config --no-interpolate | sha256sum | awk '{print $1}')
  jq --arg candidate "$candidate" \
    --arg candidateSha "$(sha256sum "$candidate" | awk '{print $1}')" \
    --arg effectiveSha "$effective_sha" '
      .candidateCompose = $candidate |
      .candidateComposeSha256 = $candidateSha |
      .effectiveComposeSha256 = $effectiveSha
    ' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc == 0)) || {
    echo 'candidate model and activation used different Compose project directories' >&2
    sed 's/^/  controller.err: /' "$fixture_dir/controller.err" >&2 || true
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == complete ]]
  unique_projects=$(sort -u "$fixture_dir/compose-project-directories.log")
  [[ "$unique_projects" == "$expected_project" ]] || {
    printf 'Compose calls used inconsistent project directories: %s\n' "$unique_projects" >&2
    exit 1
  }
)

test_failed_prejournal_recovery_commits_durable_incident() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" prejournal-fail source-fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'failed source recovery unexpectedly returned success' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == incident ]] || {
    echo 'failed source recovery remained automatically retryable' >&2
    exit 1
  }
  [[ $(jq -er '.incidentClass' "$state") == pre-journal-source-verification ]]
  [[ $(<"$live") == 'candidate model' ]]
)

test_process_evidence_rejects_impossible_chronology() (
  local fixture_dir evidence stdout_file stderr_file
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  evidence="$fixture_dir/process-evidence.json"
  stdout_file="$fixture_dir/stdout.log"
  stderr_file="$fixture_dir/stderr.log"
  printf 'output\n' > "$stdout_file"
  printf 'diagnostic\n' > "$stderr_file"
  chmod 0600 "$stdout_file" "$stderr_file"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic write_process_evidence_atomic \
    validate_process_evidence; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  write_process_evidence_atomic "$evidence" guard-exited 0 \
    "$stdout_file" "$stderr_file" invocation123 boot456 700 789 \
    2026-08-10T00:02:00Z 2026-08-10T00:01:00Z cursor-start cursor-end
  if (validate_process_evidence "$evidence"); then
    echo 'process evidence accepted an end timestamp before its start' >&2
    exit 1
  fi

  jq '.startedAt = "not-rfc3339" | .endedAt = "also-not-rfc3339"' \
    "$evidence" > "$evidence.next"
  install -m 600 "$evidence.next" "$evidence"
  if (validate_process_evidence "$evidence"); then
    echo 'process evidence accepted non-RFC3339 timestamps' >&2
    exit 1
  fi
)

test_source_snapshot_is_revalidated_before_publication() (
  local fixture_dir manifest state live source shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  printf 'mutated recovery source\n' > "$source"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'controller published candidate state after its recovery snapshot changed' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_guard_journal_path_is_canonically_bound() (
  local fixture_dir manifest state
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  jq '.guardJournal = (.backupDir + "/wrong-sibling.phase-a2b.json")' \
    "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"

  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    echo 'controller accepted a guard journal path different from the pinned guard path' >&2
    exit 1
  fi
)

test_fixed_path_toolchain_is_immutable_and_bound() (
  local fixture_dir manifest state live tool_dir marker shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  tool_dir="$fixture_dir/toolbin"
  marker="$fixture_dir/replacement-sha256sum-used"
  mkdir -m 700 "$tool_dir"
  write_execution_fixture "$fixture_dir" "$manifest"
  jq --arg fixedPath "$tool_dir:/usr/bin:/bin" '.fixedPath = $fixedPath' \
    "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  if ! "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    return 0
  fi

  cat > "$tool_dir/sha256sum" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
: > "$marker"
exec /usr/bin/sha256sum "\$@"
WRAPPER
  chmod 0700 "$tool_dir/sha256sum"
  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'controller executed a critical utility introduced into fixedPath after preparation' >&2
    exit 1
  }
  [[ ! -e "$marker" ]]
  [[ $(jq -er '.phase' "$state") == prepared ]]
  [[ $(<"$live") == 'source model' ]]
)

test_controller_state_cannot_collide_with_guard_journal() (
  local fixture_dir manifest journal
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  journal=$(jq -er '.guardJournal' "$manifest")

  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$journal"; then
    echo 'controller state was allowed to overwrite the future guard journal path' >&2
    exit 1
  fi
)

test_ambient_test_overrides_cannot_falsify_production_evidence() (
  local fixture_dir manifest state shim actual_boot guard_evidence closure_evidence
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  INVOCATION_ID=0123456789abcdef0123456789abcdef \
    CONTROLLER_UNIT=noosphere-pgvector-transition.service \
    NOOSPHERE_CONTROLLER_BOOT_ID=forged-boot-id \
    NOOSPHERE_CONTROLLER_TEST_CURSOR=forged-journal-cursor \
    "$shim" --execute --state "$state"
  actual_boot=$(< /proc/sys/kernel/random/boot_id)
  guard_evidence="${state%.json}.guard.evidence.json"
  closure_evidence="${state%.json}.verify.evidence.json"
  jq -e --arg boot "$actual_boot" '
    .bootId == $boot and
    .startCursor != "forged-journal-cursor" and
    .endCursor != "forged-journal-cursor"
  ' "$guard_evidence" >/dev/null || {
    echo 'guard evidence accepted forged ambient boot or cursor overrides' >&2
    exit 1
  }
  jq -e --arg boot "$actual_boot" '
    .bootId == $boot and
    .startCursor != "forged-journal-cursor" and
    .endCursor != "forged-journal-cursor"
  ' "$closure_evidence" >/dev/null || {
    echo 'closure evidence accepted forged ambient boot or cursor overrides' >&2
    exit 1
  }
)

test_docker_rehearsal_proves_cleanup_before_success() (
  local cleanup_line residue_line success_line
  cleanup_line=$(awk '$0 == "cleanup_successfully" { print NR; exit }' "$DOCKER_FIXTURE")
  residue_line=$(awk '$0 == "verify_zero_residue" { print NR; exit }' "$DOCKER_FIXTURE")
  success_line=$(awk '$0 == "echo '\''PostgreSQL transition controller pinned-guard Docker rehearsal passed.'\''" { print NR; exit }' "$DOCKER_FIXTURE")
  [[ -n "$cleanup_line" && -n "$residue_line" && -n "$success_line" &&
     "$cleanup_line" -lt "$residue_line" && "$residue_line" -lt "$success_line" ]] || {
    echo 'Docker rehearsal still reports success before explicit cleanup and zero-residue proof' >&2
    exit 1
  }
)

test_process_evidence_rejects_fractional_numbers() (
  local fixture_dir evidence stdout_file stderr_file accepted=0 expression
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  evidence="$fixture_dir/process-evidence.json"
  stdout_file="$fixture_dir/stdout.log"
  stderr_file="$fixture_dir/stderr.log"
  printf 'output\n' > "$stdout_file"
  printf 'diagnostic\n' > "$stderr_file"
  chmod 0600 "$stdout_file" "$stderr_file"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic write_process_evidence_atomic \
    validate_process_evidence; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  write_process_evidence_atomic "$evidence" guard-exited 0 \
    "$stdout_file" "$stderr_file" invocation123 boot456 700 789 \
    2026-08-10T00:00:00Z 2026-08-10T00:01:00Z cursor-start cursor-end

  for expression in '.exitCode = 0.5' '.controllerMainPid = 700.5'; do
    jq "$expression" "$evidence" > "$evidence.next"
    install -m 600 "$evidence.next" "$evidence"
    if (validate_process_evidence "$evidence"); then
      ((accepted += 1))
    fi
  done
  ((accepted == 0)) || {
    echo 'process evidence accepted fractional exit-code or PID values' >&2
    exit 1
  }
)

test_real_systemd_fixture_exercises_signal_delivery() (
  rg -q -- 'systemctl --user kill .*--signal=TERM|systemctl --user kill --signal=TERM' \
    "$SYSTEMD_FIXTURE" || {
    echo 'real transient-systemd fixture still does not deliver TERM' >&2
    exit 1
  }
)

test_production_execution_succeeds_without_ambient_fault_hooks() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir" disabled)
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 0 && $(jq -er '.phase' "$state") == complete ]] || {
    echo 'clean production execution failed without ambient controller fault hooks' >&2
    exit 1
  }
  [[ $(<"$live") == 'candidate model' ]]
)

test_production_execution_succeeds_without_ambient_signal_hooks() (
  local fixture_dir manifest state live shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir" disabled)
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 0 && $(jq -er '.phase' "$state") == complete ]] || {
    echo 'clean production execution failed without ambient controller signal hooks' >&2
    exit 1
  }
  [[ $(<"$live") == 'candidate model' ]]
)

test_derived_evidence_paths_cannot_collide_with_bound_inputs() (
  local fixture_dir manifest state live old_env collision_env shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  old_env="$fixture_dir/runtime.env"
  collision_env="${state%.json}.guard.stdout.log"
  write_execution_fixture "$fixture_dir" "$manifest"
  mv "$old_env" "$collision_env"
  jq --arg old "$old_env" --arg collision "$collision_env" \
    --arg digest "$(sha256sum "$collision_env" | awk '{print $1}')" '
      .envFile = $collision |
      .envFileSha256 = $digest |
      .guardArgs = (.guardArgs | map(if . == $old then $collision else . end))
    ' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
    ((rc != 0)) || {
      echo 'derived guard stdout path overwrote a manifest-bound input' >&2
      exit 1
    }
  fi
  [[ $(<"$collision_env") == 'DATABASE_URL=fixture' ]] || {
    echo 'derived controller artifact path modified a bound input before rejection' >&2
    exit 1
  }
  [[ $(<"$live") == 'source model' ]]
)

test_guard_signal_persists_child_evidence_before_return() (
  local fixture_dir manifest state shim controller_pid='' rc=0 i evidence
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  evidence="${state%.json}.guard.evidence.json"
  write_execution_fixture "$fixture_dir" "$manifest" sleep
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/guard-running" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/guard-running" ]]
  kill -TERM "$controller_pid"
  wait "$controller_pid" || rc=$?
  controller_pid=''
  [[ "$rc" == 143 ]]
  [[ -f "$evidence" ]] && jq -e '
    .phase == "guard-exited" and .exitCode == 143 and
    (.childPid | type == "number" and . > 0) and
    (.stdoutSha256 | test("^[a-f0-9]{64}$")) and
    (.stderrSha256 | test("^[a-f0-9]{64}$"))
  ' "$evidence" >/dev/null && jq -e --arg path "$evidence" '
    .guardEvidence.path == $path and .lastInterruption.signal == "TERM"
  ' "$state" >/dev/null || {
    echo 'TERM during guard returned before durable child evidence was bound' >&2
    echo "---signal-flake-diagnostics begin (guard)---" >&2
    echo "evidence_exists=$([[ -f "$evidence" ]] && echo yes || echo no) path=$evidence" >&2
    [[ -f "$evidence" ]] && { echo 'evidence_content:' >&2; cat "$evidence" >&2; } || true
    echo "state_exists=$([[ -f "$state" ]] && echo yes || echo no)" >&2
    [[ -f "$state" ]] && { echo "state_phase=$(jq -r '.phase // "<none>"' "$state" 2>&1)" >&2; echo "state_interruption=$(jq -c '.lastInterruption // "<none>"' "$state" 2>&1)" >&2; echo "state_guard=$(jq -c '.guardEvidence // "<none>"' "$state" 2>&1)" >&2; } || true
    echo "controller_err_tail:" >&2; tail -5 "$fixture_dir/controller.err" >&2 || true
    echo 'fixture_listing:' >&2; ls -la "$fixture_dir" >&2
    echo '---signal-flake-diagnostics end---' >&2
    exit 1
  }
)

test_verifier_signal_persists_child_evidence_before_return() (
  local fixture_dir manifest state shim controller_pid='' rc=0 i evidence
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  evidence="${state%.json}.verify.evidence.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete sleep
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/verifier-running" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/verifier-running" ]]
  kill -TERM "$controller_pid"
  wait "$controller_pid" || rc=$?
  controller_pid=''
  [[ "$rc" == 143 ]]
  [[ -f "$evidence" ]] && jq -e '
    .phase == "closure-running" and .exitCode == 143 and
    (.childPid | type == "number" and . > 0) and
    (.stdoutSha256 | test("^[a-f0-9]{64}$")) and
    (.stderrSha256 | test("^[a-f0-9]{64}$"))
  ' "$evidence" >/dev/null && jq -e --arg path "$evidence" '
    .closureEvidence.path == $path and .lastInterruption.signal == "TERM"
  ' "$state" >/dev/null || {
    echo 'TERM during verifier returned before durable child evidence was bound' >&2
    echo "---signal-flake-diagnostics begin (verifier)---" >&2
    echo "evidence_exists=$([[ -f "$evidence" ]] && echo yes || echo no) path=$evidence" >&2
    [[ -f "$evidence" ]] && { echo 'evidence_content:' >&2; cat "$evidence" >&2; } || true
    echo "state_exists=$([[ -f "$state" ]] && echo yes || echo no)" >&2
    [[ -f "$state" ]] && { echo "state_phase=$(jq -r '.phase // "<none>"' "$state" 2>&1)" >&2; echo "state_interruption=$(jq -c '.lastInterruption // "<none>"' "$state" 2>&1)" >&2; echo "state_closure=$(jq -c '.closureEvidence // "<none>"' "$state" 2>&1)" >&2; } || true
    echo "controller_err_tail:" >&2; tail -5 "$fixture_dir/controller.err" >&2 || true
    echo 'fixture_listing:' >&2; ls -la "$fixture_dir" >&2
    echo '---signal-flake-diagnostics end---' >&2
    exit 1
  }
)

test_terminal_state_requires_phase_specific_invariants() (
  local fixture_dir manifest state accepted=0 expression
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"

  for helper in assert_owned_regular_file sha256_file validate_controller_state validate_evidence_binding; do
    eval "$(extract_function "$helper")"
  done
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  for expression in \
    '.phase = "complete" | del(.guardEvidence, .closureEvidence, .guardJournalEvidence)' \
    '.phase = "incident" | del(.incidentClass)'; do
    jq "$expression" "$manifest" > "$state"
    chmod 0600 "$state"
    if (validate_controller_state "$state"); then
      ((accepted += 1))
    fi
  done
  ((accepted == 0)) || {
    echo 'controller accepted a terminal state without its phase-specific evidence' >&2
    exit 1
  }
)

test_preparation_resolves_docker_only_after_hermetic_sanitization() (
  local fixture_dir manifest state live fake_docker ambient_plugin ambient_config shim rc=0
  local ambient_version_sha ambient_model_sha
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  fake_docker="$fixture_dir/docker"
  ambient_plugin="$fixture_dir/docker-compose-plugin-ambient"
  ambient_config="$fixture_dir/ambient-docker"
  write_execution_fixture "$fixture_dir" "$manifest"
  mkdir -m 700 "$ambient_config"
  printf '{}\n' > "$ambient_config/config.json"
  chmod 0600 "$ambient_config/config.json"
  printf '#!/usr/bin/env bash\nprintf "ambient compose plugin\\n"\n' > "$ambient_plugin"
  chmod 0700 "$ambient_plugin"

  cat > "$fake_docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
root=$(dirname "$0")
mode=recorded
if [[ ${DOCKER_HOST:-} == unix:///ambient/docker.sock &&
      ${DOCKER_CONFIG:-} == "$root/ambient-docker" ]]; then
  mode=ambient
fi
if [[ ${1:-} == info ]]; then
  if [[ ${*:-} == *ClientInfo.Plugins* ]]; then
    if [[ "$mode" == ambient ]]; then
      printf '[{"Name":"compose","Path":"%s","Version":"v2.ambient"}]\n' "$root/docker-compose-plugin-ambient"
    else
      printf '[{"Name":"compose","Path":"%s","Version":"v2.fixture"}]\n' "$root/docker-compose-plugin"
    fi
  elif [[ "$mode" == ambient ]]; then
    printf 'ambient-engine\n'
  else
    printf 'fixture-engine\n'
  fi
elif [[ ${1:-} == compose && ${2:-} == version ]]; then
  [[ "$mode" == ambient ]] && printf 'v2.ambient\n' || printf 'v2.fixture\n'
elif [[ ${1:-} == compose ]]; then
  [[ "$mode" == ambient ]] && printf 'ambient model\n' || printf 'candidate model\n'
else
  exit 1
fi
DOCKER
  chmod 0700 "$fake_docker"
  ambient_version_sha=$(printf 'v2.ambient\n' | sha256sum | awk '{print $1}')
  ambient_model_sha=$(printf 'ambient model\n' | sha256sum | awk '{print $1}')
  jq --arg engine ambient-engine \
    --arg dockerSha "$(sha256sum "$fake_docker" | awk '{print $1}')" \
    --arg versionSha "$ambient_version_sha" \
    --arg plugin "$ambient_plugin" \
    --arg pluginSha "$(sha256sum "$ambient_plugin" | awk '{print $1}')" \
    --arg modelSha "$ambient_model_sha" '
      .engineId = $engine |
      .dockerSha256 = $dockerSha |
      .dockerComposeVersionSha256 = $versionSha |
      .composePluginPath = $plugin |
      .composePluginSha256 = $pluginSha |
      .effectiveComposeSha256 = $modelSha
    ' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  if env DOCKER_HOST=unix:///ambient/docker.sock DOCKER_CONFIG="$ambient_config" \
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"; then
    run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
    ((rc != 0)) && [[ $(jq -er '.phase' "$state") == prepared ]] && \
      [[ $(<"$live") == 'source model' ]] || {
      echo 'ambient preparation context did not diverge from sanitized execution as expected' >&2
      exit 1
    }
    echo 'preparation certified ambient Docker and Compose identity before sanitization' >&2
    exit 1
  fi
)

test_controller_executable_is_bound_after_preparation() (
  local fixture_dir manifest state live shim controller_copy rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  controller_copy="$fixture_dir/controller"
  cp "$CONTROLLER" "$controller_copy"
  chmod 0700 "$controller_copy"
  CONTROLLER=$controller_copy
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller-state.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$controller_copy" \
    >/dev/null 2>&1; then
    echo 'controller state path overwrote the bound controller executable' >&2
    exit 1
  fi
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  printf '\n# mutated after preparation\n' >> "$controller_copy"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0)) && [[ $(jq -er '.phase' "$state") == prepared ]] &&
    [[ $(<"$live") == 'source model' ]] || {
    echo 'changed controller executable consumed a valid prepared state' >&2
    exit 1
  }
)

assert_signal_wait_reaps_delayed_child() {
  local guard_mode=$1 verifier_mode=$2 running_marker=$3 complete_marker=$4 pid_file=$5 expected_rc=$6
  local fixture_dir manifest state shim controller_pid='' child_pid='' rc=0 i
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; [[ -z ${child_pid:-} ]] || kill -KILL "$child_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' RETURN
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" "$guard_mode" "$verifier_mode"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/$running_marker" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/$running_marker" ]]
  child_pid=$(<"$fixture_dir/$pid_file")
  kill -TERM "$controller_pid"
  wait "$controller_pid" || rc=$?
  controller_pid=''
  [[ "$rc" == "$expected_rc" ]]
  [[ -e "$fixture_dir/$complete_marker" ]] || {
    echo "controller returned before delayed child was reaped: $running_marker" >&2
    exit 1
  }
  if kill -0 "$child_pid" 2>/dev/null; then
    echo "delayed child remains alive after controller return: $child_pid" >&2
    exit 1
  fi
  child_pid=''
  trap - RETURN
  rm -rf "$fixture_dir"
}

test_guard_signal_waits_until_child_is_reaped() (
  assert_signal_wait_reaps_delayed_child delayed-term success \
    guard-running guard-delay-complete guard-pid 143
)

test_closure_verifier_signal_waits_until_child_is_reaped() (
  assert_signal_wait_reaps_delayed_child complete delayed-term \
    candidate-verifier-running candidate-verifier-delay-complete candidate-verifier-pid 143
)

test_source_verifier_signal_waits_until_child_is_reaped() (
  assert_signal_wait_reaps_delayed_child prejournal-fail delayed-term \
    source-verifier-running source-verifier-delay-complete source-verifier-pid 143
)

test_bootstrap_ignores_ambient_path() (
  local fixture_dir hostile_bin marker
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  hostile_bin="$fixture_dir/bin"
  marker="$fixture_dir/ambient-bash-ran"
  mkdir "$hostile_bin"
  cat > "$hostile_bin/bash" <<SH
#!/bin/sh
: > "$marker"
exec /bin/bash "\$@"
SH
  chmod 0700 "$hostile_bin/bash"

  PATH="$hostile_bin:/usr/bin:/bin" "$CONTROLLER" --help >/dev/null
  [[ ! -e "$marker" ]] || {
    echo 'controller bootstrap selected Bash from ambient PATH' >&2
    exit 1
  }
)

test_docker_config_namespace_rejects_descendants() (
  local fixture_dir manifest state docker_config mutated rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  state="$fixture_dir/home/docker/controller.json"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'controller state was accepted beneath the one-file Docker config directory' >&2
    exit 1
  }

  state="$fixture_dir/controller.json"
  docker_config="$fixture_dir/home/docker"
  mutated="$fixture_dir/docker-config-backup.json"
  jq --arg backup "$docker_config" '
    .backupDir = $backup |
    .guardJournal = ($backup + "/fixture-volume.phase-a2b.json") |
    .guardArgs[13] = $backup
  ' "$manifest" > "$mutated"
  install -m 600 "$mutated" "$manifest"
  rc=0
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'guard backup namespace was accepted as the one-file Docker config directory' >&2
    exit 1
  }
)

test_complete_state_revalidates_durable_evidence() (
  local fixture_dir manifest state shim mutated rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  mutated="$fixture_dir/mutated.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env
  jq '.guardEvidence.path = "/nonexistent/guard-evidence.json"' "$state" > "$mutated"
  install -m 600 "$mutated" "$state"

  bash -c 'source "$1"; validate_controller_state "$2"' _ "$CONTROLLER" "$state" >/dev/null 2>&1 || rc=$?
  ((rc != 0)) || {
    echo 'complete state accepted nonexistent durable process evidence' >&2
    exit 1
  }
)

test_recovery_preserves_prior_process_evidence() (
  local fixture_dir manifest state shim guard_evidence prior_sha rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env
  guard_evidence=$(jq -er '.guardEvidence.path' "$state")
  prior_sha=$(sha256sum "$guard_evidence" | awk '{print $1}')
  jq '.phase = "closure-running"' "$state" > "$fixture_dir/recovery.json"
  install -m 600 "$fixture_dir/recovery.json" "$state"

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc == 0))
  [[ $(sha256sum "$guard_evidence" | awk '{print $1}') == "$prior_sha" ]] || {
    echo 'recovery overwrote previously durable guard process evidence' >&2
    exit 1
  }
)

test_closure_incident_remains_resumable_until_writer_is_stopped() (
  local fixture_dir state stop_count phase_after_first count_after_resume
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  stop_count="$fixture_dir/stop-count"
  printf '0\n' > "$stop_count"
  printf '{"phase":"closure-running","guardJournal":"%s"}\n' \
    "$fixture_dir/missing-guard-journal.json" > "$state"
  chmod 0600 "$state"

  eval "$(extract_function begin_closure_incident)"
  eval "$(extract_function complete_closure_stop_pending)"
  eval "$(extract_function resume_controller_state)"
  path_present() { [[ -e "$1" || -L "$1" ]]; }
  validate_controller_state() { :; }
  update_controller_phase() {
    local target=$1 phase=$2 incident_class=$3
    jq --arg phase "$phase" --arg incidentClass "$incident_class" \
      '.phase = $phase | .incidentClass = $incidentClass' "$target" > "$target.next"
    install -m 600 "$target.next" "$target"
  }
  stop_application_fail_closed() {
    local count
    count=$(<"$stop_count")
    count=$((count + 1))
    printf '%s\n' "$count" > "$stop_count"
    ((count > 1))
  }
  assert_owned_regular_file() { :; }
  delegate_to_guard_journal() { return 1; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  (begin_closure_incident "$state" verification) >/dev/null 2>&1 || true
  phase_after_first=$(jq -er '.phase' "$state")
  (resume_controller_state "$state") >/dev/null 2>&1 || true
  count_after_resume=$(<"$stop_count")

  [[ "$phase_after_first" != incident && "$count_after_resume" == 2 ]] || {
    echo 'closure incident became terminal before a verified app stop could be resumed' >&2
    exit 1
  }
)

test_bootstrap_blocks_bash_env_and_exported_functions() (
  local fixture_dir bash_env_marker function_marker bash_env
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  bash_env_marker="$fixture_dir/bash-env-ran"
  function_marker="$fixture_dir/exported-function-ran"
  bash_env="$fixture_dir/bash-env"
  printf ': > %q\n' "$bash_env_marker" > "$bash_env"
  realpath() {
    : > "$function_marker"
    /usr/bin/realpath "$@"
  }
  export function_marker
  export -f realpath

  BASH_ENV="$bash_env" "$CONTROLLER" --help >/dev/null
  [[ ! -e "$bash_env_marker" && ! -e "$function_marker" ]] || {
    echo 'ambient Bash startup code executed before controller sanitization' >&2
    exit 1
  }
)

test_fixed_path_is_validated_before_installation() (
  local fixture_dir manifest state tool_dir marker rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  tool_dir="$fixture_dir/hostile-bin"
  marker="$fixture_dir/hostile-jq-ran"
  mkdir -m 700 "$tool_dir"
  write_execution_fixture "$fixture_dir" "$manifest"
  cat > "$tool_dir/jq" <<SH
#!/bin/bash
: > "$marker"
exec /usr/bin/jq "\$@"
SH
  chmod 0700 "$tool_dir/jq"
  jq --arg fixedPath "$tool_dir:/usr/bin:/bin" '.fixedPath = $fixedPath' \
    "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  [[ ! -e "$marker" ]] || {
    echo 'manifest fixedPath executed a utility before its trust boundary was validated' >&2
    exit 1
  }
)

test_signal_waits_for_guard_descendant_group() (
  local fixture_dir manifest state shim controller_pid='' descendant_pid='' rc=0 i returned_early=false
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; [[ -z ${descendant_pid:-} ]] || kill "$descendant_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" descendant-term
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/guard-descendant-running" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/guard-descendant-running" ]]
  descendant_pid=$(<"$fixture_dir/guard-descendant-pid")
  kill -TERM "$controller_pid"
  wait "$controller_pid" || rc=$?
  controller_pid=''
  [[ "$rc" == 143 ]]
  if [[ ! -e "$fixture_dir/guard-descendant-complete" ]] || kill -0 "$descendant_pid" 2>/dev/null; then
    returned_early=true
  fi
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/guard-descendant-complete" ]] && ! kill -0 "$descendant_pid" 2>/dev/null && break
    sleep 0.05
  done
  if kill -0 "$descendant_pid" 2>/dev/null; then
    kill "$descendant_pid" 2>/dev/null || true
  fi
  descendant_pid=''
  [[ "$returned_early" == false ]] || {
    echo 'controller returned while descendant transition work retained the operation lock' >&2
    exit 1
  }
)

test_concurrent_reprepare_cannot_replace_live_prepared_state() (
  local fixture_dir manifest alternate state shim controller_pid='' reprepare_rc=0 controller_rc=0 i
  local before_sha after_sha before_inode after_inode
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  alternate="$fixture_dir/alternate.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  before_sha=$(sha256sum "$state" | awk '{print $1}')
  before_inode=$(stat -c '%i' "$state")
  jq '.appUrl = "http://127.0.0.1:26578"' "$manifest" > "$alternate"
  chmod 0600 "$alternate"
  : > "$fixture_dir/pause-next-docker"

  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/docker-paused" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/docker-paused" ]]
  "$CONTROLLER" --prepare --manifest "$alternate" --state "$state" >/dev/null 2>&1 || reprepare_rc=$?
  after_sha=$(sha256sum "$state" | awk '{print $1}')
  after_inode=$(stat -c '%i' "$state")
  : > "$fixture_dir/release-docker"
  wait "$controller_pid" || controller_rc=$?
  controller_pid=''
  ((controller_rc == 0))

  ((reprepare_rc != 0)) && [[ "$before_sha" == "$after_sha" && "$before_inode" == "$after_inode" ]] || {
    echo 'concurrent preparation replaced a live prepared controller state' >&2
    exit 1
  }
)

test_guard_requires_deferred_writer_restart() (
  local fixture_dir manifest state
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  jq '.guardArgs |= map(select(. != "--defer-app-restart"))' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1; then
    echo 'controller accepted a guard invocation that can restart the writer before closure is durable' >&2
    exit 1
  fi
)

test_verified_guard_bytes_cannot_be_replaced_before_use() (
  local fixture_dir manifest state shim guard controller_pid='' rc=0 i
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${controller_pid:-} ]] || kill "$controller_pid" 2>/dev/null || true; rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  guard="$fixture_dir/guard"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  : > "$fixture_dir/pause-engine-info"

  background_fixture_controller "$state" "$shim" env >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
  controller_pid=$!
  for i in $(seq 1 600); do
    [[ -e "$fixture_dir/engine-info-paused" ]] && break
    kill -0 "$controller_pid" 2>/dev/null || break
    sleep 0.05
  done
  [[ -e "$fixture_dir/engine-info-paused" ]]
  cat > "$guard.next" <<'GUARD'
#!/usr/bin/env bash
: > "$(dirname "$0")/replacement-guard-ran"
exit 23
GUARD
  chmod 0700 "$guard.next"
  mv -f "$guard.next" "$guard"
  : > "$fixture_dir/release-engine-info"
  wait "$controller_pid" || rc=$?
  controller_pid=''

  [[ ! -e "$fixture_dir/replacement-guard-ran" ]] || {
    echo 'verified guard path replacement executed after input validation' >&2
    exit 1
  }
  ((rc == 0)) || {
    echo 'bound original guard bytes did not complete after pathname replacement' >&2
    exit 1
  }
)

test_concurrent_first_preparation_is_no_replace() (
  local fixture_dir manifest alternate state first_pid second_pid first_rc=0 second_rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  alternate="$fixture_dir/alternate.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  jq '.appUrl = "http://127.0.0.1:26578"' "$manifest" > "$alternate"
  chmod 0600 "$alternate"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1 &
  first_pid=$!
  "$CONTROLLER" --prepare --manifest "$alternate" --state "$state" >/dev/null 2>&1 &
  second_pid=$!
  wait "$first_pid" || first_rc=$?
  wait "$second_pid" || second_rc=$?

  if ! (( (first_rc == 0 && second_rc != 0) || (first_rc != 0 && second_rc == 0) )); then
    echo 'concurrent first preparations did not produce exactly one durable winner' >&2
    exit 1
  fi
  [[ $(jq -er '.appUrl' "$state") == http://127.0.0.1:16578 ||
     $(jq -er '.appUrl' "$state") == http://127.0.0.1:26578 ]]
)

test_fixed_path_rejects_mutable_symlink_aliases() (
  local fixture_dir manifest state alias
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  alias="$fixture_dir/system-bin"
  write_execution_fixture "$fixture_dir" "$manifest"
  ln -s /usr/bin "$alias"
  jq --arg fixedPath "$alias:/bin" '.fixedPath = $fixedPath' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  if "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" >/dev/null 2>&1; then
    echo 'fixed PATH accepted a mutable symlink alias after validating only its target' >&2
    exit 1
  fi
)

test_verifier_evidence_failure_remains_resumable() (
  local fixture_dir manifest state shim rc=0 phase
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  phase=$(jq -er '.phase' "$state")
  [[ "$phase" == closure-evidence-pending && -e "$fixture_dir/app-stopped" ]] || {
    echo 'verifier evidence storage failure became terminal before durable evidence binding' >&2
    exit 1
  }
)

test_operation_lock_open_does_not_follow_symlinks() (
  local fixture_dir lock_root victim lock_key lock_path rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  lock_root="$fixture_dir/locks"
  victim="$fixture_dir/victim"
  mkdir -m 700 "$lock_root"
  printf 'do-not-truncate\n' > "$victim"
  chmod 0600 "$victim"
  lock_key=$(printf '%s\0%s' fixture-engine fixture-volume | sha256sum | awk '{print $1}')
  lock_path="$lock_root/noosphere-pgvector-switch-$lock_key.lock"
  ln -s "$victim" "$lock_path"

  eval "$(extract_function acquire_operation_lock)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  (acquire_operation_lock fixture-engine fixture-volume "$lock_root") >/dev/null 2>&1 || rc=$?

  ((rc != 0)) && [[ $(<"$victim") == do-not-truncate ]] || {
    echo 'operation lock followed a pre-existing symlink and truncated its target' >&2
    exit 1
  }
)

test_execution_bundle_accepts_trusted_root_owned_executables() (
  local fixture_dir source target expected rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  source=/usr/bin/docker
  target="$fixture_dir/bound-docker"
  [[ $(stat -c '%u' "$source") == 0 ]] || {
    echo 'root-owned executable fixture source is not root-owned' >&2
    exit 1
  }
  expected=$(sha256sum "$source" | awk '{print $1}')

  for helper in assert_owned_regular_file sha256_file copy_execution_input; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  (copy_execution_input "$source" "$target" "$expected" 700 system-executable) || rc=$?
  ((rc == 0)) && [[ $(sha256_file "$target") == "$expected" ]] || {
    echo 'execution bundle rejected a trusted root-owned system executable' >&2
    exit 1
  }
)

test_bootstrap_utility_resolution_is_trusted_before_use() (
  local fixture_dir controller_copy hostile_bin marker
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  controller_copy="$fixture_dir/controller"
  hostile_bin="$fixture_dir/hostile-bin"
  marker="$fixture_dir/hostile-realpath-ran"
  mkdir -m 700 "$hostile_bin"
  sed "s|/usr/local/bin|$hostile_bin|" "$CONTROLLER" > "$controller_copy"
  chmod 0700 "$controller_copy"
  cat > "$hostile_bin/realpath" <<SH
#!/bin/sh
: > "$marker"
exec /usr/bin/realpath "\$@"
SH
  chmod 0700 "$hostile_bin/realpath"

  "$controller_copy" --help >/dev/null
  [[ ! -e "$marker" ]] || {
    echo 'controller executed a PATH-resolved bootstrap utility before proving its directory trusted' >&2
    exit 1
  }
)

test_systemd_context_requires_transient_unit_provenance() (
  local fixture_dir manifest
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  eval "$(extract_function require_systemd_execution_context)"
  controller_state="$manifest"
  INVOCATION_ID=0123456789abcdef0123456789abcdef
  CONTROLLER_UNIT=noosphere-pgvector-transition.service
  query_systemd_unit_identity() {
    printf '%s\n' \
      ActiveState=active \
      "InvocationID=$INVOCATION_ID" \
      "MainPID=$$" \
      Type=exec \
      RemainAfterExit=no \
      Restart=no \
      KillMode=mixed \
      TimeoutStartUSec=infinity \
      TimeoutStopUSec=infinity \
      RuntimeMaxUSec=infinity \
      UMask=0077 \
      Transient=no \
      "WorkingDirectory=$(dirname "$(jq -er '.liveCompose' "$controller_state")")"
  }
  query_user_linger() { printf 'yes\n'; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  if (require_systemd_execution_context); then
    echo 'persistent systemd service satisfied the transient execution contract' >&2
    exit 1
  fi
)

test_writer_activation_lifecycle_is_ordered_and_evidence_bound() (
  local fixture_dir manifest state shim rc=0 authorization_evidence
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc == 0)) || {
    echo 'controller could not complete the deferred-writer activation lifecycle' >&2
    exit 1
  }
  [[ $(paste -sd, "$fixture_dir/lifecycle.log") == transition,authorize,activate,verify ]] || {
    echo 'writer authorization, activation, and final verification ran out of order' >&2
    exit 1
  }
  authorization_evidence=$(jq -er '.authorizationEvidence.path' "$state")
  jq -e '
    .phase == "complete" and
    (.authorizationEvidence.sha256 | test("^[a-f0-9]{64}$")) and
    (.closureEvidence.sha256 | test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null
  jq -e '.phase == "authorization-running" and .exitCode == 0' \
    "$authorization_evidence" >/dev/null
)

test_authorization_evidence_is_durable_before_activation() (
  local fixture_dir manifest state shim rc=0 resume_rc=0 authorization_evidence
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION=TERM >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 143 ]] || {
    echo 'authorization boundary did not return the latched signal exit' >&2
    exit 1
  }
  # A latched signal at the pre-activation boundary fails closed: the authorized
  # writer is freshly stopped and the state carries a classified closure
  # interruption incident instead of a silently resumable activation phase.
  jq -e '.phase == "incident" and .incidentClass == "closure-interruption"' \
    "$state" >/dev/null || {
    echo 'pre-activation signal did not commit a classified closure interruption' >&2
    exit 1
  }
  [[ ! -e "$fixture_dir/app-started" ]] || {
    echo 'writer activation began before authorization evidence was durable' >&2
    exit 1
  }
  authorization_evidence=$(jq -er '.authorizationEvidence.path' "$state")
  jq -e '.phase == "authorization-running" and .exitCode == 0' \
    "$authorization_evidence" >/dev/null

  # The classified incident is terminal for this transition identity: a fresh
  # execution must refuse instead of activating the writer — and the refusal
  # must come from terminal-incident handling, not from some unrelated fault
  # (e.g. a regression in authorization that just happens to fail).
  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env \
      >/dev/null 2>"$fixture_dir/refresh.err" && {
      echo 'classified closure interruption was resumable as a fresh execution' >&2
      exit 1
    }
  # The diagnostic is intentionally shared with the closure-stop-pending resume
  # path (controller L332) so any controller branch that requires operator
  # resolution for a classified closure-interruption emits the same string.
  # Combined with the .incidentClass jq assertion below, this confirms the
  # refusal came from terminal-incident handling for the right class.
  grep -q "controller incident requires operator resolution: closure-interruption" \
    "$fixture_dir/refresh.err" || {
      echo 'fresh execution refused for a reason other than terminal-incident classification' >&2
      sed 's/^/  refresh.err: /' "$fixture_dir/refresh.err" >&2
      exit 1
    }
  jq -e '.phase == "incident" and .incidentClass == "closure-interruption"' \
    "$state" >/dev/null || {
      echo 'fresh execution mutated the terminal incident classification' >&2
      exit 1
    }
  jq -e '.writerStopEvidence
         | (.path | type == "string" and startswith("/"))
           and (.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
    "$state" >/dev/null || {
      echo 'fresh execution corrupted the durable writer-stop evidence' >&2
      exit 1
  }
  [[ $(paste -sd, "$fixture_dir/lifecycle.log") == transition,authorize ]] || {
    echo 'writer activated despite the classified closure interruption' >&2
    exit 1
  }
)

test_app_activation_failure_is_fail_closed_before_final_verification() (
  local fixture_dir manifest state shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  : > "$fixture_dir/fail-activation"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-app-activation" and
    (.authorizationEvidence.sha256 | test("^[a-f0-9]{64}$")) and
    has("closureEvidence") == false
  ' "$state" >/dev/null || {
    echo 'failed app activation did not preserve a fail-closed durable incident' >&2
    exit 1
  }
  [[ -e "$fixture_dir/app-stopped" ]]
  [[ $(paste -sd, "$fixture_dir/lifecycle.log") == transition,authorize,activate ]] || {
    echo 'final verifier ran despite failed app activation' >&2
    exit 1
  }
)

test_term_after_activation_stops_writer_before_return() (
  local fixture_dir manifest state shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  : > "$fixture_dir/signal-after-activation"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 143 ]]
  [[ -e "$fixture_dir/app-stopped" ]] || {
    echo 'TERM after app activation returned with the writer still running' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-interruption" and
    has("closureEvidence") == false
  ' "$state" >/dev/null || {
    echo 'TERM after app activation did not commit a fail-closed interruption incident' >&2
    exit 1
  }
)

test_closure_evidence_pending_resume_never_reactivates_writer() (
  local fixture_dir manifest state shim rc=0 resume_rc=0 activation_count
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  [[ $(jq -er '.phase' "$state") == closure-evidence-pending ]]
  [[ -e "$fixture_dir/app-stopped" ]]
  activation_count=$(rg -c '^activate$' "$fixture_dir/lifecycle.log")
  [[ "$activation_count" == 1 ]]

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" env >/dev/null 2>&1 || resume_rc=$?
  ((resume_rc != 0))
  activation_count=$(rg -c '^activate$' "$fixture_dir/lifecycle.log")
  [[ "$activation_count" == 1 ]] || {
    echo 'closure-evidence-pending resume reactivated the failed writer' >&2
    exit 1
  }
  [[ -e "$fixture_dir/app-stopped" ]]
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-verification" and
    (.closureEvidence.sha256 | test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null
)

test_missing_live_compose_commits_prejournal_restoration_incident() (
  local fixture_dir state live source guard_journal source_sha rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  source="$fixture_dir/source-compose.yml"
  guard_journal="$fixture_dir/guard.json"
  printf 'source\n' > "$source"
  chmod 0644 "$source"
  source_sha=$(sha256sum "$source" | awk '{print $1}')
  write_fixture_controller_state "$state" candidate-published "$live" "$source" "$source_sha" "$guard_journal"

  for helper in path_present assert_owned_regular_file sha256_file \
    write_controller_state_atomic validate_controller_state validate_evidence_binding update_controller_phase \
    restore_source_compose_snapshot resume_controller_state; do
    eval "$(extract_function "$helper")"
  done
  fsync_path() { :; }
  assert_source_state_unchanged() { :; }
  run_source_recovery_verifier_with_evidence() { :; }
  delegate_to_guard_journal() { exit 1; }
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }

  (resume_controller_state "$state") >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  jq -e '
    .phase == "incident" and
    .incidentClass == "pre-journal-source-restoration"
  ' "$state" >/dev/null || {
    echo 'missing live Compose bypassed durable pre-journal restoration classification' >&2
    exit 1
  }
)

test_post_activation_artifact_setup_failure_stops_writer_durably() (
  local fixture_dir manifest state shim activation_count control_tail rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_post_authorization_artifact_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  : > "$fixture_dir/fail-next-artifact-storage-after-authorization"
  : > "$fixture_dir/kill-controller-if-incident-before-stop"

  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc != 0))
  [[ -e "$fixture_dir/post-authorization-artifact-failure-consumed" ]] || {
    echo 'artifact-storage fixture missed the semantic post-authorization allocation boundary' >&2
    exit 1
  }
  activation_count=$(rg -c '^activate$' "$fixture_dir/lifecycle.log" || printf '0\n')
  case "$activation_count" in
    0)
      [[ -e "$fixture_dir/app-stopped" ]] || {
        echo 'pre-activation artifact rejection did not preserve the stopped writer' >&2
        exit 1
      }
      ;;
    1)
      control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
      [[ "$control_tail" == stop,inspect:false ]] || {
        echo 'post-activation artifact setup failure did not verify the writer stop' >&2
        exit 1
      }
      jq -e '
        .phase == "incident" and
        (.incidentClass | type == "string" and startswith("closure-"))
      ' "$state" >/dev/null || {
        echo 'post-activation artifact setup failure lacks durable verified stop state' >&2
        exit 1
      }
      ;;
    *)
      echo 'artifact collision fixture activated the writer more than once' >&2
      exit 1
      ;;
  esac
)

test_closure_evidence_pending_requires_verified_stop_before_persistence() (
  local fixture_dir state stopped kill_on_pending=true rc=0
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  stopped="$fixture_dir/app-stopped"
  printf '{"phase":"closure-running"}\n' > "$state"
  chmod 0600 "$state"

  eval "$(extract_function begin_closure_evidence_pending)"
  update_controller_phase() {
    local target=$1 phase=$2 incident_class=${3:-} temp
    temp="$target.next"
    jq --arg phase "$phase" --arg incidentClass "$incident_class" \
      '.phase = $phase | .incidentClass = $incidentClass' "$target" > "$temp"
    mv "$temp" "$target"
    if [[ "$phase" == closure-evidence-pending && "$kill_on_pending" == true ]]; then
      kill -KILL "$BASHPID"
    fi
  }
  stop_application_fail_closed() { : > "$stopped"; }

  (begin_closure_evidence_pending "$state" verification) >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 137 ]]
  [[ -e "$stopped" ]] ||
    failures+=('closure-evidence-pending became durable before the writer stop was verified')
  [[ $(jq -er '.phase' "$state") == closure-evidence-pending ]]

  printf '{"phase":"closure-running"}\n' > "$state"
  kill_on_pending=false
  stop_application_fail_closed() { return 1; }
  rc=0
  (begin_closure_evidence_pending "$state" verification) >/dev/null 2>&1 || rc=$?
  ((rc != 0))
  [[ $(jq -er '.phase' "$state") != closure-evidence-pending ]] ||
    failures+=('closure-evidence-pending became durable after stop verification failed')
  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_same_name_volume_replacement_is_rejected_after_preparation() (
  local fixture_dir='' manifest state shim expected_fingerprint live_fingerprint field
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for field in Driver Mountpoint CreatedAt Scope Labels Options; do
    _clear_authority_root_for_isolation
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_systemd_identity_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

    expected_fingerprint=$(jq -er '.volumeFingerprint' "$state")
    live_fingerprint=$(jq -Sc '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' \
      "$fixture_dir/volume-inspect.json" | sha256sum | awk '{print $1}')
    [[ "$expected_fingerprint" == "$live_fingerprint" ]] || {
      echo 'prepared volume fingerprint does not match the canonical inspection oracle' >&2
      exit 1
    }

    case "$field" in
      Driver) jq '.[0].Driver = "replacement-driver"' "$fixture_dir/volume-inspect.json" ;;
      Mountpoint) jq '.[0].Mountpoint = "/var/lib/docker/volumes/replaced-fixture-volume/_data"' "$fixture_dir/volume-inspect.json" ;;
      CreatedAt) jq '.[0].CreatedAt = "2026-08-15T00:00:01Z"' "$fixture_dir/volume-inspect.json" ;;
      Scope) jq '.[0].Scope = "replacement-scope"' "$fixture_dir/volume-inspect.json" ;;
      Labels) jq '.[0].Labels = {"fixture":"replacement"}' "$fixture_dir/volume-inspect.json" ;;
      Options) jq '.[0].Options = {"type":"none","o":"bind","device":"/replacement"}' "$fixture_dir/volume-inspect.json" ;;
    esac > "$fixture_dir/volume-inspect.next"
    mv "$fixture_dir/volume-inspect.next" "$fixture_dir/volume-inspect.json"
    live_fingerprint=$(jq -Sc '.[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}' \
      "$fixture_dir/volume-inspect.json" | sha256sum | awk '{print $1}')
    [[ "$live_fingerprint" != "$expected_fingerprint" ]]
    rm -f "$fixture_dir/volume-inspect-seen" "$fixture_dir/live-identity.log"

    if run_fixture_controller "$state" "$shim" env \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err"; then
      echo "same-name PostgreSQL volume replacement escaped the prepared fingerprint: $field" >&2
      exit 1
    fi
    [[ -e "$fixture_dir/volume-inspect-seen" ]] || {
      echo "execution did not inspect the replaced PostgreSQL volume: $field" >&2
      exit 1
    }
    rg -i 'PostgreSQL volume fingerprint.*(changed|differs|does not match)' \
      "$fixture_dir/controller.err" >/dev/null || {
      echo "volume replacement failed for an unrelated mechanism: $field" >&2
      exit 1
    }
    [[ $(jq -er '.phase' "$state") == prepared ]]
    [[ $(<"$fixture_dir/docker-compose.yml") == 'source model' ]]
    rm -rf "$fixture_dir"
    fixture_dir=''
  done
)

test_live_identity_checks_wait_for_the_shared_operation_lock() (
  local fixture_dir manifest state shim prepare_unheld execute_unheld call_class rc=0
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  rm -f "$fixture_dir/live-identity.log"
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" \
    >"$fixture_dir/prepare.out" 2>"$fixture_dir/prepare.err" || rc=$?
  ((rc == 0)) || {
    echo 'lock-order preparation fixture failed before its live-call oracle' >&2
    exit 1
  }
  prepare_unheld=$(rg ':unheld$' "$fixture_dir/live-identity.log" || true)
  for call_class in info volume-inspect compose-version compose-config; do
    rg -q "^$call_class:" "$fixture_dir/live-identity.log" ||
      failures+=("preparation omitted required live identity call: $call_class")
  done
  if [[ -n "$prepare_unheld" ]]; then
    failures+=('preparation issued live Docker/Compose identity calls without the shared operation lock')
  fi

  rm -f "$fixture_dir/live-identity.log"
  rc=0
  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/execute.out" 2>"$fixture_dir/execute.err" || rc=$?
  ((rc == 0)) || {
    echo 'lock-order execution fixture failed before its live-call oracle' >&2
    exit 1
  }
  execute_unheld=$(rg ':unheld$' "$fixture_dir/live-identity.log" || true)
  for call_class in info volume-inspect compose-version compose-config; do
    rg -q "^$call_class:" "$fixture_dir/live-identity.log" ||
      failures+=("execution omitted required live identity call: $call_class")
  done
  if [[ -n "$execute_unheld" ]]; then
    failures+=('execution issued live Docker/Compose identity calls without the shared operation lock')
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    [[ -z "$prepare_unheld" ]] || printf '%s\n' "$prepare_unheld" >&2
    [[ -z "$execute_unheld" ]] || printf '%s\n' "$execute_unheld" >&2
    exit 1
  }
)

test_successful_verifier_postprocessing_failure_stops_writer() (
  local failure fixture_dir='' manifest state shim rc phase control_tail
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for failure in evidence cursor state; do
    # Each iteration runs a real controller that claims the durable authority
    # record for the shared fake engine+volume identity; the previous
    # iteration's fixture is deleted, leaving a stale record that fail-closed
    # --prepare correctly refuses. Isolate per iteration.
    _clear_authority_root_for_isolation
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    if [[ "$failure" == state ]]; then
      shim=$(write_complete_state_failure_shim "$fixture_dir")
    else
      shim=$(write_systemd_identity_shim "$fixture_dir")
    fi
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
    [[ "$failure" != cursor ]] || : > "$fixture_dir/fail-cursor-after-successful-verifier"
    [[ "$failure" != state ]] || : > "$fixture_dir/fail-complete-state-write"

    rc=0
    if [[ "$failure" == evidence ]]; then
      run_fixture_controller "$state" "$shim" env \
        NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running \
        >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
      rg -Fq 'test evidence failure at phase closure-running' "$fixture_dir/controller.err" ||
        failures+=("successful verifier evidence fixture missed its injected failure")
    elif [[ "$failure" == cursor ]]; then
      run_fixture_controller "$state" "$shim" env \
        >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
      [[ -e "$fixture_dir/cursor-failure-consumed" ]] ||
        failures+=("successful verifier cursor fixture missed its injected failure")
    else
      run_fixture_controller "$state" "$shim" env \
        >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
      [[ -e "$fixture_dir/complete-state-write-failure-consumed" ]] ||
        failures+=("successful verifier state fixture missed its injected failure")
    fi
    ((rc != 0)) || failures+=("successful verifier $failure failure reported success")
    rg -q '^verify$' "$fixture_dir/lifecycle.log" ||
      failures+=("successful verifier $failure failure happened before verification succeeded")
    [[ -e "$fixture_dir/app-stopped" ]] ||
      failures+=("successful verifier $failure failure left the writer running")
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
    [[ "$control_tail" == stop,inspect:false ]] ||
      failures+=("successful verifier $failure failure did not inspect-verify the writer stop")
    phase=$(jq -r '.phase // empty' "$state")
    if [[ "$failure" == state ]]; then
      [[ "$phase" != complete ]] ||
        failures+=("successful verifier state-storage failure exposed complete")
    else
      [[ "$phase" == closure-stop-pending || "$phase" == closure-evidence-pending || "$phase" == incident ]] ||
        failures+=("successful verifier $failure failure lacks durable closure stop intent (phase=$phase)")
    fi

    rm -rf "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_post_activation_signal_with_zero_exit_verifier_stops_writer() (
  local fixture_dir='' manifest state shim controller_pid='' child_pid='' evidence='' rc i control_tail
  local signal expected_rc signal_spec
  local -a failures=()
  trap 'terminate_fixture_process "${controller_pid:-}"; terminate_fixture_process "${child_pid:-}"; [[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for signal_spec in TERM:143 INT:130 HUP:129; do
    # Per-iteration authority isolation (same rationale as the verifier
    # postprocessing loop: stale records from deleted fixtures must not
    # poison the next iteration's --prepare).
    _clear_authority_root_for_isolation
    signal=${signal_spec%%:*}
    expected_rc=${signal_spec##*:}
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest" complete signal-zero
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_systemd_identity_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

    rc=0
    background_fixture_controller "$state" "$shim" env --default-signal="$signal" \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
    controller_pid=$!
    for i in $(seq 1 600); do
      [[ -e "$fixture_dir/candidate-verifier-running" ]] && break
      kill -0 "$controller_pid" 2>/dev/null || break
      sleep 0.05
    done
    [[ -e "$fixture_dir/candidate-verifier-running" ]]
    child_pid=$(<"$fixture_dir/candidate-verifier-pid")
    kill -s "$signal" "$controller_pid"
    wait_fixture_process_bounded "$controller_pid" || rc=$?
    if ((rc == 124)); then
      failures+=("post-activation $signal controller exceeded the bounded wait")
      terminate_fixture_process "$controller_pid"
    fi
    controller_pid=''

    [[ "$rc" == "$expected_rc" ]] ||
      failures+=("post-activation $signal returned $rc instead of $expected_rc")
    [[ -e "$fixture_dir/candidate-verifier-signal-zero" ]] ||
      failures+=("post-activation signal fixture did not exercise a verifier that handled $signal and exited zero")
    [[ -e "$fixture_dir/candidate-verifier-signal-zero-complete" ]] ||
      failures+=("post-activation $signal fixture returned before the zero-exit verifier completed")
    evidence=$(jq -r '.closureEvidence.path // empty' "$state")
    [[ -n "$evidence" && -f "$evidence" && $(jq -er '.exitCode' "$evidence") == 0 ]] ||
      failures+=("post-activation $signal fixture did not record the verifier zero exit")
    [[ -e "$fixture_dir/app-stopped" ]] ||
      failures+=("post-activation $signal returned after a zero-exit verifier with the writer still running")
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
    [[ "$control_tail" == stop,inspect:false ]] ||
      failures+=("post-activation $signal did not inspect-verify the writer stop after the verifier exited zero")
    jq -e --arg signal "$signal" '
      .phase == "incident" and
      .incidentClass == "closure-interruption" and
      .lastInterruption.signal == $signal
    ' "$state" >/dev/null ||
      failures+=("post-activation $signal with a zero-exit verifier lacks a durable interruption incident")
    if kill -0 "$child_pid" 2>/dev/null; then
      failures+=("post-activation $signal verifier remains alive after controller return")
      terminate_fixture_process "$child_pid"
    fi
    child_pid=''

    rm -rf "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_source_recovery_signal_persists_process_evidence() (
  local case_name verifier_mode expected_rc expected_signal fixture_dir='' manifest state shim
  local controller_pid='' observed_controller_pid='' child_pid='' evidence='' rc i
  local expected_evidence expected_stdout expected_stderr evidence_sha stdout_sha stderr_sha
  local expected_boot expected_boot_cursor
  local -a failures=()
  trap 'terminate_fixture_process "${controller_pid:-}"; terminate_fixture_process "${child_pid:-}"; [[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for case_name in ordinary interrupted; do
    # Both cases claim the same fake engine+volume authority, but the first
    # fixture directory is deleted before the second prepare. Clear only the
    # suite-owned authority namespace so the interrupted case cannot inherit
    # a stale record whose state path no longer exists.
    _clear_authority_root_for_isolation
    if [[ "$case_name" == ordinary ]]; then
      verifier_mode=source-fail
      expected_rc=42
      expected_signal=''
    else
      verifier_mode=delayed-term
      expected_rc=143
      expected_signal=TERM
    fi
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest" prejournal-fail "$verifier_mode"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_systemd_identity_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
    expected_boot=$(< /proc/sys/kernel/random/boot_id)
    expected_boot_cursor="b=${expected_boot//-/}"

    rc=0
    background_fixture_controller "$state" "$shim" env \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" &
    controller_pid=$!
    observed_controller_pid=$controller_pid
    if [[ -n "$expected_signal" ]]; then
      for i in $(seq 1 600); do
        [[ -e "$fixture_dir/source-verifier-running" ]] && break
        kill -0 "$controller_pid" 2>/dev/null || break
        sleep 0.05
      done
      [[ -e "$fixture_dir/source-verifier-running" ]]
      child_pid=$(<"$fixture_dir/source-verifier-pid")
      kill -s "$expected_signal" "$controller_pid"
    fi
    wait_fixture_process_bounded "$controller_pid" || rc=$?
    if ((rc == 124)); then
      failures+=("source recovery $case_name controller exceeded the bounded wait")
      terminate_fixture_process "$controller_pid"
    fi
    controller_pid=''
    [[ -n "$child_pid" ]] || child_pid=$(<"$fixture_dir/source-verifier-pid")

    [[ "$rc" == "$expected_rc" ]] ||
      failures+=("source recovery $case_name failure collapsed to exit $rc instead of $expected_rc")
    expected_evidence="${state%.json}.source-recovery.evidence.json"
    expected_stdout="${state%.json}.source-recovery.stdout.log"
    expected_stderr="${state%.json}.source-recovery.stderr.log"
    evidence=$(jq -r '.sourceRecoveryEvidence.path // empty' "$state")
    if [[ "$evidence" != "$expected_evidence" || ! -f "$expected_evidence" ||
          ! -f "$expected_stdout" || ! -f "$expected_stderr" ]]; then
      failures+=("source recovery $case_name failure returned without its exact process/log artifacts")
    else
      local expected_stdout_sha expected_stderr_sha
      evidence_sha=$(sha256sum "$expected_evidence" | awk '{print $1}')
      stdout_sha=$(sha256sum "$expected_stdout" | awk '{print $1}')
      stderr_sha=$(sha256sum "$expected_stderr" | awk '{print $1}')
      expected_stdout_sha=$(printf '' | sha256sum | awk '{print $1}')
      if [[ "$case_name" == ordinary ]]; then
        expected_stderr_sha=$(printf 'source verification failed\n' | sha256sum | awk '{print $1}')
      else
        expected_stderr_sha=$(printf 'source verifier interrupted\n' | sha256sum | awk '{print $1}')
      fi
      [[ "$stdout_sha" == "$expected_stdout_sha" && "$stderr_sha" == "$expected_stderr_sha" ]] ||
        failures+=("source recovery $case_name logs do not match the independently expected bytes")
      jq -e \
        --argjson exitCode "$expected_rc" \
        --arg invocation 0123456789abcdef0123456789abcdef \
        --arg boot "$expected_boot" \
        --arg bootCursor "$expected_boot_cursor" \
        --argjson controllerPid "$observed_controller_pid" \
        --argjson childPid "$child_pid" \
        --arg stdout "$expected_stdout" \
        --arg stderr "$expected_stderr" \
        --arg stdoutSha "$expected_stdout_sha" \
        --arg stderrSha "$expected_stderr_sha" '
          .phase == "source-recovery-running" and .exitCode == $exitCode and
          .invocationId == $invocation and .bootId == $boot and
          .controllerMainPid == $controllerPid and .childPid == $childPid and
          (.startCursor | type == "string" and contains($bootCursor)) and
          (.endCursor | type == "string" and contains($bootCursor)) and
          .startCursor != "fixture-cursor" and .endCursor != "fixture-cursor" and
          .startCursor != "forged-journal-cursor" and
          .endCursor != "forged-journal-cursor" and
          .stdout == $stdout and .stderr == $stderr and
          .stdoutSha256 == $stdoutSha and .stderrSha256 == $stderrSha
        ' "$expected_evidence" >/dev/null ||
        failures+=("source recovery $case_name evidence is not bound to the exact process and log bytes")
      jq -e \
        --arg path "$expected_evidence" \
        --arg sha "$evidence_sha" \
        --arg stdout "$expected_stdout" \
        --arg stdoutSha "$expected_stdout_sha" \
        --arg stderr "$expected_stderr" \
        --arg stderrSha "$expected_stderr_sha" '
          .sourceRecoveryEvidence == {
            path:$path, sha256:$sha,
            stdout:{path:$stdout,sha256:$stdoutSha},
            stderr:{path:$stderr,sha256:$stderrSha}
          }
        ' "$state" >/dev/null ||
        failures+=("source recovery $case_name evidence/log digests are not durably bound")
    fi
    if [[ "$case_name" == ordinary ]]; then
      rg -Fq 'source verification failed' "$expected_stderr" 2>/dev/null ||
        failures+=("ordinary source recovery failure did not preserve verifier stderr")
      jq -e '.phase == "incident" and .incidentClass == "pre-journal-source-verification"' "$state" >/dev/null ||
        failures+=("ordinary source recovery failure lacks its durable verification incident")
    else
      jq -e '.lastInterruption.signal == "TERM"' "$state" >/dev/null ||
        failures+=("source recovery TERM is missing from durable interruption state")
      [[ -e "$fixture_dir/source-verifier-delay-complete" ]] ||
        failures+=("source recovery controller returned before the signaled verifier completed")
    fi
    if kill -0 "$child_pid" 2>/dev/null; then
      failures+=("source recovery $case_name verifier remains alive after controller return")
    fi
    child_pid=''

    rm -rf "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_prejournal_recovery_refuses_unexpected_live_compose() (
  local fixture_dir manifest state live shim rc=0 guard_evidence incident_class expected_live_sha
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest" third-state-fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc != 0))
  [[ -e "$fixture_dir/source-verifier-succeeded" ]] || {
    echo 'third-state recovery fixture did not prove source verification succeeded' >&2
    exit 1
  }
  guard_evidence=$(jq -r '.guardEvidence.path // empty' "$state")
  [[ -n "$guard_evidence" && -f "$guard_evidence" &&
     $(jq -er '.exitCode' "$guard_evidence") == 23 ]] || {
    echo 'third-state recovery fixture did not preserve the intended pre-journal guard failure' >&2
    exit 1
  }
  expected_live_sha=$(printf 'unexpected third state\n' | sha256sum | awk '{print $1}')
  [[ $(sha256sum "$live" | awk '{print $1}') == "$expected_live_sha" ]] || {
    echo 'pre-journal recovery overwrote an unexpected third-state live Compose file' >&2
    exit 1
  }
  incident_class=$(jq -r '.incidentClass // empty' "$state")
  [[ $(jq -r '.phase // empty' "$state") == incident &&
     "$incident_class" =~ ^pre-journal-.*(compose|model).*(diverg|unexpected|mismatch) ]] || {
    echo "unexpected third-state live Compose lacks a semantic divergence incident (class=$incident_class)" >&2
    exit 1
  }
  rg -i 'live Compose.*(unexpected|diverg|differ|mismatch|neither|not match)' \
    "$fixture_dir/controller.err" >/dev/null || {
    echo 'third-state recovery rejection lacks an explicit live-Compose divergence diagnostic' >&2
    exit 1
  }
)

test_complete_write_cannot_race_final_guard_journal_validation() (
  local fixture_dir manifest state journal shim rc=0 phase lock_key lock_path
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  journal="$fixture_dir/backup/fixture-volume.phase-a2b.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_guard_journal_race_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  : > "$fixture_dir/mutate-journal-before-complete-write"

  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  [[ -e "$fixture_dir/cooperative-mutator-attempted-at-complete-write" ]] || {
    echo 'cooperative journal actor did not contend at the final complete-state write boundary' >&2
    exit 1
  }
  rg -q '^verify$' "$fixture_dir/lifecycle.log" || {
    echo 'guard-journal race fixture failed before successful closure verification' >&2
    exit 1
  }
  phase=$(jq -r '.phase // empty' "$state")
  [[ -e "$fixture_dir/cooperative-mutator-blocked-at-complete-write" &&
     ! -e "$fixture_dir/cooperative-mutator-acquired-at-complete-write" ]] || {
    echo 'cooperative journal actor acquired the engine-volume lock during complete publication' >&2
    exit 1
  }
  ((rc == 0)) && [[ "$phase" == complete && -e "$fixture_dir/complete-state-published" ]] || {
    echo 'controller did not publish complete under the cooperative lock boundary' >&2
    exit 1
  }
  jq -e --arg sha "$(sha256sum "$journal" | awk '{print $1}')" '
    .phase == "complete" and .guardJournalEvidence.sha256 == $sha
  ' "$state" >/dev/null || {
    echo 'complete state and guard journal are not bound under the cooperative lock boundary' >&2
    exit 1
  }
  [[ ! -e "$fixture_dir/app-stopped" ]] || {
    echo 'successful cooperative-lock publication unexpectedly stopped the verified writer' >&2
    exit 1
  }
  lock_key=$(printf '%s\0%s' "$(jq -er '.engineId' "$state")" "$(jq -er '.volume' "$state")" |
    sha256sum | awk '{print $1}')
  lock_path="$(jq -er '.lockRoot' "$state")/noosphere-pgvector-switch-$lock_key.lock"
  exec 9<>"$lock_path"
  flock -n 9 || {
    echo 'cooperative journal actor could not acquire the lock after controller exit' >&2
    exit 1
  }
  flock -u 9
  exec 9>&-
)

test_engine_volume_identity_has_one_authoritative_state_path() (
  local fixture_dir shared_lock primary_dir volume_control_dir engine_control_dir duplicate_dir
  local primary_manifest volume_control_manifest engine_control_manifest duplicate_manifest
  local first_state volume_control_state engine_control_state second_state rc=0
  local first_sha first_inode first_mode first_live_sha manifest
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  shared_lock="$fixture_dir/authority-locks"
  primary_dir="$fixture_dir/primary"
  volume_control_dir="$fixture_dir/same-engine-different-volume"
  engine_control_dir="$fixture_dir/different-engine-same-volume"
  duplicate_dir="$fixture_dir/duplicate"
  mkdir -p "$shared_lock" "$primary_dir" "$volume_control_dir" "$engine_control_dir" "$duplicate_dir"
  chmod 0700 "$shared_lock" "$primary_dir" "$volume_control_dir" "$engine_control_dir" "$duplicate_dir"
  primary_manifest="$primary_dir/manifest.json"
  volume_control_manifest="$volume_control_dir/manifest.json"
  engine_control_manifest="$engine_control_dir/manifest.json"
  duplicate_manifest="$duplicate_dir/manifest.json"
  first_state="$primary_dir/controller.json"
  volume_control_state="$volume_control_dir/controller.json"
  engine_control_state="$engine_control_dir/controller.json"
  second_state="$duplicate_dir/controller.json"

  write_execution_fixture "$primary_dir" "$primary_manifest" complete success \
    fixture-engine fixture-volume
  write_execution_fixture "$volume_control_dir" "$volume_control_manifest" complete success \
    fixture-engine fixture-volume-b
  write_execution_fixture "$engine_control_dir" "$engine_control_manifest" complete success \
    fixture-engine-b fixture-volume
  write_execution_fixture "$duplicate_dir" "$duplicate_manifest" complete success \
    fixture-engine fixture-volume
  for manifest in "$primary_manifest" "$volume_control_manifest" \
    "$engine_control_manifest" "$duplicate_manifest"; do
    jq --arg lockRoot "$shared_lock" '.lockRoot = $lockRoot' "$manifest" > "$manifest.next"
    install -m 600 "$manifest.next" "$manifest"
  done
  export XDG_RUNTIME_DIR="$shared_lock"

  "$CONTROLLER" --prepare --manifest "$primary_manifest" --state "$first_state"
  first_sha=$(sha256sum "$first_state" | awk '{print $1}')
  first_inode=$(stat -c '%i' "$first_state")
  first_mode=$(stat -c '%a' "$first_state")
  first_live_sha=$(sha256sum "$primary_dir/docker-compose.yml" | awk '{print $1}')

  rc=0
  "$CONTROLLER" --prepare --manifest "$volume_control_manifest" --state "$volume_control_state" \
    >"$fixture_dir/volume-control.out" 2>"$fixture_dir/volume-control.err" || rc=$?
  ((rc == 0)) && jq -e '
    .phase == "prepared" and .engineId == "fixture-engine" and .volume == "fixture-volume-b"
  ' "$volume_control_state" >/dev/null || {
    echo 'unique-authority implementation rejected the same engine with a different volume' >&2
    exit 1
  }

  rc=0
  "$CONTROLLER" --prepare --manifest "$engine_control_manifest" --state "$engine_control_state" \
    >"$fixture_dir/engine-control.out" 2>"$fixture_dir/engine-control.err" || rc=$?
  ((rc == 0)) && jq -e '
    .phase == "prepared" and .engineId == "fixture-engine-b" and .volume == "fixture-volume"
  ' "$engine_control_state" >/dev/null || {
    echo 'unique-authority implementation rejected a different engine with the same volume name' >&2
    exit 1
  }

  rc=0
  "$CONTROLLER" --prepare --manifest "$duplicate_manifest" --state "$second_state" \
    >"$fixture_dir/second-prepare.out" 2>"$fixture_dir/second-prepare.err" || rc=$?
  if ((rc == 0)); then
    echo 'one Docker-engine/PostgreSQL-volume identity accepted two authoritative state paths' >&2
    exit 1
  fi
  rg -i 'authoritative.*state.*(engine|volume)|engine.*volume.*state.*(authoritative|claimed|owned)' \
    "$fixture_dir/second-prepare.err" >/dev/null || {
    echo 'alternate-state preparation failed without the unique-authority diagnostic' >&2
    exit 1
  }
  jq -e '
    .phase == "prepared" and
    .engineId == "fixture-engine" and
    .volume == "fixture-volume"
  ' "$first_state" >/dev/null
  [[ $(sha256sum "$first_state" | awk '{print $1}') == "$first_sha" &&
     $(stat -c '%i' "$first_state") == "$first_inode" &&
     $(stat -c '%a' "$first_state") == "$first_mode" ]] || {
    echo 'alternate-state rejection mutated the first authoritative state' >&2
    exit 1
  }
  [[ ! -e "$second_state" ]] || {
    echo 'rejected alternate state path still became a durable authority' >&2
    exit 1
  }
  [[ $(sha256sum "$primary_dir/docker-compose.yml" | awk '{print $1}') == "$first_live_sha" ]] || {
    echo 'alternate-state rejection changed the primary live Compose bytes' >&2
    exit 1
  }
)

test_production_rejects_ambient_test_hook_contamination() (
  local hook_spec hook value fixture_dir='' manifest state live shim rc auth_root
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir" "${auth_root:-}"' EXIT

  # Each iteration uses a fresh XDG_STATE_HOME so the durable authority
  # record left by the previous hook cannot be silently reclaimed under
  # the same engine+volume with a different state path. Without this, the
  # R3-1 explicit `*)` arm fires before this test reaches the
  # production-hook rejection path it means to exercise.
  for hook_spec in \
    NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT=1 \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN=TERM \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=guard-exited \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION=TERM \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE=TERM \
    NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD=TERM; do
    hook=${hook_spec%%=*}
    value=${hook_spec#*=}
    fixture_dir=$(mktemp -d)
    auth_root=$(mktemp -d)
    chmod 700 "$auth_root"
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    live="$fixture_dir/docker-compose.yml"
    write_execution_fixture "$fixture_dir" "$manifest"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    export XDG_STATE_HOME="$auth_root"
    shim=$(write_systemd_identity_shim "$fixture_dir" disabled)
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

    rc=0
    run_fixture_controller "$state" "$shim" env "$hook=$value" \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
    if ((rc == 0)); then
      failures+=("production execution silently accepted ambient $hook")
    else
      rg -qi 'NOOSPHERE_CONTROLLER_TEST_|test hook.*(ambient|contamin|production)' \
        "$fixture_dir/controller.err" ||
        failures+=("production rejection of $hook lacked a test-hook contamination diagnostic")
      [[ $(jq -r '.phase // empty' "$state") == prepared ]] ||
        failures+=("production rejection of $hook advanced durable state")
      [[ $(<"$live") == 'source model' ]] ||
        failures+=("production rejection of $hook changed live Compose")
    fi

    rm -rf "$fixture_dir"
    rm -rf "$auth_root"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_state_authority_survives_runtime_loss_and_is_revalidated_at_execute() (
  local fixture_dir='' manifest state copied_state live shim rc
  local shared lost_runtime primary volume_control engine_control duplicate manifest_path
  local primary_manifest volume_control_manifest engine_control_manifest duplicate_manifest
  local primary_state volume_control_state engine_control_state duplicate_state
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  # Execution must reject a byte-identical prepared state copied to a different
  # path. This proves the behavioral authority check without depending on the
  # authority record's filename or JSON representation.
  fixture_dir=$(mktemp -d)
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  copied_state="$fixture_dir/copied-controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  install -m 600 "$state" "$copied_state"

  rc=0
  run_fixture_controller "$copied_state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  if ((rc == 0)); then
    failures+=('execution accepted a copied prepared state at a second authority path')
  else
    rg -qi 'authoritative.*state|state.*authorit|engine.*volume.*state.*(claim|own)' \
      "$fixture_dir/controller.err" ||
      failures+=('copied-state rejection lacked an engine-volume authority diagnostic')
    [[ $(jq -r '.phase // empty' "$copied_state") == prepared ]] ||
      failures+=('copied-state authority rejection advanced the copied state')
    [[ $(jq -r '.phase // empty' "$state") == prepared ]] ||
      failures+=('copied-state authority rejection damaged the primary state')
    [[ $(<"$live") == 'source model' ]] ||
      failures+=('copied-state authority rejection changed live Compose')
  fi
  rm -rf "$fixture_dir"
  fixture_dir=''

  # The copied-state scenario above intentionally leaves a durable authority
  # record for its fake engine+volume, then deletes the state path it names.
  # The runtime-loss scenario below is independent but reuses that fake tuple;
  # isolate the suite-owned namespace before starting it so the controller's
  # fail-closed stale-record check cannot mask the behavior under test.
  _clear_authority_root_for_isolation

  # Replace the entire disposable runtime root to model reboot/runtime loss.
  # The duplicate tuple must remain rejected, while both tuple dimensions have
  # independent controls proving the implementation is not globally exclusive.
  fixture_dir=$(mktemp -d)
  shared="$fixture_dir/runtime"
  lost_runtime="$fixture_dir/runtime-lost"
  primary="$fixture_dir/primary"
  volume_control="$fixture_dir/same-engine-different-volume"
  engine_control="$fixture_dir/different-engine-same-volume"
  duplicate="$fixture_dir/duplicate"
  mkdir -m 700 "$shared" "$primary" "$volume_control" "$engine_control" "$duplicate"
  primary_manifest="$primary/manifest.json"
  volume_control_manifest="$volume_control/manifest.json"
  engine_control_manifest="$engine_control/manifest.json"
  duplicate_manifest="$duplicate/manifest.json"
  primary_state="$primary/controller.json"
  volume_control_state="$volume_control/controller.json"
  engine_control_state="$engine_control/controller.json"
  duplicate_state="$duplicate/controller.json"
  write_execution_fixture "$primary" "$primary_manifest" complete success fixture-engine fixture-volume
  write_execution_fixture "$volume_control" "$volume_control_manifest" complete success fixture-engine fixture-volume-b
  write_execution_fixture "$engine_control" "$engine_control_manifest" complete success fixture-engine-b fixture-volume
  write_execution_fixture "$duplicate" "$duplicate_manifest" complete success fixture-engine fixture-volume
  for manifest_path in "$primary_manifest" "$volume_control_manifest" \
    "$engine_control_manifest" "$duplicate_manifest"; do
    jq --arg lockRoot "$shared" '.lockRoot = $lockRoot' "$manifest_path" > "$manifest_path.next"
    install -m 600 "$manifest_path.next" "$manifest_path"
  done
  export XDG_RUNTIME_DIR="$shared"
  "$CONTROLLER" --prepare --manifest "$primary_manifest" --state "$primary_state"
  mv "$shared" "$lost_runtime"
  mkdir -m 700 "$shared"

  rc=0
  "$CONTROLLER" --prepare --manifest "$volume_control_manifest" --state "$volume_control_state" \
    >"$fixture_dir/volume-control.out" 2>"$fixture_dir/volume-control.err" || rc=$?
  ((rc == 0)) && jq -e '
    .phase == "prepared" and .engineId == "fixture-engine" and .volume == "fixture-volume-b"
  ' "$volume_control_state" >/dev/null ||
    failures+=('runtime-loss authority rejected the same engine with a different volume')

  rc=0
  "$CONTROLLER" --prepare --manifest "$engine_control_manifest" --state "$engine_control_state" \
    >"$fixture_dir/engine-control.out" 2>"$fixture_dir/engine-control.err" || rc=$?
  ((rc == 0)) && jq -e '
    .phase == "prepared" and .engineId == "fixture-engine-b" and .volume == "fixture-volume"
  ' "$engine_control_state" >/dev/null ||
    failures+=('runtime-loss authority rejected a different engine with the same volume')

  rc=0
  "$CONTROLLER" --prepare --manifest "$duplicate_manifest" --state "$duplicate_state" \
    >"$fixture_dir/duplicate.out" 2>"$fixture_dir/duplicate.err" || rc=$?
  if ((rc == 0)); then
    failures+=('runtime-directory loss erased the unique engine-volume state authority')
  else
    rg -qi 'authoritative.*state|state.*authorit|engine.*volume.*state.*(claim|own)' \
      "$fixture_dir/duplicate.err" ||
      failures+=('runtime-loss duplicate rejection lacked an engine-volume authority diagnostic')
    [[ ! -e "$duplicate_state" ]] ||
      failures+=('reboot-simulation rejection still created a second state history')
    jq -e '.phase == "prepared" and .engineId == "fixture-engine" and .volume == "fixture-volume"' \
      "$primary_state" >/dev/null ||
      failures+=('reboot-simulation rejection damaged the primary state history')
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_post_authorization_pre_activation_failures_commit_fresh_stop_evidence() (
  local case_name fixture_dir='' manifest state shim rc phase control_tail lifecycle expected_class
  local authorization_evidence
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for case_name in signal artifact-storage; do
    # Per-iteration authority isolation (stale-record poisoning guard).
    _clear_authority_root_for_isolation
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    if [[ "$case_name" == artifact-storage ]]; then
      shim=$(write_post_authorization_artifact_failure_shim "$fixture_dir")
    else
      shim=$(write_systemd_identity_shim "$fixture_dir")
    fi
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
    [[ "$case_name" != artifact-storage ]] ||
      : > "$fixture_dir/fail-next-artifact-storage-after-authorization"
    : > "$fixture_dir/kill-controller-if-incident-before-stop"

    rc=0
    if [[ "$case_name" == signal ]]; then
      run_fixture_controller "$state" "$shim" env \
        NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION=TERM \
        >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
      [[ "$rc" == 143 ]] ||
        failures+=("post-authorization signal returned $rc instead of 143")
    else
      run_fixture_controller "$state" "$shim" env \
        >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
      ((rc != 0)) ||
        failures+=('post-authorization artifact-storage failure unexpectedly reported success')
      [[ -e "$fixture_dir/post-authorization-artifact-failure-consumed" ]] ||
        failures+=('post-authorization artifact-storage fixture missed the semantic allocation boundary')
    fi

    lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
    [[ "$lifecycle" == transition,authorize ]] ||
      failures+=("post-authorization $case_name did not stop at the pre-activation boundary")
    authorization_evidence=$(jq -r '.authorizationEvidence.path // empty' "$state")
    [[ -n "$authorization_evidence" && -f "$authorization_evidence" &&
       $(jq -er '.exitCode' "$authorization_evidence") == 0 ]] ||
      failures+=("post-authorization $case_name lacked successful authorization evidence")
    if [[ -f "$fixture_dir/app-control.log" ]]; then
      control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
    else
      control_tail=''
    fi
    [[ "$control_tail" == stop,inspect:false ]] ||
      failures+=("post-authorization $case_name lacked a fresh inspect-verified stop")
    [[ ! -e "$fixture_dir/incident-persisted-before-stop" ]] ||
      failures+=("post-authorization $case_name published terminal incident before stopping the writer")
    phase=$(jq -r '.phase // empty' "$state")
    if [[ "$case_name" == signal ]]; then
      expected_class=closure-interruption
    else
      expected_class=closure-artifact-storage
    fi
    jq -e --arg incidentClass "$expected_class" '
      .phase == "incident" and
      .incidentClass == $incidentClass
    ' "$state" >/dev/null ||
      failures+=("post-authorization $case_name lacked exact $expected_class classification (phase=$phase)")

    rm -rf "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

# RED owner: the controller's select_process_artifact_base for the verify
# role must surface per-invocation collisions through the caller's
# if-! wrapper so the verifier-allocation path routes through
# begin_closure_incident artifact-storage. Today the function uses die()
# which exits the whole controller and bypasses the wrapper, leaving the
# phase at activation-running with no stop/incident so a later execution
# can reactivate. The fix is to convert die to return 1 so the caller can
# route the failure through begin_closure_incident artifact-storage.
test_verifier_artifact_selector_collision_routes_through_closure_artifact_storage() (
  local fixture_dir='' manifest state shim rc invocation control_tail lifecycle
  local phase incident_class
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  fixture_dir=$(mktemp -d)
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  invocation=${NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID:-0123456789abcdef0123456789abcdef}

  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  # The selector uses ${state%.json} as the artifact base, so pre-create
  # canonical and suffixed verifier artifacts at the *stripped* path.
  local state_base=${state%.json}
  printf 'existing\n' > "$state_base.verify.stdout.log"
  printf 'existing\n' > "$state_base.verify.stderr.log"
  printf '{"existing":true}\n' > "$state_base.verify.evidence.json"
  # Pre-create suffixed verifier artifacts for the test INVOCATION_ID so
  # the selector dies with 'process evidence path for this systemd
  # invocation already exists'.
  printf 'existing\n' > "$state_base.$invocation.verify.stdout.log"
  printf 'existing\n' > "$state_base.$invocation.verify.stderr.log"
  printf '{"existing":true}\n' > "$state_base.$invocation.verify.evidence.json"

  # The docker shim (controller script L577-581) only writes the
  # `incident-persisted-before-stop` sentinel when this hook file exists.
  # Without it, the assertion below is a permanent no-op — a regression
  # that publishes the terminal incident before stopping the writer
  # would still pass. Mirror the sibling pattern at L4075.
  : > "$fixture_dir/kill-controller-if-incident-before-stop"

  rc=0
  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc != 0)) ||
    failures+=('verifier selector collision unexpectedly reported success')

  phase=$(jq -er '.phase // empty' "$state" 2>/dev/null || true)
  incident_class=$(jq -er '.incidentClass // empty' "$state" 2>/dev/null || true)
  if [[ "$phase" != incident ]]; then
    failures+=("verifier selector collision left phase=$phase (expected incident)")
  fi
  if [[ "$incident_class" != closure-artifact-storage ]]; then
    failures+=("verifier selector collision produced incidentClass=$incident_class (expected closure-artifact-storage)")
  fi

  # The writer was authorized before the selector ran; the controller must
  # ALSO have stopped and inspect-verified it before publishing the
  # terminal incident. A die() that bypasses the wrapper would leave the
  # writer running and no stop evidence.
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] ||
    failures+=("verifier selector collision lacked a fresh inspect-verified stop (control_tail=$control_tail)")
  [[ ! -e "$fixture_dir/incident-persisted-before-stop" ]] ||
    failures+=('verifier selector collision published terminal incident before stopping the writer')

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

# RED owner: the controller's assert_controller_artifact_paths_separate must
# include source-recovery artifact paths (stdout.log, stderr.log, evidence.json)
# in its controlled-path array so that a derived source-recovery path that
# collides with any bound transition input is rejected during --prepare.
# Currently the controller omits source-recovery paths from the controlled
# array, so this test fails (RED) until the controller is fixed.
test_source_recovery_artifacts_cannot_collide_with_bound_inputs() (
  local artifact_role input_class fixture_dir='' manifest state rc derived_path
  local -a failures=()
  # NOTE: controller-executable, compose-plugin, and guard-journal are excluded
  # because the controller validates their identity/consistency BEFORE the
  # collision check runs, so a path collision can never be reached for them.
  local -a input_classes=(
    live-compose source-snapshot candidate-compose env-file
    guard-executable verifier-executable docker-executable manifest
    docker-config
  )
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for artifact_role in stdout stderr evidence; do
    for input_class in "${input_classes[@]}"; do
      fixture_dir=$(mktemp -d)
      manifest="$fixture_dir/manifest.json"
      state="$fixture_dir/controller.json"
      write_execution_fixture "$fixture_dir" "$manifest"

      # Derive the source-recovery artifact path the controller will use at
      # execution time: ${state%.json}.source-recovery.{stdout,stderr,evidence}
      case "$artifact_role" in
        stdout) derived_path="${state%.json}.source-recovery.stdout.log" ;;
        stderr) derived_path="${state%.json}.source-recovery.stderr.log" ;;
        evidence) derived_path="${state%.json}.source-recovery.evidence.json" ;;
      esac

      # Create the collision: point the bound input at the derived artifact path
      # so the controller's path-separation check must reject it.
      case "$input_class" in
        live-compose)
          original_path=$(jq -er '.liveCompose' "$manifest")
          cp "$original_path" "$derived_path"
          jq --arg p "$derived_path" --arg old "$original_path" \
            '.liveCompose = $p |
             .guardArgs = [.guardArgs[] | if . == $old then $p else . end]' \
            "$manifest" > "$manifest.tmp" &&
            mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        # Update the live compose file content check: the live compose file
        # is now at the derived path, so the original file is unchanged.
        source-snapshot)
          cp "$(jq -er '.sourceSnapshot' "$manifest")" "$derived_path"
          jq --arg p "$derived_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.sourceSnapshot = $p | .sourceSnapshotSha256 = $s' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        candidate-compose)
          cp "$(jq -er '.candidateCompose' "$manifest")" "$derived_path"
          jq --arg p "$derived_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.candidateCompose = $p | .candidateComposeSha256 = $s' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        env-file)
          original_path=$(jq -er '.envFile' "$manifest")
          cp "$original_path" "$derived_path"
          jq --arg p "$derived_path" --arg old "$original_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.envFile = $p | .envFileSha256 = $s |
             .guardArgs = [.guardArgs[] | if . == $old then $p else . end]' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        guard-executable)
          cp "$(jq -er '.guard' "$manifest")" "$derived_path"
          chmod 0700 "$derived_path"
          jq --arg p "$derived_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.guard = $p | .guardSha256 = $s' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        verifier-executable)
          cp "$(jq -er '.verifier' "$manifest")" "$derived_path"
          chmod 0700 "$derived_path"
          jq --arg p "$derived_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.verifier = $p | .verifierSha256 = $s' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        docker-executable)
          cp "$(jq -er '.dockerPath' "$manifest")" "$derived_path"
          chmod 0700 "$derived_path"
          jq --arg p "$derived_path" \
            --arg s "$(sha256sum "$derived_path" | awk '{print $1}')" \
            '.dockerPath = $p | .dockerSha256 = $s' \
            "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
          chmod 0600 "$manifest"
          ;;
        manifest)
          # The manifest itself is the bound input; place it at the derived
          # source-recovery artifact path.
          cp "$manifest" "$derived_path"
          manifest=$derived_path
          ;;
        docker-config)
          # Place the state path inside the Docker config directory so that
          # the derived source-recovery artifact path falls inside it too.
          # The controller's namespace check must reject this.
          local docker_home
          docker_home=$(jq -er '.controllerHome' "$manifest")
          mkdir -p "$docker_home/docker"
          state="$docker_home/docker/controller.json"
          # Re-derive with the new state path
          case "$artifact_role" in
            stdout) derived_path="${state%.json}.source-recovery.stdout.log" ;;
            stderr) derived_path="${state%.json}.source-recovery.stderr.log" ;;
            evidence) derived_path="${state%.json}.source-recovery.evidence.json" ;;
          esac
          ;;
      esac

      export XDG_RUNTIME_DIR="$fixture_dir/locks"
      rc=0
      "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" \
        >"$fixture_dir/prepare.out" 2>"$fixture_dir/prepare.err" || rc=$?
      if ((rc == 0)); then
        failures+=("source-recovery $artifact_role path was accepted as bound $input_class input")
      else
        rg -qi 'collid' "$fixture_dir/prepare.err" ||
          failures+=("source-recovery $artifact_role/$input_class collision lacked a specific diagnostic")
        [[ ! -e "$state" ]] ||
          failures+=("source-recovery $artifact_role/$input_class collision still created controller state")
      fi

      rm -rf "$fixture_dir"
      fixture_dir=''
    done
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_source_recovery_retry_preserves_prior_unbound_evidence() (
  local fixture_dir manifest state crash_shim retry_shim rc=0 prior_evidence prior_stdout prior_stderr
  local evidence_sha stdout_sha stderr_sha evidence_inode stdout_inode stderr_inode new_evidence
  local new_stdout new_stderr expected_stdout_sha expected_stderr_sha
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" prejournal-fail source-fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  crash_shim=$(write_source_recovery_evidence_publication_crash_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  : > "$fixture_dir/crash-after-source-evidence-publication"

  run_fixture_controller "$state" "$crash_shim" env \
    >"$fixture_dir/first.out" 2>"$fixture_dir/first.err" || rc=$?
  [[ "$rc" == 86 && -e "$fixture_dir/source-evidence-publication-crash-consumed" ]] || {
    echo "source-recovery crash-window fixture returned $rc instead of 86" >&2
    exit 1
  }
  jq -e '.phase == "source-recovery-running" and has("sourceRecoveryEvidence") == false' \
    "$state" >/dev/null || {
    echo 'source-recovery crash did not preserve the real pre-binding durable phase' >&2
    exit 1
  }
  prior_evidence=$(<"$fixture_dir/unbound-source-evidence-path")
  prior_stdout=$(jq -er '.stdout' "$prior_evidence")
  prior_stderr=$(jq -er '.stderr' "$prior_evidence")
  evidence_sha=$(sha256sum "$prior_evidence" | awk '{print $1}')
  stdout_sha=$(sha256sum "$prior_stdout" | awk '{print $1}')
  stderr_sha=$(sha256sum "$prior_stderr" | awk '{print $1}')
  evidence_inode=$(stat -c '%i' "$prior_evidence")
  stdout_inode=$(stat -c '%i' "$prior_stdout")
  stderr_inode=$(stat -c '%i' "$prior_stderr")
  expected_stdout_sha=$(sha256sum /dev/null | awk '{print $1}')
  expected_stderr_sha=$(printf 'source verification failed\n' | sha256sum | awk '{print $1}')
  # Boot provenance is the REAL host boot id: ambient NOOSPHERE_CONTROLLER_BOOT_ID
  # is untrusted noise (see test_ambient_test_overrides_cannot_falsify_production_evidence
  # and test_source_recovery_signal_persists_process_evidence), so the evidence
  # must carry the kernel boot id, never the ambient override.
  jq -e --arg boot "$(</proc/sys/kernel/random/boot_id)" \
    --arg stdoutSha "$expected_stdout_sha" --arg stderrSha "$expected_stderr_sha" '
    .phase == "source-recovery-running" and .exitCode == 42 and
    .invocationId == "0123456789abcdef0123456789abcdef" and
    .bootId == $boot and
    (.controllerMainPid | type == "number" and . > 0) and
    (.childPid | type == "number" and . > 0) and
    .controllerMainPid != .childPid and
    (.startCursor | type == "string" and length > 0) and
    (.endCursor | type == "string" and length > 0) and
    .stdoutSha256 == $stdoutSha and .stderrSha256 == $stderrSha
  ' "$prior_evidence" >/dev/null || {
    echo 'first source-recovery evidence lacked exact process/log/provenance binding' >&2
    exit 1
  }

  retry_shim=$(write_systemd_identity_shim "$fixture_dir")
  rc=0
  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$retry_shim" env \
      >"$fixture_dir/second.out" 2>"$fixture_dir/second.err" || rc=$?
  [[ "$rc" == 42 ]] || {
    echo "source-recovery retry returned $rc instead of 42" >&2
    exit 1
  }

  new_evidence=$(jq -er '.sourceRecoveryEvidence.path' "$state")
  [[ "$new_evidence" != "$prior_evidence" && -f "$new_evidence" ]] || {
    echo 'source-recovery retry reused the prior unbound evidence path' >&2
    exit 1
  }
  [[ $(sha256sum "$prior_evidence" | awk '{print $1}') == "$evidence_sha" &&
     $(sha256sum "$prior_stdout" | awk '{print $1}') == "$stdout_sha" &&
     $(sha256sum "$prior_stderr" | awk '{print $1}') == "$stderr_sha" &&
     $(stat -c '%i' "$prior_evidence") == "$evidence_inode" &&
     $(stat -c '%i' "$prior_stdout") == "$stdout_inode" &&
     $(stat -c '%i' "$prior_stderr") == "$stderr_inode" ]] || {
    echo 'source-recovery retry overwrote prior truthful evidence or logs' >&2
    exit 1
  }
  new_stdout=$(jq -er '.stdout' "$new_evidence")
  new_stderr=$(jq -er '.stderr' "$new_evidence")
  [[ "$new_stdout" != "$prior_stdout" && "$new_stderr" != "$prior_stderr" &&
     -f "$new_stdout" && -f "$new_stderr" ]] || {
    echo 'source-recovery retry did not allocate distinct durable logs' >&2
    exit 1
  }
  jq -e --arg evidenceSha "$(sha256sum "$new_evidence" | awk '{print $1}')" \
    --arg stdoutSha "$expected_stdout_sha" --arg stderrSha "$expected_stderr_sha" '
    .phase == "incident" and .incidentClass == "pre-journal-source-verification" and
    .sourceRecoveryEvidence.sha256 == $evidenceSha
  ' "$state" >/dev/null &&
  jq -e --arg boot "$(</proc/sys/kernel/random/boot_id)" \
    --arg stdoutSha "$expected_stdout_sha" --arg stderrSha "$expected_stderr_sha" '
    .phase == "source-recovery-running" and .exitCode == 42 and
    .invocationId == "fedcba9876543210fedcba9876543210" and
    .bootId == $boot and
    (.controllerMainPid | type == "number" and . > 0) and
    (.childPid | type == "number" and . > 0) and
    .controllerMainPid != .childPid and
    (.startCursor | type == "string" and length > 0) and
    (.endCursor | type == "string" and length > 0) and
    .stdoutSha256 == $stdoutSha and .stderrSha256 == $stderrSha
  ' "$new_evidence" >/dev/null || {
    echo 'source-recovery retry did not bind complete new evidence/log/provenance state' >&2
    exit 1
  }
)

test_phase_owned_invariants_reject_unproved_states() (
  local fixture_dir='' manifest state mutated case_name guard_mode verifier_mode target_phase
  local target_incident_class proof_key diagnostic_pattern shim rc
  local -a run_env=()
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir"' EXIT

  for case_name in \
    authorization-without-guard \
    activation-without-guard \
    closure-without-guard \
    stop-pending-without-authorization \
    evidence-pending-without-stop-proof \
    source-incident-without-source-evidence \
    closure-incident-without-stop-proof; do
    _clear_authority_root_for_isolation
    guard_mode=complete
    verifier_mode=success
    target_incident_class=''
    run_env=()
    case "$case_name" in
      authorization-without-guard)
        target_phase=authorization-running
        proof_key=guardEvidence
        diagnostic_pattern='guard.*evidence.*required|required.*guard.*evidence'
        ;;
      activation-without-guard)
        target_phase=activation-running
        proof_key=guardEvidence
        diagnostic_pattern='guard.*evidence.*required|required.*guard.*evidence'
        ;;
      closure-without-guard)
        target_phase=closure-running
        proof_key=guardEvidence
        diagnostic_pattern='guard.*evidence.*required|required.*guard.*evidence'
        ;;
      stop-pending-without-authorization)
        verifier_mode=fail
        target_phase=closure-stop-pending
        proof_key=authorizationEvidence
        diagnostic_pattern='authorization.*evidence.*required|required.*authorization.*evidence'
        ;;
      evidence-pending-without-stop-proof)
        verifier_mode=fail
        target_phase=closure-evidence-pending
        proof_key=writerStopEvidence
        diagnostic_pattern='writer.*stop.*evidence.*required|required.*writer.*stop.*evidence'
        run_env=(NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running)
        ;;
      source-incident-without-source-evidence)
        guard_mode=prejournal-fail
        verifier_mode=source-fail
        target_phase=incident
        target_incident_class=pre-journal-source-verification
        proof_key=sourceRecoveryEvidence
        diagnostic_pattern='source.*recovery.*evidence.*required|required.*source.*recovery.*evidence'
        ;;
      closure-incident-without-stop-proof)
        verifier_mode=fail
        target_phase=incident
        target_incident_class=closure-verification
        proof_key=writerStopEvidence
        diagnostic_pattern='writer.*stop.*evidence.*required|required.*writer.*stop.*evidence'
        ;;
    esac

    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    mutated="$fixture_dir/mutated-controller.json"
    write_execution_fixture "$fixture_dir" "$manifest" "$guard_mode" "$verifier_mode"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_phase_snapshot_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

    rc=0
    run_fixture_controller "$state" "$shim" env \
      "${run_env[@]}" \
      "NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE=$target_phase" \
      "NOOSPHERE_CONTROLLER_TEST_CAPTURE_INCIDENT_CLASS=$target_incident_class" \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
    if [[ "$rc" != 86 || ! -e "$fixture_dir/controller-phase-snapshot-captured" ]]; then
      failures+=("controller did not produce the $case_name baseline at $target_phase")
      rm -rf "$fixture_dir"
      fixture_dir=''
      continue
    fi
    if ! /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
      _ "$CONTROLLER" "$state" >"$fixture_dir/baseline.out" 2>"$fixture_dir/baseline.err"; then
      failures+=("controller rejected its own valid $case_name baseline")
      rm -rf "$fixture_dir"
      fixture_dir=''
      continue
    fi
    if ! jq -e --arg key "$proof_key" 'has($key)' "$state" >/dev/null; then
      failures+=("controller-produced $case_name baseline lacked owned proof $proof_key")
      rm -rf "$fixture_dir"
      fixture_dir=''
      continue
    fi

    jq --arg key "$proof_key" 'del(.[$key])' "$state" > "$mutated"
    chmod 0600 "$mutated"
    if /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
      _ "$CONTROLLER" "$mutated" >"$fixture_dir/mutated.out" 2>"$fixture_dir/mutated.err"; then
      failures+=("controller accepted unproved phase ownership: $case_name")
    elif ! rg -qi "$diagnostic_pattern" "$fixture_dir/mutated.err"; then
      failures+=("controller rejected $case_name without a $proof_key-specific diagnostic")
    fi

    rm -rf "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_disposable_rehearsals_clean_and_assert_state_authority() (
  local fixture_dir manifest state runtime_root lock_key authority rc=0
  local -a failures=()

  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  runtime_root="$fixture_dir/locks"
  mkdir -m 700 "$runtime_root"

  # Real prepared tuple: the controller's own claim_authoritative_state_path
  # creates the authority record.  No fabricated lock_key or special probe.
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$runtime_root"
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  lock_key=$(printf '%s\0%s' fixture-engine fixture-volume | sha256sum | awk '{print $1}')
  authority="$runtime_root/noosphere-pgvector-state-$lock_key.json"
  [[ -f "$authority" && ! -L "$authority" ]] ||
    failures+=("real prepare did not create the authority record")

  if ((${#failures[@]} == 0)); then
    # Success cleanup removes the exact authority record.
    cleanup_state_authority_record "$runtime_root" "$authority"
    [[ ! -e "$authority" ]] ||
      failures+=("real success cleanup left the authority record")
  fi

  if ((${#failures[@]} == 0)); then
    # Failure cleanup propagates when the authority record is unsafe (symlink).
    ln -s /dev/null "$authority"
    rc=0
    cleanup_state_authority_record "$runtime_root" "$authority" 2>/dev/null || rc=$?
    ((rc != 0)) ||
      failures+=("unsafe authority record was silently accepted by cleanup")
    rm -f "$authority"
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_transient_systemd_fixture_independently_proves_identity_and_cursors() (
  timeout 180s "$SYSTEMD_FIXTURE"
)

test_writer_stop_evidence_is_retry_distinct() (
  # Re-review round 2, finding 1: the writer-stop proof must reuse the
  # retry-distinct allocation scheme so a crash between evidence publication
  # and phase advance can never overwrite the prior truthful stop record.
  # Probes run in child bash so the controller's real die() exits only the
  # probe, keeping the test's own assertions in control.
  local fixture_dir base first second rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  base="$fixture_dir/controller"
  {
    extract_function path_present
    extract_function select_process_artifact_base
    extract_function die
  } > "$fixture_dir/functions.sh"
  cat > "$fixture_dir/probe.sh" <<'PROBE'
source "$1"
select_process_artifact_base "$2" writer-stop
PROBE

  # First stop owns the canonical path when no prior artifacts exist.
  first=$(bash "$fixture_dir/probe.sh" "$fixture_dir/functions.sh" "$base")
  [[ "$first" == "$base" ]] || {
    echo "first writer-stop allocation was not canonical: $first" >&2
    exit 1
  }

  # After the canonical evidence exists, a later invocation with a distinct
  # InvocationID must allocate a distinct base instead of reusing canonical.
  printf '{"version":1,"stopExitCode":0}\n' > "$base.writer-stop.evidence.json"
  second=$(INVOCATION_ID=0123456789abcdef0123456789abcdef \
    bash "$fixture_dir/probe.sh" "$fixture_dir/functions.sh" "$base")
  [[ "$second" == "$base.0123456789abcdef0123456789abcdef" ]] || {
    echo "retry writer-stop allocation was not InvocationID-distinct: $second" >&2
    exit 1
  }
  [[ "$(cat "$base.writer-stop.evidence.json")" == '{"version":1,"stopExitCode":0}' ]] || {
    echo "prior canonical writer-stop evidence did not survive the retry allocation" >&2
    exit 1
  }

  # An unsafe InvocationID must be rejected, never used inside a path.
  INVOCATION_ID=../escape \
    bash "$fixture_dir/probe.sh" "$fixture_dir/functions.sh" "$base" \
    >/dev/null 2>"$fixture_dir/unsafe.err" || rc=$?
  ((rc != 0)) || { echo "unsafe InvocationID was accepted" >&2; exit 1; }
  rg -q 'unsafe for evidence paths' "$fixture_dir/unsafe.err" || {
    echo "unsafe InvocationID lacked its diagnostic" >&2
    exit 1
  }
)

test_invocation_suffixed_artifacts_cannot_collide_with_bound_inputs() (
  # Re-review round 2, findings 1-2: the collision matrix must also cover the
  # InvocationID-suffixed artifact paths a retrying invocation will use.
  local fixture_dir manifest state rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"

  # Point the bound live Compose input at the invocation-suffixed writer-stop
  # evidence path so the separation check must reject it at execute time.
  local original_path suffixed
  original_path=$(jq -er '.liveCompose' "$manifest")
  suffixed="${state%.json}.0123456789abcdef0123456789abcdef.writer-stop.evidence.json"
  cp "$original_path" "$suffixed"
  jq --arg p "$suffixed" --arg old "$original_path" \
    '.liveCompose = $p |
     .guardArgs = [.guardArgs[] | if . == $old then $p else . end]' \
    "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
  chmod 0600 "$manifest"

  {
    extract_function die
    extract_function assert_controller_artifact_paths_separate
  } > "$fixture_dir/functions.sh"
  cat > "$fixture_dir/probe.sh" <<'PROBE'
source "$1"
assert_controller_artifact_paths_separate "$2" "$3" "$2"
PROBE
  INVOCATION_ID=0123456789abcdef0123456789abcdef \
    bash "$fixture_dir/probe.sh" "$fixture_dir/functions.sh" "$manifest" "$state" \
    >"$fixture_dir/check.out" 2>"$fixture_dir/check.err" || rc=$?
  ((rc != 0)) || {
    echo "invocation-suffixed writer-stop path was accepted as bound live-compose input" >&2
    exit 1
  }
  rg -qi 'collid' "$fixture_dir/check.err" || {
    echo "invocation-suffixed collision lacked a specific diagnostic" >&2
    exit 1
  }

  # Control: the same state passes when the bound input is moved off every
  # controlled path, proving the rejection came from the suffix entry.
  jq --arg p "$original_path" --arg old "$suffixed" \
    '.liveCompose = $p |
     .guardArgs = [.guardArgs[] | if . == $old then $p else . end]' \
    "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
  chmod 0600 "$manifest"
  INVOCATION_ID=0123456789abcdef0123456789abcdef \
    bash "$fixture_dir/probe.sh" "$fixture_dir/functions.sh" "$manifest" "$state" \
    >"$fixture_dir/control.out" 2>"$fixture_dir/control.err" || {
    echo "control run with no collision was rejected: $(cat "$fixture_dir/control.err")" >&2
    exit 1
  }
)

test_xdg_state_home_cross_root_execute_rejected() (
  local fixture_dir='' manifest state shim rc auth_a auth_b
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir" "$auth_a" "$auth_b"' EXIT

  auth_a=$(mktemp -d)
  auth_b=$(mktemp -d)
  chmod 700 "$auth_a" "$auth_b"
  fixture_dir=$(mktemp -d)
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")

  # Prepare under XDG_STATE_HOME=A: durable authority record must live under A.
  XDG_STATE_HOME="$auth_a" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  if [[ ! -d "$auth_a/noosphere-pgvector-controller/authority" ]]; then
    failures+=('prepare under XDG_STATE_HOME=A did not create a durable authority root')
  fi

  # Execute under XDG_STATE_HOME=B: cross-root reclaim must die with an
  # authority-root diagnostic and must not create a record under B.
  rc=0
  XDG_STATE_HOME="$auth_b" run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  if ((rc == 0)); then
    failures+=('execute under a different XDG_STATE_HOME succeeded; expected authority-root rejection')
  else
    rg -qi 'authoritative.*state|state.*authorit|durable.*authority.*root|engine.*volume.*state.*(claim|own)|authority root' \
      "$fixture_dir/controller.err" ||
      failures+=('cross-root execute rejection lacked an authority-root diagnostic')
  fi

  # Controller must die before writing the record under the new root.
  if [[ -d "$auth_b/noosphere-pgvector-controller/authority" ]]; then
    failures+=('cross-root execute created a durable authority record under the wrong root')
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)
test_corrupt_phase_durable_state_rejected() (
  local fixture_dir="" manifest state_a state_b rc auth runtime_dir lock_key claim authority
  # Test-unique engine+volume keeps this test from claiming the same
  # durable authority namespace as earlier tests in the suite-level
  # XDG_STATE_HOME root. Without isolation, the controller would read a
  # record pointing at a path the earlier test has already rm-rf'd; the
  # resulting empty `.phase` would fire the R3-1 `*)` arm with the wrong
  # diagnostic for the wrong reason and mask the real failure this test
  # means to exercise.
  local engine_id=corrupt-phase-engine volume=corrupt-phase-volume
  local -a failures=()
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf "$fixture_dir" "$auth"' EXIT

  auth=$(mktemp -d)
  chmod 700 "$auth"
  fixture_dir=$(mktemp -d)
  manifest="$fixture_dir/manifest.json"
  state_a="$fixture_dir/controller.json"
  state_b="$fixture_dir/controller-alt.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete success "$engine_id" "$volume"
  # lockRoot in the manifest is $fixture_dir/locks; assert_live_engine_binding
  # compares it against XDG_RUNTIME_DIR. Using a separate directory here would
  # die with "recorded lock root does not match the guard engine-volume lock
  # contract" before reaching the case arm we mean to exercise.
  runtime_dir="$fixture_dir/locks"
  install -d -m 700 "$runtime_dir"
  export XDG_RUNTIME_DIR="$runtime_dir"
  lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
  claim="$runtime_dir/noosphere-pgvector-state-$lock_key.json"
  authority="$auth/noosphere-pgvector-controller/authority/state-$lock_key.json"

  # Prepare once at state_a to seed the durable authority record AND the
  # runtime claim.
  XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state_a"

  # Reboot-shaped recovery: the runtime claim is wiped, the durable record
  # remains. Without this step, the next prepare would die at the runtime
  # claim check (controller L587) with "authoritative state ... already
  # claimed by another path" — masking the L654 enum case the test means
  # to exercise. Recreate the runtime dir before the second prepare so
  # acquire_operation_lock sees a real directory.
  rm -rf "$runtime_dir"
  install -d -m 700 "$runtime_dir"

  # Corrupt the state file phase to a value outside the enum.
  jq ".phase = \"garbage\"" "$state_a" > "$state_a.next"
  install -m 600 "$state_a.next" "$state_a"

  # Run --prepare at a DIFFERENT state path so claim_authoritative_state_path
  # reads the durable record, sees recorded_path=state_a != current=state_b,
  # and reaches the case statement at the active-phase enum. With the
  # R3-1 fix the `*)` default arm fires; without it, the case silently
  # falls through to a reclaim that overwrites the durable record.
  rc=0
  XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state_b" \
    >"$fixture_dir/alt.out" 2>"$fixture_dir/alt.err" || rc=$?
  if ((rc == 0)); then
    failures+=("controller reclaimed a durable state with .phase=garbage; expected unrecognized-phase rejection")
  else
    grep -qiE "unrecognized phase" "$fixture_dir/alt.err" ||
      failures+=("corrupt-phase rejection lacked the "unrecognized phase" diagnostic; stderr=$(tr "\n" " " < "$fixture_dir/alt.err")")
  fi

  # A rejected alternate prepare must not publish a reboot-volatile claim for
  # the rejected path or disturb the durable record for the authoritative
  # state. Otherwise repairing and resuming state_a is poisoned until an
  # operator manually deletes the stale runtime claim.
  [[ ! -e "$claim" ]] ||
    failures+=("corrupt-phase rejection left a runtime claim for the rejected alternate state")
  [[ $(jq -er '.statePath' "$authority") == "$(realpath -m "$state_a")" ]] ||
    failures+=("corrupt-phase rejection changed the durable authoritative state path")

  jq '.phase = "prepared"' "$state_a" > "$state_a.next"
  install -m 600 "$state_a.next" "$state_a"
  rc=0
  XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state_a" \
    >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || rc=$?
  ((rc == 0)) ||
    failures+=("authoritative state could not resume after alternate rejection; stderr=$(tr "\n" " " < "$fixture_dir/retry.err")")

  ((${#failures[@]} == 0)) || {
    printf "%s\n" "${failures[@]}" >&2
    exit 1
  }
)

test_bound_transition_inputs_are_pairwise_distinct() (
  local fixture_dir manifest state live rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  live="$fixture_dir/docker-compose.yml"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"

  jq '.sourceSnapshot = .liveCompose' "$manifest" > "$manifest.next"
  install -m 600 "$manifest.next" "$manifest"
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" \
    >"$fixture_dir/prepare.out" 2>"$fixture_dir/prepare.err" || rc=$?

  ((rc != 0)) || {
    echo 'controller accepted sourceSnapshot aliasing liveCompose' >&2
    exit 1
  }
  rg -qi 'bound transition inputs collide' "$fixture_dir/prepare.err" || {
    echo "bound-input alias rejection lacked the pairwise-collision diagnostic: $(tr '\n' ' ' < "$fixture_dir/prepare.err")" >&2
    exit 1
  }
  [[ ! -e "$state" && $(<"$live") == 'source model' ]]
)

test_invalid_complete_state_cannot_relinquish_durable_authority() (
  local fixture_dir manifest state_a state_b auth runtime_dir engine_id volume lock_key claim authority rc=0
  fixture_dir=$(mktemp -d)
  auth=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir" "$auth"' EXIT
  chmod 700 "$auth"
  manifest="$fixture_dir/manifest.json"
  state_a="$fixture_dir/controller.json"
  state_b="$fixture_dir/controller-next.json"
  engine_id=invalid-complete-engine
  volume=invalid-complete-volume
  write_execution_fixture "$fixture_dir" "$manifest" complete success "$engine_id" "$volume"
  runtime_dir="$fixture_dir/locks"
  export XDG_RUNTIME_DIR="$runtime_dir"
  lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
  claim="$runtime_dir/noosphere-pgvector-state-$lock_key.json"
  authority="$auth/noosphere-pgvector-controller/authority/state-$lock_key.json"

  XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state_a"
  rm -f -- "$claim"
  jq '.phase = "complete"' "$state_a" > "$state_a.next"
  install -m 600 "$state_a.next" "$state_a"

  XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest" --state "$state_b" \
    >"$fixture_dir/reclaim.out" 2>"$fixture_dir/reclaim.err" || rc=$?
  ((rc != 0)) || {
    echo 'controller reclaimed authority from an evidentially invalid complete state' >&2
    exit 1
  }
  rg -qi 'controller state is malformed|complete.*evidence' "$fixture_dir/reclaim.err" || {
    echo "invalid-complete rejection lacked an evidence-validation diagnostic: $(tr '\n' ' ' < "$fixture_dir/reclaim.err")" >&2
    exit 1
  }
  [[ ! -e "$claim" && ! -e "$state_b" ]]
  [[ $(jq -er '.statePath' "$authority") == "$(realpath -m "$state_a")" ]]
)

test_durable_authority_reclaims_complete_or_missing_state() (
  local case_name case_root auth runtime_dir fixture_a fixture_b fixture_dir manifest manifest_a manifest_b
  local state_a state_b engine_id volume shim rc
  local -a failures=() cleanup_roots=()
  trap 'for cleanup_root in "${cleanup_roots[@]}"; do rm -rf -- "$cleanup_root"; done' EXIT

  for case_name in complete missing; do
    auth=$(mktemp -d)
    case_root=$(mktemp -d)
    cleanup_roots+=("$auth" "$case_root")
    chmod 700 "$auth"
    runtime_dir="$case_root/runtime"
    fixture_a="$case_root/a"
    fixture_b="$case_root/b"
    install -d -m 700 "$runtime_dir" "$fixture_a" "$fixture_b"
    manifest_a="$fixture_a/manifest.json"
    manifest_b="$fixture_b/manifest.json"
    state_a="$fixture_a/controller.json"
    state_b="$fixture_b/controller.json"
    engine_id="reclaim-$case_name-engine"
    volume="reclaim-$case_name-volume"
    write_execution_fixture "$fixture_a" "$manifest_a" complete success "$engine_id" "$volume"
    write_execution_fixture "$fixture_b" "$manifest_b" complete success "$engine_id" "$volume"
    for manifest in "$manifest_a" "$manifest_b"; do
      jq --arg lockRoot "$runtime_dir" '.lockRoot = $lockRoot' "$manifest" > "$manifest.next"
      install -m 600 "$manifest.next" "$manifest"
    done
    export XDG_RUNTIME_DIR="$runtime_dir"

    XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest_a" --state "$state_a"
    if [[ "$case_name" == complete ]]; then
      fixture_dir=$fixture_a
      shim=$(write_systemd_identity_shim "$fixture_a")
      XDG_STATE_HOME="$auth" run_fixture_controller "$state_a" "$shim" env
      [[ $(jq -er '.phase' "$state_a") == complete ]]
    else
      rm -f -- "$state_a"
    fi

    rc=0
    XDG_STATE_HOME="$auth" "$CONTROLLER" --prepare --manifest "$manifest_b" --state "$state_b" \
      >"$fixture_b/reclaim.out" 2>"$fixture_b/reclaim.err" || rc=$?
    ((rc == 0)) ||
      failures+=("$case_name durable state with retained runtime claim was not reclaimable; stderr=$(tr "\n" " " < "$fixture_b/reclaim.err")")
    if ((rc == 0)); then
      [[ $(jq -er '.phase' "$state_b") == prepared ]] ||
        failures+=("$case_name reclaim did not publish a prepared replacement state")
    fi
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_cli_rejects_duplicate_or_mixed_modes() (
  local fixture_dir case_name rc
  local -a args failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT

  for case_name in prepare-execute execute-prepare prepare-prepare execute-execute; do
    case "$case_name" in
      prepare-execute) args=(--prepare --execute --state "$fixture_dir/state.json") ;;
      execute-prepare) args=(--execute --prepare --manifest "$fixture_dir/manifest.json" --state "$fixture_dir/state.json") ;;
      prepare-prepare) args=(--prepare --prepare --manifest "$fixture_dir/manifest.json" --state "$fixture_dir/state.json") ;;
      execute-execute) args=(--execute --execute --state "$fixture_dir/state.json") ;;
    esac
    rc=0
    "$CONTROLLER" "${args[@]}" >"$fixture_dir/$case_name.out" 2>"$fixture_dir/$case_name.err" || rc=$?
    ((rc != 0)) || failures+=("$case_name unexpectedly succeeded")
    rg -qi 'exactly one of --prepare or --execute is required' "$fixture_dir/$case_name.err" ||
      failures+=("$case_name did not reject duplicate/mixed mode flags at parse time; stderr=$(tr '\n' ' ' < "$fixture_dir/$case_name.err")")
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_execution_environment_removes_all_ambient_docker_compose_behavior() (
  local name remaining=''
  eval "$(extract_function sanitize_execution_environment)"

  export DOCKER_DEFAULT_PLATFORM=linux/arm64
  export DOCKER_API_VERSION=1.41
  export COMPOSE_REMOVE_ORPHANS=1
  export COMPOSE_IGNORE_ORPHANS=1

  sanitize_execution_environment \
    unix:///var/run/docker.sock /opt/noosphere-tools /tmp/controller-home

  while IFS= read -r name; do
    case "$name" in
      DOCKER_CONFIG|DOCKER_HOST|COMPOSE_DISABLE_ENV_FILE) ;;
      DOCKER_*|COMPOSE_*) remaining+="${remaining:+$'\n'}$name" ;;
    esac
  done < <(compgen -e)
  [[ -z "$remaining" ]] || {
    printf 'ambient Docker/Compose behavior variables survived sanitization:\n%s\n' \
      "$remaining" >&2
    exit 1
  }
)

test_durable_authority_rejects_runtime_backed_state_home() (
  local fixture_dir manifest state runtime_state_home rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete success \
    runtime-authority-engine runtime-authority-volume
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  runtime_state_home="$XDG_RUNTIME_DIR/xdg-state-home"
  install -d -m 700 "$runtime_state_home"

  XDG_STATE_HOME="$runtime_state_home" \
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state" \
      >"$fixture_dir/prepare.out" 2>"$fixture_dir/prepare.err" || rc=$?

  ((rc != 0)) || {
    echo 'controller accepted a reboot-volatile durable authority root under XDG_RUNTIME_DIR' >&2
    exit 1
  }
  rg -qi 'durable.*authority|runtime.*state|reboot.*volatile' "$fixture_dir/prepare.err" || {
    echo "runtime-backed authority rejection lacked a durability diagnostic: $(tr '\n' ' ' < "$fixture_dir/prepare.err")" >&2
    exit 1
  }
  [[ ! -e "$state" ]]
)

test_bound_inputs_and_publication_reject_unsafe_write_modes() (
  local fixture_dir safe_dir unsafe_dir source target
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  safe_dir="$fixture_dir/safe"
  unsafe_dir="$fixture_dir/unsafe"
  install -d -m 700 "$safe_dir"
  install -d -m 777 "$unsafe_dir"
  target="$safe_dir/live-compose.yml"

  eval "$(extract_function path_present)"
  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function publish_compose_atomic)"
  eval "$(extract_function die)"
  fsync_path() { :; }

  source="$safe_dir/world-writable-source.yml"
  printf 'candidate-file-mode\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0666 "$source"
  chmod 0600 "$target"
  if (publish_compose_atomic "$source" "$target"); then
    failures+=('publication accepted a group/world-writable bound input')
  fi

  source="$unsafe_dir/candidate.yml"
  printf 'candidate-parent-mode\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$target"
  if (publish_compose_atomic "$source" "$target"); then
    failures+=('publication accepted a bound input below a group/world-writable caller-owned parent')
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
  [[ $(<"$target") == source-model ]]
)

test_incident_classes_and_stop_proofs_are_closed_world() (
  local fixture_dir='' manifest state mutated shim rc=0 proof_phase verifier_mode
  local -a run_env=()
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap '[[ -z ${fixture_dir:-} ]] || rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  mutated="$fixture_dir/unclassified-incident.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
  run_fixture_controller "$state" "$shim" env \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  ((rc != 0))
  jq -e '.phase == "incident" and .incidentClass == "closure-verification" and has("writerStopEvidence")' \
    "$state" >/dev/null

  jq '.incidentClass = "unclassified-post-authorization" | del(.writerStopEvidence)' \
    "$state" > "$mutated"
  chmod 0600 "$mutated"
  if /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
    _ "$CONTROLLER" "$mutated" \
      >"$fixture_dir/validate.out" 2>"$fixture_dir/validate.err"; then
    echo 'controller accepted an unknown post-authorization incident class without writer-stop proof' >&2
    exit 1
  fi
  rg -qi 'incident.*class|writer.*stop.*evidence' "$fixture_dir/validate.err" || {
    echo "unclassified incident rejection lacked a class/stop-proof diagnostic: $(tr '\n' ' ' < "$fixture_dir/validate.err")" >&2
    exit 1
  }

  rm -rf -- "$fixture_dir"
  fixture_dir=''
  for proof_phase in closure-stop-pending closure-evidence-pending; do
    _clear_authority_root_for_isolation
    fixture_dir=$(mktemp -d)
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    mutated="$fixture_dir/unclassified-$proof_phase.json"
    verifier_mode=fail
    run_env=()
    if [[ "$proof_phase" == closure-evidence-pending ]]; then
      run_env=(NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running)
    fi
    write_execution_fixture "$fixture_dir" "$manifest" complete "$verifier_mode"
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_phase_snapshot_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

    rc=0
    run_fixture_controller "$state" "$shim" env \
      "${run_env[@]}" \
      "NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE=$proof_phase" \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
    if [[ "$rc" != 86 || ! -e "$fixture_dir/controller-phase-snapshot-captured" ]]; then
      failures+=("controller did not produce the $proof_phase baseline")
      rm -rf -- "$fixture_dir"
      fixture_dir=''
      continue
    fi
    if ! /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
      _ "$CONTROLLER" "$state" >"$fixture_dir/baseline.out" 2>"$fixture_dir/baseline.err"; then
      failures+=("controller rejected its own valid $proof_phase baseline")
      rm -rf -- "$fixture_dir"
      fixture_dir=''
      continue
    fi

    jq '.incidentClass = "unclassified-post-authorization"' "$state" > "$mutated"
    chmod 0600 "$mutated"
    if /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
      _ "$CONTROLLER" "$mutated" >"$fixture_dir/validate.out" 2>"$fixture_dir/validate.err"; then
      failures+=("controller accepted an unsupported incident class in phase $proof_phase")
    elif ! rg -q 'incident class is unsupported or unrecognized: unclassified-post-authorization' \
      "$fixture_dir/validate.err"; then
      failures+=("unsupported incident class in phase $proof_phase lacked the class diagnostic")
    fi

    rm -rf -- "$fixture_dir"
    fixture_dir=''
  done

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_real_docker_rehearsal_declares_interruption_resume_coverage() (
  local execute_sites interruption_sites recovery_assertions
  execute_sites=$(rg -F -c -- '--execute --state "$state"' "$DOCKER_FIXTURE" || printf '0\n')
  interruption_sites=$(rg -c -i \
    'systemctl --user kill|kill[[:space:]].*(TERM|KILL)|interrupt.*(controller|unit)' \
    "$DOCKER_FIXTURE" || printf '0\n')
  recovery_assertions=$(rg -c -i \
    'candidate-published|source-recovery-running|pre-journal-source-restored|recovery rehearsal passed' \
    "$DOCKER_FIXTURE" || printf '0\n')

  [[ "$execute_sites" =~ ^[0-9]+$ && "$execute_sites" -ge 2 &&
     "$interruption_sites" =~ ^[0-9]+$ && "$interruption_sites" -ge 1 &&
     "$recovery_assertions" =~ ^[0-9]+$ && "$recovery_assertions" -ge 2 ]] || {
    printf 'real-Docker rehearsal lacks an interruption/resume owner (execute=%s interrupt=%s recovery-assertions=%s)\n' \
      "$execute_sites" "$interruption_sites" "$recovery_assertions" >&2
    exit 1
  }
)

test_activation_uses_only_bound_compose_interpolation_values() (
  local fixture_dir fake_docker state env_file candidate live selected execution_home
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  fake_docker="$fixture_dir/docker"
  state="$fixture_dir/controller.json"
  env_file="$fixture_dir/runtime.env"
  candidate="$fixture_dir/candidate-compose.yml"
  live="$fixture_dir/docker-compose.yml"
  execution_home="$fixture_dir/execution-home"

  cat > "$fake_docker" <<'DOCKER'
#!/bin/bash -p
set -Eeuo pipefail
root=$(/usr/bin/dirname "$0")
case ${1:-} in
  inspect)
    if [[ -e "$root/app-running" ]]; then
      printf 'true\n'
    else
      printf 'false\n'
    fi
    ;;
  compose)
    env_file=''
    while (($# > 0)); do
      if [[ $1 == --env-file ]]; then
        shift
        env_file=$1
        break
      fi
      shift
    done
    [[ -n "$env_file" ]]
    bound_image=$(/usr/bin/sed -n 's/^APP_IMAGE=//p' "$env_file" | /usr/bin/tail -1)
    selected_image=${APP_IMAGE:-$bound_image}
    printf '%s\n' "$selected_image" > "$root/selected-image"
    : > "$root/app-running"
    ;;
  *) exit 64 ;;
esac
DOCKER
  chmod 0700 "$fake_docker"
  printf 'APP_IMAGE=expected/image@sha256:bound\n' > "$env_file"
  printf 'services:\n  app:\n    image: ${APP_IMAGE}\n' > "$candidate"
  printf 'source-model\n' > "$live"
  chmod 0600 "$env_file" "$candidate" "$live"
  mkdir -m 700 -p "$execution_home/docker" "$fixture_dir/locks"
  printf '{}\n' > "$execution_home/docker/config.json"
  chmod 0600 "$execution_home/docker/config.json"
  jq -n \
    --arg dockerPath "$fake_docker" \
    --arg appContainer fixture-app \
    --arg liveCompose "$live" \
    --arg dockerEndpoint 'unix:///fixture/docker.sock' \
    --arg lockRoot "$fixture_dir/locks" \
    --arg fixedPath '/usr/sbin:/usr/bin:/sbin:/bin' \
    '{dockerPath:$dockerPath,appContainer:$appContainer,liveCompose:$liveCompose,
      dockerEndpoint:$dockerEndpoint,lockRoot:$lockRoot,fixedPath:$fixedPath}' > "$state"
  chmod 0600 "$state"

  eval "$(extract_function child_path_for_state)"
  eval "$(extract_function activate_application_for_verification)"
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }
  execution_docker_path=$fake_docker
  execution_controller_home=$execution_home
  execution_env_file=$env_file
  execution_candidate_compose=$candidate
  HOME="$fixture_dir/home"
  DOCKER_CONFIG="$HOME/docker"
  DOCKER_HOST='unix:///fixture/docker.sock'
  PATH='/usr/sbin:/usr/bin:/sbin:/bin'
  export HOME DOCKER_CONFIG DOCKER_HOST PATH

  APP_IMAGE=attacker/image \
    activate_application_for_verification "$state" || {
      echo 'activation fixture failed before observing Compose interpolation' >&2
      exit 1
    }
  selected=$(<"$fixture_dir/selected-image")
  [[ "$selected" == expected/image@sha256:bound ]] || {
    printf 'ambient APP_IMAGE overrode the bound Compose env file during activation: %s\n' \
      "$selected" >&2
    exit 1
  }
)

test_authorization_postprocessing_failure_closes_writer_durably() (
  local fixture_dir manifest state shim rc=0 lifecycle control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=authorization-running \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  ((rc != 0)) || {
    echo 'authorization evidence postprocessing failure unexpectedly reported success' >&2
    exit 1
  }
  rg -Fq 'test evidence failure at phase authorization-running' \
    "$fixture_dir/controller.err" || {
      echo 'authorization postprocessing owner missed its injected evidence failure' >&2
      exit 1
    }
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  [[ "$lifecycle" == transition,authorize ]] || {
    printf 'authorization postprocessing failure crossed the activation boundary: %s\n' \
      "$lifecycle" >&2
    exit 1
  }
  [[ ! -e "$fixture_dir/app-started" ]] || {
    echo 'authorization postprocessing failure activated the application writer' >&2
    exit 1
  }
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] || {
    echo 'authorization postprocessing failure did not inspect-verify writer closure' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-authorization-evidence" and
    .proofException == "authorization-evidence-unavailable" and
    (.writerStopEvidence.path | type == "string" and startswith("/")) and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null || {
    echo 'authorization postprocessing failure lacks a durable closure incident and writer-stop proof' >&2
    exit 1
  }
)

test_authorization_postprocessing_ordinary_failure_is_fail_closed() (
  local fixture_dir manifest state shim rc=0 lifecycle control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  : > "$fixture_dir/fail-authorization-postprocessing-fsync"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_authorization_postprocessing_non_die_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  [[ -e "$fixture_dir/authorization-postprocessing-fsync-failure-consumed" ]] || {
    echo 'authorization postprocessing owner missed its ordinary fsync failure' >&2
    exit 1
  }
  ((rc != 0)) || {
    echo 'ordinary authorization postprocessing failure was ignored under conditional errexit' >&2
    exit 1
  }
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  [[ "$lifecycle" == transition,authorize ]] || {
    printf 'ordinary authorization postprocessing failure crossed the activation boundary: %s\n' \
      "$lifecycle" >&2
    exit 1
  }
  [[ ! -e "$fixture_dir/app-started" ]] || {
    echo 'ordinary authorization postprocessing failure activated the application writer' >&2
    exit 1
  }
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] || {
    echo 'ordinary authorization postprocessing failure did not inspect-verify writer closure' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-authorization-evidence" and
    .proofException == "authorization-evidence-unavailable" and
    (.writerStopEvidence.path | type == "string" and startswith("/")) and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null || {
    echo 'ordinary authorization postprocessing failure lacks its exact durable closure proof' >&2
    exit 1
  }
)

test_closure_postprocessing_proof_exception_is_scoped() (
  local fixture_dir manifest state mutated shim rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  mutated="$fixture_dir/missing-authorization-evidence.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete success
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_phase_snapshot_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=closure-running \
    NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE=closure-stop-pending \
    NOOSPHERE_CONTROLLER_TEST_CAPTURE_INCIDENT_CLASS=closure-postprocessing \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  [[ "$rc" == 86 && -e "$fixture_dir/controller-phase-snapshot-captured" ]] || {
    echo 'controller did not capture the later closure-postprocessing baseline' >&2
    exit 1
  }
  /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
    _ "$CONTROLLER" "$state"

  jq '.proofException = "authorization-evidence-unavailable" | del(.authorizationEvidence)' \
    "$state" > "$mutated"
  chmod 0600 "$mutated"
  if /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
    _ "$CONTROLLER" "$mutated" \
      >"$fixture_dir/validate.out" 2>"$fixture_dir/validate.err"; then
    echo 'later closure-postprocessing accepted missing authorization evidence' >&2
    exit 1
  fi
  rg -qi 'authorization.*evidence.*(required|exception)|(required|exception).*authorization.*evidence' \
    "$fixture_dir/validate.err" || {
      echo 'missing authorization-evidence rejection lacked its proof diagnostic' >&2
      exit 1
  }
)

test_phase_state_fsync_failure_does_not_advance() (
  local fixture_dir state rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  state="$fixture_dir/controller.json"
  printf '{"phase":"prepared"}\n' > "$state"
  chmod 0600 "$state"

  eval "$(extract_function path_present)"
  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function write_controller_state_atomic)"
  eval "$(extract_function update_controller_phase)"
  validate_controller_state() { :; }
  record_controller_interruption() { :; }
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }
  fsync_path() {
    if [[ "$1" == "$state.tmp."* &&
          ! -e "$fixture_dir/state-fsync-failure-consumed" ]]; then
      : > "$fixture_dir/state-fsync-failure-consumed"
      return 74
    fi
    :
  }

  set +e
  update_controller_phase "$state" candidate-published \
    >"$fixture_dir/update.out" 2>"$fixture_dir/update.err"
  rc=$?
  set -e

  [[ -e "$fixture_dir/state-fsync-failure-consumed" ]] || {
    echo 'phase-state owner missed its injected fsync failure' >&2
    exit 1
  }
  ((rc != 0)) || {
    echo 'phase-state fsync failure was swallowed as success' >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == prepared ]] || {
    echo 'phase-state fsync failure still advanced the controller phase' >&2
    exit 1
  }
)

test_writer_stop_evidence_fsync_failure_is_not_bound() (
  local fixture_dir manifest state shim rc=0 control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest" complete fail
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_writer_stop_evidence_fsync_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  [[ -e "$fixture_dir/writer-stop-evidence-fsync-failure-consumed" ]] || {
    echo 'writer-stop owner missed its injected evidence fsync failure' >&2
    exit 1
  }
  ((rc != 0)) || {
    echo 'writer-stop evidence fsync failure unexpectedly reported success' >&2
    exit 1
  }
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] || {
    echo 'writer-stop evidence failure did not inspect-verify the application stop' >&2
    exit 1
  }
  jq -e '
    .phase == "closure-stop-pending" and
    .incidentClass == "closure-verification" and
    (has("writerStopEvidence") | not)
  ' "$state" >/dev/null || {
    echo 'writer-stop evidence fsync failure advanced or bound non-durable evidence' >&2
    exit 1
  }
  [[ ! -e "${state%.json}.writer-stop.evidence.json" ]] || {
    echo 'writer-stop evidence fsync failure published a non-durable evidence file' >&2
    exit 1
  }
)

test_late_authorization_evidence_failure_remains_resumable() (
  local fixture_dir manifest state shim rc=0 retry_rc=0 control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_authorization_evidence_late_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  [[ -e "$fixture_dir/authorization-evidence-late-failure-consumed" ]] || {
    echo 'late authorization-evidence owner missed its injected bind failure' >&2
    exit 1
  }
  ((rc != 0)) || {
    echo 'late authorization-evidence failure unexpectedly reported success' >&2
    exit 1
  }
  control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
  [[ "$control_tail" == stop,inspect:false ]] || {
    echo 'late authorization-evidence failure did not inspect-verify writer closure' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-authorization-evidence" and
    .proofException == "authorization-evidence-unavailable" and
    (has("authorizationEvidence") | not) and
    (.writerStopEvidence.path | type == "string" and startswith("/"))
  ' "$state" >/dev/null || {
    echo 'late authorization-evidence failure stranded an invalid closure state' >&2
    exit 1
  }
  /bin/bash -c 'source "$1"; validate_controller_state "$2"' \
    _ "$CONTROLLER" "$state" || {
      echo 'late authorization-evidence incident is not independently resumable' >&2
      exit 1
    }

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  ((retry_rc != 0)) || {
    echo 'terminal authorization-evidence incident unexpectedly resumed execution' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-authorization-evidence" and
    .proofException == "authorization-evidence-unavailable" and
    (has("authorizationEvidence") | not)
  ' "$state" >/dev/null || {
    echo 'terminal authorization-evidence retry changed the durable incident' >&2
    exit 1
  }
)

test_closure_intent_failure_preserves_status_and_blocks_reauthorization() (
  local fixture_dir manifest state shim rc=0 retry_rc=0 lifecycle control_tail
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_closure_intent_fsync_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=authorization-running \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?

  [[ -e "$fixture_dir/closure-intent-fsync-failure-consumed" ]] ||
    failures+=('closure-intent owner missed its injected state-publication failure')
  [[ "$rc" == 73 ]] ||
    failures+=("closure-intent failure returned $rc instead of preserving status 73")
  control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
  [[ "$control_tail" == stop,inspect:false ]] ||
    failures+=("closure-intent failure lacked an inspect-verified stop (control_tail=$control_tail)")
  jq -e '
    .phase == "authorization-running" and
    (.writerStopEvidence.path | type == "string" and startswith("/")) and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null ||
    failures+=('closure-intent failure did not preserve its truthful pre-intent phase and writer-stop proof')

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  ((retry_rc != 0)) ||
    failures+=('closure-intent failure remained resumable through writer reauthorization')
  rg -Fq 'fresh invocation stopped an interrupted authorization phase; operator resolution is required' \
    "$fixture_dir/retry.err" ||
    failures+=('closure-intent retry lacked the fresh inspect-stop operator-resolution diagnostic')
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-interruption" and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null ||
    failures+=('closure-intent retry did not promote its fresh stop to a terminal interruption incident')
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  [[ "$lifecycle" == transition,authorize ]] ||
    failures+=("closure-intent retry crossed reauthorization/activation boundary: $lifecycle")

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_initial_activation_inspect_failure_commits_durable_closure() (
  local fixture_dir manifest state shim rc=0 retry_rc=0 lifecycle control_tail
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  : > "$fixture_dir/fail-initial-activation-inspect"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_systemd_identity_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
  [[ -e "$fixture_dir/initial-activation-inspect-failure-consumed" ]] ||
    failures+=('activation-inspect owner missed the initial inspect boundary')
  ((rc != 0)) || failures+=('initial activation inspect failure unexpectedly reported success')
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  [[ "$lifecycle" == transition,authorize ]] ||
    failures+=("initial activation inspect failure crossed activation: $lifecycle")
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] ||
    failures+=("initial activation inspect failure lacked a fresh stop proof (control_tail=$control_tail)")
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-app-activation" and
    (.authorizationEvidence.sha256 | test("^[a-f0-9]{64}$")) and
    (.writerStopEvidence.sha256 | test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null ||
    failures+=('initial activation inspect failure bypassed durable app-activation closure')

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  ((retry_rc != 0)) || failures+=('activation-inspect incident was resumable')
  [[ $(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true) == transition,authorize ]] ||
    failures+=('activation-inspect incident retry reauthorized or activated the writer')

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_compose_publication_is_anchored_against_ancestor_retarget() (
  local fixture_dir source_root original_root attacker_root target_root source target
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  source_root="$fixture_dir/source-root"
  original_root="$fixture_dir/source-root-original"
  attacker_root="$fixture_dir/attacker-root"
  target_root="$fixture_dir/target-root"
  install -d -m 700 "$source_root/parent" "$attacker_root/parent" "$target_root"
  source="$source_root/parent/candidate.yml"
  target="$target_root/live-compose.yml"
  printf 'reviewed-candidate\n' > "$source"
  printf 'attacker-candidate\n' > "$attacker_root/parent/candidate.yml"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$attacker_root/parent/candidate.yml" "$target"

  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function publish_compose_atomic)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  fsync_path() { :; }
  mktemp() {
    if [[ $1 == *.item3-publish.* &&
          ! -e "$fixture_dir/ancestor-retarget-consumed" ]]; then
      command mv "$source_root" "$original_root"
      command ln -s "$attacker_root" "$source_root"
      : > "$fixture_dir/ancestor-retarget-consumed"
    fi
    command mktemp "$@"
  }

  if ! publish_compose_atomic "$source" "$target"; then
    failures+=('anchored publication rejected a path that was safe when opened')
  fi
  [[ -e "$fixture_dir/ancestor-retarget-consumed" ]] ||
    failures+=('publication owner missed its deterministic ancestor retarget')
  [[ $(<"$target") == reviewed-candidate ]] ||
    failures+=("ancestor retarget substituted publication bytes: $(<"$target")")

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_simulated_root_rejects_root_owned_writable_compose_parent() (
  local fixture_dir unsafe_dir safe_dir source target definition mutant
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  unsafe_dir="$fixture_dir/root-owned-writable"
  safe_dir="$fixture_dir/safe"
  install -d -m 777 "$unsafe_dir"
  install -d -m 700 "$safe_dir"
  source="$unsafe_dir/candidate.yml"
  target="$safe_dir/live-compose.yml"
  printf 'candidate-model\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$target"

  eval "$(extract_function assert_owned_regular_file)"
  definition=$(extract_function publish_compose_atomic)
  eval "$definition"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  fsync_path() { :; }
  id() {
    [[ ${1:-} == -u ]] && { printf '0\n'; return; }
    command id "$@"
  }
  stat() {
    if [[ $1 == -c && $2 == %u &&
          ( $3 == "$fixture_dir"/* || $3 == /proc/*/fd/* ) ]]; then
      printf '0\n'
      return
    fi
    command stat "$@"
  }

  if (publish_compose_atomic "$source" "$target"); then
    failures+=('simulated root accepted a root-owned mode-0777 publication parent')
  fi
  [[ $(<"$target") == source-model ]] ||
    failures+=('simulated-root writable-parent rejection changed target bytes')

  # Mutation proof: delete only the parent-mode guard from an extracted copy.
  # The same owner must then expose the unsafe publication by observing the
  # target overwrite; this keeps the fixture meaningful under a root runner.
  mutant=$(printf '%s\n' "$definition" | awk '
    /^publish_compose_atomic\(\) \{/ { sub(/publish_compose_atomic/, "publish_compose_atomic_without_parent_mode") }
    /^[[:space:]]*parent_mode=\$\(stat -c/ { skip = 2; next }
    skip > 0 { skip--; next }
    { print }
  ')
  eval "$mutant"
  printf 'source-model\n' > "$target"
  if ! publish_compose_atomic_without_parent_mode "$source" "$target"; then
    failures+=('simulated-root owner could not exercise its parent-mode mutation')
  elif [[ $(<"$target") != candidate-model ]]; then
    failures+=('simulated-root owner did not detect the removed parent-mode guard')
  fi

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_foreign_owned_compose_parents_are_rejected() (
  local fixture_dir safe_source_dir safe_target_dir foreign_source_dir foreign_target_dir
  local source target simulated_current_uid=0 foreign_uid
  local -a failures=()
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  safe_source_dir="$fixture_dir/safe-source"
  safe_target_dir="$fixture_dir/safe-target"
  foreign_source_dir="$fixture_dir/foreign-source"
  foreign_target_dir="$fixture_dir/foreign-target"
  install -d -m 700 \
    "$safe_source_dir" "$safe_target_dir" "$foreign_source_dir" "$foreign_target_dir"
  foreign_uid=$(( simulated_current_uid == 0 ? 1 : 0 ))

  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function publish_compose_atomic)"
  die() {
    printf 'fixture: %s\n' "$*" >&2
    exit 1
  }
  fsync_path() { :; }
  id() {
    if [[ ${1:-} == -u ]]; then
      printf '%s\n' "$simulated_current_uid"
      return 0
    fi
    command id "$@"
  }
  stat() {
    if [[ $1 == -c && $2 == %u ]]; then
      if [[ $3 == "$foreign_source_dir" || $3 == "$foreign_target_dir" ]]; then
        printf '%s\n' "$foreign_uid"
        return 0
      fi
      if [[ $3 == "$fixture_dir"/* ]]; then
        printf '%s\n' "$simulated_current_uid"
        return 0
      fi
    fi
    command stat "$@"
  }

  source="$foreign_source_dir/candidate.yml"
  target="$safe_target_dir/live-compose.yml"
  printf 'candidate-from-foreign-parent\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$target"
  if (publish_compose_atomic "$source" "$target"); then
    failures+=('publication accepted a foreign-owned source parent')
  fi
  [[ $(<"$target") == source-model ]] ||
    failures+=('foreign-owned source parent rejection overwrote the live Compose target')

  source="$safe_source_dir/candidate.yml"
  target="$foreign_target_dir/live-compose.yml"
  printf 'candidate-to-foreign-parent\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$target"
  if (publish_compose_atomic "$source" "$target"); then
    failures+=('publication accepted a foreign-owned target parent')
  fi
  [[ $(<"$target") == source-model ]] ||
    failures+=('foreign-owned target parent rejection overwrote the live Compose target')

  ((${#failures[@]} == 0)) || {
    printf '%s\n' "${failures[@]}" >&2
    exit 1
  }
)

test_preopen_parent_retarget_cannot_substitute_publication_identity() (
  local fixture_dir source_parent original_parent attacker_parent target_parent source target rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  source_parent="$fixture_dir/source-parent"
  original_parent="$fixture_dir/source-parent-original"
  attacker_parent="$fixture_dir/attacker-parent"
  target_parent="$fixture_dir/target-parent"
  install -d -m 700 "$source_parent" "$attacker_parent" "$target_parent"
  source="$source_parent/candidate.yml"
  target="$target_parent/live-compose.yml"
  printf 'reviewed-candidate\n' > "$source"
  printf 'attacker-candidate\n' > "$attacker_parent/candidate.yml"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$attacker_parent/candidate.yml" "$target"

  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function publish_compose_atomic)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  fsync_path() { :; }
  stat() {
    local result
    if [[ $1 == -c && $2 == %a && $3 == "$target_parent" &&
          ! -e "$fixture_dir/preopen-parent-retarget-consumed" ]]; then
      result=$(command stat "$@")
      printf '%s\n' "$result"
      command mv "$source_parent" "$original_parent"
      command ln -s "$attacker_parent" "$source_parent"
      : > "$fixture_dir/preopen-parent-retarget-consumed"
      return 0
    fi
    command stat "$@"
  }

  publish_compose_atomic "$source" "$target" || rc=$?
  [[ -e "$fixture_dir/preopen-parent-retarget-consumed" ]] || {
    echo 'pre-open parent-retarget owner missed the final validation boundary' >&2
    exit 1
  }
  if ((rc == 0)) && [[ $(<"$target") != reviewed-candidate ]]; then
    printf 'pre-open parent retarget substituted publication bytes: %s\n' \
      "$(<"$target")" >&2
    exit 1
  fi
  ((rc != 0)) || [[ $(<"$target") == reviewed-candidate ]]
)

test_candidate_entry_swap_cannot_escape_prepared_digest() (
  local fixture_dir candidate_parent target_parent candidate live source_snapshot state
  local expected_candidate_sha source_sha rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  candidate_parent="$fixture_dir/candidate-parent"
  target_parent="$fixture_dir/target-parent"
  install -d -m 700 "$candidate_parent" "$target_parent"
  candidate="$candidate_parent/candidate.yml"
  live="$target_parent/live-compose.yml"
  source_snapshot="$fixture_dir/source-compose.yml"
  state="$fixture_dir/controller.json"
  printf 'reviewed-candidate\n' > "$candidate"
  printf 'source-model\n' > "$live"
  printf 'source-model\n' > "$source_snapshot"
  chmod 0600 "$candidate" "$live" "$source_snapshot"
  expected_candidate_sha=$(sha256sum "$candidate" | awk '{print $1}')
  source_sha=$(sha256sum "$source_snapshot" | awk '{print $1}')
  jq -n \
    --arg liveCompose "$live" \
    --arg sourceSnapshot "$source_snapshot" \
    --arg sourceSha "$source_sha" \
    --arg candidateSha "$expected_candidate_sha" \
    '{phase:"prepared",engineId:"fixture-engine",volume:"fixture-volume",
      liveCompose:$liveCompose,sourceSnapshot:$sourceSnapshot,
      sourceSnapshotSha256:$sourceSha,candidateComposeSha256:$candidateSha}' > "$state"
  chmod 0600 "$state"

  eval "$(extract_function path_present)"
  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function sha256_file)"
  eval "$(extract_function publish_compose_atomic)"
  eval "$(extract_function publish_candidate_under_lock)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  fsync_path() { :; }
  validate_controller_state() { :; }
  assert_operation_lock_held() { :; }
  update_controller_phase() {
    local next_phase=$2 replacement
    if [[ "$next_phase" == candidate-published &&
          ! -e "$fixture_dir/candidate-entry-swap-consumed" ]]; then
      replacement="$candidate_parent/candidate.replacement"
      printf 'attacker-candidate\n' > "$replacement"
      chmod 0600 "$replacement"
      command mv -f "$replacement" "$candidate"
      : > "$fixture_dir/candidate-entry-swap-consumed"
    fi
  }

  publish_candidate_under_lock "$state" "$candidate" "$fixture_dir/locks" || rc=$?
  [[ -e "$fixture_dir/candidate-entry-swap-consumed" ]] || {
    echo 'candidate-entry owner missed the post-digest publication-intent boundary' >&2
    exit 1
  }
  if ((rc == 0)) && [[ $(sha256sum "$live" | awk '{print $1}') != "$expected_candidate_sha" ]]; then
    printf 'candidate entry swap published bytes outside the prepared digest: %s\n' \
      "$(<"$live")" >&2
    exit 1
  fi
  ((rc != 0)) || [[ $(sha256sum "$live" | awk '{print $1}') == "$expected_candidate_sha" ]]
)

test_closure_intent_and_stop_failure_cannot_cross_writer_boundary() (
  local fixture_dir manifest state shim initial_rc=0 retry_rc=0 lifecycle phase control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  : > "$fixture_dir/fail-closure-stop-once"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_closure_intent_fsync_failure_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  run_fixture_controller "$state" "$shim" env \
    NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=authorization-running \
    >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || initial_rc=$?
  ((initial_rc != 0)) || {
    echo 'dual closure failure unexpectedly reported initial success' >&2
    exit 1
  }
  [[ -e "$fixture_dir/closure-intent-fsync-failure-consumed" &&
     -e "$fixture_dir/closure-stop-failure-consumed" ]] || {
    echo 'dual closure owner missed its intent-write or fixture-Docker stop failure' >&2
    exit 1
  }
  phase=$(jq -r '.phase // empty' "$state")
  [[ "$phase" == authorization-running || "$phase" == activation-running ]] || {
    printf 'dual closure owner did not retain a resumable writer phase: %s\n' "$phase" >&2
    exit 1
  }
  jq -e 'has("writerStopEvidence") | not' "$state" >/dev/null || {
    echo 'dual closure owner unexpectedly bound writer-stop evidence' >&2
    exit 1
  }

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  if [[ "$lifecycle" == *,authorize,authorize* || "$lifecycle" == *,activate* || "$retry_rc" == 0 ]]; then
    printf 'dual closure failure retry crossed writer reauthorization/reactivation: rc=%s lifecycle=%s\n' \
      "$retry_rc" "$lifecycle" >&2
    exit 1
  fi
  control_tail=$(tail -n 2 "$fixture_dir/app-control.log" 2>/dev/null | paste -sd, -)
  [[ "$control_tail" == stop,inspect:false ]] || {
    printf 'dual closure failure retry did not inspect-stop the retained writer before proof validation: %s\n' \
      "$control_tail" >&2
    exit 1
  }
  jq -e '
    (.writerStopEvidence.path | type == "string" and startswith("/")) and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null || {
    echo 'dual closure failure retry did not durably bind its fresh writer stop' >&2
    exit 1
  }
)

test_fresh_activation_recovery_stops_before_phase_owned_proof_validation() (
  local fixture_dir manifest state shim authorization_evidence initial_rc=0 retry_rc=0 control_tail
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_phase_snapshot_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE=activation-running \
    run_fixture_controller "$state" "$shim" env \
      >"$fixture_dir/initial.out" 2>"$fixture_dir/initial.err" || initial_rc=$?
  [[ "$initial_rc" == 86 && -e "$fixture_dir/controller-phase-snapshot-captured" ]] || {
    printf 'fresh activation owner did not capture activation-running: rc=%s\n' "$initial_rc" >&2
    exit 1
  }
  [[ $(jq -er '.phase' "$state") == activation-running ]] || {
    echo 'fresh activation owner did not retain activation-running state' >&2
    exit 1
  }

  # Exact crash image: Compose has started the app, but the controller has not
  # yet advanced from activation-running. The bound proof then becomes
  # unavailable before a fresh invocation can recover.
  : > "$fixture_dir/app-started"
  rm -f -- "$fixture_dir/app-stopped"
  authorization_evidence=$(jq -er '.authorizationEvidence.path' "$state")
  rm -f -- "$authorization_evidence"

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  ((retry_rc != 0)) || {
    echo 'fresh activation recovery unexpectedly reported success' >&2
    exit 1
  }
  if [[ -f "$fixture_dir/app-control.log" ]]; then
    control_tail=$(tail -n 2 "$fixture_dir/app-control.log" | paste -sd, -)
  else
    control_tail=''
  fi
  [[ "$control_tail" == stop,inspect:false ]] || {
    printf 'fresh activation recovery left the writer running before proof validation: %s\n' \
      "$control_tail" >&2
    exit 1
  }
  jq -e '
    .phase == "activation-running" and
    (.writerStopEvidence.path | type == "string" and startswith("/")) and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$state" >/dev/null || {
    echo 'fresh activation recovery did not bind stop evidence before proof validation failed' >&2
    exit 1
  }
)

test_fresh_activation_stop_failure_persists_closure_intent() (
  local fixture_dir manifest state shim authorization_evidence initial_rc=0 retry_rc=0 lifecycle
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  manifest="$fixture_dir/manifest.json"
  state="$fixture_dir/controller.json"
  write_execution_fixture "$fixture_dir" "$manifest"
  export XDG_RUNTIME_DIR="$fixture_dir/locks"
  shim=$(write_phase_snapshot_shim "$fixture_dir")
  "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"

  NOOSPHERE_CONTROLLER_TEST_CAPTURE_PHASE=activation-running \
    run_fixture_controller "$state" "$shim" env \
      >"$fixture_dir/initial.out" 2>"$fixture_dir/initial.err" || initial_rc=$?
  [[ "$initial_rc" == 86 && $(jq -er '.phase' "$state") == activation-running ]] || {
    printf 'fresh stop-failure owner did not capture activation-running: rc=%s\n' "$initial_rc" >&2
    exit 1
  }

  : > "$fixture_dir/app-started"
  rm -f -- "$fixture_dir/app-stopped"
  : > "$fixture_dir/fail-closure-stop-once"
  authorization_evidence=$(jq -er '.authorizationEvidence.path' "$state")
  rm -f -- "$authorization_evidence"

  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=fedcba9876543210fedcba9876543210 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/retry.out" 2>"$fixture_dir/retry.err" || retry_rc=$?
  ((retry_rc != 0)) || {
    echo 'fresh activation stop failure unexpectedly reported success' >&2
    exit 1
  }
  [[ -e "$fixture_dir/closure-stop-failure-consumed" ]] || {
    echo 'fresh activation stop-failure owner did not exercise the injected stop failure' >&2
    exit 1
  }
  jq -e '
    .phase == "closure-stop-pending" and
    .incidentClass == "closure-interruption" and
    (has("writerStopEvidence") | not)
  ' "$state" >/dev/null || {
    echo 'fresh activation stop failure did not preserve durable closure intent' >&2
    exit 1
  }
  lifecycle=$(paste -sd, "$fixture_dir/lifecycle.log" 2>/dev/null || true)
  [[ "$lifecycle" == transition,authorize ]] || {
    printf 'fresh activation stop failure crossed writer replay boundary: %s\n' "$lifecycle" >&2
    exit 1
  }

  retry_rc=0
  NOOSPHERE_CONTROLLER_FIXTURE_INVOCATION_ID=11112222333344445555666677778888 \
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/recovery.out" 2>"$fixture_dir/recovery.err" || retry_rc=$?
  ((retry_rc != 0)) || {
    echo 'fresh activation stop-failure recovery unexpectedly reported success' >&2
    exit 1
  }
  jq -e '
    .phase == "incident" and
    .incidentClass == "closure-interruption" and
    (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (has("proofException") | not)
  ' "$state" >/dev/null || {
    echo 'fresh activation stop-failure state was not resumable to terminal interruption' >&2
    sed 's/^/  recovery.err: /' "$fixture_dir/recovery.err" >&2 || true
    jq . "$state" >&2 || true
    exit 1
  }
)

test_detached_target_parent_cannot_false_complete_publication() (
  local fixture_dir source_parent target_parent detached_parent source target rc=0
  fixture_dir=$(mktemp -d)
  trap 'rm -rf -- "$fixture_dir"' EXIT
  source_parent="$fixture_dir/source-parent"
  target_parent="$fixture_dir/target-parent"
  detached_parent="$fixture_dir/target-parent-detached"
  install -d -m 700 "$source_parent" "$target_parent"
  source="$source_parent/candidate.yml"
  target="$target_parent/live-compose.yml"
  printf 'reviewed-candidate\n' > "$source"
  printf 'source-model\n' > "$target"
  chmod 0600 "$source" "$target"

  eval "$(extract_function assert_owned_regular_file)"
  eval "$(extract_function publish_compose_atomic)"
  die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
  fsync_path() { :; }
  mktemp() {
    if [[ $1 == *.item3-publish.* &&
          ! -e "$fixture_dir/detached-target-parent-consumed" ]]; then
      command mv "$target_parent" "$detached_parent"
      command install -d -m 700 "$target_parent"
      printf 'source-model\n' > "$target"
      chmod 0600 "$target"
      : > "$fixture_dir/detached-target-parent-consumed"
    fi
    command mktemp "$@"
  }

  publish_compose_atomic "$source" "$target" || rc=$?
  [[ -e "$fixture_dir/detached-target-parent-consumed" ]] || {
    echo 'detached-target owner missed the post-descriptor publication boundary' >&2
    exit 1
  }
  if ((rc == 0)) && [[ $(<"$target") != reviewed-candidate ]]; then
    printf 'detached target parent falsely reported publication success: live=%s detached=%s\n' \
      "$(<"$target")" "$(<"$detached_parent/live-compose.yml")" >&2
    exit 1
  fi
  ((rc != 0)) || [[ $(<"$target") == reviewed-candidate ]]
)

test_postrename_fsync_failure_cannot_expose_advanced_publications() (
  local state_case_rc=0 writer_case_rc=0

  (
    local fixture_dir state rc=0 phase
    fixture_dir=$(mktemp -d)
    trap 'rm -rf -- "$fixture_dir"' EXIT
    state="$fixture_dir/controller.json"
    printf '{"phase":"prepared"}\n' > "$state"
    chmod 0600 "$state"
    eval "$(extract_function path_present)"
    eval "$(extract_function assert_owned_regular_file)"
    eval "$(extract_function write_controller_state_atomic)"
    eval "$(extract_function update_controller_phase)"
    validate_controller_state() { :; }
    record_controller_interruption() { :; }
    die() { printf 'fixture: %s\n' "$*" >&2; exit 1; }
    fsync_path() {
      if [[ "$1" == "$fixture_dir" &&
            ! -e "$fixture_dir/state-postrename-fsync-failure-consumed" ]]; then
        : > "$fixture_dir/state-postrename-fsync-failure-consumed"
        return 74
      fi
      :
    }
    set +e
    update_controller_phase "$state" candidate-published
    rc=$?
    set -e
    [[ -e "$fixture_dir/state-postrename-fsync-failure-consumed" ]] || {
      echo 'post-rename state owner missed the parent-directory fsync boundary' >&2
      exit 1
    }
    ((rc != 0)) || {
      echo 'post-rename state parent-fsync failure unexpectedly reported success' >&2
      exit 1
    }
    phase=$(jq -r '.phase // empty' "$state")
    [[ "$phase" == prepared ]] || {
      printf 'post-rename state fsync failure exposed advanced phase: %s\n' "$phase" >&2
      exit 1
    }
  ) || state_case_rc=$?

  (
    local fixture_dir manifest state shim rc=0 evidence_count
    fixture_dir=$(mktemp -d)
    trap 'rm -rf -- "$fixture_dir"' EXIT
    manifest="$fixture_dir/manifest.json"
    state="$fixture_dir/controller.json"
    write_execution_fixture "$fixture_dir" "$manifest" complete fail
    export XDG_RUNTIME_DIR="$fixture_dir/locks"
    shim=$(write_writer_stop_postrename_fsync_failure_shim "$fixture_dir")
    "$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
    run_fixture_controller "$state" "$shim" \
      >"$fixture_dir/controller.out" 2>"$fixture_dir/controller.err" || rc=$?
    [[ -e "$fixture_dir/writer-stop-postrename-fsync-failure-consumed" ]] || {
      echo 'post-rename writer-stop owner missed the evidence parent-directory fsync boundary' >&2
      exit 1
    }
    ((rc != 0)) || {
      echo 'post-rename writer-stop parent-fsync failure unexpectedly reported success' >&2
      exit 1
    }
    evidence_count=$(compgen -G "${state%.json}.writer-stop*.evidence.json" | wc -l)
    [[ "$evidence_count" == 0 ]] || {
      printf 'post-rename writer-stop fsync failure exposed %s advanced evidence object(s)\n' \
        "$evidence_count" >&2
      exit 1
    }
  ) || writer_case_rc=$?

  ((state_case_rc == 0 && writer_case_rc == 0)) || exit 1
)

test_verification_url_requires_a_local_ipv4_interface() (
  eval "$(extract_function query_local_ipv4_addresses)"
  eval "$(extract_function assert_local_verification_url)"
  query_local_ipv4_addresses() {
    printf '%s\n' 127.0.0.1 192.0.2.10
  }

  assert_local_verification_url 'http://127.0.0.1:16578'
  assert_local_verification_url 'http://192.0.2.10:16578'
  if assert_local_verification_url 'http://198.51.100.20:16578' >/dev/null 2>&1; then
    echo 'unassigned IPv4 verification target was accepted' >&2
    exit 1
  fi
  if assert_local_verification_url 'http://0.0.0.0:16578' >/dev/null 2>&1; then
    echo 'wildcard verification target was accepted' >&2
    exit 1
  fi
  if assert_local_verification_url 'http://localhost:16578' >/dev/null 2>&1; then
    echo 'DNS verification target was accepted' >&2
    exit 1
  fi
  if assert_local_verification_url 'https://192.0.2.10:16578' >/dev/null 2>&1; then
    echo 'HTTPS verification target was accepted' >&2
    exit 1
  fi
)

# Per-test isolation helper: clear the durable authority namespace so a
# prior test's stale record (pointing at an already-rm-rf'd fixture_dir)
# cannot fire the R3-1 unrecognized-phase arm before the current test
# exercises its own contract.
_clear_authority_root_for_isolation() {
  rm -rf -- "$XDG_STATE_HOME/noosphere-pgvector-controller"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  _clear_authority_root_for_isolation
  test_atomic_controller_state
  _clear_authority_root_for_isolation
  test_source_restore_without_guard_journal
  _clear_authority_root_for_isolation
  test_execution_environment_is_hermetic
  _clear_authority_root_for_isolation
  test_closure_failure_classification
  _clear_authority_root_for_isolation
  test_signal_handler_is_idempotent
  _clear_authority_root_for_isolation
  test_reboot_recovers_prejournal_candidate_publication
  _clear_authority_root_for_isolation
  test_valid_guard_journal_suppresses_outer_restore
  _clear_authority_root_for_isolation
  test_shared_lock_is_inherited
  _clear_authority_root_for_isolation
  test_candidate_publication_intent_is_recoverable
  _clear_authority_root_for_isolation
  test_systemd_contract_has_no_automatic_kill
  _clear_authority_root_for_isolation
  test_process_evidence_is_bounded_and_hashed
  _clear_authority_root_for_isolation
  test_closure_outcome_never_false_completes
  _clear_authority_root_for_isolation
  test_complete_entrypoint_with_disposable_commands
  _clear_authority_root_for_isolation
  test_manifest_mutation_fails_before_publication
  _clear_authority_root_for_isolation
  test_execution_requires_systemd_identity
  _clear_authority_root_for_isolation
  test_guard_failure_before_journal_restores_source
  _clear_authority_root_for_isolation
  test_guard_journal_prevents_outer_restore
  _clear_authority_root_for_isolation
  test_verifier_failure_commits_incident_and_stops_app
  _clear_authority_root_for_isolation
  test_evidence_failure_cannot_complete
  _clear_authority_root_for_isolation
  test_term_during_guard_records_and_recovers
  _clear_authority_root_for_isolation
  test_terminal_states_never_delegate_to_a_stale_guard_journal
  _clear_authority_root_for_isolation
  test_systemd_identity_is_queried_not_asserted
  _clear_authority_root_for_isolation
  test_prepare_refuses_to_overwrite_active_or_terminal_state
  _clear_authority_root_for_isolation
  test_engine_identity_is_rebound_to_the_live_daemon
  _clear_authority_root_for_isolation
  test_lock_root_must_match_the_guard_lock_contract
  _clear_authority_root_for_isolation
  test_child_process_environment_and_docker_resolution_are_hermetic
  _clear_authority_root_for_isolation
  test_latched_signal_before_guard_cannot_be_ignored
  _clear_authority_root_for_isolation
  test_verifier_evidence_failure_stops_writer_before_storage
  _clear_authority_root_for_isolation
  test_process_logs_are_fsynced_before_evidence_binding
  _clear_authority_root_for_isolation
  test_complete_state_binds_guard_and_closure_evidence
  _clear_authority_root_for_isolation
  test_systemd_safety_properties_and_linger_are_queried
  _clear_authority_root_for_isolation
  test_signals_cannot_cross_spawn_or_complete_boundaries
  _clear_authority_root_for_isolation
  test_source_recovery_verifier_is_hermetic_and_target_bound
  _clear_authority_root_for_isolation
  test_complete_state_binds_immutable_guard_journal
  _clear_authority_root_for_isolation
  test_process_evidence_separates_controller_and_child_identity
  _clear_authority_root_for_isolation
  test_guard_arguments_are_semantically_bound_to_manifest
  _clear_authority_root_for_isolation
  test_compose_plugin_and_docker_config_identity_are_bound
  _clear_authority_root_for_isolation
  test_activation_uses_invocation_private_docker_bundle
  _clear_authority_root_for_isolation
  test_candidate_model_uses_activation_project_directory
  _clear_authority_root_for_isolation
  test_failed_prejournal_recovery_commits_durable_incident
  _clear_authority_root_for_isolation
  test_process_evidence_rejects_impossible_chronology
  _clear_authority_root_for_isolation
  test_source_snapshot_is_revalidated_before_publication
  _clear_authority_root_for_isolation
  test_guard_journal_path_is_canonically_bound
  _clear_authority_root_for_isolation
  test_fixed_path_toolchain_is_immutable_and_bound
  _clear_authority_root_for_isolation
  test_controller_state_cannot_collide_with_guard_journal
  _clear_authority_root_for_isolation
  test_ambient_test_overrides_cannot_falsify_production_evidence
  _clear_authority_root_for_isolation
  test_docker_rehearsal_proves_cleanup_before_success
  _clear_authority_root_for_isolation
  test_process_evidence_rejects_fractional_numbers
  _clear_authority_root_for_isolation
  test_real_systemd_fixture_exercises_signal_delivery
  _clear_authority_root_for_isolation
  test_production_execution_succeeds_without_ambient_fault_hooks
  _clear_authority_root_for_isolation
  test_production_execution_succeeds_without_ambient_signal_hooks

  _clear_authority_root_for_isolation
  test_derived_evidence_paths_cannot_collide_with_bound_inputs
  _clear_authority_root_for_isolation
  test_guard_signal_persists_child_evidence_before_return
  _clear_authority_root_for_isolation
  test_verifier_signal_persists_child_evidence_before_return
  _clear_authority_root_for_isolation
  test_terminal_state_requires_phase_specific_invariants
  _clear_authority_root_for_isolation
  test_preparation_resolves_docker_only_after_hermetic_sanitization
  _clear_authority_root_for_isolation
  test_controller_executable_is_bound_after_preparation
  _clear_authority_root_for_isolation
  test_guard_signal_waits_until_child_is_reaped
  _clear_authority_root_for_isolation
  test_closure_verifier_signal_waits_until_child_is_reaped
  _clear_authority_root_for_isolation
  test_source_verifier_signal_waits_until_child_is_reaped
  _clear_authority_root_for_isolation
  test_bootstrap_ignores_ambient_path
  _clear_authority_root_for_isolation
  test_docker_config_namespace_rejects_descendants
  _clear_authority_root_for_isolation
  test_complete_state_revalidates_durable_evidence
  _clear_authority_root_for_isolation
  test_recovery_preserves_prior_process_evidence
  _clear_authority_root_for_isolation
  test_closure_incident_remains_resumable_until_writer_is_stopped
  _clear_authority_root_for_isolation
  test_bootstrap_blocks_bash_env_and_exported_functions
  _clear_authority_root_for_isolation
  test_fixed_path_is_validated_before_installation
  _clear_authority_root_for_isolation
  test_signal_waits_for_guard_descendant_group
  _clear_authority_root_for_isolation
  test_concurrent_reprepare_cannot_replace_live_prepared_state
  _clear_authority_root_for_isolation
  test_guard_requires_deferred_writer_restart
  _clear_authority_root_for_isolation
  test_verified_guard_bytes_cannot_be_replaced_before_use
  _clear_authority_root_for_isolation
  test_concurrent_first_preparation_is_no_replace
  _clear_authority_root_for_isolation
  test_fixed_path_rejects_mutable_symlink_aliases
  _clear_authority_root_for_isolation
  test_verifier_evidence_failure_remains_resumable
  _clear_authority_root_for_isolation
  test_operation_lock_open_does_not_follow_symlinks
  _clear_authority_root_for_isolation
  test_execution_bundle_accepts_trusted_root_owned_executables
  _clear_authority_root_for_isolation
  test_bootstrap_utility_resolution_is_trusted_before_use
  _clear_authority_root_for_isolation
  test_systemd_context_requires_transient_unit_provenance
  _clear_authority_root_for_isolation
  test_writer_activation_lifecycle_is_ordered_and_evidence_bound
  _clear_authority_root_for_isolation
  test_authorization_evidence_is_durable_before_activation
  _clear_authority_root_for_isolation
  test_app_activation_failure_is_fail_closed_before_final_verification
  _clear_authority_root_for_isolation
  test_term_after_activation_stops_writer_before_return
  _clear_authority_root_for_isolation
  test_closure_evidence_pending_resume_never_reactivates_writer
  _clear_authority_root_for_isolation
  test_missing_live_compose_commits_prejournal_restoration_incident
  _clear_authority_root_for_isolation
  test_post_activation_artifact_setup_failure_stops_writer_durably
  _clear_authority_root_for_isolation
  test_closure_evidence_pending_requires_verified_stop_before_persistence
  _clear_authority_root_for_isolation
  test_same_name_volume_replacement_is_rejected_after_preparation
  _clear_authority_root_for_isolation
  test_live_identity_checks_wait_for_the_shared_operation_lock
  _clear_authority_root_for_isolation
  test_successful_verifier_postprocessing_failure_stops_writer
  _clear_authority_root_for_isolation
  test_post_activation_signal_with_zero_exit_verifier_stops_writer
  _clear_authority_root_for_isolation
  test_source_recovery_signal_persists_process_evidence
  _clear_authority_root_for_isolation
  test_prejournal_recovery_refuses_unexpected_live_compose
  _clear_authority_root_for_isolation
  test_complete_write_cannot_race_final_guard_journal_validation
  _clear_authority_root_for_isolation
  test_engine_volume_identity_has_one_authoritative_state_path
  _clear_authority_root_for_isolation
  test_production_rejects_ambient_test_hook_contamination
  _clear_authority_root_for_isolation
  test_state_authority_survives_runtime_loss_and_is_revalidated_at_execute
  _clear_authority_root_for_isolation
  test_post_authorization_pre_activation_failures_commit_fresh_stop_evidence
  _clear_authority_root_for_isolation
  test_verifier_artifact_selector_collision_routes_through_closure_artifact_storage
  _clear_authority_root_for_isolation
  test_source_recovery_artifacts_cannot_collide_with_bound_inputs
  _clear_authority_root_for_isolation
  test_source_recovery_retry_preserves_prior_unbound_evidence
  _clear_authority_root_for_isolation
  test_phase_owned_invariants_reject_unproved_states
  _clear_authority_root_for_isolation
  test_disposable_rehearsals_clean_and_assert_state_authority
  _clear_authority_root_for_isolation
  test_transient_systemd_fixture_independently_proves_identity_and_cursors
  _clear_authority_root_for_isolation
  test_writer_stop_evidence_is_retry_distinct
  _clear_authority_root_for_isolation
  test_invocation_suffixed_artifacts_cannot_collide_with_bound_inputs
  _clear_authority_root_for_isolation
  test_xdg_state_home_cross_root_execute_rejected

  _clear_authority_root_for_isolation
  test_bound_transition_inputs_are_pairwise_distinct
  _clear_authority_root_for_isolation
  test_invalid_complete_state_cannot_relinquish_durable_authority
  _clear_authority_root_for_isolation
  test_durable_authority_reclaims_complete_or_missing_state
  _clear_authority_root_for_isolation
  test_corrupt_phase_durable_state_rejected
  _clear_authority_root_for_isolation
  test_cli_rejects_duplicate_or_mixed_modes

  _clear_authority_root_for_isolation
  test_execution_environment_removes_all_ambient_docker_compose_behavior
  _clear_authority_root_for_isolation
  test_durable_authority_rejects_runtime_backed_state_home
  _clear_authority_root_for_isolation
  test_bound_inputs_and_publication_reject_unsafe_write_modes
  _clear_authority_root_for_isolation
  test_incident_classes_and_stop_proofs_are_closed_world
  _clear_authority_root_for_isolation
  test_real_docker_rehearsal_declares_interruption_resume_coverage
  _clear_authority_root_for_isolation
  test_activation_uses_only_bound_compose_interpolation_values
  _clear_authority_root_for_isolation
  test_authorization_postprocessing_failure_closes_writer_durably
  _clear_authority_root_for_isolation
  test_authorization_postprocessing_ordinary_failure_is_fail_closed
  _clear_authority_root_for_isolation
  test_closure_postprocessing_proof_exception_is_scoped
  _clear_authority_root_for_isolation
  test_phase_state_fsync_failure_does_not_advance
  _clear_authority_root_for_isolation
  test_writer_stop_evidence_fsync_failure_is_not_bound
  _clear_authority_root_for_isolation
  test_late_authorization_evidence_failure_remains_resumable
  _clear_authority_root_for_isolation
  test_closure_intent_failure_preserves_status_and_blocks_reauthorization
  _clear_authority_root_for_isolation
  test_initial_activation_inspect_failure_commits_durable_closure
  _clear_authority_root_for_isolation
  test_compose_publication_is_anchored_against_ancestor_retarget
  _clear_authority_root_for_isolation
  test_simulated_root_rejects_root_owned_writable_compose_parent
  _clear_authority_root_for_isolation
  test_foreign_owned_compose_parents_are_rejected
  _clear_authority_root_for_isolation
  test_preopen_parent_retarget_cannot_substitute_publication_identity
  _clear_authority_root_for_isolation
  test_candidate_entry_swap_cannot_escape_prepared_digest
  _clear_authority_root_for_isolation
  test_closure_intent_and_stop_failure_cannot_cross_writer_boundary
  _clear_authority_root_for_isolation
  test_fresh_activation_recovery_stops_before_phase_owned_proof_validation
  _clear_authority_root_for_isolation
  test_fresh_activation_stop_failure_persists_closure_intent
  _clear_authority_root_for_isolation
  test_detached_target_parent_cannot_false_complete_publication
  _clear_authority_root_for_isolation
  test_postrename_fsync_failure_cannot_expose_advanced_publications
  _clear_authority_root_for_isolation
  test_verification_url_requires_a_local_ipv4_interface
  echo 'PostgreSQL transition controller focused fixtures passed.'
fi
