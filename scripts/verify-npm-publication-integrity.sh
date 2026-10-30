#!/usr/bin/env bash
# Verify that a published npm version is byte-identical to the artifact we built.
#
# npm publishes asynchronously: the registry can keep reporting a freshly
# published version as missing for several minutes ("Your package is being
# processed and may take a few minutes to become available"). Treating that
# window as a hard failure aborts an otherwise healthy release, which is exactly
# how the 1.15.2 openclaw surface was lost: the helper package published fine
# and the readback gave up before the registry served it. The dependent
# publish job was then skipped, so the plugin that carries the installer pins
# never reached npm.
#
# The three outcomes are distinguished on purpose:
#
#   match    -> exit 0  the registry serves exactly the artifact we published
#   mismatch -> exit 1  the registry serves a DIFFERENT artifact: a real
#                        integrity violation, never a transient condition
#   absent   -> exit 2  the version never became visible within the deadline
#
# A mismatch must never be retried: a different artifact means the release is
# unsafe to promote, and waiting cannot change that.
#
# Usage:
#   verify-npm-publication-integrity.sh \
#     <package@version> <expected-sha512-integrity> [deadline_seconds] [poll_interval_seconds]
set -euo pipefail

target=${1:?usage: verify-npm-publication-integrity.sh <package@version> <expected-integrity> [deadline_seconds] [poll_interval_seconds]}
expected=${2:?missing expected integrity}
deadline=${3:-600}
interval=${4:-15}

case "$expected" in
  sha512-*) ;;
  *)
    printf 'Expected integrity is not a sha512 digest: %s\n' "$expected" >&2
    exit 3
    ;;
esac

for numeric in "$deadline" "$interval"; do
  case "$numeric" in
    ''|*[!0-9]*)
      printf 'Deadline and poll interval must be positive integers: %s\n' "$numeric" >&2
      exit 3
      ;;
  esac
done
if (( deadline < 1 || interval < 1 )); then
  printf 'Deadline and poll interval must be positive integers: %s / %s\n' "$deadline" "$interval" >&2
  exit 3
fi

# `npm view <pkg>@<version> dist.integrity --json` prints a JSON string for a
# visible version and exits non-zero with E404 while the version is still
# missing. Only stdout is inspected, so "not visible yet" reads as empty.
read_remote_integrity() {
  local raw
  raw=$(npm view "$target" dist.integrity --json 2>/dev/null || true)
  [[ -n "$raw" ]] || return 0
  node -e 'try { const value = JSON.parse(process.argv[1]); if (typeof value === "string") process.stdout.write(value); } catch {}' "$raw"
}

started=$SECONDS
attempt=0
while :; do
  attempt=$(( attempt + 1 ))
  remote=$(read_remote_integrity)
  if [[ -n "$remote" ]]; then
    if [[ "$remote" == "$expected" ]]; then
      printf 'Verified %s after %s poll(s): registry integrity matches the published artifact.\n' "$target" "$attempt"
      exit 0
    fi
    printf 'Integrity mismatch for %s.\n  expected: %s\n  registry: %s\n' "$target" "$expected" "$remote" >&2
    printf 'The registry serves a different artifact than the published one. Do not promote this release.\n' >&2
    exit 1
  fi
  if (( SECONDS - started >= deadline )); then
    printf 'Timed out after %ss waiting for %s to become visible on the registry.\n' "$(( SECONDS - started ))" "$target" >&2
    printf 'The version may still be propagating. Re-run the publish workflow instead of publishing again.\n' >&2
    exit 2
  fi
  sleep "$interval"
done
