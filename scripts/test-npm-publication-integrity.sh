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
# These tests drive the real script against a stubbed `npm`. The stub answers
# per requested target and per JSON shape, because a stub that returns the same
# canned digest for every question cannot detect a readback of the wrong
# package. The distinct outcomes are:
#   - visible with the expected integrity -> exit 0
#   - visible with a DIFFERENT integrity  -> exit 1, never retried
#   - still propagating (E404)            -> exit 2
#   - unusable arguments                  -> exit 3
#   - registry/credential failure         -> exit 4 (not propagation)
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
# FAKE_NPM_STATE drives the stub:
#   match       -> serve the digest for the requested target
#   array       -> serve it in the one-element array shape npm 11+ uses
#   delay       -> answer E404 for the first FAKE_NPM_DELAY calls, then serve it
#   mismatch    -> serve a different digest for the requested target
#   absent      -> always answer E404
#   auth        -> always answer an authentication failure
#   unknown     -> fail without any recognizable error code
# The stub records every requested target so the tests can assert that the
# readback asked for the package@version it was told to check.
mkdir -p "$work_dir/bin"
cat > "$work_dir/bin/npm" <<'STUB'
#!/usr/bin/env bash
counter_file="${FAKE_NPM_COUNTER:?}"
requested=""
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *@*) requested="$arg"; break ;;
  esac
done
printf '%s\n' "$requested" >> "${FAKE_NPM_REQUEST_LOG:?}"
count=0
[[ -f "$counter_file" ]] && count=$(cat "$counter_file")
count=$(( count + 1 ))
printf '%s' "$count" > "$counter_file"

digest_for() {
  local target=$1 line
  [[ -f "${FAKE_NPM_DIGEST_FILE:?}" ]] || return 0
  while IFS='=' read -r key digest; do
    [[ "$key" == "$target" ]] || continue
    printf '%s' "$digest"
    return 0
  done < "$FAKE_NPM_DIGEST_FILE"
  printf ''
}

serve() {
  case "${FAKE_NPM_STATE:?}" in
    match|array)
      local digest
      digest=$(digest_for "$requested")
      if [[ -z "$digest" ]]; then
        printf 'npm error code E404\nnpm error 404 Not Found\n' >&2
        exit 1
      fi
      if [[ "${FAKE_NPM_STATE}" == "array" ]]; then
        printf '[\n  "%s"\n]\n' "$digest"
      else
        printf '"%s"\n' "$digest"
      fi
      ;;
    mismatch)
      printf '"%s"\n' "${FAKE_NPM_OTHER_INTEGRITY:?}"
      ;;
    delay)
      if (( count > ${FAKE_NPM_DELAY:-1} )); then
        local digest
        digest=$(digest_for "$requested")
        printf '"%s"\n' "$digest"
      else
        printf 'npm error code E404\nnpm error 404 Not Found\n' >&2
        exit 1
      fi
      ;;
    absent)
      printf 'npm error code E404\nnpm error 404 Not Found\n' >&2
      exit 1
      ;;
    stdout404)
      printf '{\n  "error": {\n    "code": "E404",\n    "summary": "No match found for version"\n  }\n}\n'
      printf 'npm error code E404\n' >&2
      exit 1
      ;;
    auth)
      printf 'npm error code E401\nnpm error 401 Unauthorized - bad credentials\n' >&2
      exit 1
      ;;
    unknown)
      printf 'something went sideways\n' >&2
      exit 1
      ;;
    *) printf 'unknown FAKE_NPM_STATE\n' >&2; exit 9 ;;
  esac
}
serve
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
    FAKE_NPM_REQUEST_LOG="$work_dir/requests.log" \
    FAKE_NPM_DIGEST_FILE="$work_dir/digests.txt" \
    bash "$script" "$@"
}

# Reads the poll counter without inheriting a failure status from `cat`.
poll_count() {
  [[ -f "$work_dir/counter" ]] || { printf '0'; return 0; }
  cat "$work_dir/counter"
}

# Declares which target the stub answers for, as "<package@version>=<digest>".
serve_digest_for() {
  printf '%s=%s\n' "$1" "$2" > "$work_dir/digests.txt"
}

expected_integrity="sha512-$(printf 'a%.0s' {1..86})=="
other_integrity="sha512-$(printf 'b%.0s' {1..86})=="
target="noosphere-memory@1.15.2"

# --- visible with the expected integrity -------------------------------------
rm -f "$work_dir/counter" "$work_dir/requests.log"
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" "$expected_integrity" 5 1; then
  pass "accepts a visible version whose integrity matches"
else
  fail "expected success for a matching integrity"
fi
if grep -qxF "$target" "$work_dir/requests.log"; then
  pass "reads back the requested package@version"
else
  fail "expected the readback to request ${target}, got: $(cat "$work_dir/requests.log")"
fi

# --- the one-element array shape npm 11+ returns -----------------------------
# npm 10 answers with a bare JSON string, npm 11 and newer answer with an
# array. A parser that only understands the string shape silently extracts
# nothing and then waits out the whole deadline.
rm -f "$work_dir/counter" "$work_dir/requests.log"
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=array -- \
  "$target" "$expected_integrity" 5 1; then
  pass "accepts the one-element array shape returned by npm 11+"
else
  fail "expected success for the array-shaped registry response"
fi

# --- registry propagation delay ---------------------------------------------
# The version only becomes visible after a few polls. The script must keep
# polling instead of failing the release.
rm -f "$work_dir/counter" "$work_dir/requests.log"
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=delay FAKE_NPM_DELAY=3 -- \
  "$target" "$expected_integrity" 30 1; then
  polls=$(poll_count)
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
rm -f "$work_dir/counter" "$work_dir/requests.log"
if run_script FAKE_NPM_STATE=mismatch FAKE_NPM_OTHER_INTEGRITY="$other_integrity" -- \
  "$target" "$expected_integrity" 30 1 \
  > "$work_dir/mismatch.out" 2>&1; then
  fail "expected failure when the registry serves a different artifact"
else
  status=$?
  polls=$(poll_count)
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
  if grep -q "mismatch\|different artifact" "$work_dir/mismatch.out"; then
    pass "explains the integrity mismatch"
  else
    fail "expected a mismatch explanation, got: $(cat "$work_dir/mismatch.out")"
  fi
fi

# --- the wrong target must not be accepted -----------------------------------
# The stub only serves the digest for the exact package@version it was asked
# about. Reading back a different target must not be able to match.
rm -f "$work_dir/counter" "$work_dir/requests.log"
serve_digest_for "other-package@9.9.9" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" "$expected_integrity" 5 1 \
  > "$work_dir/wrongtarget.out" 2>&1; then
  fail "expected failure when the registry does not serve the requested version"
else
  status=$?
  if (( status == 2 )); then
    pass "does not accept a digest served for a different target (status 2)"
  else
    fail "expected status 2 for an unserved target, saw ${status}"
  fi
fi

# --- never visible -----------------------------------------------------------
rm -f "$work_dir/counter" "$work_dir/requests.log"
started=$SECONDS
if run_script FAKE_NPM_STATE=absent -- \
  "$target" "$expected_integrity" 3 1 \
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

# --- npm 12 writes the E404 error object to stdout ----------------------------
# npm 10 reports a missing version as E404 on stderr, npm 12 writes an error
# object to stdout. Both mean "not published yet" and neither may be reported
# as a registry failure.
rm -f "$work_dir/counter" "$work_dir/requests.log"
if run_script FAKE_NPM_STATE=stdout404 -- \
  "$target" "$expected_integrity" 3 1 \
  > "$work_dir/stdout404.out" 2>&1; then
  fail "expected failure when the version is absent (npm 12 stdout error shape)"
else
  status=$?
  if (( status == 2 )); then
    pass "reads the npm 12 stdout E404 error object as not-visible (status 2)"
  else
    fail "expected status 2 for the npm 12 stdout error shape, saw ${status}: $(cat "$work_dir/stdout404.out")"
  fi
fi

# --- registry or credential failure ------------------------------------------
# An authentication failure is not propagation. Reporting it as a slow registry
# would send the operator into a pointless wait for a version that will never
# appear.
rm -f "$work_dir/counter" "$work_dir/requests.log"
if run_script FAKE_NPM_STATE=auth -- \
  "$target" "$expected_integrity" 3 1 \
  > "$work_dir/auth.out" 2>&1; then
  fail "expected failure when the registry rejects the request"
else
  status=$?
  if (( status == 4 )); then
    pass "fails with status 4 on a registry or credential failure"
  else
    fail "expected status 4 for a registry failure, saw ${status}"
  fi
  if grep -qi "not a propagation delay\|instead of serving the version" "$work_dir/auth.out"; then
    pass "distinguishes a registry failure from propagation delay"
  else
    fail "expected the failure to be distinguished from propagation, got: $(cat "$work_dir/auth.out")"
  fi
fi

# --- an unrecognised failure is not propagation either ----------------------
rm -f "$work_dir/counter" "$work_dir/requests.log"
if run_script FAKE_NPM_STATE=unknown -- \
  "$target" "$expected_integrity" 3 1 \
  > "$work_dir/unknown.out" 2>&1; then
  fail "expected failure when the registry answers with an unknown error"
else
  status=$?
  if (( status == 4 )); then
    pass "fails with status 4 on an unrecognised registry failure"
  else
    fail "expected status 4 for an unknown registry failure, saw ${status}"
  fi
fi

# --- argument validation -----------------------------------------------------
# Usage errors must exit 3 so that they are never mistaken for an integrity
# mismatch, which is fatal and must not be retried.
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" "not-a-digest" 5 1 \
  > "$work_dir/args.out" 2>&1; then
  fail "expected failure for a malformed expected integrity"
else
  status=$?
  if (( status == 3 )); then
    pass "rejects a malformed expected integrity with status 3"
  else
    fail "expected status 3 for a malformed integrity, saw ${status}"
  fi
fi

serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" "$expected_integrity" 0 1 \
  > "$work_dir/deadline.out" 2>&1; then
  fail "expected failure for a non-positive deadline"
else
  status=$?
  if (( status == 3 )); then
    pass "rejects a non-positive deadline with status 3"
  else
    fail "expected status 3 for a non-positive deadline, saw ${status}"
  fi
fi

# A deadline with a leading zero is decimal eight, not octal: bash arithmetic
# reads "08" as an invalid octal number and aborts with a syntax error.
rm -f "$work_dir/counter" "$work_dir/requests.log"
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" "$expected_integrity" 08 1 \
  > "$work_dir/leadingzero.out" 2>&1; then
  pass "accepts a deadline with a leading zero as decimal"
else
  status=$?
  if (( status == 3 )); then
    fail "rejected a decimal deadline with a leading zero (status ${status})"
  else
    fail "expected success for the leading-zero deadline, saw status ${status}: $(cat "$work_dir/leadingzero.out")"
  fi
fi

# Missing arguments must be a usage error, not an integrity mismatch.
serve_digest_for "$target" "$expected_integrity"
if run_script FAKE_NPM_STATE=match -- \
  "$target" \
  > "$work_dir/missing.out" 2>&1; then
  fail "expected failure when the expected integrity is missing"
else
  status=$?
  if (( status == 3 )); then
    pass "rejects a missing expected integrity with status 3"
  else
    fail "expected status 3 for a missing argument, saw ${status}"
  fi
fi

printf '\n%s passed, %s failed\n' "$passed" "$failures"
(( failures == 0 ))
