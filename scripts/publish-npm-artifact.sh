#!/usr/bin/env bash
# Publish an already packed artifact, then verify exact registry bytes.
# Only npm's explicit duplicate-version error may fall through after failure.
# Other publish errors are not evidence of eventual registry propagation.
#
# Exit contract (the verifier's codes propagate unchanged because the
# verifier is this script's last command):
#   0  published and verified byte-identical
#   1  integrity mismatch: the registry serves a DIFFERENT artifact (fatal)
#   2  not visible within the deadline: still propagating, re-run the workflow
#   3  usage error
#   4  registry answered with errors (authentication, network, server)
#   5  npm publish failed for a reason other than an existing version
#  40  local artifact validation failed (nothing was published)
#  41  local tooling unavailable, timed out, or faulted (nothing was published)
#
# The two local classes use a private range so a caller can always tell
# "nothing was published" (40/41) from "published, but the readback failed"
# (1/2/4). The protection against Node's own reserved codes (3 parse error, 4
# internal evaluation failure, 6 invalid argument) comes from the remap below,
# not from the range: a Node exit status is honoured only when it is 40 or 41
# and every other status is reported as a tooling failure, so a Node fault can
# never surface as one of this script's own verdicts (1/2/3/4/5).
set -euo pipefail
if (( $# != 3 )); then
  printf 'Usage: %s <tarball> <package@version> <sha512-integrity>\n' "${0##*/}" >&2
  exit 3
fi
tarball=$1
target=$2
integrity=$3
if [[ ! -f "$tarball" || ! -r "$tarball" || ! "$target" =~ ^(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+@[0-9][0-9A-Za-z.+-]*$ || ! "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]]; then
  printf 'Invalid packed artifact, exact package version or sha512 integrity.\n' >&2
  exit 3
fi
# Validate before any registry write. Local artifact failures are exit 40;
# unavailable tools/timeouts are exit 41. Report only fixed reason codes.
if ! command -v node >/dev/null 2>&1; then
  printf 'Local validation failed: NODE_UNAVAILABLE. Check Node.js installation.\n' >&2
  exit 41
fi
if node - "$tarball" "$target" "$integrity" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
function fail(reason, status = 40) {
  // Write the reason synchronously. process.exit() can discard an asynchronous
  // stderr write where pipes are asynchronous (macOS), which would drop the
  // only explanation of why the publication was refused.
  fs.writeSync(2, `Refusing publication: local validation ${reason}.\n`);
  process.exit(status);
}
const [archive, target, expected] = process.argv.slice(2);
let bytes;
try { bytes = fs.readFileSync(archive); } catch { fail("ARCHIVE_UNREADABLE"); }
const digest = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
if (digest !== expected) fail("DIGEST_MISMATCH");
let manifestText;
try {
  // Never extract members to disk. Bound tool execution even for bad archives.
  manifestText = execFileSync("tar", ["-xzOf", archive, "package/package.json"], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10000, killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  if (error.code === "ENOENT" || error.code === "EACCES") fail("TOOL_UNAVAILABLE", 41);
  // An explicit timeout names the cause. Signal death alone does not: OOM
  // or an external kill must remain a tooling fault without guessing why.
  if (error.code === "ETIMEDOUT") fail("TOOL_TIMEOUT", 41);
  if (error.killed === true || error.signal) fail("TOOL_TERMINATED", 41);
  fail("ARCHIVE_UNREADABLE");
}
let manifest;
try { manifest = JSON.parse(manifestText); } catch { fail("MANIFEST_INVALID"); }
const separator = target.lastIndexOf("@");
if (!manifest || manifest.name !== target.slice(0, separator)) fail("NAME_MISMATCH");
if (manifest.version !== target.slice(separator + 1)) fail("VERSION_MISMATCH");
NODE
then
  :
else
  status=$?
  # Only the private local range is a decision this script made. Any other
  # status is Node faulting on its own terms (a parse error, an internal
  # evaluation failure, an uncaught throw), so it is a tooling failure and
  # never an artifact or registry verdict. Report the observed status instead
  # of swallowing it.
  if [[ "$status" == 40 || "$status" == 41 ]]; then exit "$status"; fi
  printf 'Local validation failed: TOOL_FAILURE (node exited %s). Check Node.js installation.\n' "$status" >&2
  exit 41
fi
# Guard dirname separately: nesting it inside cd can hide its failure behind
# a successful cd to an empty path. No registry call may follow failed setup.
script_dir=$(dirname -- "${BASH_SOURCE[0]}") || {
  printf 'Local validation failed: SCRIPT_DIR_UNAVAILABLE. Check coreutils availability.\n' >&2
  exit 41
}
script_dir=$(cd -- "$script_dir" && pwd) || {
  printf 'Local validation failed: SCRIPT_DIR_UNAVAILABLE. Check script directory access.\n' >&2
  exit 41
}
output=$(mktemp) || exit 41
trap 'rm -f "$output"' EXIT
# Missing npm is a local tooling fault, not a registry/authentication failure.
if ! command -v npm >/dev/null 2>&1; then
  printf 'Local validation failed: NPM_UNAVAILABLE. Check the npm installation.\n' >&2
  exit 41
fi
if npm publish "$tarball" --access public --provenance >"$output" 2>&1; then
  printf 'npm accepted publication of %s; verifying registry integrity.\n' "$target"
else
  status=$?
  code=$(grep -oE 'code E[A-Z0-9]+' "$output" | head -n 1 || true)
  code=${code#code }
  # npm can reject an already-visible version locally without assigning an
  # error code. Accept only its exact version-bound message in that case;
  # a coded auth/server error must not be hidden by a similar phrase.
  if { [[ "$code" == E403 || "$code" == EPUBLISHCONFLICT ]] &&
       grep -qiF 'cannot publish over the previously published versions' "$output"; } ||
     { [[ -z "$code" ]] &&
       grep -qxF "npm error You cannot publish over the previously published versions: ${target##*@}." "$output"; }; then
    printf 'npm reports an existing version of %s; exact-integrity readback decides.\n' "$target"
  else
    # Do not echo arbitrary npm/registry output that may contain credentials.
    printf 'npm publish failed for %s (status %s, code %s). Publication is not confirmed; check npm credentials, package access and registry availability.\n' "$target" "$status" "${code:-UNKNOWN}" >&2
    exit 5
  fi
fi
bash "$script_dir/verify-npm-publication-integrity.sh" "$target" "$integrity" 600 15
