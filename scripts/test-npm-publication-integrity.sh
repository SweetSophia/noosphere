#!/usr/bin/env bash
# Regression tests for scripts/verify-npm-publication-integrity.sh.
#
# Background: npm publishes asynchronously. Right after `npm publish` succeeds the
# registry can keep reporting the new version as missing for several minutes
# ("Your package is being processed and may take a few minutes to become
# available"). The 1.15.2 coordinated release lost the OpenClaw plugin exactly
# that way: the helper package published fine, the readback gave up before the
# registry served it, and the dependent publish job was skipped.
#
# These tests drive the real script against a stubbed `npm` so the three
# outcomes stay distinguishable:
#   - visible with the expected integrity -> success
#   - visible with a DIFFERENT integrity  -> immediate failure, never retried
#   - never visible                       -> failure once the deadline expires
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
script="$repo_root/scripts/verify-npm-publication-integrity.sh"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

failures=0
passed=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$(( failures + 1 ))
}

pass() {
  printf 'ok: %s\n' "$1"
  passed=$(( passed + 1 ))
}

# --- stubbed npm -------------------------------------------------------------
# The stub records every call and answers from FAKE_NPM_STATE:
#   match     -> report FAKE_NPM_INTEGRITY immediately
#   delay     -> stay invisible for FAKE_NPM_DELAY calls, then report it
#   mismatch  -> report FAKE_NPM_OTHER_INTEGRITY immediately
#   absent    -> never report anything
mkdir -p "$work_dir/bin"
cat > "$work_dir/bin/npm" <<'STUB'
#!/usr/bin/env bash
counter_file="${FAKE_NPM_COUNTER:?}"
count=0
[[ -f "$counter_file" ]] && count=$(cat "$counter_file")
count=$(( count + 1 ))
printf '%s' "$count" > "$counter_file"

case "${FAKE_NPM_STATE:?}" in
  match)    printf '"%s"\n' "${FAKE_NPM_INTEGRITY:?}" ;;
  mismatch) printf '"%s"\n' "${FAKE_NPM_OTHER_INTEGRITY:?}" ;;
  delay)
    if (( count > ${FAKE_NPM_DELAY:-1} )); then
      printf '"%s"\n' "${FAKE_NPM_INTEGRITY:?}"
    else
      exit 1
    fi
    ;;
  absent) exit 1 ;;
  *) printf 'unknown FAKE_NPM_STATE\n' >&2; exit 9 ;;
esac
STUB
chmod +x "$work_dir/bin/npm"

# run_script [VAR=value ...] -- <script args...>
# Environment assignments are consumed from the front of the argument list so a
# stubbed npm can be steered per case without leaking state between cases.
run_script() {
  local -a envs=()
  while [[ "${1:-}" == *=* ]]; do
    envs+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  env "${envs[@]}" \
    PATH="$work_dir/bin:$PATH" \
    FAKE_NPM_COUNTER="$work_dir/counter" \
    bash "$script" "$@"
}

expected_integrity="sha512-$(printf 'a%.0s' {1..86})=="
other_integrity="sha512-$(printf 'b%.0s' {1..86})=="

# --- visible with the expected integrity -------------------------------------
rm -f "$work_dir/counter"
if run_script FAKE_NPM_STATE=match FAKE_NPM_INTEGRITY="$expected_integrity" -- \
  "noosphere-memory@1.15.2" "$expected_integrity" 5 1; then
  pass "accepts a visible version whose integrity matches"
else
  fail "expected success for a matching integrity"
fi

# --- registry propagation delay ---------------------------------------------
# The version only becomes visible after a few polls. The script must keep
# polling instead of failing the release.
rm -f "$work_dir/counter"
if run_script FAKE_NPM_STATE=delay FAKE_NPM_DELAY=3 FAKE_NPM_INTEGRITY="$expected_integrity" -- \
  "noosphere-memory@1.15.2" "$expected_integrity" 30 1; then
  polls=$(cat "$work_dir/counter")
  if (( polls >= 4 )); then
    pass "tolerates registry propagation delay (succeeded after ${polls} polls)"
  else
    fail "expected at least 4 polls during propagation delay, saw ${polls}"
  fi
else
  fail "expected success despite a registry propagation delay"
fi

# --- integrity mismatch ------------------------------------------------------
# A different artifact is never a transient condition: fail immediately and do
# not keep polling, because the release must not be promoted on unknown bytes.
rm -f "$work_dir/counter"
if run_script FAKE_NPM_STATE=mismatch FAKE_NPM_OTHER_INTEGRITY="$other_integrity" -- \
  "noosphere-memory@1.15.2" "$expected_integrity" 30 1 \
  > "$work_dir/mismatch.out" 2>&1; then
  fail "expected failure when the registry serves a different artifact"
else
  status=$?
  polls=$(cat "$work_dir/counter")
  if (( status == 1 )); then
    pass "fails with status 1 on an integrity mismatch"
  else
    fail "expected status 1 on mismatch, saw ${status}"
  fi
  if (( polls == 1 )); then
    pass "does not retry after an integrity mismatch"
  else
    fail "expected exactly 1 poll on mismatch, saw ${polls}"
  fi
  if grep -q "does not match\|mismatch\|different artifact" "$work_dir/mismatch.out"; then
    pass "explains the integrity mismatch"
  else
    fail "expected a mismatch explanation, got: $(cat "$work_dir/mismatch.out")"
  fi
fi

# --- never visible -----------------------------------------------------------
rm -f "$work_dir/counter"
started=$SECONDS
if run_script FAKE_NPM_STATE=absent -- \
  "noosphere-memory@1.15.2" "$expected_integrity" 3 1 \
  > "$work_dir/absent.out" 2>&1; then
  fail "expected failure when the version never becomes visible"
else
  status=$?
  elapsed=$(( SECONDS - started ))
  if (( status == 2 )); then
    pass "fails with status 2 when the version stays invisible"
  else
    fail "expected status 2 for an invisible version, saw ${status}"
  fi
  if (( elapsed >= 3 )); then
    pass "respects the readback deadline before failing"
  else
    fail "expected to wait for the deadline, gave up after ${elapsed}s"
  fi
  if grep -q "Re-run the publish workflow" "$work_dir/absent.out"; then
    pass "points at the safe recovery instead of republishing"
  else
    fail "expected a re-run hint, got: $(cat "$work_dir/absent.out")"
  fi
fi

# --- argument validation -----------------------------------------------------
if run_script FAKE_NPM_STATE=match FAKE_NPM_INTEGRITY="$expected_integrity" -- \
  "noosphere-memory@1.15.2" "not-a-digest" 5 1 \
  > "$work_dir/args.out" 2>&1; then
  fail "expected failure for a malformed expected integrity"
else
  pass "rejects a malformed expected integrity"
fi

if run_script FAKE_NPM_STATE=match FAKE_NPM_INTEGRITY="$expected_integrity" -- \
  "noosphere-memory@1.15.2" "$expected_integrity" 0 1 \
  > "$work_dir/deadline.out" 2>&1; then
  fail "expected failure for a non-positive deadline"
else
  pass "rejects a non-positive deadline"
fi

printf '\n%s passed, %s failed\n' "$passed" "$failures"
(( failures == 0 ))
