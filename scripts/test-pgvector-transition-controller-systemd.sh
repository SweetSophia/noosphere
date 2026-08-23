#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTROLLER="$ROOT_DIR/scripts/run-pgvector-transition-controller.sh"
FIXTURE_SUITE="$ROOT_DIR/scripts/test-pgvector-transition-controller.sh"

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

[[ -x "$CONTROLLER" && -f "$FIXTURE_SUITE" ]] || {
  echo 'Missing controller or focused fixture support.' >&2
  exit 1
}
systemctl --user show-environment >/dev/null
[[ $(loginctl show-user "$(id -u)" -p Linger --value) == yes ]] || {
  echo 'Persistent user manager is required for the transient-unit fixture.' >&2
  exit 1
}

# Load only reusable fixture builders. The focused suite's main block remains
# inactive because it is sourced rather than executed.
source "$FIXTURE_SUITE"
source "$CONTROLLER"

fixture_dir=$(mktemp -d)
unit_base="noosphere-pgvector-controller-test-$BASHPID-$RANDOM"
unit="$unit_base.service"
manifest="$fixture_dir/manifest.json"
state="$fixture_dir/controller.json"
signal_unit=''
signal_lock_path=''
signal_state_authority_path=''
systemd_runner_pid=''
volume="fixture-volume-$BASHPID-$RANDOM"
runtime_root=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
lock_key=$(printf '%s\0%s' fixture-engine "$volume" | sha256sum | awk '{print $1}')
lock_path="$runtime_root/noosphere-pgvector-switch-$lock_key.lock"
state_authority_path="$runtime_root/noosphere-pgvector-state-$lock_key.json"

cleanup() {
  [[ -z "$signal_unit" ]] || systemctl --user stop "$signal_unit" >/dev/null 2>&1 || true
  [[ -z "$signal_unit" ]] || systemctl --user reset-failed "$signal_unit" >/dev/null 2>&1 || true
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  [[ -z "$systemd_runner_pid" ]] || wait "$systemd_runner_pid" >/dev/null 2>&1 || true
  [[ "$lock_path" == "$runtime_root"/noosphere-pgvector-switch-*.lock ]] &&
    rm -f -- "$lock_path"
  [[ -z "$signal_lock_path" || "$signal_lock_path" != "$runtime_root"/noosphere-pgvector-switch-*.lock ]] ||
    rm -f -- "$signal_lock_path"
  local cleanup_rc=0
  cleanup_state_authority_record "$runtime_root" "$state_authority_path" || cleanup_rc=$?
  [[ -z "$signal_state_authority_path" ]] ||
    cleanup_state_authority_record "$runtime_root" "$signal_state_authority_path" || cleanup_rc=$?
  # Remove the isolated durable-authority state root created by sourcing the
  # focused suite (its own EXIT trap is replaced by this one).
  case "${XDG_STATE_HOME:-}" in
    /tmp/tmp.*) rm -rf -- "$XDG_STATE_HOME" ;;
  esac
  rm -rf -- "$fixture_dir"
  return "$cleanup_rc"
}
trap cleanup EXIT

unit_load_state() {
  systemctl --user show "$unit" -p LoadState --value 2>/dev/null || printf 'not-found\n'
}

if [[ $(unit_load_state) != not-found ]]; then
  echo "Transient fixture unit already exists: $unit" >&2
  exit 1
fi

write_execution_fixture "$fixture_dir" "$manifest"
jq --arg volume "$volume" '
  .[0].Name = $volume |
  .[0].Mountpoint = ("/var/lib/docker/volumes/" + $volume + "/_data")
' "$fixture_dir/volume-inspect.json" > "$fixture_dir/volume-inspect.json.next"
install -m 600 "$fixture_dir/volume-inspect.json.next" "$fixture_dir/volume-inspect.json"
rm -f -- "$fixture_dir/volume-inspect.json.next"
jq \
  --arg volume "$volume" \
  --arg lockRoot "$runtime_root" \
  --arg journal "$fixture_dir/backup/$volume.phase-a2b.json" '
    .volume = $volume |
    .lockRoot = $lockRoot |
    .guardJournal = $journal |
    .guardArgs = [
      "--compose-file", .liveCompose,
      "--env-file", .envFile,
      "--db-container", .dbContainer,
      "--app-container", .appContainer,
      "--backup-dir", .backupDir,
      "--volume", $volume,
      "--authorization-volume", .authorizationVolume,
      "--platform", .platform,
      "--defer-app-restart"
    ]
  ' "$manifest" > "$manifest.next"
install -m 600 "$manifest.next" "$manifest"
rm -f -- "$manifest.next"

"$CONTROLLER" --prepare --manifest "$manifest" --state "$state"
: > "$fixture_dir/pause-candidate-verifier"

systemd_args=(
  systemd-run
  --user
  --unit="$unit_base"
  --wait
  --collect
  --quiet
  --setenv="CONTROLLER_UNIT=$unit"
  --setenv="XDG_STATE_HOME=$XDG_STATE_HOME"
  --setenv=NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot
  --setenv=NOOSPHERE_CONTROLLER_TEST_CURSOR=fixture-cursor
)
while IFS= read -r property; do
  systemd_args+=(--property="$property")
done < <(systemd_properties "$fixture_dir")
systemd_args+=("$CONTROLLER" --execute --state "$state")
"${systemd_args[@]}" >"$fixture_dir/systemd-run.out" 2>"$fixture_dir/systemd-run.err" &
systemd_runner_pid=$!
for _ in $(seq 1 200); do
  [[ -e "$fixture_dir/candidate-verifier-paused" ]] && break
  sleep 0.05
done
[[ -e "$fixture_dir/candidate-verifier-paused" ]] || {
  echo 'Transient fixture did not hold the candidate verifier live for identity proof.' >&2
  exit 1
}

unit_invocation=$(systemctl --user show "$unit" -p InvocationID --value)
unit_main_pid=$(systemctl --user show "$unit" -p MainPID --value)
[[ $(systemctl --user show "$unit" -p ActiveState --value) == active &&
   "$unit_invocation" =~ ^[a-f0-9]{32}$ && "$unit_main_pid" =~ ^[1-9][0-9]*$ ]] || {
  echo 'Transient fixture could not independently query its live systemd identity.' >&2
  exit 1
}
authorization_evidence=$(jq -er '.authorizationEvidence.path' "$state")
start_cursor=$(jq -er '.startCursor' "$authorization_evidence")
end_cursor=$(jq -er '.endCursor' "$authorization_evidence")
jq -e --arg invocation "$unit_invocation" --argjson mainPid "$unit_main_pid" '
  .invocationId == $invocation and .controllerMainPid == $mainPid
' "$authorization_evidence" >/dev/null || {
  echo 'Durable authorization evidence does not match the independently queried systemd identity.' >&2
  exit 1
}
for cursor in "$start_cursor" "$end_cursor"; do
  queried_cursor=$(journalctl --user -u "$unit" --cursor "$cursor" -n 0 --show-cursor --no-pager |
    sed -n 's/^-- cursor: //p' | tail -1)
  [[ "$queried_cursor" == "$cursor" ]] || {
    echo 'Durable authorization evidence contains a cursor not independently resolved in the live unit journal.' >&2
    exit 1
  }
done
: > "$fixture_dir/release-candidate-verifier"
wait "$systemd_runner_pid"
systemd_runner_pid=''

jq -e '
  .phase == "complete" and
  (.guardEvidence.sha256 | test("^[a-f0-9]{64}$")) and
  (.closureEvidence.sha256 | test("^[a-f0-9]{64}$"))
' "$state" >/dev/null
[[ $(<"$fixture_dir/docker-compose.yml") == 'candidate model' ]]
[[ ! -e "$lock_path" || -f "$lock_path" ]]

# --collect removes the unit after completion. A lingering unit object would
# permit stale identity evidence to be mistaken for the next invocation.
for _ in $(seq 1 50); do
  [[ $(unit_load_state) == not-found ]] && break
  sleep 0.05
done
if [[ $(unit_load_state) != not-found ]]; then
  echo "Transient fixture unit still exists after --collect: $unit" >&2
  exit 1
fi
cleanup_state_authority_record "$runtime_root" "$state_authority_path"

# Exercise real user-manager signal ownership. TERM is delivered to the unit's
# MainPID; the controller must forward it once to the sleeping guard, record the
# interruption, exit 143, and remain incapable of a false complete state.
signal_dir="$fixture_dir/signal"
signal_manifest="$signal_dir/manifest.json"
signal_state="$signal_dir/controller.json"
signal_volume="fixture-signal-$BASHPID-$RANDOM"
signal_base="noosphere-pgvector-controller-signal-$BASHPID-$RANDOM"
signal_unit="$signal_base.service"
mkdir -m 700 "$signal_dir"
write_execution_fixture "$signal_dir" "$signal_manifest" sleep
jq --arg volume "$signal_volume" '
  .[0].Name = $volume |
  .[0].Mountpoint = ("/var/lib/docker/volumes/" + $volume + "/_data")
' "$signal_dir/volume-inspect.json" > "$signal_dir/volume-inspect.json.next"
install -m 600 "$signal_dir/volume-inspect.json.next" "$signal_dir/volume-inspect.json"
rm -f -- "$signal_dir/volume-inspect.json.next"
signal_lock_key=$(printf '%s\0%s' fixture-engine "$signal_volume" | sha256sum | awk '{print $1}')
signal_lock_path="$runtime_root/noosphere-pgvector-switch-$signal_lock_key.lock"
signal_state_authority_path="$runtime_root/noosphere-pgvector-state-$signal_lock_key.json"
jq --arg volume "$signal_volume" --arg lockRoot "$runtime_root" \
  --arg journal "$signal_dir/backup/$signal_volume.phase-a2b.json" '
    .volume = $volume |
    .lockRoot = $lockRoot |
    .guardJournal = $journal |
    .guardArgs = [
      "--compose-file", .liveCompose,
      "--env-file", .envFile,
      "--db-container", .dbContainer,
      "--app-container", .appContainer,
      "--volume", $volume,
      "--authorization-volume", .authorizationVolume,
      "--backup-dir", .backupDir,
      "--platform", .platform,
      "--defer-app-restart"
    ]
  ' "$signal_manifest" > "$signal_manifest.next"
install -m 600 "$signal_manifest.next" "$signal_manifest"
rm -f -- "$signal_manifest.next"
"$CONTROLLER" --prepare --manifest "$signal_manifest" --state "$signal_state"

signal_args=(
  systemd-run --user --unit="$signal_base" --quiet
  --setenv="CONTROLLER_UNIT=$signal_unit"
  --setenv="XDG_STATE_HOME=$XDG_STATE_HOME"
  --setenv=NOOSPHERE_CONTROLLER_BOOT_ID=fixture-boot
  --setenv='NOOSPHERE_CONTROLLER_TEST_CURSOR=s=fixture;i=1'
)
while IFS= read -r property; do
  signal_args+=(--property="$property")
done < <(systemd_properties "$signal_dir")
signal_args+=("$CONTROLLER" --execute --state "$signal_state")
"${signal_args[@]}"
for _ in $(seq 1 600); do
  [[ -e "$signal_dir/guard-running" ]] && break
  sleep 0.05
done
[[ -e "$signal_dir/guard-running" ]] || {
  echo 'Sleeping guard did not start under the real transient unit.' >&2
  exit 1
}
systemctl --user kill --kill-whom=main --signal=TERM "$signal_unit"
for _ in $(seq 1 100); do
  [[ $(systemctl --user show "$signal_unit" -p ActiveState --value) != active ]] && break
  sleep 0.05
done
[[ $(systemctl --user show "$signal_unit" -p ExecMainStatus --value) == 143 ]]
[[ $(<"$signal_dir/guard-term-count") == 1 ]]
jq -e '.phase != "complete" and .lastInterruption.signal == "TERM"' "$signal_state" >/dev/null
systemctl --user reset-failed "$signal_unit" >/dev/null 2>&1 || true
signal_unit=''
cleanup_state_authority_record "$runtime_root" "$signal_state_authority_path"

echo 'PostgreSQL transition controller transient-unit fixture passed.'
