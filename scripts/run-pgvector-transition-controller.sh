#!/bin/bash -p
set -Eeuo pipefail

# Bootstrap without consulting the ambient user-manager PATH. The prepared
# fixedPath is validated and installed later, but no interpreter or utility
# may be selected from inherited state before that boundary.
readonly CONTROLLER_BOOTSTRAP_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
PATH=$CONTROLLER_BOOTSTRAP_PATH
export PATH

# Resolve once when the file is loaded. This remains the controller file even
# when the focused/systemd fixtures source it through a small identity shim.
CONTROLLER_EXECUTABLE_PATH=$(realpath "${BASH_SOURCE[0]}")

# This controller is intentionally separate from switch-pgvector-compose.sh.
# The pinned guard remains the only database, authorization, and transition-
# journal mutator. This file owns only the outer process/evidence transaction.

die() {
  printf 'PostgreSQL transition controller: %s\n' "$*" >&2
  exit 1
}

path_present() {
  [[ -e "$1" || -L "$1" ]]
}

assert_owned_regular_file() {
  local path=$1 mode
  [[ -f "$path" && ! -L "$path" ]] || die "required file is missing or unsafe: $path"
  [[ $(stat -c '%u' "$path") == "$(id -u)" ]] || die "required file is not owned by the current user: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 8#022) == 0 )) || die "required file permits group/world writes: $path"
}

assert_owned_private_directory() {
  local path=$1 mode
  [[ -d "$path" && ! -L "$path" ]] || die "required private directory is missing or unsafe: $path"
  [[ $(stat -c '%u' "$path") == "$(id -u)" ]] || die "private directory is not owned by the current user: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 8#077) == 0 )) || die "private directory permits group/world access: $path"
}

assert_trusted_fixed_path() {
  local fixed_path=$1 component resolved mode alias_owner
  local -a components=()
  IFS=: read -r -a components <<< "$fixed_path"
  ((${#components[@]} > 0)) || die 'fixed PATH is empty'
  for component in "${components[@]}"; do
    [[ "$component" == /* ]] || die "fixed PATH component is not absolute: $component"
    resolved=$(realpath -e "$component" 2>/dev/null) ||
      die "fixed PATH component is unavailable: $component"
    if [[ -L "$component" ]]; then
      alias_owner=$(stat -c '%u' "$component")
      [[ "$alias_owner" == 0 ]] ||
        die "fixed PATH component is a mutable non-root symlink alias: $component"
    fi
    [[ -d "$resolved" ]] || die "fixed PATH component is not a directory: $component"
    [[ $(stat -c '%u' "$resolved") == 0 ]] ||
      die "fixed PATH component is not root-owned: $component"
    mode=$(stat -c '%a' "$resolved")
    (( (8#$mode & 8#022) == 0 )) ||
      die "fixed PATH component permits group/world writes: $component"
  done
}

fsync_path() {
  node -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

write_controller_state_atomic() {
  local target=$1 source=$2 temp
  controller_state_write_active=true
  assert_owned_regular_file "$source"
  if path_present "$target"; then
    assert_owned_regular_file "$target"
    [[ $(stat -c '%a' "$target") == 600 ]] || die 'controller state mode must be 0600'
  fi
  jq -e 'type == "object" and (.phase | type == "string")' "$source" >/dev/null ||
    die 'controller state must contain one phased JSON object'
  temp=$(mktemp "${target}.tmp.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  install -m 600 "$source" "$temp"
  fsync_path "$temp"
  mv -f "$temp" "$target"
  fsync_path "$(dirname "$target")"
  trap - RETURN
  controller_state_write_active=false
  if [[ ${controller_interruption_pending:-false} == true &&
        -n ${controller_state:-} && "$target" == "$controller_state" ]]; then
    controller_interruption_pending=false
    record_controller_interruption "$controller_signal"
  fi
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

validate_controller_state() {
  local state=$1 proof_phase proof_class
  assert_owned_regular_file "$state"
  [[ $(stat -c '%a' "$state") == 600 ]] || die 'controller state mode must be 0600'
  jq -e '
    type == "object" and
    .version == 1 and
    (.phase == "prepared" or
     .phase == "candidate-published" or
     .phase == "source-recovery-running" or
     .phase == "guard-exited" or
     .phase == "authorization-running" or
     .phase == "activation-running" or
     .phase == "closure-running" or
     .phase == "closure-stop-pending" or
     .phase == "closure-evidence-pending" or
     .phase == "complete" or
     .phase == "incident") and
    (.engineId | type == "string" and length > 0) and
    (.dockerEndpoint | type == "string" and startswith("unix:///")) and
    (.volume | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and
    ((.volumeFingerprint == null) or
     (.volumeFingerprint | type == "string" and test("^[a-f0-9]{64}$"))) and
    ((.authorityRoot == null) or
     (.authorityRoot | type == "string" and startswith("/"))) and
    (.liveCompose | type == "string" and startswith("/")) and
    (.sourceSnapshot | type == "string" and startswith("/")) and
    (.sourceSnapshotSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.candidateComposeSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.guardJournal | type == "string" and startswith("/")) and
    if .phase == "complete" then
      (.guardEvidence.path | type == "string" and startswith("/")) and
      (.guardEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.authorizationEvidence.path | type == "string" and startswith("/")) and
      (.authorizationEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.closureEvidence.path | type == "string" and startswith("/")) and
      (.closureEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      (.guardJournalEvidence.path | type == "string" and startswith("/")) and
      (.guardJournalEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
      .guardJournalEvidence.phase == "complete"
    elif (.phase == "activation-running" or .phase == "closure-running") then
      (.authorizationEvidence.path | type == "string" and startswith("/")) and
      (.authorizationEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))
    elif (.phase == "closure-stop-pending" or .phase == "closure-evidence-pending" or .phase == "incident") then
      (.incidentClass | type == "string" and length > 0)
    else
      true
    end
  ' "$state" >/dev/null || die 'controller state is malformed'
  # Phase-owned proofs: every non-trivial phase carries evidence that its own
  # mechanism actually ran. Each requirement rejects with a key-specific
  # diagnostic so a mutation that strips one owned proof cannot pass silently.
  # (Kept inline so extraction-based reuse of this function stays self-contained.)
  proof_phase=$(jq -er '.phase' "$state")
  case "$proof_phase" in
    authorization-running|activation-running|closure-running)
      jq -e '(.guardEvidence.path | type == "string" and startswith("/")) and
             (.guardEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
        "$state" >/dev/null ||
        die "guardEvidence is required for phase $proof_phase but missing or malformed"
      validate_evidence_binding "$state" guardEvidence process
      ;;
  esac
  case "$proof_phase" in
    closure-stop-pending)
      jq -e '(.authorizationEvidence.path | type == "string" and startswith("/")) and
             (.authorizationEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
        "$state" >/dev/null ||
        die "authorizationEvidence is required for phase $proof_phase but missing or malformed"
      validate_evidence_binding "$state" authorizationEvidence process
      ;;
    closure-evidence-pending)
      jq -e '(.writerStopEvidence.path | type == "string" and startswith("/")) and
             (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
        "$state" >/dev/null ||
        die "writerStopEvidence is required for phase $proof_phase but missing or malformed"
      validate_evidence_binding "$state" writerStopEvidence process
      ;;
    closure-stop-pending|closure-evidence-pending|incident)
      proof_class=$(jq -er '.incidentClass // ""' "$state")
      case "$proof_class" in
        pre-journal-source-verification|pre-journal-source-restoration|pre-journal-source-restored|pre-journal-live-compose-divergence|closure-artifact-storage|closure-interruption|closure-writer-authorization|closure-app-activation|closure-postprocessing|closure-verification|closure-identity|closure-extension|closure-counts|closure-infrastructure|closure-app-health|isolated-app-health-requires-guard-revalidation) ;;
        *) die "incident class is unsupported or unrecognized: ${proof_class:-empty}" ;;
      esac
      ;;
  esac
  case "$proof_phase" in
    incident)
      case "$proof_class" in
        pre-journal-source-verification|pre-journal-source-restoration|pre-journal-source-restored|pre-journal-live-compose-divergence)
          jq -e '(.sourceRecoveryEvidence.path | type == "string" and startswith("/")) and
                 (.sourceRecoveryEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
            "$state" >/dev/null ||
            die "sourceRecoveryEvidence is required for incident class $proof_class but missing or malformed"
          validate_evidence_binding "$state" sourceRecoveryEvidence process
          ;;
        closure-*|isolated-app-health-requires-guard-revalidation)
          jq -e '(.writerStopEvidence.path | type == "string" and startswith("/")) and
                 (.writerStopEvidence.sha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
            "$state" >/dev/null ||
            die "writerStopEvidence is required for incident class $proof_class but missing or malformed"
          validate_evidence_binding "$state" writerStopEvidence process
          ;;
      esac
      ;;
  esac
  case "$proof_phase" in
    activation-running|closure-running)
      validate_evidence_binding "$state" authorizationEvidence process
      ;;
  esac
  if [[ "$proof_phase" == complete ]]; then
    validate_evidence_binding "$state" guardEvidence process
    validate_evidence_binding "$state" authorizationEvidence process
    validate_evidence_binding "$state" closureEvidence process
    validate_evidence_binding "$state" guardJournalEvidence file
  fi
  if [[ $(jq -er '.phase' "$state") == complete ]]; then
    validate_complete_state_evidence "$state"
  fi
}

# Phase-owned proofs must reference the real evidence bytes on disk, not just
# a well-shaped binding: the file must exist, be an owned regular non-symlink
# 0600 file, match its recorded digest, and (for process evidence) carry the
# controller evidence schema. The writer-stop proof must additionally name
# this state's application container and prove an inspect-verified stop, so a
# forged or foreign stop record cannot satisfy a closure proof.
validate_evidence_binding() {
  local state=$1 key=$2 kind=${3:-process} path recorded actual
  path=$(jq -er --arg k "$key" '.[$k].path // empty' "$state" 2>/dev/null) || path=''
  [[ -n "$path" && "$path" == /* ]] ||
    die "$key binding is missing an absolute evidence path"
  assert_owned_regular_file "$path"
  [[ $(stat -c '%a' "$path") == 600 ]] || die "$key evidence file mode must be 0600: $path"
  recorded=$(jq -er --arg k "$key" '.[$k].sha256 // empty' "$state" 2>/dev/null)
  [[ "$recorded" =~ ^[a-f0-9]{64}$ ]] || die "$key binding has no valid sha256"
  actual=$(sha256_file "$path")
  [[ "$actual" == "$recorded" ]] ||
    die "$key evidence file no longer matches its recorded digest: $path"
  if [[ "$kind" == process ]]; then
    jq -e 'type == "object" and .version == 1 and (.phase | type == "string" and length > 0)' \
      "$path" >/dev/null ||
      die "$key evidence file is not a controller process-evidence object: $path"
  fi
  if [[ "$key" == writerStopEvidence ]]; then
    jq -e --arg app "$(jq -er '.appContainer // ""' "$state")" \
      'type == "object" and .container == $app and .container != "" and
       .inspectRunning == false and .stopExitCode == 0' \
      "$path" >/dev/null ||
      die "writerStopEvidence file does not prove this state's application container was inspect-verified stopped: $path"
  fi
}

update_controller_phase() {
  local state=$1 phase=$2 incident_class=${3:-} temp write_exit=0
  validate_controller_state "$state"
  case "$phase" in
    prepared|candidate-published|source-recovery-running|guard-exited|authorization-running|activation-running|closure-running|closure-stop-pending|closure-evidence-pending|complete|incident) ;;
    *) die "invalid controller phase: $phase" ;;
  esac
  [[ "$phase" != incident && "$phase" != closure-stop-pending && "$phase" != closure-evidence-pending || -n "$incident_class" ]] ||
    die 'closure pending and incident phases require a class'
  temp=$(mktemp "$(dirname "$state")/.controller-phase.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq --arg phase "$phase" --arg incidentClass "$incident_class" '
    .phase = $phase |
    .updatedAt = (now | todateiso8601) |
    if ($phase == "closure-stop-pending" or $phase == "closure-evidence-pending" or $phase == "incident") then .incidentClass = $incidentClass
    else del(.incidentClass) end
  ' "$state" > "$temp"
  write_controller_state_atomic "$state" "$temp" || write_exit=$?
  trap - RETURN
  return "$write_exit"
}

restore_source_without_guard_journal() {
  local live_compose=$1 source_snapshot=$2 expected_source_sha=$3 staged
  assert_owned_regular_file "$live_compose"
  assert_owned_regular_file "$source_snapshot"
  [[ $(sha256_file "$source_snapshot") == "$expected_source_sha" ]] ||
    die 'source Compose snapshot digest changed'

  # The caller must prove that the source containers and authorization marker
  # still match the pre-publication baseline before desired state is restored.
  assert_source_state_unchanged

  staged=$(mktemp "${live_compose}.item3-restore.XXXXXX")
  trap 'rm -f "$staged"' RETURN
  install -m "$(stat -c '%a' "$source_snapshot")" "$source_snapshot" "$staged"
  fsync_path "$staged"
  mv -f "$staged" "$live_compose"
  fsync_path "$(dirname "$live_compose")"
  trap - RETURN
}

restore_source_compose_snapshot() {
  local live_compose=$1 source_snapshot=$2 expected_source_sha=$3 staged
  [[ -f "$live_compose" && ! -L "$live_compose" ]] || {
    printf 'required file is missing or unsafe: %s\n' "$live_compose" >&2
    return 1
  }
  [[ $(stat -c '%u' "$live_compose") == "$(id -u)" ]] || {
    printf 'required file is not owned by the current user: %s\n' "$live_compose" >&2
    return 1
  }
  [[ -f "$source_snapshot" && ! -L "$source_snapshot" ]] || {
    printf 'required file is missing or unsafe: %s\n' "$source_snapshot" >&2
    return 1
  }
  [[ $(stat -c '%u' "$source_snapshot") == "$(id -u)" ]] || {
    printf 'required file is not owned by the current user: %s\n' "$source_snapshot" >&2
    return 1
  }
  [[ $(sha256_file "$source_snapshot") == "$expected_source_sha" ]] || {
    printf 'source Compose snapshot digest changed\n' >&2
    return 1
  }
  staged=$(mktemp "${live_compose}.item3-restore.XXXXXX") || return
  install -m "$(stat -c '%a' "$source_snapshot")" "$source_snapshot" "$staged" || return
  fsync_path "$staged" || return
  mv -f "$staged" "$live_compose" || return
  fsync_path "$(dirname "$live_compose")"
}

resume_controller_state() {
  local state=$1 phase guard_journal live_compose source_snapshot source_sha candidate_sha live_sha
  local source_verify_exit=0
  validate_controller_state "$state"
  phase=$(jq -er '.phase' "$state")
  guard_journal=$(jq -er '.guardJournal' "$state")

  # A pending fail-closed writer stop outranks every journal and is resumable.
  # Only after the application is verified stopped may the incident become
  # terminal and require operator resolution.
  case "$phase" in
    closure-stop-pending)
      complete_closure_stop_pending "$state"
      die "controller incident requires operator resolution: $(jq -r '.incidentClass // "unknown"' "$state")"
      ;;
    closure-evidence-pending)
      validate_bound_process_evidence "$state" authorizationEvidence authorization-running
      assert_bound_guard_journal_unchanged "$state"
      resume_action=run-closure-stopped
      return
      ;;
  esac

  # Terminal phases outrank any guard journal on disk. An incident always
  # requires operator resolution, and a completed transition is revalidated
  # only through an explicit separate invocation — never by resuming.
  case "$phase" in
    incident)
      die "controller incident requires operator resolution: $(jq -r '.incidentClass // "unknown"' "$state")"
      ;;
    complete)
      die 'controller phase complete is terminal; completed-journal revalidation is an explicit separate invocation'
      ;;
  esac

  # Once the initial guard and completed journal are durably bound, resume the
  # controller-owned writer lifecycle instead of delegating back to switch
  # mode. Authorization is idempotent and activation is verified separately.
  case "$phase" in
    authorization-running)
      assert_bound_guard_journal_unchanged "$state"
      resume_action=run-authorization
      return
      ;;
    activation-running)
      jq -e 'has("writerStopEvidence")' "$state" >/dev/null &&
        die 'state records a verified writer stop without a terminal incident; reactivation is forbidden and requires operator resolution'
      validate_bound_process_evidence "$state" authorizationEvidence authorization-running
      assert_bound_guard_journal_unchanged "$state"
      resume_action=run-activation
      return
      ;;
    closure-running)
      jq -e 'has("writerStopEvidence")' "$state" >/dev/null &&
        die 'state records a verified writer stop without a terminal incident; reactivation is forbidden and requires operator resolution'
      validate_bound_process_evidence "$state" authorizationEvidence authorization-running
      assert_bound_guard_journal_unchanged "$state"
      resume_action=run-closure
      return
      ;;
  esac

  if path_present "$guard_journal"; then
    assert_owned_regular_file "$guard_journal"
    [[ $(stat -c '%a' "$guard_journal") == 600 ]] || die 'guard journal mode must be 0600'
    delegate_to_guard_journal "$state" "$guard_journal"
    resume_action=run-guard
    return
  fi

  case "$phase" in
    prepared)
      resume_action=publish-and-run
      return
      ;;
    candidate-published|source-recovery-running|guard-exited)
      live_compose=$(jq -er '.liveCompose' "$state")
      source_snapshot=${execution_source_snapshot:-$(jq -er '.sourceSnapshot' "$state")}
      source_sha=$(jq -er '.sourceSnapshotSha256' "$state")
      candidate_sha=$(jq -er '.candidateComposeSha256' "$state")
      update_controller_phase "$state" source-recovery-running
      run_source_recovery_verifier_with_evidence "$state" || source_verify_exit=$?
      if ((source_verify_exit != 0)); then
        update_controller_phase "$state" incident pre-journal-source-verification
        resume_action=incident
        return "$source_verify_exit"
      fi
      if [[ ! -f "$live_compose" || -L "$live_compose" ]]; then
        printf 'required file is missing or unsafe: %s\n' "$live_compose" >&2
        update_controller_phase "$state" incident pre-journal-source-restoration
        resume_action=incident
        return 1
      fi
      if [[ $(stat -c '%u' "$live_compose") != "$(id -u)" ]]; then
        printf 'required file is not owned by the current user: %s\n' "$live_compose" >&2
        update_controller_phase "$state" incident pre-journal-source-restoration
        resume_action=incident
        return 1
      fi
      live_sha=$(sha256_file "$live_compose")
      if [[ "$live_sha" != "$source_sha" && "$live_sha" != "$candidate_sha" ]]; then
        printf 'live Compose is unexpected: bytes match neither the prepared source nor candidate model\n' >&2
        update_controller_phase "$state" incident pre-journal-live-compose-divergence
        resume_action=incident
        return 1
      fi
      if ! restore_source_compose_snapshot "$live_compose" "$source_snapshot" "$source_sha"; then
        update_controller_phase "$state" incident pre-journal-source-restoration
        resume_action=incident
        return 1
      fi
      update_controller_phase "$state" incident pre-journal-source-restored
      resume_action=source-restored
      ;;
    authorization-running|activation-running|closure-running|complete)
      die "controller phase $phase is missing its completed guard journal"
      ;;
  esac
}

query_live_engine_id() {
  local docker_path=$1
  "$docker_path" info --format '{{.ID}}'
}

query_postgres_volume_fingerprint() {
  local docker_path=$1 volume=$2 fingerprint
  fingerprint=$(
    "$docker_path" volume inspect "$volume" |
      jq -eSc --arg volume "$volume" '
        if type == "array" and length == 1 and .[0].Name == $volume then
          .[0] | {Name,Driver,Mountpoint,CreatedAt,Scope,Labels,Options}
        else
          error("PostgreSQL volume inspection is missing or ambiguous")
        end
      ' |
      sha256sum | awk '{print $1}'
  ) || die "could not fingerprint PostgreSQL volume $volume"
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] ||
    die "PostgreSQL volume fingerprint is malformed for $volume"
  printf '%s\n' "$fingerprint"
}

assert_postgres_volume_binding() {
  local state=$1 docker_path=$2 volume expected actual
  volume=$(jq -er '.volume' "$state")
  expected=$(jq -er '.volumeFingerprint | select(type == "string" and test("^[a-f0-9]{64}$"))' "$state") ||
    die 'prepared state is missing the PostgreSQL volume fingerprint'
  actual=$(query_postgres_volume_fingerprint "$docker_path" "$volume")
  [[ "$actual" == "$expected" ]] ||
    die 'PostgreSQL volume fingerprint changed after preparation'
}

# Rebind the recorded transition identity to the live Docker daemon while the
# guard's engine-plus-volume lock is held and before any Compose action.
assert_live_engine_binding() {
  local state=$1 docker_path=$2 live_engine expected_engine expected_root
  expected_engine=$(jq -er '.engineId' "$state")
  live_engine=$(query_live_engine_id "$docker_path") ||
    die 'could not query the live Docker engine ID'
  [[ -n "$live_engine" ]] || die 'live Docker engine ID is empty'
  [[ "$live_engine" == "$expected_engine" ]] ||
    die 'live Docker engine ID does not match the recorded transition identity'
  expected_root=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  [[ $(jq -er '.lockRoot' "$state") == "$expected_root" ]] ||
    die 'recorded lock root does not match the guard engine-volume lock contract'
}

ensure_regular_lock_file() {
  local lock_path=$1 temp created=false
  if ! path_present "$lock_path"; then
    temp=$(mktemp "$(dirname "$lock_path")/.operation-lock.XXXXXX")
    trap 'rm -f "$temp"' RETURN
    install -m 600 /dev/null "$temp"
    if ln "$temp" "$lock_path" 2>/dev/null; then
      created=true
      fsync_path "$lock_path"
      fsync_path "$(dirname "$lock_path")"
    elif ! path_present "$lock_path"; then
      die "could not create operation lock: $lock_path"
    fi
    trap - RETURN
    rm -f "$temp"
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" ]] ||
    die "operation lock path is not a regular no-follow file: $lock_path"
  [[ $(stat -c '%u' "$lock_path") == "$(id -u)" ]] ||
    die "operation lock is not owned by the current user: $lock_path"
  [[ $(stat -c '%a' "$lock_path") == 600 ]] ||
    die "operation lock mode must be 0600: $lock_path"
  [[ "$created" == false ]] || :
}

acquire_preparation_lock() {
  local state=$1 lock_path
  lock_path="$state.prepare.lock"
  ensure_regular_lock_file "$lock_path"
  exec 7<>"$lock_path"
  [[ $(readlink "/proc/$BASHPID/fd/7" 2>/dev/null || true) == "$lock_path" ]] ||
    die 'preparation lock descriptor does not name the deterministic lock path'
  flock -w 30 7 || die 'another controller preparation is active for this state path'
}

after_preparation_lock() {
  :
}

acquire_operation_lock() {
  local engine_id=$1 volume=$2 lock_root=$3 lock_key lock_path
  [[ -n "$engine_id" ]] || die 'Docker engine ID is empty'
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'invalid PostgreSQL volume name'
  [[ "$lock_root" == /* && -d "$lock_root" && ! -L "$lock_root" ]] ||
    die "runtime lock directory is unavailable or unsafe: $lock_root"
  [[ $(stat -c '%u' "$lock_root") == "$(id -u)" ]] ||
    die 'runtime lock directory is not owned by the current user'

  lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
  lock_path="$lock_root/noosphere-pgvector-switch-$lock_key.lock"
  ensure_regular_lock_file "$lock_path"
  exec 8<>"$lock_path"
  [[ $(readlink "/proc/$BASHPID/fd/8" 2>/dev/null || true) == "$lock_path" ]] ||
    die 'operation lock descriptor does not name the deterministic lock path'
  flock -w 5 8 || die "another PostgreSQL image transition is active for volume $volume"
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_A2B_LOCK_PATH=$lock_path
}

claim_authoritative_state_path() {
  # mode: prepare (default) claims or reclaims; revalidate requires an existing
  # record under the CURRENT durable authority root (execution path).
  local state=$1 engine_id=$2 volume=$3 lock_root=$4 mode=${5:-prepare}
  local lock_key claim state_path temp recorded_lock_root existing_claim_path
  local durable_home state_base runtime_base root entry recorded_path recorded_phase
  local recorded_state_unreadable=false reclaim_previous=false
  assert_operation_lock_held "$engine_id" "$volume" "$lock_root"
  lock_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
  claim="$lock_root/noosphere-pgvector-state-$lock_key.json"
  state_path=$(realpath -m "$state")

  # The runtime claim in lock_root is reboot-volatile by
  # contract. A durable mirror under the invoking user's state directory keeps
  # the engine-plus-volume identity bound to exactly one state path even after
  # the runtime directory is replaced, so a duplicate prepare cannot silently
  # start a second state history while a prior one is still alive. Stale
  # records whose state file is gone or terminal (complete) are reclaimed under
  # the same lock. (Kept inline so extraction-based reuse stays self-contained.)
  durable_home=${controller_durable_home:-${HOME:-}}
  [[ -n "$durable_home" && "$durable_home" == /* ]] ||
    die 'durable state-authority home is unavailable for this controller identity'
  # XDG Base Directory conformance: an explicit XDG_STATE_HOME (absolute)
  # relocates the durable authority root. Disposable rehearsals use it to
  # isolate records from the invoking user's real state namespace.
  state_base=${XDG_STATE_HOME:-}
  [[ -z "$state_base" || "$state_base" == /* ]] ||
    die 'XDG_STATE_HOME must be an absolute path'
  [[ -n "$state_base" ]] || state_base=$durable_home/.local/state
  state_base=$(realpath -m "$state_base")
  runtime_base=$(realpath -m "$lock_root")
  [[ "$state_base" != "$runtime_base" && "$state_base" != "$runtime_base"/* ]] ||
    die 'durable state-authority root cannot live below the reboot-volatile runtime lock root'
  root=$state_base/noosphere-pgvector-controller/authority
  entry="$root/state-$lock_key.json"
  # Execution may only continue a state whose durable authority record lives
  # under the *current* durable authority root: a record prepared under
  # another root must never be executed or duplicated from this one. In
  # revalidate mode the record must already be present; otherwise die
  # *before* creating the authority directory structure so cross-root
  # execute cannot silently populate the wrong namespace with an empty
  # root.
  if [[ "$mode" == revalidate ]]; then
    path_present "$entry" ||
      die 'no durable state-authority record exists under the current durable authority root for this engine and volume'
  fi
  if ! path_present "$root"; then
    install -d -m 700 "$root" || die 'could not create the durable state-authority root'
    # Make the new authority directory entry durable: the root itself, its
    # parent, and the state base must all reach stable storage so a power
    # loss cannot silently drop the authority namespace and admit a
    # duplicate claim after restart.
    fsync_path "$root"
    fsync_path "$(dirname "$root")"
    [[ "$state_base" == "/" ]] || fsync_path "$state_base"
  fi
  [[ -d "$root" && ! -L "$root" ]] || die 'durable state-authority root must be a real directory'
  [[ $(stat -c '%u' "$root") == "$(id -u)" ]] ||
    die 'durable state-authority root must be owned by the controller user'
  [[ $(stat -c '%a' "$root") == 700 ]] || die 'durable state-authority root mode must be 0700'
  if path_present "$entry"; then
    assert_owned_regular_file "$entry"
    [[ $(stat -c '%a' "$entry") == 600 ]] || die 'durable state-authority record mode must be 0600'
    jq -e --arg engineId "$engine_id" --arg volume "$volume" '
      .version == 1 and .engineId == $engineId and .volume == $volume and
      (.statePath | type == "string" and startswith("/"))
    ' "$entry" >/dev/null ||
      die 'durable state-authority record is malformed for this engine and volume'
    recorded_path=$(jq -er '.statePath' "$entry")
    if [[ "$recorded_path" != "$(realpath -m "$state")" ]]; then
      [[ "$mode" != revalidate ]] ||
        die 'durable state-authority record points to another state path'
      recorded_phase=''
      recorded_state_unreadable=false
      if path_present "$recorded_path"; then
        assert_owned_regular_file "$recorded_path"
        if ! recorded_phase=$(jq -er '.phase // empty' "$recorded_path" 2>/dev/null); then
          recorded_phase=''
          recorded_state_unreadable=true
        fi
      fi
      if [[ "$recorded_state_unreadable" == true ]]; then
        die 'durable state-authority record references an unreadable or phase-less state file; operator resolution required'
      fi
      case "$recorded_phase" in
        prepared|candidate-published|source-recovery-running|guard-exited|authorization-running|activation-running|closure-running|closure-stop-pending|closure-evidence-pending|incident)
          die 'authoritative state for this Docker engine and PostgreSQL volume is already claimed by another path'
          ;;
        '')
          # A missing state is reclaimable under the operation lock. Its
          # reboot-volatile claim, when retained, is replaced below only after
          # proving that it still names this exact durable predecessor.
          reclaim_previous=true
          ;;
        complete)
          # A phase string alone is not terminal evidence. Validate the full
          # state and its bound guard, authorization, closure, and completed
          # journal bytes before it may relinquish unique engine-volume
          # authority.
          validate_controller_state "$recorded_path"
          jq -e \
            --arg engineId "$engine_id" \
            --arg volume "$volume" \
            --arg authorityRoot "$root" '
              .engineId == $engineId and .volume == $volume and
              .authorityRoot == $authorityRoot
            ' "$recorded_path" >/dev/null ||
            die 'complete state identity does not match its durable authority record'
          reclaim_previous=true
          ;;
        *)
          # Present durable state whose `.phase` is outside the recognizable
          # set (on-disk corruption, partial write, or a future schema whose
          # active phases have not been enumerated here) MUST NOT silently
          # fall through to a reclaim: that would let one engine and volume
          # pair end up with two competing authority records. The contract
          # elsewhere in this function is fail-closed; the case arm
          # deserves the same.
          die "durable state-authority record references unrecognized phase '$recorded_phase'; operator resolution required"
          ;;
      esac
    else
      # Same state path re-claimed (idempotent prepare or execute
      # revalidation). The durable authority root is part of the record's
      # identity: a record claimed under another durable root means this
      # state was prepared in a different authority namespace.
      [[ "$(jq -er '.authorityRoot // empty' "$entry")" == "$root" ]] ||
        die 'durable state-authority record was claimed under a different durable authority root'
      # A different runtime lock root is only tolerated when the recorded
      # runtime claim is gone (reboot or runtime-directory loss). While the
      # previous runtime claim is still live, replacing it would leave two
      # potentially concurrent authorities for one engine and volume.
      recorded_lock_root=$(jq -er '.lockRoot // empty' "$entry")
      if [[ -n "$recorded_lock_root" && "$recorded_lock_root" != "$lock_root" ]] &&
         path_present "$recorded_lock_root/noosphere-pgvector-state-$lock_key.json"; then
        die 'durable state-authority record was claimed under a different runtime lock root; refusing to replace a live claim'
      fi
    fi
  fi

  # Validate the durable authority before publishing a reboot-volatile claim
  # for this path. A rejected alternate prepare must not poison a later retry
  # of the still-authoritative state with a stale runtime claim.
  if path_present "$claim"; then
    assert_owned_regular_file "$claim"
    [[ $(stat -c '%a' "$claim") == 600 ]] || die 'authoritative state-path claim mode must be 0600'
    jq -e \
      --arg engineId "$engine_id" \
      --arg volume "$volume" '
        .version == 1 and .engineId == $engineId and .volume == $volume and
        (.statePath | type == "string" and startswith("/"))
      ' "$claim" >/dev/null ||
      die 'authoritative state-path claim is malformed for this engine and volume'
    existing_claim_path=$(jq -er '.statePath' "$claim")
    if [[ "$existing_claim_path" != "$state_path" && "$reclaim_previous" == true ]]; then
      [[ "$existing_claim_path" == "$recorded_path" ]] ||
        die 'authoritative state for this Docker engine and PostgreSQL volume is already claimed by another path'
      temp=$(mktemp "$lock_root/.state-authority.XXXXXX")
      trap 'rm -f "$temp"' RETURN
      jq -n \
        --arg engineId "$engine_id" \
        --arg volume "$volume" \
        --arg statePath "$state_path" \
        '{version:1,engineId:$engineId,volume:$volume,statePath:$statePath}' > "$temp"
      chmod 0600 "$temp"
      fsync_path "$temp"
      mv -f "$temp" "$claim"
      fsync_path "$claim"
      fsync_path "$lock_root"
      trap - RETURN
    fi
  else
    temp=$(mktemp "$lock_root/.state-authority.XXXXXX")
    trap 'rm -f "$temp"' RETURN
    jq -n \
      --arg engineId "$engine_id" \
      --arg volume "$volume" \
      --arg statePath "$state_path" \
      '{version:1,engineId:$engineId,volume:$volume,statePath:$statePath}' > "$temp"
    chmod 0600 "$temp"
    fsync_path "$temp"
    if ln "$temp" "$claim" 2>/dev/null; then
      fsync_path "$claim"
      fsync_path "$lock_root"
    elif ! path_present "$claim"; then
      die 'could not create the authoritative state-path claim'
    fi
    trap - RETURN
    rm -f "$temp"
  fi

  assert_owned_regular_file "$claim"
  [[ $(stat -c '%a' "$claim") == 600 ]] || die 'authoritative state-path claim mode must be 0600'
  jq -e \
    --arg engineId "$engine_id" \
    --arg volume "$volume" \
    --arg statePath "$state_path" '
      .version == 1 and .engineId == $engineId and .volume == $volume and
      (.statePath | type == "string" and startswith("/")) and
      .statePath == $statePath
    ' "$claim" >/dev/null ||
    die 'authoritative state for this Docker engine and PostgreSQL volume is already claimed by another path'

  temp=$(mktemp "$root/.state-authority.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq -n \
    --arg engineId "$engine_id" \
    --arg volume "$volume" \
    --arg statePath "$(realpath -m "$state")" \
    --arg lockRoot "$lock_root" \
    --arg authorityRoot "$root" \
    --arg bootId "$(</proc/sys/kernel/random/boot_id)" \
    '{version:1,engineId:$engineId,volume:$volume,statePath:$statePath,
      lockRoot:$lockRoot,authorityRoot:$authorityRoot,bootId:$bootId,
      updatedAt:(now|todateiso8601)}' > "$temp"
  chmod 0600 "$temp"
  fsync_path "$temp"
  mv -f "$temp" "$entry"
  fsync_path "$root"
  trap - RETURN
  printf '%s\n' "$root"
}

assert_operation_lock_held() {
  local engine_id=$1 volume=$2 lock_root=$3 expected_key expected_path actual_path
  [[ ${NOOSPHERE_A2B_LOCK_FD:-} =~ ^[0-9]+$ ]] || die 'operation lock descriptor is missing or invalid'
  expected_key=$(printf '%s\0%s' "$engine_id" "$volume" | sha256sum | awk '{print $1}')
  expected_path="$lock_root/noosphere-pgvector-switch-$expected_key.lock"
  [[ ${NOOSPHERE_A2B_LOCK_PATH:-} == "$expected_path" ]] || die 'operation lock path does not match the engine and volume'
  # BASHPID remains correct when a focused fixture or caller runs the
  # controller in a Bash subshell; $$ can still identify the parent shell.
  actual_path=$(readlink "/proc/$BASHPID/fd/$NOOSPHERE_A2B_LOCK_FD" 2>/dev/null || true)
  [[ "$actual_path" == "$expected_path" ]] || die 'operation lock descriptor names another path'
  flock -n "$NOOSPHERE_A2B_LOCK_FD" || die 'operation lock descriptor is not held'
}

publish_compose_atomic() {
  local source=$1 target=$2 staged parent parent_mode
  assert_owned_regular_file "$source"
  assert_owned_regular_file "$target"
  for parent in "$(dirname "$source")" "$(dirname "$target")"; do
    [[ -d "$parent" && ! -L "$parent" ]] ||
      die "Compose publication parent is missing or unsafe: $parent"
    if [[ $(stat -c '%u' "$parent") == "$(id -u)" ]]; then
      parent_mode=$(stat -c '%a' "$parent")
      (( (8#$parent_mode & 8#022) == 0 )) ||
        die "Compose publication parent permits group/world writes: $parent"
    fi
  done
  staged=$(mktemp "${target}.item3-publish.XXXXXX")
  trap 'rm -f "$staged"' RETURN
  install -m 600 "$source" "$staged"
  fsync_path "$staged"
  mv -f "$staged" "$target"
  fsync_path "$(dirname "$target")"
  trap - RETURN
}

publish_candidate_under_lock() {
  local state=$1 candidate_compose=$2 lock_root=$3 bound_source_snapshot=${4:-}
  local phase engine_id volume live_compose source_snapshot source_sha candidate_sha
  validate_controller_state "$state"
  phase=$(jq -er '.phase' "$state")
  [[ "$phase" == prepared ]] || die "candidate publication requires prepared state, found $phase"
  engine_id=$(jq -er '.engineId' "$state")
  volume=$(jq -er '.volume' "$state")
  live_compose=$(jq -er '.liveCompose' "$state")
  source_snapshot=${bound_source_snapshot:-$(jq -er '.sourceSnapshot' "$state")}
  source_sha=$(jq -er '.sourceSnapshotSha256' "$state")
  candidate_sha=$(jq -er '.candidateComposeSha256' "$state")
  assert_operation_lock_held "$engine_id" "$volume" "$lock_root"
  assert_owned_regular_file "$candidate_compose"
  assert_owned_regular_file "$live_compose"
  assert_owned_regular_file "$source_snapshot"
  [[ $(sha256_file "$candidate_compose") == "$candidate_sha" ]] || die 'candidate Compose digest changed'
  [[ $(sha256_file "$source_snapshot") == "$source_sha" ]] || die 'source Compose snapshot digest changed'
  [[ $(sha256_file "$live_compose") == "$source_sha" ]] || die 'live Compose no longer matches the prepared source snapshot'

  # Commit recovery ownership before the atomic publication. A kill between
  # these operations therefore resumes through the source-restore path whether
  # the rename happened or not.
  update_controller_phase "$state" candidate-published
  if [[ ${NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT:-0} == 1 ]]; then
    die 'test interruption after candidate publication intent'
  fi
  publish_compose_atomic "$candidate_compose" "$live_compose"
}

child_path_for_state() {
  local state=$1 docker_path fixed_path
  docker_path=${execution_docker_path:-$(jq -er '.dockerPath' "$state")}
  fixed_path=$(jq -er '.fixedPath' "$state")
  [[ $(basename "$docker_path") == docker ]] ||
    die 'recorded Docker executable must be named docker'
  printf '%s:%s\n' "$(dirname "$docker_path")" "$fixed_path"
}

assert_recorded_docker_resolution() {
  local state=$1 docker_path child_path resolved
  docker_path=${execution_docker_path:-$(jq -er '.dockerPath' "$state")}
  child_path=$(child_path_for_state "$state")
  resolved=$(PATH="$child_path" command -v docker 2>/dev/null || true)
  [[ -n "$resolved" && $(realpath "$resolved") == "$(realpath "$docker_path")" ]] ||
    die 'child PATH does not resolve the recorded Docker executable'
}

run_guard_with_inherited_lock() {
  local state=$1 engine_id=$2 volume=$3 lock_root=$4
  local child_path controller_home docker_config docker_host guard_exit=0 spawned_pid
  local -a fixture_env=()
  shift 4
  (($# > 0)) || die 'guard command is empty'
  assert_operation_lock_held "$engine_id" "$volume" "$lock_root"
  assert_recorded_docker_resolution "$state"
  child_path=$(child_path_for_state "$state")
  controller_home=${execution_controller_home:-$(jq -er '.controllerHome' "$state")}
  docker_config="$controller_home/docker"
  docker_host=$(jq -er '.dockerEndpoint' "$state")
  if [[ ${controller_test_hooks_enabled:-false} == true && -n ${controller_fixture_root:-} ]]; then
    fixture_env+=("NOOSPHERE_CONTROLLER_FIXTURE_ROOT=$controller_fixture_root")
  fi
  setsid env -i \
    "HOME=$controller_home" \
    "PATH=$child_path" \
    "DOCKER_CONFIG=$docker_config" \
    "DOCKER_HOST=$docker_host" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "XDG_RUNTIME_DIR=$lock_root" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    "NOOSPHERE_A2B_LOCK_FD=$NOOSPHERE_A2B_LOCK_FD" \
    "NOOSPHERE_A2B_LOCK_PATH=$NOOSPHERE_A2B_LOCK_PATH" \
    "${fixture_env[@]}" \
    "$@" &
  spawned_pid=$!
  if [[ -n ${NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN:-} ]]; then
    handle_controller_signal "$NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN"
  fi
  guard_pid=$spawned_pid
  active_child_pid=$guard_pid
  active_child_pgid=$guard_pid
  last_guard_pid=$guard_pid
  forward_latched_signal_to_active_child
  wait_for_child_exit "$guard_pid" || guard_exit=$?
  wait_for_process_group_empty "$active_child_pgid"
  guard_pid=''
  active_child_pid=''
  active_child_pgid=''
  return "$guard_exit"
}

run_verifier_hermetic() {
  local state=$1 guard_journal=$2 volume=$3 verifier=$4
  local child_path controller_home docker_config docker_host lock_root app_url verify_exit=0
  local -a fixture_env=()
  assert_recorded_docker_resolution "$state"
  child_path=$(child_path_for_state "$state")
  controller_home=${execution_controller_home:-$(jq -er '.controllerHome' "$state")}
  docker_config="$controller_home/docker"
  docker_host=$(jq -er '.dockerEndpoint' "$state")
  lock_root=$(jq -er '.lockRoot' "$state")
  app_url=$(jq -er '.appUrl' "$state")
  if [[ ${controller_test_hooks_enabled:-false} == true && -n ${controller_fixture_root:-} ]]; then
    fixture_env+=("NOOSPHERE_CONTROLLER_FIXTURE_ROOT=$controller_fixture_root")
  fi
  setsid env -i \
    "HOME=$controller_home" \
    "PATH=$child_path" \
    "DOCKER_CONFIG=$docker_config" \
    "DOCKER_HOST=$docker_host" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "XDG_RUNTIME_DIR=$lock_root" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    "NOOSPHERE_APP_URL=$app_url" \
    NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE=candidate \
    "NOOSPHERE_POSTGRES_EVIDENCE=$guard_journal" \
    "NOOSPHERE_DB_CONTAINER=$(jq -er '.dbContainer' "$state")" \
    "NOOSPHERE_EXPECTED_DB_VOLUME=$volume" \
    "NOOSPHERE_EXPECTED_POSTGRES_AUTHORIZATION_VOLUME=$(jq -er '.authorizationVolume' "$state")" \
    "${fixture_env[@]}" \
    "$verifier" &
  active_child_pid=$!
  active_child_pgid=$active_child_pid
  last_verifier_pid=$active_child_pid
  forward_latched_signal_to_active_child
  wait_for_child_exit "$active_child_pid" || verify_exit=$?
  wait_for_process_group_empty "$active_child_pgid"
  active_child_pid=''
  active_child_pgid=''
  return "$verify_exit"
}

run_source_verifier_hermetic() {
  local state=$1 verifier=$2
  local child_path controller_home docker_config docker_host lock_root app_url verify_exit=0
  local -a fixture_env=()
  assert_recorded_docker_resolution "$state"
  child_path=$(child_path_for_state "$state")
  controller_home=${execution_controller_home:-$(jq -er '.controllerHome' "$state")}
  docker_config="$controller_home/docker"
  docker_host=$(jq -er '.dockerEndpoint' "$state")
  lock_root=$(jq -er '.lockRoot' "$state")
  app_url=$(jq -er '.appUrl' "$state")
  if [[ ${controller_test_hooks_enabled:-false} == true && -n ${controller_fixture_root:-} ]]; then
    fixture_env+=("NOOSPHERE_CONTROLLER_FIXTURE_ROOT=$controller_fixture_root")
  fi
  setsid env -i \
    "HOME=$controller_home" \
    "PATH=$child_path" \
    "DOCKER_CONFIG=$docker_config" \
    "DOCKER_HOST=$docker_host" \
    COMPOSE_DISABLE_ENV_FILE=1 \
    "XDG_RUNTIME_DIR=$lock_root" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    "NOOSPHERE_APP_URL=$app_url" \
    NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE=source \
    "NOOSPHERE_DB_CONTAINER=$(jq -er '.dbContainer' "$state")" \
    "NOOSPHERE_EXPECTED_DB_VOLUME=$(jq -er '.volume' "$state")" \
    "NOOSPHERE_EXPECTED_POSTGRES_AUTHORIZATION_VOLUME=$(jq -er '.authorizationVolume' "$state")" \
    "${fixture_env[@]}" \
    "$verifier" &
  active_child_pid=$!
  active_child_pgid=$active_child_pid
  last_verifier_pid=$active_child_pid
  forward_latched_signal_to_active_child
  wait_for_child_exit "$active_child_pid" || verify_exit=$?
  wait_for_process_group_empty "$active_child_pgid"
  active_child_pid=''
  active_child_pgid=''
  return "$verify_exit"
}

run_source_recovery_verifier_with_evidence() {
  local state=$1 verifier artifact_base stdout_file stderr_file evidence
  local start_cursor end_cursor started_at ended_at verify_exit=0
  verifier=${execution_verifier:-$(jq -er '.verifier' "$state")}
  # Source-recovery artifacts reuse the per-invocation scheme of the guard and
  # verifier roles: the first run owns the canonical paths, and any later
  # invocation that finds prior artifacts allocates InvocationID-suffixed
  # paths so truthful prior evidence and logs are never overwritten.
  artifact_base=$(select_process_artifact_base "${state%.json}" source-recovery)
  [[ -n "$artifact_base" && "$artifact_base" == /* ]] ||
    die 'could not allocate distinct source-recovery artifact paths'
  stdout_file="$artifact_base.source-recovery.stdout.log"
  stderr_file="$artifact_base.source-recovery.stderr.log"
  evidence="$artifact_base.source-recovery.evidence.json"
  install -m 600 /dev/null "$stdout_file"
  install -m 600 /dev/null "$stderr_file"
  start_cursor=$(capture_journal_cursor)
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  run_source_verifier_hermetic "$state" "$verifier" >"$stdout_file" 2>"$stderr_file" ||
    verify_exit=$?
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  end_cursor=$(capture_journal_cursor)
  write_process_evidence_atomic "$evidence" source-recovery-running "$verify_exit" \
    "$stdout_file" "$stderr_file" "$INVOCATION_ID" "$controller_boot_id" \
    "$systemd_controller_main_pid" "$last_verifier_pid" "$started_at" "$ended_at" \
    "$start_cursor" "$end_cursor"
  bind_process_evidence_to_state "$state" sourceRecoveryEvidence "$evidence" \
    "$INVOCATION_ID" "$controller_boot_id" "$systemd_controller_main_pid" "$last_verifier_pid"
  return "$verify_exit"
}

systemd_properties() {
  local working_directory=$1
  printf '%s\n' \
    Type=exec \
    RemainAfterExit=no \
    Restart=no \
    KillMode=mixed \
    TimeoutStartSec=infinity \
    TimeoutStopSec=infinity \
    RuntimeMaxSec=infinity \
    UMask=0077 \
    "WorkingDirectory=$working_directory"
}

write_process_evidence_atomic() {
  local target=$1 phase=$2 exit_code=$3 stdout_file=$4 stderr_file=$5
  local invocation_id=$6 boot_id=$7 controller_main_pid=$8 child_pid=$9
  local started_at=${10} ended_at=${11} start_cursor=${12} end_cursor=${13} temp
  [[ ${NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE:-} != "$phase" ]] ||
    die "test evidence failure at phase $phase"
  assert_owned_regular_file "$stdout_file"
  assert_owned_regular_file "$stderr_file"
  [[ $(stat -c '%a' "$stdout_file") == 600 ]] || die 'process stdout mode must be 0600'
  [[ $(stat -c '%a' "$stderr_file") == 600 ]] || die 'process stderr mode must be 0600'
  [[ "$exit_code" =~ ^[0-9]+$ ]] || die 'process exit code must be a non-negative integer'
  [[ "$controller_main_pid" =~ ^[0-9]+$ && "$controller_main_pid" -gt 0 ]] ||
    die 'controller MainPID must be a positive integer'
  [[ "$child_pid" =~ ^[0-9]+$ && "$child_pid" -gt 0 ]] ||
    die 'process child PID must be a positive integer'
  [[ "$controller_main_pid" != "$child_pid" ]] ||
    die 'controller MainPID and process child PID must differ'

  # The evidence hashes are only durable claims after the log bytes and their
  # directory entry have reached stable storage.
  fsync_path "$stdout_file"
  fsync_path "$stderr_file"
  fsync_path "$(dirname "$target")"
  temp=$(mktemp "$(dirname "$target")/.process-evidence.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq -n \
    --arg phase "$phase" \
    --argjson exitCode "$exit_code" \
    --arg stdout "$stdout_file" \
    --arg stderr "$stderr_file" \
    --arg stdoutSha256 "$(sha256_file "$stdout_file")" \
    --arg stderrSha256 "$(sha256_file "$stderr_file")" \
    --arg invocationId "$invocation_id" \
    --arg bootId "$boot_id" \
    --argjson controllerMainPid "$controller_main_pid" \
    --argjson childPid "$child_pid" \
    --arg startedAt "$started_at" \
    --arg endedAt "$ended_at" \
    --arg startCursor "$start_cursor" \
    --arg endCursor "$end_cursor" \
    '{
      version: 1,
      phase: $phase,
      exitCode: $exitCode,
      stdout: $stdout,
      stderr: $stderr,
      stdoutSha256: $stdoutSha256,
      stderrSha256: $stderrSha256,
      invocationId: $invocationId,
      bootId: $bootId,
      controllerMainPid: $controllerMainPid,
      childPid: $childPid,
      startedAt: $startedAt,
      endedAt: $endedAt,
      startCursor: $startCursor,
      endCursor: $endCursor
    }' > "$temp"
  write_controller_state_atomic "$target" "$temp"
  trap - RETURN
}

validate_process_evidence() {
  local evidence=$1 expected_phase=${2:-} expected_invocation=${3:-}
  local expected_boot=${4:-} expected_controller_pid=${5:-} expected_child_pid=${6:-}
  local stdout_file stderr_file started_at ended_at started_epoch ended_epoch
  assert_owned_regular_file "$evidence"
  [[ $(stat -c '%a' "$evidence") == 600 ]] || die 'process evidence mode must be 0600'
  jq -e '
    type == "object" and .version == 1 and
    (.phase | type == "string") and
    (.exitCode | type == "number" and . >= 0 and floor == .) and
    (.stdout | type == "string" and startswith("/")) and
    (.stderr | type == "string" and startswith("/")) and
    (.stdoutSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.stderrSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.invocationId | type == "string" and length > 0) and
    (.bootId | type == "string" and length > 0) and
    (.controllerMainPid | type == "number" and . > 0 and floor == .) and
    (.childPid | type == "number" and . > 0 and floor == .) and
    .controllerMainPid != .childPid and
    (.startedAt | type == "string" and length > 0) and
    (.endedAt | type == "string" and length > 0) and
    (.startCursor | type == "string" and length > 0) and
    (.endCursor | type == "string" and length > 0)
  ' "$evidence" >/dev/null || die 'process evidence is malformed'
  started_at=$(jq -er '.startedAt' "$evidence")
  ended_at=$(jq -er '.endedAt' "$evidence")
  [[ "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
     "$ended_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'process evidence timestamps must be canonical UTC RFC3339 values'
  started_epoch=$(date -u -d "$started_at" +%s 2>/dev/null) || die 'process evidence start timestamp is invalid'
  ended_epoch=$(date -u -d "$ended_at" +%s 2>/dev/null) || die 'process evidence end timestamp is invalid'
  ((ended_epoch >= started_epoch)) || die 'process evidence ends before it starts'
  [[ -z "$expected_phase" || $(jq -er '.phase' "$evidence") == "$expected_phase" ]] ||
    die 'process evidence phase does not match the controller phase'
  [[ -z "$expected_invocation" || $(jq -er '.invocationId' "$evidence") == "$expected_invocation" ]] ||
    die 'process evidence InvocationID does not match the controller execution'
  [[ -z "$expected_boot" || $(jq -er '.bootId' "$evidence") == "$expected_boot" ]] ||
    die 'process evidence boot ID does not match the controller execution'
  [[ -z "$expected_controller_pid" || $(jq -er '.controllerMainPid' "$evidence") == "$expected_controller_pid" ]] ||
    die 'process evidence controller MainPID does not match systemd'
  [[ -z "$expected_child_pid" || $(jq -er '.childPid' "$evidence") == "$expected_child_pid" ]] ||
    die 'process evidence child PID does not match the launched process'
  stdout_file=$(jq -er '.stdout' "$evidence")
  stderr_file=$(jq -er '.stderr' "$evidence")
  assert_owned_regular_file "$stdout_file"
  assert_owned_regular_file "$stderr_file"
  [[ $(stat -c '%a' "$stdout_file") == 600 ]] || die 'evidence stdout mode must be 0600'
  [[ $(stat -c '%a' "$stderr_file") == 600 ]] || die 'evidence stderr mode must be 0600'
  [[ $(sha256_file "$stdout_file") == "$(jq -er '.stdoutSha256' "$evidence")" ]] ||
    die 'evidence stdout digest does not match its log'
  [[ $(sha256_file "$stderr_file") == "$(jq -er '.stderrSha256' "$evidence")" ]] ||
    die 'evidence stderr digest does not match its log'
}

validate_bound_process_evidence() {
  local state=$1 key=$2 expected_phase=$3 path expected_sha
  local recorded_stdout recorded_stderr
  path=$(jq -er --arg key "$key" '.[$key].path' "$state")
  expected_sha=$(jq -er --arg key "$key" '.[$key].sha256' "$state")
  assert_owned_regular_file "$path"
  [[ $(stat -c '%a' "$path") == 600 ]] || die "$key mode must be 0600"
  [[ $(sha256_file "$path") == "$expected_sha" ]] || die "$key digest does not match durable evidence"
  validate_process_evidence "$path" "$expected_phase"
  [[ $(jq -er '.exitCode' "$path") == 0 ]] || die "$key records a nonzero terminal exit"
  recorded_stdout=$(jq -er --arg key "$key" '.[$key].stdout | [.path,.sha256] | @tsv' "$state")
  recorded_stderr=$(jq -er --arg key "$key" '.[$key].stderr | [.path,.sha256] | @tsv' "$state")
  [[ "$recorded_stdout" == "$(jq -er '[.stdout,.stdoutSha256] | @tsv' "$path")" ]] ||
    die "$key stdout binding differs from durable evidence"
  [[ "$recorded_stderr" == "$(jq -er '[.stderr,.stderrSha256] | @tsv' "$path")" ]] ||
    die "$key stderr binding differs from durable evidence"
}

validate_complete_state_evidence() {
  local state=$1
  validate_bound_process_evidence "$state" guardEvidence guard-exited
  validate_bound_process_evidence "$state" authorizationEvidence authorization-running
  validate_bound_process_evidence "$state" closureEvidence closure-running
  assert_bound_guard_journal_unchanged "$state"
}

bind_process_evidence_to_state() {
  local state=$1 key=$2 evidence=$3 expected_invocation=${4:-} expected_boot=${5:-}
  local expected_controller_pid=${6:-} expected_child_pid=${7:-} expected_phase temp stdout_file stderr_file
  case "$key" in
    guardEvidence) expected_phase=guard-exited ;;
    authorizationEvidence) expected_phase=authorization-running ;;
    closureEvidence) expected_phase=closure-running ;;
    sourceRecoveryEvidence) expected_phase=source-recovery-running ;;
    *) die "invalid controller evidence key: $key" ;;
  esac
  validate_controller_state "$state"
  validate_process_evidence "$evidence" "$expected_phase" "$expected_invocation" \
    "$expected_boot" "$expected_controller_pid" "$expected_child_pid"
  stdout_file=$(jq -er '.stdout' "$evidence")
  stderr_file=$(jq -er '.stderr' "$evidence")
  temp=$(mktemp "$(dirname "$state")/.controller-evidence.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq \
    --arg key "$key" \
    --arg path "$evidence" \
    --arg sha256 "$(sha256_file "$evidence")" \
    --arg stdout "$stdout_file" \
    --arg stdoutSha256 "$(jq -er '.stdoutSha256' "$evidence")" \
    --arg stderr "$stderr_file" \
    --arg stderrSha256 "$(jq -er '.stderrSha256' "$evidence")" '
      .[$key] = {
        path: $path,
        sha256: $sha256,
        stdout: {path: $stdout, sha256: $stdoutSha256},
        stderr: {path: $stderr, sha256: $stderrSha256}
      } |
      .updatedAt = (now | todateiso8601)
    ' "$state" > "$temp"
  write_controller_state_atomic "$state" "$temp"
  trap - RETURN
}

bind_guard_journal_to_state() {
  local state=$1 journal=$2 temp journal_sha phase mode run_id
  assert_owned_regular_file "$journal"
  [[ $(stat -c '%a' "$journal") == 600 ]] || die 'completed guard journal mode must be 0600'
  phase=$(jq -er '.phase' "$journal")
  [[ "$phase" == complete ]] || die 'guard exited successfully without complete evidence'
  mode=$(jq -er '.mode' "$journal")
  run_id=$(jq -er '.runId // ""' "$journal")
  fsync_path "$journal"
  fsync_path "$(dirname "$journal")"
  journal_sha=$(sha256_file "$journal")
  temp=$(mktemp "$(dirname "$state")/.controller-guard-journal.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq \
    --arg path "$journal" \
    --arg sha256 "$journal_sha" \
    --arg phase "$phase" \
    --arg mode "$mode" \
    --arg runId "$run_id" '
      .guardJournalEvidence = {
        path: $path,
        sha256: $sha256,
        phase: $phase,
        mode: $mode,
        runId: $runId
      } |
      .updatedAt = (now | todateiso8601)
    ' "$state" > "$temp"
  write_controller_state_atomic "$state" "$temp"
  trap - RETURN
}

assert_bound_guard_journal_unchanged() {
  local state=$1 path expected_sha
  path=$(jq -er '.guardJournalEvidence.path' "$state")
  expected_sha=$(jq -er '.guardJournalEvidence.sha256' "$state")
  [[ "$path" == "$(jq -er '.guardJournal' "$state")" ]] ||
    die 'bound guard journal path does not match the prepared journal'
  assert_owned_regular_file "$path"
  [[ $(stat -c '%a' "$path") == 600 ]] || die 'bound guard journal mode must be 0600'
  [[ $(jq -er '.phase' "$path") == complete ]] || die 'bound guard journal is no longer complete'
  [[ $(sha256_file "$path") == "$expected_sha" ]] || die 'bound guard journal digest changed'
}

begin_closure_incident() {
  local state=$1 failure_class=$2
  if ! update_controller_phase "$state" closure-stop-pending "closure-$failure_class"; then
    # Even if the durable intent write fails, attempt to remove the writer
    # before returning the storage failure to the operator.
    stop_application_fail_closed || true
    die 'could not persist closure incident; application stop was attempted'
  fi
  complete_closure_stop_pending "$state"
}

begin_closure_evidence_pending() {
  local state=$1 failure_class=$2
  # Persist stop intent first. A crash or failed stop verification remains in
  # closure-stop-pending, whose recovery path retries the fail-closed stop.
  update_controller_phase "$state" closure-stop-pending "closure-$failure_class"
  if ! stop_application_fail_closed; then
    return 1
  fi
  # Only a verified stopped writer may enter the evidence-retry phase.
  update_controller_phase "$state" closure-evidence-pending "closure-$failure_class"
}

complete_closure_evidence_pending() {
  local state=$1 evidence=$2 expected_invocation=${3:-} expected_boot=${4:-}
  local expected_controller_pid=${5:-} expected_child_pid=${6:-} incident_class
  incident_class=$(jq -er '.incidentClass' "$state")
  bind_process_evidence_to_state "$state" closureEvidence "$evidence" \
    "$expected_invocation" "$expected_boot" "$expected_controller_pid" "$expected_child_pid"
  update_controller_phase "$state" incident "$incident_class"
}

complete_closure_stop_pending() {
  local state=$1 incident_class
  incident_class=$(jq -er '.incidentClass' "$state")
  # Do not depend on errexit here: callers intentionally invoke recovery from
  # conditional contexts where Bash suppresses it for the entire call stack.
  if ! stop_application_fail_closed; then
    return 1
  fi
  update_controller_phase "$state" incident "$incident_class"
}

commit_closure_outcome() {
  local state=$1 evidence=$2 failure_class=$3 other_failures=$4
  local expected_invocation=${5:-} expected_boot=${6:-} expected_controller_pid=${7:-}
  local expected_child_pid=${8:-} action exit_code phase
  validate_controller_state "$state"
  validate_process_evidence "$evidence" closure-running "$expected_invocation" \
    "$expected_boot" "$expected_controller_pid" "$expected_child_pid"
  phase=$(jq -er '.phase' "$state")
  [[ "$phase" == closure-running ]] || die "closure outcome requires closure-running state, found $phase"
  [[ "$other_failures" =~ ^[0-9]+$ ]] || die 'closure failure count must be a non-negative integer'
  exit_code=$(jq -er '.exitCode' "$evidence")

  if [[ "$failure_class" == none && "$other_failures" == 0 && "$exit_code" == 0 ]]; then
    jq -e '.guardEvidence.path | type == "string" and startswith("/")' "$state" >/dev/null ||
      die 'complete state requires bound guard evidence'
    assert_bound_guard_journal_unchanged "$state"
    abort_if_interrupted || return $?
    bind_process_evidence_to_state "$state" closureEvidence "$evidence" \
      "$expected_invocation" "$expected_boot" "$expected_controller_pid" "$expected_child_pid"
    abort_if_interrupted || return $?
    assert_bound_guard_journal_unchanged "$state"
    if [[ -n ${NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE:-} ]]; then
      handle_controller_signal "$NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE"
    fi
    abort_if_interrupted || return $?
    # The completed journal and controller state form one publication while the
    # shared engine-volume lock excludes every cooperating transition actor.
    # A non-cooperating same-UID writer is outside this controller's trust
    # boundary and requires a separate publication identity/capability.
    assert_operation_lock_held \
      "$(jq -er '.engineId' "$state")" \
      "$(jq -er '.volume' "$state")" \
      "$(jq -er '.lockRoot' "$state")"
    assert_bound_guard_journal_unchanged "$state"
    if update_controller_phase "$state" complete; then
      return 0
    else
      return $?
    fi
  fi

  action=$(classify_closure_failure "$failure_class" "$other_failures")
  if [[ "$action" == completed-journal-revalidate ]]; then
    revalidate_completed_guard_journal "$state" "$evidence"
    return
  fi

  begin_closure_evidence_pending "$state" "$failure_class"
  complete_closure_evidence_pending "$state" "$evidence" \
    "$expected_invocation" "$expected_boot" "$expected_controller_pid" "$expected_child_pid"
}

sanitize_execution_environment() {
  local docker_host=$1 fixed_path=$2 controller_home=$3 ambient_name

  while IFS= read -r ambient_name; do
    case "$ambient_name" in
      DOCKER_*|COMPOSE_*) unset "$ambient_name" ;;
    esac
  done < <(compgen -v)
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
  unset BASH_ENV ENV CDPATH GLOBIGNORE
  unset NOOSPHERE_A2B_LOCK_FD NOOSPHERE_A2B_LOCK_PATH
  unset NOOSPHERE_CONTROLLER_FIXTURE_ROOT
  if [[ ${controller_test_hooks_enabled:-false} != true ]]; then
    unset NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT
    unset NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN
    unset NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE
    unset NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION
    unset NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE
    unset NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD
  fi
  if [[ ${controller_test_hooks_enabled:-false} == true && -n ${controller_fixture_root:-} ]]; then
    export NOOSPHERE_CONTROLLER_FIXTURE_ROOT=$controller_fixture_root
  fi

  export HOME=$controller_home
  export DOCKER_CONFIG="$controller_home/docker"
  export DOCKER_HOST=$docker_host
  export COMPOSE_DISABLE_ENV_FILE=1
  export PATH=$fixed_path
}

assert_controller_artifact_paths_separate() {
  local state_document=$1 state_path=$2 preparation_manifest=${3:-}
  local base field controlled_path bound_path docker_config_dir namespace_path
  local bound_index other_bound_index
  local -a controlled=() bound=()
  base=${state_path%.json}
  controlled=(
    "$state_path"
    "$base.guard.stdout.log"
    "$base.guard.stderr.log"
    "$base.guard.evidence.json"
    "$base.authorization.stdout.log"
    "$base.authorization.stderr.log"
    "$base.authorization.evidence.json"
    "$base.verify.stdout.log"
    "$base.verify.stderr.log"
    "$base.verify.evidence.json"
    "$base.source-recovery.stdout.log"
    "$base.source-recovery.stderr.log"
    "$base.source-recovery.evidence.json"
    "$base.writer-stop.evidence.json"
  )
  # Invocation-suffixed variants are the paths a later invocation actually
  # uses once canonical artifacts exist (select_process_artifact_base), so
  # they join the same separation contract whenever an InvocationID is set.
  if [[ -n ${INVOCATION_ID:-} ]]; then
    [[ "$INVOCATION_ID" =~ ^[A-Za-z0-9_.-]+$ ]] ||
      die 'systemd InvocationID is unsafe for evidence paths'
    controlled+=(
      "$base.$INVOCATION_ID.guard.stdout.log"
      "$base.$INVOCATION_ID.guard.stderr.log"
      "$base.$INVOCATION_ID.guard.evidence.json"
      "$base.$INVOCATION_ID.authorization.stdout.log"
      "$base.$INVOCATION_ID.authorization.stderr.log"
      "$base.$INVOCATION_ID.authorization.evidence.json"
      "$base.$INVOCATION_ID.verify.stdout.log"
      "$base.$INVOCATION_ID.verify.stderr.log"
      "$base.$INVOCATION_ID.verify.evidence.json"
      "$base.$INVOCATION_ID.source-recovery.stdout.log"
      "$base.$INVOCATION_ID.source-recovery.stderr.log"
      "$base.$INVOCATION_ID.source-recovery.evidence.json"
      "$base.$INVOCATION_ID.writer-stop.evidence.json"
    )
  fi
  [[ -z "$preparation_manifest" ]] || bound+=("$preparation_manifest")
  for field in liveCompose sourceSnapshot candidateCompose envFile controllerPath guard verifier \
    dockerPath composePluginPath guardJournal; do
    bound+=("$(jq -er --arg field "$field" '.[$field]' "$state_document")")
  done
  bound+=("$(jq -er '.controllerHome' "$state_document")/docker/config.json")
  docker_config_dir=$(realpath -m "$(jq -er '.controllerHome' "$state_document")/docker")

  for controlled_path in "${controlled[@]}"; do
    for bound_path in "${bound[@]}"; do
      [[ "$(realpath -m "$controlled_path")" != "$(realpath -m "$bound_path")" ]] ||
        die 'controller state/log/evidence path collides with a bound transition input'
    done
  done
  for ((bound_index = 0; bound_index < ${#bound[@]}; bound_index += 1)); do
    for ((other_bound_index = bound_index + 1; other_bound_index < ${#bound[@]}; other_bound_index += 1)); do
      [[ "$(realpath -m "${bound[$bound_index]}")" != "$(realpath -m "${bound[$other_bound_index]}")" ]] ||
        die 'bound transition inputs collide with each other'
    done
  done
  for namespace_path in "${controlled[@]}" \
    "$(jq -er '.backupDir' "$state_document")" \
    "$(jq -er '.lockRoot' "$state_document")"; do
    namespace_path=$(realpath -m "$namespace_path")
    [[ "$namespace_path" != "$docker_config_dir" &&
       "$namespace_path" != "$docker_config_dir"/* &&
       "$docker_config_dir" != "$namespace_path"/* ]] ||
      die 'controller artifact namespace collides with the one-file Docker config directory'
  done
  for ((field = 0; field < ${#controlled[@]}; field += 1)); do
    for ((base = field + 1; base < ${#controlled[@]}; base += 1)); do
      [[ "$(realpath -m "${controlled[$field]}")" != "$(realpath -m "${controlled[$base]}")" ]] ||
        die 'controller state/log/evidence paths collide with each other'
    done
  done
}

select_process_artifact_base() {
  local state=$1 role=$2 base candidate invocation
  base=${state%.json}
  candidate=$base
  if path_present "$base.$role.stdout.log" ||
     path_present "$base.$role.stderr.log" ||
     path_present "$base.$role.evidence.json"; then
    invocation=${INVOCATION_ID:?systemd InvocationID is required for recovery evidence}
    [[ "$invocation" =~ ^[A-Za-z0-9_.-]+$ ]] || die 'systemd InvocationID is unsafe for evidence paths'
    candidate="$base.$invocation"
    ! path_present "$candidate.$role.stdout.log" &&
      ! path_present "$candidate.$role.stderr.log" &&
      ! path_present "$candidate.$role.evidence.json" ||
      die 'process evidence path for this systemd invocation already exists'
  fi
  [[ "$candidate" == /* ]] || die 'process artifact base must be absolute'
  printf '%s\n' "$candidate"
}

assert_guard_journal_path() {
  local state=$1 backup_dir volume journal expected
  backup_dir=$(jq -er '.backupDir' "$state")
  volume=$(jq -er '.volume' "$state")
  journal=$(jq -er '.guardJournal' "$state")
  expected="$backup_dir/$volume.phase-a2b.json"
  [[ $(realpath -m "$journal") == "$(realpath -m "$expected")" ]] ||
    die 'guard journal path does not match the pinned guard path'
}

validate_execution_manifest() {
  local state=$1
  validate_controller_state "$state"
  jq -e '
    (.guard | type == "string" and startswith("/")) and
    (.guardSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.controllerPath | type == "string" and startswith("/")) and
    (.controllerSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.guardArgs | type == "array" and length > 0 and
      all(.[]; (type == "string") and (test("[\u0000-\u001f]") | not))) and
    (.verifier | type == "string" and startswith("/")) and
    (.verifierSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.candidateCompose | type == "string" and startswith("/")) and
    (.envFile | type == "string" and startswith("/")) and
    (.envFileSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.dockerPath | type == "string" and startswith("/")) and
    (.dockerSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.dockerComposeVersionSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.composePluginPath | type == "string" and startswith("/")) and
    (.composePluginSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.dockerConfigSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.effectiveComposeSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.backupDir | type == "string" and startswith("/")) and
    (.lockRoot | type == "string" and startswith("/")) and
    (.controllerHome | type == "string" and startswith("/")) and
    (.fixedPath | type == "string" and test("^(/[A-Za-z0-9._-]+)+(:(/[A-Za-z0-9._-]+)+)*$")) and
    (.dbContainer | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and
    (.appContainer | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and
    (.authorizationVolume | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and
    (.appUrl | type == "string" and test("^http://127[.]0[.]0[.]1:[1-9][0-9]{0,4}$")) and
    ((.appUrl | split(":")[-1] | tonumber) <= 65535) and
    (.platform == "linux/amd64" or .platform == "linux/arm64")
  ' "$state" >/dev/null || die 'execution manifest is malformed'
  assert_guard_journal_path "$state"
  validate_guard_arguments "$state"
}

assert_controller_execution_identity() {
  local state=$1 recorded_path expected
  recorded_path=$(jq -er '.controllerPath' "$state")
  expected=$(jq -er '.controllerSha256' "$state")
  [[ $(realpath "$recorded_path") == "$CONTROLLER_EXECUTABLE_PATH" ]] ||
    die 'prepared controller path does not match the executing controller'
  assert_owned_regular_file "$CONTROLLER_EXECUTABLE_PATH"
  [[ $(sha256_file "$CONTROLLER_EXECUTABLE_PATH") == "$expected" ]] ||
    die 'controller executable digest changed after preparation'
}

validate_guard_arguments() {
  local state=$1 option value index=0
  local -a args=()
  local -A seen=() values=()
  mapfile -d '' -t args < <(jq -j '.guardArgs[] | ., "\u0000"' "$state")
  while ((index < ${#args[@]})); do
    option=${args[$index]}
    case "$option" in
      --defer-app-restart)
        [[ -z ${seen[$option]:-} ]] || die "duplicate guard argument: $option"
        seen[$option]=1
        ((index += 1))
        ;;
      --compose-file|--env-file|--db-container|--app-container|--volume|--authorization-volume|--backup-dir|--platform)
        [[ -z ${seen[$option]:-} ]] || die "duplicate guard argument: $option"
        ((index + 1 < ${#args[@]})) || die "guard argument requires a value: $option"
        value=${args[$((index + 1))]}
        [[ "$value" != --* ]] || die "guard argument requires a value: $option"
        seen[$option]=1
        values[$option]=$value
        ((index += 2))
        ;;
      --prepare-new-install|--record-new-install|--authorize-writer|--db-service)
        die "guard argument is incompatible with a source transition: $option"
        ;;
      *) die "unsupported guard argument: $option" ;;
    esac
  done
  for option in --compose-file --env-file --db-container --app-container --volume \
    --authorization-volume --backup-dir --platform; do
    [[ -n ${seen[$option]:-} ]] || die "required guard argument is missing: $option"
  done
  [[ -n ${seen[--defer-app-restart]:-} ]] ||
    die 'guard invocation must defer application restart until durable closure'
  [[ ${values[--compose-file]} == "$(jq -er '.liveCompose' "$state")" ]] || die 'guard Compose path does not match the manifest'
  [[ ${values[--env-file]} == "$(jq -er '.envFile' "$state")" ]] || die 'guard environment path does not match the manifest'
  [[ ${values[--db-container]} == "$(jq -er '.dbContainer' "$state")" ]] || die 'guard database container does not match the manifest'
  [[ ${values[--app-container]} == "$(jq -er '.appContainer' "$state")" ]] || die 'guard app container does not match the manifest'
  [[ ${values[--volume]} == "$(jq -er '.volume' "$state")" ]] || die 'guard volume does not match the manifest'
  [[ ${values[--authorization-volume]} == "$(jq -er '.authorizationVolume' "$state")" ]] || die 'guard authorization volume does not match the manifest'
  [[ ${values[--backup-dir]} == "$(jq -er '.backupDir' "$state")" ]] || die 'guard backup directory does not match the manifest'
  [[ ${values[--platform]} == "$(jq -er '.platform' "$state")" ]] || die 'guard platform does not match the manifest'
}

query_compose_plugin_path() {
  local docker_path=$1
  "$docker_path" info --format '{{json .ClientInfo.Plugins}}' |
    jq -er '[.[] | select(.Name == "compose") | .Path] | if length == 1 then .[0] else error("Compose plugin identity is ambiguous") end'
}

assert_private_docker_config() {
  local controller_home=$1 config_dir config_file
  config_dir="$controller_home/docker"
  config_file="$config_dir/config.json"
  assert_owned_private_directory "$config_dir"
  assert_owned_regular_file "$config_file"
  [[ $(stat -c '%a' "$config_file") == 600 ]] || die 'Docker config mode must be 0600'
  [[ $(find -P "$config_dir" -mindepth 1 -maxdepth 1 -printf x | wc -c) == 1 ]] ||
    die 'Docker config directory must contain only the recorded config.json'
}

compose_model_signature() {
  local state=$1 docker_path candidate env_file
  docker_path=$(jq -er '.dockerPath' "$state")
  candidate=$(jq -er '.candidateCompose' "$state")
  env_file=$(jq -er '.envFile' "$state")
  "$docker_path" compose --env-file "$env_file" -f "$candidate" config --no-interpolate |
    sha256sum | awk '{print $1}'
}

verify_execution_inputs() {
  local state=$1 field path_field digest_field path expected docker_path plugin_path config_path
  validate_execution_manifest "$state"
  assert_controller_execution_identity "$state"
  assert_owned_private_directory "$(dirname "$state")"
  assert_owned_private_directory "$(jq -er '.backupDir' "$state")"
  assert_owned_private_directory "$(jq -er '.lockRoot' "$state")"
  assert_owned_private_directory "$(jq -er '.controllerHome' "$state")"
  assert_trusted_fixed_path "$(jq -er '.fixedPath' "$state")"
  assert_private_docker_config "$(jq -er '.controllerHome' "$state")"
  for field in guard verifier candidateCompose envFile; do
    case "$field" in
      guard) path_field=guard; digest_field=guardSha256 ;;
      verifier) path_field=verifier; digest_field=verifierSha256 ;;
      candidateCompose) path_field=candidateCompose; digest_field=candidateComposeSha256 ;;
      envFile) path_field=envFile; digest_field=envFileSha256 ;;
    esac
    path=$(jq -er --arg field "$path_field" '.[$field]' "$state")
    expected=$(jq -er --arg field "$digest_field" '.[$field]' "$state")
    assert_owned_regular_file "$path"
    [[ $(sha256_file "$path") == "$expected" ]] || die "$field digest changed after preparation"
  done
  docker_path=$(jq -er '.dockerPath' "$state")
  [[ -f "$docker_path" && -x "$docker_path" && ! -L "$docker_path" ]] || die 'recorded Docker executable is unsafe'
  [[ $(sha256_file "$docker_path") == "$(jq -er '.dockerSha256' "$state")" ]] || die 'Docker executable digest changed after preparation'
  plugin_path=$(jq -er '.composePluginPath' "$state")
  [[ -f "$plugin_path" && -x "$plugin_path" && ! -L "$plugin_path" ]] || die 'recorded Docker Compose plugin is unsafe'
  [[ $(sha256_file "$plugin_path") == "$(jq -er '.composePluginSha256' "$state")" ]] || die 'Docker Compose plugin digest changed after preparation'
  [[ $(query_compose_plugin_path "$docker_path") == "$plugin_path" ]] || die 'Docker Compose plugin path changed after preparation'
  config_path="$(jq -er '.controllerHome' "$state")/docker/config.json"
  [[ $(sha256_file "$config_path") == "$(jq -er '.dockerConfigSha256' "$state")" ]] || die 'Docker config changed after preparation'
  [[ $("$docker_path" compose version --short | sha256sum | awk '{print $1}') == "$(jq -er '.dockerComposeVersionSha256' "$state")" ]] ||
    die 'Docker Compose version changed after preparation'
  [[ $(compose_model_signature "$state") == "$(jq -er '.effectiveComposeSha256' "$state")" ]] ||
    die 'effective candidate Compose model changed after preparation'
}

copy_execution_input() {
  local source=$1 target=$2 expected=$3 mode=$4 owner_policy=${5:-caller}
  local source_owner source_mode
  case "$owner_policy" in
    caller)
      assert_owned_regular_file "$source"
      ;;
    system-executable)
      [[ -f "$source" && ! -L "$source" ]] ||
        die "required system executable is missing or unsafe: $source"
      source_owner=$(stat -c '%u' "$source")
      [[ "$source_owner" == 0 || "$source_owner" == "$(id -u)" ]] ||
        die "system executable has an untrusted owner: $source"
      source_mode=$(stat -c '%a' "$source")
      (( (8#$source_mode & 8#022) == 0 )) ||
        die "system executable permits group/world writes: $source"
      ;;
    *) die "unknown execution-input owner policy: $owner_policy" ;;
  esac
  install -m "$mode" "$source" "$target"
  fsync_path "$target"
  [[ $(sha256_file "$target") == "$expected" ]] ||
    die "execution input changed while binding: $source"
}

create_execution_bundle() {
  local state=$1 base config_source docker_host fixed_path
  [[ ${INVOCATION_ID:-} =~ ^[a-fA-F0-9]{32}$ ]] ||
    die 'execution input binding requires a systemd InvocationID'
  base="${state%.json}.inputs.$INVOCATION_ID"
  ! path_present "$base" || die "execution input bundle already exists: $base"
  mkdir -m 700 "$base"
  mkdir -m 700 "$base/home" "$base/home/docker" "$base/home/docker/cli-plugins"

  execution_guard="$base/guard"
  execution_verifier="$base/verifier"
  execution_candidate_compose="$base/candidate-compose.yml"
  execution_source_snapshot="$base/source-compose.yml"
  execution_env_file="$base/runtime.env"
  execution_docker_path="$base/docker"
  execution_compose_plugin="$base/home/docker/cli-plugins/docker-compose"
  execution_controller_home="$base/home"

  copy_execution_input "$(jq -er '.guard' "$state")" "$execution_guard" \
    "$(jq -er '.guardSha256' "$state")" 700
  copy_execution_input "$(jq -er '.verifier' "$state")" "$execution_verifier" \
    "$(jq -er '.verifierSha256' "$state")" 700
  copy_execution_input "$(jq -er '.candidateCompose' "$state")" "$execution_candidate_compose" \
    "$(jq -er '.candidateComposeSha256' "$state")" "$(stat -c '%a' "$(jq -er '.candidateCompose' "$state")")"
  copy_execution_input "$(jq -er '.sourceSnapshot' "$state")" "$execution_source_snapshot" \
    "$(jq -er '.sourceSnapshotSha256' "$state")" "$(stat -c '%a' "$(jq -er '.sourceSnapshot' "$state")")"
  copy_execution_input "$(jq -er '.envFile' "$state")" "$execution_env_file" \
    "$(jq -er '.envFileSha256' "$state")" 600
  copy_execution_input "$(jq -er '.dockerPath' "$state")" "$execution_docker_path" \
    "$(jq -er '.dockerSha256' "$state")" 700 system-executable
  copy_execution_input "$(jq -er '.composePluginPath' "$state")" "$execution_compose_plugin" \
    "$(jq -er '.composePluginSha256' "$state")" 700 system-executable
  config_source="$(jq -er '.controllerHome' "$state")/docker/config.json"
  copy_execution_input "$config_source" "$execution_controller_home/docker/config.json" \
    "$(jq -er '.dockerConfigSha256' "$state")" 600
  fsync_path "$base/home/docker/cli-plugins"
  fsync_path "$base/home/docker"
  fsync_path "$base/home"
  fsync_path "$base"
  fsync_path "$(dirname "$base")"

  docker_host=$(jq -er '.dockerEndpoint' "$state")
  fixed_path=$(jq -er '.fixedPath' "$state")
  [[ $(DOCKER_CONFIG="$execution_controller_home/docker" DOCKER_HOST="$docker_host" \
      "$execution_docker_path" info --format '{{json .ClientInfo.Plugins}}' | \
      jq -er '[.[] | select(.Name == "compose") | .Path] | if length == 1 then .[0] else error("Compose plugin identity is ambiguous") end') == \
      "$execution_compose_plugin" ]] ||
    die 'bound Docker Compose plugin path does not match the execution bundle'
  [[ $(DOCKER_CONFIG="$execution_controller_home/docker" DOCKER_HOST="$docker_host" \
      "$execution_docker_path" compose version --short | sha256sum | awk '{print $1}') == \
      "$(jq -er '.dockerComposeVersionSha256' "$state")" ]] ||
    die 'bound Docker Compose version differs from the prepared identity'
  [[ $(DOCKER_CONFIG="$execution_controller_home/docker" DOCKER_HOST="$docker_host" \
      "$execution_docker_path" compose --env-file "$execution_env_file" \
      -f "$execution_candidate_compose" config --no-interpolate | sha256sum | awk '{print $1}') == \
      "$(jq -er '.effectiveComposeSha256' "$state")" ]] ||
    die 'bound candidate Compose model differs from the prepared model'
  PATH="$(dirname "$execution_docker_path"):$fixed_path" command -v docker >/dev/null ||
    die 'bound Docker executable is absent from the child PATH'
}

prepare_execution_state() {
  local manifest=$1 state=$2 guard_journal docker_host fixed_path controller_home
  local engine_id volume lock_root volume_fingerprint prepared authority_root
  assert_owned_regular_file "$manifest"
  [[ $(stat -c '%a' "$manifest") == 600 ]] || die 'preparation manifest mode must be 0600'
  assert_owned_private_directory "$(dirname "$state")"
  acquire_preparation_lock "$state"
  after_preparation_lock
  validate_execution_manifest "$manifest"
  assert_controller_execution_identity "$manifest"
  assert_controller_artifact_paths_separate "$manifest" "$state" "$manifest"
  docker_host=$(jq -er '.dockerEndpoint' "$manifest")
  fixed_path=$(jq -er '.fixedPath' "$manifest")
  controller_home=$(jq -er '.controllerHome' "$manifest")
  # Validate with the fixed bootstrap toolchain before manifest-controlled
  # PATH bytes can influence any command resolution.
  assert_trusted_fixed_path "$fixed_path"
  sanitize_execution_environment "$docker_host" "$fixed_path" "$controller_home"
  [[ $(jq -er '.phase' "$manifest") == prepared ]] || die 'preparation manifest must start in prepared phase'
  engine_id=$(jq -er '.engineId' "$manifest")
  volume=$(jq -er '.volume' "$manifest")
  lock_root=$(jq -er '.lockRoot' "$manifest")
  acquire_operation_lock "$engine_id" "$volume" "$lock_root"
  authority_root=$(claim_authoritative_state_path "$state" "$engine_id" "$volume" "$lock_root" prepare)
  assert_live_engine_binding "$manifest" "$(jq -er '.dockerPath' "$manifest")"
  verify_execution_inputs "$manifest"
  volume_fingerprint=$(query_postgres_volume_fingerprint "$(jq -er '.dockerPath' "$manifest")" "$volume")
  prepared=$(mktemp "$(dirname "$state")/.controller-prepared.XXXXXX")
  trap 'rm -f "$prepared"' RETURN
  jq --arg volumeFingerprint "$volume_fingerprint" \
     --arg authorityRoot "$authority_root" \
    '.volumeFingerprint = $volumeFingerprint | .authorityRoot = $authorityRoot' "$manifest" > "$prepared"
  validate_execution_manifest "$prepared"
  guard_journal=$(jq -er '.guardJournal' "$manifest")
  [[ $(realpath -m "$state") != "$(realpath -m "$guard_journal")" ]] ||
    die 'controller state path collides with the guard journal path'
  # Preparation is only ever a fresh start or an idempotent re-preparation.
  # Overwriting an active or terminal state would orphan its recovery
  # ownership and incident evidence.
  if path_present "$state"; then
    validate_controller_state "$state"
    [[ $(jq -er '.phase' "$state") == prepared ]] ||
      die "refusing to overwrite controller state in phase $(jq -er '.phase' "$state")"
    cmp -s "$state" "$prepared" ||
      die 'refusing to replace an existing prepared controller state with different bytes'
    trap - RETURN
    rm -f "$prepared"
    return 0
  fi
  write_controller_state_atomic "$state" "$prepared"
  trap - RETURN
}

capture_journal_cursor() {
  journalctl --user -u "$CONTROLLER_UNIT" -n 0 --show-cursor --no-pager |
    sed -n 's/^-- cursor: //p' | tail -1
}

record_controller_interruption() {
  local signal=$1 temp
  [[ -n ${controller_state:-} && -f ${controller_state:-} ]] || return 0
  temp=$(mktemp "$(dirname "$controller_state")/.controller-interrupt.XXXXXX")
  trap 'rm -f "$temp"' RETURN
  jq --arg signal "$signal" '.lastInterruption = {signal:$signal, at:(now | todateiso8601)}' \
    "$controller_state" > "$temp"
  write_controller_state_atomic "$controller_state" "$temp"
  trap - RETURN
}

persist_interrupted_state() {
  record_controller_interruption "$1"
}

delegate_to_guard_journal() {
  : # The execution loop sees resume_action=run-guard and invokes the pinned guard.
}

assert_source_state_unchanged() {
  local verifier
  verifier=${execution_verifier:-$(jq -er '.verifier' "$controller_state")}
  run_source_verifier_hermetic "$controller_state" "$verifier" >/dev/null
}

stop_application_fail_closed() {
  local docker_path app_container running stop_evidence stop_temp stopped_at
  docker_path=${execution_docker_path:-$(jq -er '.dockerPath' "$controller_state")}
  app_container=$(jq -er '.appContainer' "$controller_state")
  "$docker_path" stop --time 60 "$app_container" >/dev/null 2>&1 ||
    die "failed to stop application container $app_container"
  running=$("$docker_path" inspect --format '{{.State.Running}}' "$app_container" 2>/dev/null) ||
    die "could not verify stopped application container $app_container"
  [[ "$running" == false ]] ||
    die "application container remains running after stop: $app_container"
  # Every inspect-verified stop is durably evidenced and bound to the state so
  # closure-evidence-pending and closure-incident phases carry their owned
  # writer-stop proof. A failure to persist the proof is fatal: the stop itself
  # succeeded, but the state must not advance without its owned evidence.
  stopped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Retry-distinct allocation: the first stop owns the canonical evidence
  # path; a later invocation that finds it allocates InvocationID-suffixed
  # paths so a prior truthful stop record is never overwritten.
  stop_evidence="$(select_process_artifact_base "${controller_state%.json}" writer-stop).writer-stop.evidence.json"
  stop_temp=$(mktemp "$(dirname "$controller_state")/.writer-stop-evidence.XXXXXX")
  trap 'rm -f "$stop_temp"' RETURN
  jq -n \
    --arg phase "$(jq -er '.phase // ""' "$controller_state")" \
    --arg container "$app_container" \
    --arg stoppedAt "$stopped_at" \
    --arg invocationId "${INVOCATION_ID:-}" \
    --arg bootId "$(</proc/sys/kernel/random/boot_id)" \
    --argjson controllerMainPid "${systemd_controller_main_pid:-0}" '
      {version:1,phase:$phase,container:$container,stopExitCode:0,
       inspectRunning:false,stoppedAt:$stoppedAt,invocationId:$invocationId,
       bootId:$bootId,controllerMainPid:$controllerMainPid}
    ' > "$stop_temp"
  chmod 0600 "$stop_temp"
  fsync_path "$stop_temp"
  mv -f "$stop_temp" "$stop_evidence"
  fsync_path "$(dirname "$stop_evidence")"
  trap - RETURN
  stop_temp=$(mktemp "$(dirname "$controller_state")/.controller-evidence.XXXXXX")
  trap 'rm -f "$stop_temp"' RETURN
  jq --arg path "$stop_evidence" --arg sha256 "$(sha256_file "$stop_evidence")" '
    .writerStopEvidence = {path:$path, sha256:$sha256}
  ' "$controller_state" > "$stop_temp"
  write_controller_state_atomic "$controller_state" "$stop_temp"
  trap - RETURN
}

activate_application_for_verification() {
  local state=$1 docker_path app_container running project_directory
  docker_path=${execution_docker_path:-$(jq -er '.dockerPath' "$state")}
  app_container=$(jq -er '.appContainer' "$state")
  running=$("$docker_path" inspect --format '{{.State.Running}}' "$app_container" 2>/dev/null) ||
    die "could not inspect application container before activation: $app_container"
  [[ "$running" == true || "$running" == false ]] ||
    die "application container has an invalid running state: $app_container"
  [[ "$running" == false ]] || return 0

  project_directory=$(dirname "$(jq -er '.liveCompose' "$state")")
  "$docker_path" compose \
    --project-directory "$project_directory" \
    --env-file "$execution_env_file" \
    -f "$execution_candidate_compose" \
    up -d --no-deps --force-recreate app >/dev/null ||
    return 1
  running=$("$docker_path" inspect --format '{{.State.Running}}' "$app_container" 2>/dev/null) ||
    return 1
  [[ "$running" == true ]]
}

revalidate_completed_guard_journal() {
  local state=$1
  update_controller_phase "$state" closure-stop-pending isolated-app-health-requires-guard-revalidation
  complete_closure_stop_pending "$state"
}

# Default systemd identity source. Focused fixtures override this function;
# production resolves the live unit state from systemd itself.
query_systemd_unit_identity() {
  systemctl --user show "$CONTROLLER_UNIT" \
    --property=ActiveState,InvocationID,MainPID,Type,RemainAfterExit,Restart,KillMode,TimeoutStartUSec,TimeoutStopUSec,RuntimeMaxUSec,UMask,Transient,WorkingDirectory 2>/dev/null
}

query_user_linger() {
  loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null
}

require_systemd_execution_context() {
  [[ ${INVOCATION_ID:-} =~ ^[a-fA-F0-9]{32}$ ]] || die 'execution requires a systemd InvocationID'
  [[ ${CONTROLLER_UNIT:-} =~ ^[A-Za-z0-9_.@:-]+\.service$ ]] || die 'execution requires an explicit systemd service unit'
  # Environment variables are only claims: bind them to the queried unit so a
  # inherited or forged environment cannot satisfy the execution boundary.
  local queried q_active q_invocation q_main_pid q_type q_remain q_restart q_kill_mode
  local q_timeout_start q_timeout_stop q_runtime_max q_umask q_transient q_working_directory
  local expected_working_directory linger
  queried=$(query_systemd_unit_identity) ||
    die "could not query systemd identity for unit $CONTROLLER_UNIT"
  q_active=$(sed -n 's/^ActiveState=//p' <<<"$queried" | head -n 1)
  q_invocation=$(sed -n 's/^InvocationID=//p' <<<"$queried" | head -n 1)
  q_main_pid=$(sed -n 's/^MainPID=//p' <<<"$queried" | head -n 1)
  q_type=$(sed -n 's/^Type=//p' <<<"$queried" | head -n 1)
  q_remain=$(sed -n 's/^RemainAfterExit=//p' <<<"$queried" | head -n 1)
  q_restart=$(sed -n 's/^Restart=//p' <<<"$queried" | head -n 1)
  q_kill_mode=$(sed -n 's/^KillMode=//p' <<<"$queried" | head -n 1)
  q_timeout_start=$(sed -n 's/^TimeoutStartUSec=//p' <<<"$queried" | head -n 1)
  q_timeout_stop=$(sed -n 's/^TimeoutStopUSec=//p' <<<"$queried" | head -n 1)
  q_runtime_max=$(sed -n 's/^RuntimeMaxUSec=//p' <<<"$queried" | head -n 1)
  q_umask=$(sed -n 's/^UMask=//p' <<<"$queried" | head -n 1)
  q_transient=$(sed -n 's/^Transient=//p' <<<"$queried" | head -n 1)
  q_working_directory=$(sed -n 's/^WorkingDirectory=//p' <<<"$queried" | head -n 1)
  expected_working_directory=$(dirname "$(jq -er '.liveCompose' "$controller_state")")
  [[ "$q_active" == active ]] ||
    die "systemd unit $CONTROLLER_UNIT is not active (found ${q_active:-unknown})"
  [[ -n "$q_invocation" && "$q_invocation" == "$INVOCATION_ID" ]] ||
    die 'environment InvocationID does not match the queried systemd unit'
  [[ "$q_main_pid" =~ ^[0-9]+$ && "$q_main_pid" == "$$" ]] ||
    die 'systemd MainPID does not match this controller process'
  [[ "$q_type" == exec && "$q_remain" == no && "$q_restart" == no ]] ||
    die 'systemd unit type/restart policy does not match the controller contract'
  [[ "$q_kill_mode" == mixed ]] || die 'systemd KillMode must be mixed'
  [[ "$q_timeout_start" == infinity && "$q_timeout_stop" == infinity && "$q_runtime_max" == infinity ]] ||
    die 'systemd unit time limits must be infinite'
  [[ "$q_umask" == 0077 ]] || die 'systemd unit UMask must be 0077'
  [[ "$q_transient" == yes ]] || die 'systemd unit must be transient'
  [[ "$q_working_directory" == "$expected_working_directory" ]] ||
    die 'systemd WorkingDirectory does not match the prepared Compose directory'
  linger=$(query_user_linger) || die 'could not query user-manager linger state'
  [[ "$linger" == yes ]] || die 'persistent user manager requires linger=yes'
  systemd_controller_main_pid=$q_main_pid
}

execute_prepared_state() {
  local state=$1 engine_id volume lock_root docker_host fixed_path controller_home authority_root
  local candidate guard verifier guard_journal guard_stdout guard_stderr guard_evidence
  local authorization_stdout authorization_stderr authorization_evidence authorization_artifact_base
  local verify_stdout verify_stderr verify_evidence start_cursor end_cursor started_at ended_at
  local guard_exit=0 authorization_exit=0 verify_exit=0 postprocess_exit=0 boot_id phase guard_artifact_base verify_artifact_base
  local run_initial_guard=true run_authorization=true run_activation=true
  local resume_closure_evidence=false
  local -a guard_args authorization_args
  local ambient_test_hook
  controller_state=$state
  # Production execution fails closed before any state mutation when ambient
  # test hooks are present: hooks are honored only when the fixture marker is
  # explicitly enabled (set by the systemd identity shim in fixture mode), so
  # an inherited hook can never steer production evidence or the transition.
  if [[ ${controller_test_hooks_enabled:-false} != true ]]; then
    for ambient_test_hook in NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT \
                             NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_GUARD_SPAWN \
                             NOOSPHERE_CONTROLLER_TEST_FAIL_EVIDENCE \
                             NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION \
                             NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_COMPLETE \
                             NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD; do
      [[ -z ${!ambient_test_hook:-} ]] ||
        die "production execution rejected ambient test hook contamination: $ambient_test_hook is set; unset NOOSPHERE_CONTROLLER_TEST_* outside fixture mode"
    done
  fi
  validate_execution_manifest "$state"
  docker_host=$(jq -er '.dockerEndpoint' "$state")
  fixed_path=$(jq -er '.fixedPath' "$state")
  controller_home=$(jq -er '.controllerHome' "$state")
  # The recorded PATH cannot participate in validating its own trust.
  assert_trusted_fixed_path "$fixed_path"
  sanitize_execution_environment "$docker_host" "$fixed_path" "$controller_home"
  # Identity is queried through the hermetic PATH, never from the inherited one.
  require_systemd_execution_context
  assert_controller_artifact_paths_separate "$state" "$state"
  engine_id=$(jq -er '.engineId' "$state")
  volume=$(jq -er '.volume' "$state")
  lock_root=$(jq -er '.lockRoot' "$state")
  acquire_operation_lock "$engine_id" "$volume" "$lock_root"
  # Execution revalidates the engine-volume state authority: only the single
  # authoritative state path may execute, so a byte-identical copy at another
  # path is rejected before any state mutation or child process runs.
  authority_root=$(claim_authoritative_state_path "$state" "$engine_id" "$volume" "$lock_root" revalidate)
  [[ $(jq -er '.authorityRoot // empty' "$state") == "$authority_root" ]] ||
    die 'controller state was prepared under a different durable authority root; refusing execution'
  assert_live_engine_binding "$state" "$(jq -er '.dockerPath' "$state")"
  verify_execution_inputs "$state"
  assert_postgres_volume_binding "$state" "$(jq -er '.dockerPath' "$state")"
  create_execution_bundle "$state"
  boot_id=$(< /proc/sys/kernel/random/boot_id)
  controller_boot_id=$boot_id
  resume_action=''
  resume_controller_state "$state"
  case "$resume_action" in
    publish-and-run)
      candidate=$execution_candidate_compose
      publish_candidate_under_lock "$state" "$candidate" "$lock_root" "$execution_source_snapshot"
      ;;
    run-guard) ;;
    run-authorization) run_initial_guard=false ;;
    run-activation|run-closure)
      run_initial_guard=false
      run_authorization=false
      ;;
    run-closure-stopped)
      run_initial_guard=false
      run_authorization=false
      run_activation=false
      resume_closure_evidence=true
      ;;
    source-restored) return 1 ;;
    *) die "unsupported resume action: ${resume_action:-empty}" ;;
  esac

  guard=$execution_guard
  verifier=$execution_verifier
  guard_journal=$(jq -er '.guardJournal' "$state")
  mapfile -t guard_args < <(jq -er '.guardArgs[]' "$state")
  for ((phase = 0; phase + 1 < ${#guard_args[@]}; phase++)); do
    if [[ ${guard_args[$phase]} == --env-file ]]; then
      guard_args[$((phase + 1))]=$execution_env_file
      break
    fi
  done
  authorization_args=(--authorize-writer)
  for phase in "${guard_args[@]}"; do
    [[ "$phase" == --defer-app-restart ]] || authorization_args+=("$phase")
  done

  if [[ "$run_initial_guard" == true ]]; then
  guard_artifact_base=$(select_process_artifact_base "$state" guard)
  [[ -n "$guard_artifact_base" && "$guard_artifact_base" == /* ]] ||
    die 'could not allocate distinct guard artifact paths'
  guard_stdout="$guard_artifact_base.guard.stdout.log"
  guard_stderr="$guard_artifact_base.guard.stderr.log"
  guard_evidence="$guard_artifact_base.guard.evidence.json"
  install -m 600 /dev/null "$guard_stdout"
  install -m 600 /dev/null "$guard_stderr"
  start_cursor=$(capture_journal_cursor)
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ -n ${NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD:-} ]]; then
    handle_controller_signal "$NOOSPHERE_CONTROLLER_TEST_SIGNAL_BEFORE_GUARD"
  fi
  abort_if_interrupted || return $?
  run_guard_with_inherited_lock "$state" "$engine_id" "$volume" "$lock_root" \
    "$guard" "${guard_args[@]}" >"$guard_stdout" 2>"$guard_stderr" || guard_exit=$?
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  end_cursor=$(capture_journal_cursor)
  write_process_evidence_atomic "$guard_evidence" guard-exited "$guard_exit" \
    "$guard_stdout" "$guard_stderr" "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_guard_pid" \
    "$started_at" "$ended_at" "$start_cursor" "$end_cursor"
  bind_process_evidence_to_state "$state" guardEvidence "$guard_evidence" \
    "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_guard_pid"
  update_controller_phase "$state" guard-exited
  abort_if_interrupted || return $?
  if ((guard_exit != 0)); then
    resume_controller_state "$state"
    return "$guard_exit"
  fi
  bind_guard_journal_to_state "$state" "$guard_journal"
  abort_if_interrupted || return $?

  # The complete pinned-guard journal and process evidence are the durable
  # pre-authorization boundary. No writer marker exists and the app remains
  # stopped until the next independently evidenced phase succeeds.
  update_controller_phase "$state" authorization-running
  abort_if_interrupted || return $?
  else
    assert_bound_guard_journal_unchanged "$state"
  fi

  if [[ "$run_authorization" == true ]]; then
    authorization_artifact_base=$(select_process_artifact_base "$state" authorization)
    if [[ -z "$authorization_artifact_base" || "$authorization_artifact_base" != /* ]]; then
      # The guard has already mutated the transition: a selector failure is a
      # storage failure that must stop the writer and fail closed.
      begin_closure_incident "$state" artifact-storage
      return 1
    fi
    authorization_stdout="$authorization_artifact_base.authorization.stdout.log"
    authorization_stderr="$authorization_artifact_base.authorization.stderr.log"
    authorization_evidence="$authorization_artifact_base.authorization.evidence.json"
    install -m 600 /dev/null "$authorization_stdout"
    install -m 600 /dev/null "$authorization_stderr"
    start_cursor=$(capture_journal_cursor)
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    abort_if_interrupted || return $?
    run_guard_with_inherited_lock "$state" "$engine_id" "$volume" "$lock_root" \
      "$guard" "${authorization_args[@]}" >"$authorization_stdout" 2>"$authorization_stderr" ||
      authorization_exit=$?
    ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    end_cursor=$(capture_journal_cursor)
    write_process_evidence_atomic "$authorization_evidence" authorization-running "$authorization_exit" \
      "$authorization_stdout" "$authorization_stderr" "$INVOCATION_ID" "$boot_id" \
      "$systemd_controller_main_pid" "$last_guard_pid" "$started_at" "$ended_at" "$start_cursor" "$end_cursor"
    bind_process_evidence_to_state "$state" authorizationEvidence "$authorization_evidence" \
      "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_guard_pid"
    if [[ -n ${controller_signal:-} ]]; then
      if ! abort_if_interrupted; then
        # A latched signal after successful writer authorization must not
        # return while the authorized writer could be running: stop it and
        # commit a classified closure incident first.
        begin_closure_incident "$state" interruption
        return "$(signal_exit_code "$controller_signal")"
      fi
    fi
    if ((authorization_exit != 0)); then
      begin_closure_incident "$state" writer-authorization
      return "$authorization_exit"
    fi
    assert_bound_guard_journal_unchanged "$state"
    update_controller_phase "$state" activation-running
    if [[ -n ${NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION:-} ]]; then
      handle_controller_signal "$NOOSPHERE_CONTROLLER_TEST_SIGNAL_AFTER_AUTHORIZATION"
    fi
    if ! abort_if_interrupted; then
      # The pre-activation boundary has an authorized writer: a latched signal
      # must durably stop it and classify the incident before returning.
      begin_closure_incident "$state" interruption
      return "$(signal_exit_code "$controller_signal")"
    fi
  else
    validate_bound_process_evidence "$state" authorizationEvidence authorization-running
  fi

  # Allocate and durably create every verifier artifact before activation. A
  # collision or storage failure therefore rejects while the writer is still
  # stopped, rather than creating an unverified active writer.
  if ! verify_artifact_base=$(select_process_artifact_base "$state" verify) ||
     [[ -z "$verify_artifact_base" || "$verify_artifact_base" != /* ]]; then
    # A selector failure (per-invocation collision) is an artifact-storage
    # failure while the authorized writer is stopped: stop it freshly and
    # classify the closure incident instead of proceeding with a relative or
    # empty artifact base that would scatter evidence into the worktree.
    begin_closure_incident "$state" artifact-storage
    return 1
  fi
  verify_stdout="$verify_artifact_base.verify.stdout.log"
  verify_stderr="$verify_artifact_base.verify.stderr.log"
  verify_evidence="$verify_artifact_base.verify.evidence.json"
  verify_alloc_exit=0
  install -m 600 /dev/null "$verify_stdout" || verify_alloc_exit=$?
  if (( verify_alloc_exit == 0 )); then
    install -m 600 /dev/null "$verify_stderr" || verify_alloc_exit=$?
  fi
  if (( verify_alloc_exit != 0 )); then
    # Verifier artifact storage failed while the authorized writer is still
    # stopped: stop it freshly, verify the stop, and classify the incident.
    begin_closure_incident "$state" artifact-storage
    return "$verify_alloc_exit"
  fi
  start_cursor=$(capture_journal_cursor)
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  assert_bound_guard_journal_unchanged "$state"
  if [[ "$run_activation" == true ]]; then
    if ! activate_application_for_verification "$state"; then
      begin_closure_incident "$state" app-activation
      return 1
    fi
    if [[ $(jq -er '.phase' "$state") != closure-running ]]; then
      update_controller_phase "$state" closure-running
    fi
    if ! abort_if_interrupted; then
      begin_closure_incident "$state" interruption
      return "$(signal_exit_code "$controller_signal")"
    fi
  else
    # Evidence-pending recovery may re-run the verifier only while the writer
    # remains stopped. It must never recreate or reactivate the failed writer.
    stop_application_fail_closed
  fi

  abort_if_interrupted || return $?
  run_verifier_hermetic "$state" "$guard_journal" "$volume" "$verifier" \
    >"$verify_stdout" 2>"$verify_stderr" || verify_exit=$?
  ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if end_cursor=$(capture_journal_cursor); then
    :
  else
    postprocess_exit=$?
    begin_closure_incident "$state" postprocessing
    return "$postprocess_exit"
  fi
  if ((verify_exit != 0)) && [[ "$resume_closure_evidence" == false ]]; then
    # The writer-stop intent and observed stop precede every fallible evidence
    # write. A full evidence disk cannot leave the candidate writer running.
    begin_closure_evidence_pending "$state" verification
  fi
  if (
    write_process_evidence_atomic "$verify_evidence" closure-running "$verify_exit" \
      "$verify_stdout" "$verify_stderr" "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_verifier_pid" \
      "$started_at" "$ended_at" "$start_cursor" "$end_cursor"
  ); then
    :
  else
    postprocess_exit=$?
    if ((verify_exit == 0)); then
      # A successful verifier still has a live writer, so postprocessing
      # storage failure must durably stop it. A failed verifier has already
      # entered closure-evidence-pending with an inspect-verified stop; retain
      # that resumable evidence state instead of replacing it with a second
      # incident.
      begin_closure_incident "$state" postprocessing
    fi
    return "$postprocess_exit"
  fi
  if [[ "$resume_closure_evidence" == true ]]; then
    complete_closure_evidence_pending "$state" "$verify_evidence" \
      "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_verifier_pid"
    abort_if_interrupted || return $?
    ((verify_exit != 0)) && return "$verify_exit"
    return 1
  fi
  if [[ -n ${controller_signal:-} ]]; then
    if (
      bind_process_evidence_to_state "$state" closureEvidence "$verify_evidence" \
        "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_verifier_pid"
    ); then
      begin_closure_incident "$state" interruption
      return "$(signal_exit_code "$controller_signal")"
    else
      postprocess_exit=$?
      begin_closure_incident "$state" postprocessing
      return "$postprocess_exit"
    fi
  fi
  if ((verify_exit == 0)); then
    if (
      commit_closure_outcome "$state" "$verify_evidence" none 0 \
        "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_verifier_pid"
    ); then
      :
    else
      postprocess_exit=$?
      begin_closure_incident "$state" postprocessing
      return "$postprocess_exit"
    fi
  else
    complete_closure_evidence_pending "$state" "$verify_evidence" \
      "$INVOCATION_ID" "$boot_id" "$systemd_controller_main_pid" "$last_verifier_pid"
    return "$verify_exit"
  fi
}

classify_closure_failure() {
  local failure_class=$1 other_failures=$2
  if [[ "$failure_class" == app-health && "$other_failures" == 0 ]]; then
    printf 'completed-journal-revalidate\n'
  else
    printf 'incident-stop-app\n'
  fi
}

controller_signal_active=false
controller_test_hooks_enabled=false
controller_fixture_root=''
# Durable per-user authority records must survive XDG_RUNTIME_DIR replacement
# and reboots, so the root is captured from the invoking user's real home
# before sanitize_execution_environment installs the hermetic controller HOME.
controller_durable_home=${HOME:-}
# XDG_STATE_HOME is read inline at claim time: sanitize never unsets XDG
# vars and process-locale env cannot change mid-run, so a module-level
# capture would add a second source of truth without adding a guarantee.
controller_signal=''
controller_signal_forwarded=false
controller_state_write_active=false
controller_interruption_pending=false
controller_wait_interrupted=false
active_child_pid=''
active_child_pgid=''
guard_pid=''
last_guard_pid=0
last_verifier_pid=0
controller_state=''
systemd_controller_main_pid=0
controller_boot_id=''
execution_guard=''
execution_verifier=''
execution_candidate_compose=''
execution_source_snapshot=''
execution_env_file=''
execution_docker_path=''
execution_compose_plugin=''
execution_controller_home=''
resume_action=''

signal_exit_code() {
  case "$1" in
    HUP) printf '129\n' ;;
    INT) printf '130\n' ;;
    TERM) printf '143\n' ;;
    *) printf '1\n' ;;
  esac
}

abort_if_interrupted() {
  [[ -z ${controller_signal:-} ]] && return 0
  return "$(signal_exit_code "$controller_signal")"
}

forward_latched_signal_to_active_child() {
  [[ -n ${controller_signal:-} && ${controller_signal_forwarded:-false} == false ]] || return 0
  [[ -n ${active_child_pid:-} ]] || return 0
  if [[ -n ${active_child_pgid:-} ]] && kill -0 -- "-$active_child_pgid" 2>/dev/null; then
    kill -s "$controller_signal" -- "-$active_child_pgid" 2>/dev/null || true
    controller_signal_forwarded=true
  elif kill -0 "$active_child_pid" 2>/dev/null; then
    kill -s "$controller_signal" "$active_child_pid" 2>/dev/null || true
    controller_signal_forwarded=true
  fi
}

wait_for_process_group_empty() {
  local pgid=$1
  [[ -n "$pgid" ]] || return 0
  while kill -0 -- "-$pgid" 2>/dev/null; do
    sleep 0.02
  done
}

wait_for_child_exit() {
  local child_pid=$1 child_exit=0
  while true; do
    controller_wait_interrupted=false
    child_exit=0
    wait "$child_pid" || child_exit=$?
    if [[ ${controller_wait_interrupted:-false} == true ]] &&
      kill -0 "$child_pid" 2>/dev/null; then
      # A trapped signal interrupts Bash's wait before the child necessarily
      # exits. Keep its identity live and wait again until the child is reaped.
      forward_latched_signal_to_active_child
      continue
    fi
    return "$child_exit"
  done
}

handle_controller_signal() {
  local signal=$1
  [[ "$controller_signal_active" == false ]] || return 0
  controller_signal_active=true
  controller_signal=$signal
  controller_wait_interrupted=true
  forward_latched_signal_to_active_child
  if [[ ${controller_state_write_active:-false} == true ]]; then
    controller_interruption_pending=true
  else
    persist_interrupted_state "$signal"
  fi
}

main() {
  local mode='' manifest='' state=''
  while (($# > 0)); do
    case "$1" in
      --prepare)
        [[ -z "$mode" ]] || die 'exactly one of --prepare or --execute is required'
        mode=prepare
        shift
        ;;
      --execute)
        [[ -z "$mode" ]] || die 'exactly one of --prepare or --execute is required'
        mode=execute
        shift
        ;;
      --manifest) manifest=${2:?missing value}; shift 2 ;;
      --state) state=${2:?missing value}; shift 2 ;;
      --help|-h)
        printf 'Usage: %s --prepare --manifest FILE --state FILE\n' "$0"
        printf '       %s --execute --state FILE\n' "$0"
        return
        ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [[ -n "$state" && "$state" == /* ]] || die '--state must be an absolute path'
  case "$mode" in
    prepare)
      [[ -n "$manifest" && "$manifest" == /* ]] || die '--manifest must be an absolute path'
      prepare_execution_state "$manifest" "$state"
      ;;
    execute)
      [[ -z "$manifest" ]] || die '--manifest is not valid with --execute'
      trap 'handle_controller_signal TERM' TERM
      trap 'handle_controller_signal INT' INT
      trap 'handle_controller_signal HUP' HUP
      execute_prepared_state "$state"
      ;;
    *) die 'exactly one of --prepare or --execute is required' ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
