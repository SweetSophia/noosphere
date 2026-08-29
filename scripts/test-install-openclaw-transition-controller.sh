#!/bin/bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALLER="$ROOT_DIR/install-openclaw.sh"

source "$INSTALLER"

fail() {
  printf 'installer controller fixture: %s\n' "$*" >&2
  exit 1
}

require_function() {
  declare -F "$1" >/dev/null || fail "required installer function is missing: $1"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

write_fake_docker() {
  local target=$1 plugin=$2
  cat > "$target" <<'SH'
#!/bin/bash
set -Eeuo pipefail
plugin=${FIXTURE_COMPOSE_PLUGIN:?}
[[ -z ${FIXTURE_DOCKER_LOG:-} ]] || printf '%s\n' "$*" >> "$FIXTURE_DOCKER_LOG"
if [[ ${1:-} == context && ${2:-} == show ]]; then
  printf 'fixture\n'
  exit 0
fi
if [[ ${1:-} == context && ${2:-} == inspect ]]; then
  printf 'unix:///fixture/docker.sock\n'
  exit 0
fi
if [[ ${1:-} == info && ${2:-} == --format ]]; then
  case ${3:-} in
    '{{.ID}}') printf 'fixture-engine\n' ;;
    '{{.OSType}}/{{.Architecture}}') printf 'linux/amd64\n' ;;
    '{{json .ClientInfo.Plugins}}') printf '[{"Name":"compose","Path":"%s"}]\n' "$plugin" ;;
    *) printf 'unsupported info format: %s\n' "${3:-}" >&2; exit 1 ;;
  esac
  exit 0
fi
if [[ ${1:-} == compose && ${2:-} == version && ${3:-} == --short ]]; then
  [[ -z ${COMPOSE_FILE+x} ]]
  [[ -z ${COMPOSE_PROFILES+x} ]]
  [[ -z ${DOCKER_CONTEXT+x} ]]
  [[ ${COMPOSE_DISABLE_ENV_FILE:-} == 1 ]]
  [[ ${DOCKER_HOST:-} == unix:///fixture/docker.sock ]]
  [[ -z ${NOOSPHERE_A2B_LOCK_FD+x} ]]
  [[ -z ${NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE+x} ]]
  printf 'v2.fixture\n'
  exit 0
fi
if [[ ${1:-} == compose ]]; then
  [[ ${!#:-} != pull ]] || exit 0
  if [[ " $* " == *' config '* ]]; then
    [[ -z ${COMPOSE_FILE+x} ]]
    [[ -z ${COMPOSE_PROFILES+x} ]]
    [[ -z ${DOCKER_CONTEXT+x} ]]
    [[ ${COMPOSE_DISABLE_ENV_FILE:-} == 1 ]]
    [[ ${DOCKER_HOST:-} == unix:///fixture/docker.sock ]]
  fi
  printf 'fixture-effective-compose-model\n'
  exit 0
fi
printf 'unsupported fake Docker invocation: %s\n' "$*" >&2
exit 1
SH
  chmod 0700 "$target"
  printf '#!/bin/sh\nexit 0\n' > "$plugin"
  chmod 0700 "$plugin"
}

write_controller_stub() {
  local target=$1
  cat > "$target" <<'SH'
#!/bin/bash
set -Eeuo pipefail
systemd_properties() {
  local working_directory=$1
  printf '%s\n' Type=exec RemainAfterExit=no Restart=no KillMode=mixed \
    TimeoutStartSec=infinity TimeoutStopSec=infinity RuntimeMaxSec=infinity \
    UMask=0077 "WorkingDirectory=$working_directory"
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  printf '%s\n' "$*" >> "${FIXTURE_CONTROLLER_LOG:?}"
  case ${1:-} in
    --prepare)
      manifest=''; state=''
      while (($#)); do
        case $1 in
          --manifest) manifest=$2; shift 2 ;;
          --state) state=$2; shift 2 ;;
          *) shift ;;
        esac
      done
      install -m 600 "$manifest" "$state"
      ;;
    --execute)
      state=''
      while (($#)); do
        case $1 in
          --state) state=$2; shift 2 ;;
          *) shift ;;
        esac
      done
      jq --arg phase "${FIXTURE_EXECUTION_PHASE:-complete}" '.phase = $phase' "$state" > "$state.next"
      install -m 600 "$state.next" "$state"
      rm -f "$state.next"
      exit "${FIXTURE_EXECUTION_EXIT:-0}"
      ;;
    *) exit 1 ;;
  esac
fi
SH
  chmod 0700 "$target"
}

write_systemd_shims() {
  local bin=$1
  cat > "$bin/systemctl" <<'SH'
#!/bin/sh
case "$*" in
  *show-environment*) exit 0 ;;
  *" -p LoadState --value"*) printf '%s\n' "${FIXTURE_SYSTEMD_LOAD_STATE:-not-found}"; exit 0 ;;
esac
exit 1
SH
  cat > "$bin/loginctl" <<'SH'
#!/bin/sh
printf 'yes\n'
SH
  cat > "$bin/systemd-run" <<'SH'
#!/bin/bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${FIXTURE_SYSTEMD_LOG:?}"
while (($#)); do
  case $1 in
    --*) shift ;;
    *) break ;;
  esac
done
"$@"
SH
  chmod 0700 "$bin/systemctl" "$bin/loginctl" "$bin/systemd-run"
}

test_controller_artifacts_are_checksum_pinned_and_private() (
  local fixture root
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_BACKUP_DIR="$NOOSPHERE_HOME/backups/postgres-pgvector"
  mkdir -m 700 "$NOOSPHERE_HOME"

  require_function prepare_postgres_controller_runtime
  prepare_postgres_controller_runtime

  root="$NOOSPHERE_HOME/postgres-transition-controller"
  [[ $(stat -c '%a' "$root") == 700 ]]
  [[ $(stat -c '%a' "$POSTGRES_CONTROLLER_HOME") == 700 ]]
  [[ $(stat -c '%a' "$POSTGRES_CONTROLLER_HOME/docker") == 700 ]]
  [[ $(stat -c '%a' "$POSTGRES_CONTROLLER_HOME/docker/config.json") == 600 ]]
  [[ $(stat -c '%a' "$POSTGRES_CONTROLLER_SCRIPT") == 700 ]]
  [[ $(stat -c '%a' "$POSTGRES_SWITCH_SCRIPT") == 700 ]]
  [[ $(stat -c '%a' "$POSTGRES_VERIFY_SCRIPT") == 700 ]]
  [[ $(sha256_file "$POSTGRES_CONTROLLER_SCRIPT") == "$POSTGRES_CONTROLLER_SCRIPT_SHA256" ]]
  [[ $(sha256_file "$POSTGRES_SWITCH_SCRIPT") == "$POSTGRES_SWITCH_SCRIPT_SHA256" ]]
  [[ $(sha256_file "$POSTGRES_VERIFY_SCRIPT") == "$POSTGRES_VERIFY_SCRIPT_SHA256" ]]
  [[ $(<"$POSTGRES_CONTROLLER_HOME/docker/config.json") == '{}' ]]
)

test_artifact_mismatch_preserves_existing_private_targets() (
  local fixture label source expected target mutated
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  NOOSPHERE_HOME="$fixture/home"
  mkdir -m 700 "$NOOSPHERE_HOME"

  while IFS='|' read -r label source expected; do
    target="$fixture/$label.installed"
    mutated="$fixture/$label.mutated"
    install -m 700 "$source" "$target"
    cp "$source" "$mutated"
    printf '\n# fixture byte mismatch\n' >> "$mutated"
    if (
      prepare_guard_script "scripts/fixture-missing-$label" "file://$mutated" "$expected" "$target"
    ) >/dev/null 2>&1; then
      fail "$label checksum mismatch was accepted"
    fi
    cmp -s "$source" "$target" || fail "$label mismatch replaced the existing private target"
    [[ $(stat -c '%a' "$target") == 700 ]]
  done <<EOF
controller|$ROOT_DIR/scripts/run-pgvector-transition-controller.sh|$POSTGRES_CONTROLLER_SCRIPT_SHA256
guard|$ROOT_DIR/scripts/switch-pgvector-compose.sh|$POSTGRES_SWITCH_SCRIPT_SHA256
verifier|$ROOT_DIR/scripts/verify-deploy.sh|$POSTGRES_VERIFY_SCRIPT_SHA256
EOF
)

test_manifest_binds_installer_transition_inputs() (
  local fixture bin plugin live source candidate env docker_host
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  bin="$fixture/bin"
  mkdir -m 700 "$bin" "$fixture/runtime"
  plugin="$fixture/docker-compose"
  write_fake_docker "$bin/docker" "$plugin"
  export FIXTURE_COMPOSE_PLUGIN=$plugin
  PATH="$bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="$fixture/runtime"
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_BACKUP_DIR="$NOOSPHERE_HOME/backups/postgres-pgvector"
  mkdir -m 700 "$NOOSPHERE_HOME"

  require_function prepare_postgres_controller_runtime
  require_function write_postgres_controller_manifest
  prepare_postgres_controller_runtime

  live="$NOOSPHERE_HOME/docker-compose.yml"
  source="$POSTGRES_CONTROLLER_ROOT/source-compose.yml"
  candidate="$POSTGRES_CONTROLLER_ROOT/candidate-compose.yml"
  env="$NOOSPHERE_HOME/.env"
  printf 'services:\n  db:\n    image: source\n' > "$live"
  printf 'services:\n  db:\n    image: source\n' > "$source"
  printf 'services:\n  db:\n    image: candidate\n' > "$candidate"
  printf 'APP_URL=http://192.0.2.10:6578\n' > "$env"
  chmod 0600 "$live" "$source" "$candidate" "$env"
  BIND_ADDRESS=192.0.2.10
  NOOSPHERE_PORT=6578
  export COMPOSE_FILE=/fixture/ambient-compose.yml
  export COMPOSE_PROFILES=ambient-profile
  export DOCKER_CONTEXT=ambient-context
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE=guard-exited

  write_postgres_controller_manifest

  [[ $(stat -c '%a' "$POSTGRES_CONTROLLER_MANIFEST") == 600 ]]
  jq -e \
    --arg live "$live" \
    --arg source "$source" \
    --arg candidate "$candidate" \
    --arg env "$env" \
    --arg controller "$POSTGRES_CONTROLLER_SCRIPT" \
    --arg guard "$POSTGRES_SWITCH_SCRIPT" \
    --arg verifier "$POSTGRES_VERIFY_SCRIPT" '
      .version == 1 and .phase == "prepared" and
      .engineId == "fixture-engine" and
      .dockerEndpoint == "unix:///fixture/docker.sock" and
      .volume == "noosphere_postgres_data" and
      .authorizationVolume == "noosphere_postgres_authorization" and
      .liveCompose == $live and .sourceSnapshot == $source and
      .candidateCompose == $candidate and .envFile == $env and
      .controllerPath == $controller and .guard == $guard and .verifier == $verifier and
      .appUrl == "http://192.0.2.10:6578" and .platform == "linux/amd64" and
      (.guardArgs | index("--defer-app-restart") != null)
    ' "$POSTGRES_CONTROLLER_MANIFEST" >/dev/null
  [[ $(jq -r '.sourceSnapshotSha256' "$POSTGRES_CONTROLLER_MANIFEST") == "$(sha256_file "$source")" ]]
  [[ $(jq -r '.candidateComposeSha256' "$POSTGRES_CONTROLLER_MANIFEST") == "$(sha256_file "$candidate")" ]]
  [[ $(jq -r '.envFileSha256' "$POSTGRES_CONTROLLER_MANIFEST") == "$(sha256_file "$env")" ]]
)

test_interrupted_controller_rerun_reuses_bound_state() (
  local fixture bin manifest state controller first_rc=0 prepare_count
  fixture=$(mktemp -d)
  trap 'exec 8>&- 2>/dev/null || true; rm -rf "$fixture"' EXIT
  bin="$fixture/bin"
  mkdir -m 700 "$bin" "$fixture/home" "$fixture/runtime"
  write_systemd_shims "$bin"
  controller="$fixture/home/controller"
  write_controller_stub "$controller"
  manifest="$fixture/home/manifest.json"
  state="$fixture/home/state.json"
  printf '{"version":1,"phase":"prepared","liveCompose":"%s"}\n' "$fixture/home/docker-compose.yml" > "$manifest"
  chmod 0600 "$manifest"
  : > "$fixture/controller.log"
  : > "$fixture/systemd.log"
  export FIXTURE_CONTROLLER_LOG="$fixture/controller.log"
  export FIXTURE_SYSTEMD_LOG="$fixture/systemd.log"
  PATH="$bin:/usr/bin:/bin"
  POSTGRES_CONTROLLER_SCRIPT=$controller
  POSTGRES_CONTROLLER_MANIFEST=$manifest
  POSTGRES_CONTROLLER_STATE=$state
  NOOSPHERE_HOME="$fixture/home"
  XDG_STATE_HOME="$fixture/home/state"
  export XDG_STATE_HOME
  exec 8>"$fixture/runtime/operation.lock"
  flock -n 8
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_A2B_LOCK_PATH="$fixture/runtime/operation.lock"

  require_function run_existing_postgres_controller_transition
  export FIXTURE_SYSTEMD_LOAD_STATE=loaded
  first_rc=0
  run_existing_postgres_controller_transition || first_rc=$?
  [[ $first_rc != 0 ]]
  [[ $(jq -r '.phase' "$state") == prepared ]]
  [[ ! -s "$fixture/systemd.log" ]]

  exec 8>"$fixture/runtime/operation.lock"
  flock -n 8
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_A2B_LOCK_PATH="$fixture/runtime/operation.lock"
  export FIXTURE_SYSTEMD_LOAD_STATE=not-found
  export FIXTURE_EXECUTION_PHASE=guard-exited
  export FIXTURE_EXECUTION_EXIT=143
  run_existing_postgres_controller_transition || first_rc=$?
  [[ $first_rc == 143 ]]
  [[ $(jq -r '.phase' "$state") == guard-exited ]]
  [[ -z ${NOOSPHERE_A2B_LOCK_FD:-} && -z ${NOOSPHERE_A2B_LOCK_PATH:-} ]]
  prepare_count=$(grep -c '^--prepare ' "$fixture/controller.log")
  [[ $prepare_count == 1 ]]

  exec 8>"$fixture/runtime/operation.lock"
  flock -n 8
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_A2B_LOCK_PATH="$fixture/runtime/operation.lock"
  export FIXTURE_EXECUTION_PHASE=complete
  export FIXTURE_EXECUTION_EXIT=0
  run_existing_postgres_controller_transition
  [[ $(jq -r '.phase' "$state") == complete ]]
  [[ $(grep -c '^--prepare ' "$fixture/controller.log") == 1 ]]
  [[ $(grep -c '^--execute ' "$fixture/controller.log") == 2 ]]
  grep -F -- '--property=Type=exec' "$fixture/systemd.log" >/dev/null
  grep -F -- "--property=WorkingDirectory=$NOOSPHERE_HOME" "$fixture/systemd.log" >/dev/null
)

test_new_install_bypasses_transition_controller() (
  local fixture guard
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  guard="$fixture/guard"
  cat > "$guard" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "${FIXTURE_GUARD_LOG:?}"
SH
  chmod 0700 "$guard"
  : > "$fixture/guard.log"
  export FIXTURE_GUARD_LOG="$fixture/guard.log"
  existing_switch_required=false
  new_install_required=true
  controller_transition_completed=false
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_BACKUP_DIR="$NOOSPHERE_HOME/backups/postgres-pgvector"
  POSTGRES_SWITCH_SCRIPT=$guard
  mkdir -p "$NOOSPHERE_HOME"
  : > "$NOOSPHERE_HOME/.env"

  assert_postgres_controller_bootstrap_node() { fail 'new install reached controller bootstrap preflight'; }
  write_postgres_controller_manifest() { fail 'new install generated a controller manifest'; }
  run_existing_postgres_controller_transition() { fail 'new install executed the transition controller'; }
  route_postgres_install_transition

  [[ "$controller_transition_completed" == false ]]
  [[ $(grep -c -- '--prepare-new-install' "$fixture/guard.log") == 1 ]]
  grep -F -- "--compose-file $NOOSPHERE_HOME/docker-compose.yml" "$fixture/guard.log" >/dev/null
  grep -F -- "--backup-dir $POSTGRES_BACKUP_DIR" "$fixture/guard.log" >/dev/null
)

test_complete_controller_state_requires_guard_closure() (
  local fixture evidence evidence_sha rc
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  POSTGRES_CONTROLLER_STATE="$fixture/state.json"
  POSTGRES_BACKUP_DIR="$fixture/backups"
  mkdir -m 700 "$POSTGRES_BACKUP_DIR"
  printf '{"phase":"complete"}\n' > "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"

  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'complete controller state passed without durable switch closure evidence'

  evidence="$POSTGRES_BACKUP_DIR/noosphere_postgres_data.phase-a2b.json"
  printf '{"mode":"switch","phase":"guard-exited"}\n' > "$evidence"
  chmod 0600 "$evidence"
  evidence_sha=$(sha256_file "$evidence")
  jq -n --arg path "$evidence" --arg sha "$evidence_sha" \
    '{phase:"complete",guardJournalEvidence:{path:$path,sha256:$sha,phase:"complete"}}' \
    > "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'complete controller state passed with incomplete guard closure evidence'

  printf '{"mode":"switch","phase":"complete"}\n' > "$evidence"
  evidence_sha=$(sha256_file "$evidence")
  jq -n --arg path "$evidence" --arg sha "$evidence_sha" \
    '{phase:"complete",guardJournalEvidence:{path:$path,sha256:$sha,phase:"complete"}}' \
    > "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"

  jq --arg path "$fixture/other-guard.json" '.guardJournalEvidence.path=$path' \
    "$POSTGRES_CONTROLLER_STATE" > "$fixture/state.tmp"
  mv "$fixture/state.tmp" "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'complete controller state passed with a different guard-journal path'

  jq --arg path "$evidence" --arg sha "$(printf mismatch | sha256sum | awk '{print $1}')" \
    '.guardJournalEvidence.path=$path | .guardJournalEvidence.sha256=$sha' \
    "$POSTGRES_CONTROLLER_STATE" > "$fixture/state.tmp"
  mv "$fixture/state.tmp" "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'complete controller state passed with a mismatched guard-journal digest'

  jq --arg sha "$evidence_sha" '.guardJournalEvidence.sha256=$sha' \
    "$POSTGRES_CONTROLLER_STATE" > "$fixture/state.tmp"
  mv "$fixture/state.tmp" "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  chmod 0666 "$evidence"
  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'complete controller state passed with writable guard closure evidence'

  chmod 0600 "$evidence"
  chmod 0666 "$POSTGRES_CONTROLLER_STATE"
  rc=0
  reconcile_postgres_controller_before_configuration || rc=$?
  [[ $rc != 0 ]] || fail 'writable complete controller state passed early reconciliation'

  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  controller_transition_completed=false
  reacquire_postgres_operation_lock_from_manifest() { :; }
  reconcile_postgres_controller_before_configuration
  [[ "$controller_transition_completed" == true ]]
)

write_complete_controller_reconciliation_fixture() {
  local fixture=$1 docker_endpoint=$2 engine_id=$3 lock_root=$4 evidence evidence_sha
  POSTGRES_CONTROLLER_STATE="$fixture/state.json"
  POSTGRES_CONTROLLER_MANIFEST="$fixture/manifest.json"
  POSTGRES_BACKUP_DIR="$fixture/backups"
  mkdir -m 700 "$POSTGRES_BACKUP_DIR" "$lock_root"
  evidence="$POSTGRES_BACKUP_DIR/noosphere_postgres_data.phase-a2b.json"
  printf '{"mode":"switch","phase":"complete"}\n' > "$evidence"
  chmod 0600 "$evidence"
  evidence_sha=$(sha256_file "$evidence")
  jq -n --arg path "$evidence" --arg sha "$evidence_sha" \
    '{phase:"complete",guardJournalEvidence:{path:$path,sha256:$sha,phase:"complete"}}' \
    > "$POSTGRES_CONTROLLER_STATE"
  jq -n --arg dockerEndpoint "$docker_endpoint" --arg engineId "$engine_id" --arg lockRoot "$lock_root" \
    '{dockerEndpoint:$dockerEndpoint,engineId:$engineId,lockRoot:$lockRoot}' \
    > "$POSTGRES_CONTROLLER_MANIFEST"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE" "$POSTGRES_CONTROLLER_MANIFEST"
}

test_complete_reconciliation_reacquires_manifest_operation_lock() (
  local fixture expected_lock_key expected_lock_path
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  XDG_RUNTIME_DIR="$fixture/runtime"
  write_complete_controller_reconciliation_fixture \
    "$fixture" unix:///fixture/docker.sock fixture-engine "$XDG_RUNTIME_DIR"
  controller_transition_completed=false
  resolve_local_docker_endpoint() { printf 'unix:///fixture/docker.sock\n'; }
  docker() { printf 'fixture-engine\n'; }

  reconcile_postgres_controller_before_configuration

  expected_lock_key=$(printf '%s\0%s' fixture-engine noosphere_postgres_data | sha256sum | awk '{print $1}')
  expected_lock_path="$XDG_RUNTIME_DIR/noosphere-pgvector-switch-$expected_lock_key.lock"
  [[ "$controller_transition_completed" == true ]]
  [[ ${NOOSPHERE_A2B_LOCK_PATH:-} == "$expected_lock_path" ]]
  if flock -n "$expected_lock_path" -c true; then
    fail 'complete reconciliation did not retain the manifest operation lock'
  fi
)

test_complete_reconciliation_rejects_manifest_engine_drift() (
  local fixture rc=0
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  XDG_RUNTIME_DIR="$fixture/runtime"
  write_complete_controller_reconciliation_fixture \
    "$fixture" unix:///fixture/docker.sock manifest-engine "$XDG_RUNTIME_DIR"
  controller_transition_completed=false
  resolve_local_docker_endpoint() { printf 'unix:///fixture/docker.sock\n'; }
  docker() { printf 'current-engine\n'; }

  acquire_postgres_operation_lock
  reconcile_postgres_controller_before_configuration || rc=$?

  [[ $rc != 0 ]]
  [[ "$controller_transition_completed" == false ]]
)

test_complete_reconciliation_rejects_manifest_lock_root_drift() (
  local fixture manifest_lock_root rc=0
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  XDG_RUNTIME_DIR="$fixture/current-runtime"
  manifest_lock_root="$fixture/manifest-runtime"
  write_complete_controller_reconciliation_fixture \
    "$fixture" unix:///fixture/docker.sock fixture-engine "$manifest_lock_root"
  mkdir -m 700 "$XDG_RUNTIME_DIR"
  controller_transition_completed=false
  resolve_local_docker_endpoint() { printf 'unix:///fixture/docker.sock\n'; }
  docker() { printf 'fixture-engine\n'; }

  acquire_postgres_operation_lock
  reconcile_postgres_controller_before_configuration || rc=$?

  [[ $rc != 0 ]]
  [[ "$controller_transition_completed" == false ]]
)

test_existing_upgrade_routes_through_controller() (
  local fixture bin plugin trace
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  bin="$fixture/bin"
  mkdir -m 700 "$bin" "$fixture/home" "$fixture/runtime"
  plugin="$fixture/docker-compose"
  write_fake_docker "$bin/docker" "$plugin"
  export FIXTURE_COMPOSE_PLUGIN=$plugin
  export FIXTURE_DOCKER_LOG="$fixture/docker.log"
  PATH="$bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="$fixture/runtime"
  trace="$fixture/trace.log"
  : > "$trace"
  existing_switch_required=true
  new_install_required=false
  controller_transition_completed=false
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_CONTROLLER_CANDIDATE="$NOOSPHERE_HOME/candidate-compose.yml"
  POSTGRES_CONTROLLER_MANIFEST="$NOOSPHERE_HOME/manifest.json"
  : > "$NOOSPHERE_HOME/.env"
  : > "$POSTGRES_CONTROLLER_CANDIDATE"

  assert_postgres_controller_bootstrap_node() { printf 'bootstrap\n' >> "$trace"; }
  resolve_local_docker_endpoint() { printf 'unix:///fixture/docker.sock\n'; }
  provision_existing_postgres_roles_for_controller() { printf 'provision\n' >> "$trace"; }
  write_postgres_controller_manifest() {
    printf 'manifest\n' >> "$trace"
    jq -n --arg lockRoot "$XDG_RUNTIME_DIR" \
      '{dockerEndpoint:"unix:///fixture/docker.sock",engineId:"fixture-engine",lockRoot:$lockRoot}' \
      > "$POSTGRES_CONTROLLER_MANIFEST"
    chmod 0600 "$POSTGRES_CONTROLLER_MANIFEST"
  }
  run_existing_postgres_controller_transition() { printf 'controller\n' >> "$trace"; }
  route_postgres_install_transition

  [[ "$controller_transition_completed" == true ]]
  [[ $(paste -sd, "$trace") == bootstrap,provision,manifest,controller ]]
  grep -F -- "compose --project-directory $NOOSPHERE_HOME --env-file $NOOSPHERE_HOME/.env -f $POSTGRES_CONTROLLER_CANDIDATE pull" \
    "$fixture/docker.log" >/dev/null
)

test_existing_upgrade_reacquires_operation_lock() (
  local fixture bin plugin expected_lock_path
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  bin="$fixture/bin"
  mkdir -m 700 "$bin" "$fixture/home" "$fixture/runtime"
  plugin="$fixture/docker-compose"
  write_fake_docker "$bin/docker" "$plugin"
  export FIXTURE_COMPOSE_PLUGIN=$plugin
  export FIXTURE_DOCKER_LOG="$fixture/docker.log"
  PATH="$bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="$fixture/runtime"
  existing_switch_required=true
  new_install_required=false
  controller_transition_completed=false
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_CONTROLLER_CANDIDATE="$NOOSPHERE_HOME/candidate-compose.yml"
  POSTGRES_CONTROLLER_MANIFEST="$NOOSPHERE_HOME/manifest.json"
  : > "$NOOSPHERE_HOME/.env"
  : > "$POSTGRES_CONTROLLER_CANDIDATE"

  assert_postgres_controller_bootstrap_node() { :; }
  resolve_local_docker_endpoint() { printf 'unix:///fixture/docker.sock\n'; }
  write_postgres_controller_manifest() {
    jq -n --arg lockRoot "$XDG_RUNTIME_DIR" \
      '{dockerEndpoint:"unix:///fixture/docker.sock",engineId:"fixture-engine",lockRoot:$lockRoot}' \
      > "$POSTGRES_CONTROLLER_MANIFEST"
    chmod 0600 "$POSTGRES_CONTROLLER_MANIFEST"
  }
  run_existing_postgres_controller_transition() {
    release_postgres_operation_lock
  }

  acquire_postgres_operation_lock
  expected_lock_path=$NOOSPHERE_A2B_LOCK_PATH
  route_postgres_install_transition

  [[ "$controller_transition_completed" == true ]]
  [[ -n ${NOOSPHERE_A2B_LOCK_FD:-} ]]
  [[ ${NOOSPHERE_A2B_LOCK_PATH:-} == "$expected_lock_path" ]]
  if flock -n "$expected_lock_path" -c true; then
    fail 'competing installer acquired the operation lock after controller completion'
  fi
)

test_existing_upgrade_rejects_lock_identity_change() (
  local fixture bin plugin expected_lock_path rc=0
  fixture=$(mktemp -d)
  trap 'release_postgres_operation_lock >/dev/null 2>&1 || true; rm -rf "$fixture"' EXIT
  bin="$fixture/bin"
  mkdir -m 700 "$bin" "$fixture/home" "$fixture/runtime"
  plugin="$fixture/docker-compose"
  write_fake_docker "$bin/docker" "$plugin"
  export FIXTURE_COMPOSE_PLUGIN=$plugin
  export FIXTURE_DOCKER_LOG="$fixture/docker.log"
  PATH="$bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="$fixture/runtime"
  existing_switch_required=true
  new_install_required=false
  controller_transition_completed=false
  NOOSPHERE_HOME="$fixture/home"
  POSTGRES_CONTROLLER_CANDIDATE="$NOOSPHERE_HOME/candidate-compose.yml"
  POSTGRES_CONTROLLER_MANIFEST="$NOOSPHERE_HOME/manifest.json"
  : > "$NOOSPHERE_HOME/.env"
  : > "$POSTGRES_CONTROLLER_CANDIDATE"
  FIXTURE_DOCKER_ENDPOINT=unix:///fixture/docker.sock

  assert_postgres_controller_bootstrap_node() { :; }
  resolve_local_docker_endpoint() { printf '%s\n' "$FIXTURE_DOCKER_ENDPOINT"; }
  write_postgres_controller_manifest() {
    jq -n --arg lockRoot "$XDG_RUNTIME_DIR" \
      '{dockerEndpoint:"unix:///fixture/docker.sock",engineId:"fixture-engine",lockRoot:$lockRoot}' \
      > "$POSTGRES_CONTROLLER_MANIFEST"
    chmod 0600 "$POSTGRES_CONTROLLER_MANIFEST"
  }
  run_existing_postgres_controller_transition() {
    release_postgres_operation_lock
    FIXTURE_DOCKER_ENDPOINT=unix:///fixture/changed.sock
  }

  acquire_postgres_operation_lock
  expected_lock_path=$NOOSPHERE_A2B_LOCK_PATH
  route_postgres_install_transition || rc=$?

  [[ $rc != 0 ]]
  [[ "$controller_transition_completed" == false ]]
  [[ -z ${NOOSPHERE_A2B_LOCK_FD:-} && -z ${NOOSPHERE_A2B_LOCK_PATH:-} ]]
  flock -n "$expected_lock_path" -c true
)

test_nonterminal_reconciliation_marks_controller_completion() (
  local fixture
  fixture=$(mktemp -d)
  trap 'rm -rf "$fixture"' EXIT
  POSTGRES_CONTROLLER_STATE="$fixture/state.json"
  printf '{"phase":"prepared"}\n' > "$POSTGRES_CONTROLLER_STATE"
  chmod 0600 "$POSTGRES_CONTROLLER_STATE"
  controller_transition_completed=false

  assert_postgres_controller_bootstrap_node() { :; }
  run_existing_postgres_controller_transition() { :; }
  reacquire_postgres_operation_lock_from_manifest() { :; }

  reconcile_postgres_controller_before_configuration
  [[ "$controller_transition_completed" == true ]]
)

main() {
  test_controller_artifacts_are_checksum_pinned_and_private
  test_artifact_mismatch_preserves_existing_private_targets
  test_manifest_binds_installer_transition_inputs
  test_interrupted_controller_rerun_reuses_bound_state
  test_new_install_bypasses_transition_controller
  test_complete_controller_state_requires_guard_closure
  test_complete_reconciliation_reacquires_manifest_operation_lock
  test_complete_reconciliation_rejects_manifest_engine_drift
  test_complete_reconciliation_rejects_manifest_lock_root_drift
  test_existing_upgrade_routes_through_controller
  test_existing_upgrade_reacquires_operation_lock
  test_existing_upgrade_rejects_lock_identity_change
  test_nonterminal_reconciliation_marks_controller_completion
  printf 'OpenClaw installer transition-controller fixtures passed.\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
