#!/usr/bin/env bash
# Verify that a published npm version is byte-identical to the artifact we built.
#
# npm publishes asynchronously: the registry can keep reporting a freshly
# published version as missing for several minutes ("Your package is being
# processed and may take a few minutes to become available"). Treating that
# window as a hard failure aborts an otherwise healthy release, which is
# exactly how the 1.15.2 helper publication was lost: the helper package
# published fine and the readback gave up before the registry served it. The
# dependent publish job was then skipped, so the plugin that carries the
# installer pins never reached npm.
#
# The outcomes are distinguished on purpose:
#
#   exit 0  verified: the registry serves exactly the integrity we published
#   exit 1  integrity mismatch: the registry serves a DIFFERENT artifact. This
#           is a real violation, it is never retried, and the release must not
#           be promoted
#   exit 2  not visible within the deadline: the registry is still processing
#           the version. The publication may well have succeeded, so the
#           correct response is to re-run the workflow, not to publish again
#   exit 3  usage error: the arguments are not usable
#   exit 4  could not verify: the registry answered with errors (authentication,
#           network, server) instead of serving the version. Reported separately
#           so that a broken credential is never mistaken for a slow registry
#
# Usage:
#   verify-npm-publication-integrity.sh \
#     <package@version> <expected-sha512-integrity> [deadline_seconds] [poll_interval_seconds]
set -euo pipefail

PROGRAM_NAME=${0##*/}

usage() {
  printf 'Usage: %s <package@version> <expected-sha512-integrity> [deadline_seconds] [poll_interval_seconds]\n' "$PROGRAM_NAME" >&2
  exit 3
}

# Bash aborts on an unset parameter expansion with status 1, which would be
# indistinguishable from an integrity mismatch. Check the argument count
# explicitly so usage errors always exit 3.
if (( $# < 2 || $# > 4 )); then
  usage
fi

target=$1
expected=$2
deadline_arg=${3:-600}
interval_arg=${4:-15}

# The target must be <package>@<version>. Scoped names contain an extra "@",
# so split on the last one.
if [[ "$target" != *@* ]]; then
  printf 'Target must be <package@version>: %s\n' "$target" >&2
  usage
fi
target_package=${target%@*}
target_version=${target##*@}
if [[ -z "$target_package" || -z "$target_version" ]]; then
  printf 'Target must be <package@version>: %s\n' "$target" >&2
  usage
fi
if [[ ! "$target_package" =~ ^(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+$ ]]; then
  printf 'Target package name is not a valid npm package name: %s\n' "$target_package" >&2
  usage
fi
if [[ ! "$target_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  printf 'Target version is not a valid npm version: %s\n' "$target_version" >&2
  usage
fi

# A sha512 integrity is "sha512-" followed by the base64 of 64 bytes: 88
# base64 characters ending in "==". Accepting any "sha512-*" prefix would let
# a typo through and then wait out the whole deadline for a digest that can
# never match.
if [[ ! "$expected" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]]; then
  printf 'Expected integrity is not a sha512 digest: %s\n' "$expected" >&2
  exit 3
fi

for numeric in "$deadline_arg" "$interval_arg"; do
  if [[ ! "$numeric" =~ ^[0-9]+$ ]]; then
    printf 'Deadline and poll interval must be positive integers: %s\n' "$numeric" >&2
    exit 3
  fi
done
# Strip leading zeros explicitly: bare arithmetic would read "08" as octal and
# fail outright.
deadline=$(( 10#$deadline_arg ))
interval=$(( 10#$interval_arg ))
if (( deadline < 1 || interval < 1 )); then
  printf 'Deadline and poll interval must be positive integers: %s / %s\n' "$deadline_arg" "$interval_arg" >&2
  exit 3
fi
if (( interval > deadline )); then
  printf 'Poll interval (%s) must not exceed the deadline (%s).\n' "$interval_arg" "$deadline_arg" >&2
  exit 3
fi

# Read the published integrity.
#
# `npm view <pkg>@<version> dist.integrity --json` answers with a JSON string
# on npm 10 and with a one-element JSON array on npm 11 and newer, so both
# shapes are accepted. A version that is not visible yet answers with E404,
# either as an error object on stdout or as an error on stderr.
#
# The parsed result is reported as a tagged token:
#   OK:<integrity>   the registry served an integrity
#   ABSENT           the registry does not serve this version (yet)
#   ERROR:<code>     the registry could not be queried
parse_registry_response() {
  node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    process.stdout.write("EMPTY");
    return;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    process.stdout.write("ERROR:UNPARSEABLE");
    return;
  }
  const integrity = (text) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(text);
  if (typeof value === "string") {
    process.stdout.write(integrity(value) ? "OK:" + value : "ERROR:INVALID_INTEGRITY");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write("ABSENT");
      return;
    }
    if (value.length === 1 && typeof value[0] === "string") {
      process.stdout.write(integrity(value[0]) ? "OK:" + value[0] : "ERROR:INVALID_INTEGRITY");
      return;
    }
    process.stdout.write("ERROR:AMBIGUOUS");
    return;
  }
  if (value && typeof value === "object" && value.error) {
    const code = typeof value.error.code === "string" && /^E[A-Z0-9]{1,31}$/.test(value.error.code) ? value.error.code : "UNKNOWN";
    process.stdout.write(code === "E404" ? "ABSENT" : "ERROR:" + code);
    return;
  }
  process.stdout.write("ERROR:INVALID_RESPONSE");
});
'
}

started=$SECONDS
attempt=0
last_error=""

while :; do
  attempt=$(( attempt + 1 ))
  elapsed=$(( SECONDS - started ))
  remaining=$(( deadline - elapsed ))
  if (( remaining <= 0 )); then
    break
  fi

  # A single registry request must never outlive the readback deadline, so
  # bound each request by the time that is actually left.
  request_timeout=$(( remaining < 60 ? remaining : 60 ))
  stdout_file=$(mktemp) || { printf 'Cannot create registry response file.\n' >&2; exit 4; }
  stderr_file=$(mktemp) || { rm -f "$stdout_file"; printf 'Cannot create registry error file.\n' >&2; exit 4; }
  # SIGKILL bounds even a client that traps SIGTERM; no grace period beyond
  # the release readback deadline is permitted.
  if timeout --signal=KILL "$request_timeout" \
    npm view "$target" dist.integrity --json \
      --fetch-retries=0 --fetch-timeout="$(( request_timeout * 1000 ))" \
      >"$stdout_file" 2>"$stderr_file"; then
    npm_status=0
  else
    npm_status=$?
  fi

  if (( npm_status == 124 || npm_status == 137 )); then
    # A timeout is not evidence that a version is absent. Keep it distinct
    # from propagation so the operator knows verification never got an answer.
    token="ERROR:TIMEOUT"
  elif (( npm_status == 0 )); then
    token=$(parse_registry_response <"$stdout_file") || token="ERROR:PARSE"
    [[ "$token" != "EMPTY" ]] || token="ERROR:MISSING_INTEGRITY"
  else
    # A failed request is either "not published yet" or a real registry
    # problem. npm 10 reports the missing version as E404 on stderr; npm 12
    # writes an E404 error object to stdout instead. Both must read as
    # "not visible yet" and never as a credential or server failure. An
    # empty response with a failing status is neither, so it stays an error.
    stdout_token=$(parse_registry_response <"$stdout_file") || stdout_token="ERROR:PARSE"
    if [[ "$stdout_token" == "ABSENT" ]] || grep -qiE 'E404|404 Not Found' "$stderr_file"; then
      token="ABSENT"
    elif [[ "$stdout_token" == ERROR:* ]]; then
      token="$stdout_token"
    else
      # Authentication, network and server failures are not propagation. Keep
      # the code so the deadline message can name the real cause.
      error_code=$(grep -oE 'code E[A-Z0-9]+' "$stderr_file" | head -n 1 || true)
      error_code=${error_code#code }
      token="ERROR:${error_code:-UNKNOWN}"
    fi
  fi
  rm -f "$stdout_file" "$stderr_file"

  case "$token" in
    OK:*)
      remote=${token#OK:}
      if [[ "$remote" == "$expected" ]]; then
        printf 'Verified %s after %s poll(s): registry integrity matches the published artifact.\n' "$target" "$attempt"
        exit 0
      fi
      printf 'Integrity mismatch for %s.\n  expected: %s\n  registry: %s\n' "$target" "$expected" "$remote" >&2
      printf 'The registry serves a different artifact than the published one. Do not promote this release.\n' >&2
      exit 1
      ;;
    ABSENT)
      last_error=""
      ;;
    ERROR:*)
      last_error=${token#ERROR:}
      printf 'Could not verify %s: registry/readback failure %s (npm status %s); not a propagation delay.\n' "$target" "$last_error" "$npm_status" >&2
      case "$last_error" in
        E401|E403) printf 'Check the npm credential and package access before re-running the workflow.\n' >&2 ;;
        TIMEOUT) printf 'Registry request exceeded its budget; check connectivity and re-run verification.\n' >&2 ;;
        *) printf 'Check registry availability and the local npm/Node tools before re-running verification.\n' >&2 ;;
      esac
      # Do not print arbitrary npm output: registry/proxy responses can contain
      # credential-bearing URLs. The allowlisted code and fixed guidance above
      # are the safe diagnostic contract, not a pointer to deleted raw output.
      exit 4
      ;;
    *)
      printf 'Unknown local verification result; cannot establish registry integrity.\n' >&2
      exit 4
      ;;
  esac

  elapsed=$(( SECONDS - started ))
  remaining=$(( deadline - elapsed ))
  if (( remaining <= 0 )); then
    break
  fi
  sleep_for=$(( interval < remaining ? interval : remaining ))
  sleep "$sleep_for"
done

printf 'Timed out after %ss waiting for %s to become visible on the registry.\n' "$deadline" "$target" >&2
printf 'The version may still be propagating. Re-run the publish workflow instead of publishing again.\n' >&2
exit 2
