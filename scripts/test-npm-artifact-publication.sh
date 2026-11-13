#!/usr/bin/env bash
# No registry writes: exercise the real publication wrapper against a stub npm.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
mkdir -p "$work/package"
printf '{"name":"fixture","version":"1.0.0"}\n' > "$work/package/package.json"
tar -czf "$work/artifact.tgz" -C "$work" package
export PUBLISHED_TARBALL="$work/artifact.tgz"
export CALLS="$work/calls"
export EXPECTED="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$PUBLISHED_TARBALL")"
cat > "$work/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  publish)
    [[ "$2" == "$PUBLISHED_TARBALL" ]] || exit 97
    [[ "$3" == --access && "$4" == public && "$5" == --provenance ]] || exit 99
    case "$MODE" in
      success|mismatch) exit 0 ;;
      clientduplicate) printf 'npm error You cannot publish over the previously published versions: 1.0.0.\n' >&2 ;;
      duplicate) printf 'npm error code E403\ncannot publish over the previously published versions\n' >&2 ;;
      auth) printf 'npm error code E401\nfixture-sensitive-token\n' >&2 ;;
      server) printf 'npm error code E500\nfixture-sensitive-token\n' >&2 ;;
      misleading) printf 'npm error code E401\ncannot publish over the previously published versions\n' >&2 ;;
    esac
    exit 1 ;;
  view)
    if [[ "$MODE" == mismatch ]]; then printf '"sha512-%s=="\n' "$(printf 'b%.0s' {1..86})"; else printf '"%s"\n' "$EXPECTED"; fi ;;
  *) exit 98 ;;
esac
STUB
chmod +x "$work/bin/npm"
for mode in success duplicate clientduplicate auth server misleading mismatch; do
  : > "$CALLS"
  status=0
  MODE="$mode" PATH="$work/bin:$PATH" bash "$root/scripts/publish-npm-artifact.sh" "$work/artifact.tgz" fixture@1.0.0 "$EXPECTED" >"$work/output" 2>&1 || status=$?
  case "$mode" in
    success|duplicate|clientduplicate) expected=0 ;;
    mismatch) expected=1 ;;
    *) expected=5 ;;
  esac
  [[ "$status" == "$expected" ]] || { cat "$work/output"; printf 'FAIL %s: expected%s got%s\n' "$mode" "$expected" "$status"; exit 1; }
  if [[ "$expected" == 5 ]]; then
    ! grep -q '^view ' "$CALLS" || { printf 'FAIL: publish failure continued to readback\n'; exit 1; }
    ! grep -q 'fixture-sensitive-token' "$work/output" || { printf 'FAIL: raw credential-bearing npm output leaked\n'; exit 1; }
  else
    grep -q '^view fixture@1.0.0 dist.integrity --json' "$CALLS"
  fi
  printf 'ok: %s publication path (status%s)\n' "$mode" "$status"
done

# A syntactically valid digest must bind the local bytes before any registry write.
for invalid in digest identity version malformed; do
  artifact="$work/artifact.tgz"
  integrity="$EXPECTED"
  case "$invalid" in
    digest) integrity="sha512-$(printf 'b%.0s' {1..86})==" ;;
    identity|version)
      if [[ "$invalid" == identity ]]; then name=other; version=1.0.0; else name=fixture; version=2.0.0; fi
      printf '{"name":"%s","version":"%s"}\n' "$name" "$version" > "$work/package/package.json"
      artifact="$work/$invalid.tgz"
      tar -czf "$artifact" -C "$work" package
      integrity="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$artifact")" ;;
    malformed)
      artifact="$work/malformed.tgz"
      printf 'not a tar archive' > "$artifact"
      integrity="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$artifact")" ;;
  esac
  : > "$CALLS"
  status=0
  MODE=success PATH="$work/bin:$PATH" bash "$root/scripts/publish-npm-artifact.sh" "$artifact" fixture@1.0.0 "$integrity" > "$work/output" 2>&1 || status=$?
  [[ "$status" == 40 ]] || { printf 'FAIL local %s: expected40 got%s\n' "$invalid" "$status"; exit 1; }
  [[ ! -s "$CALLS" ]] || { printf 'FAIL: local artifact failure reached npm\n'; exit 1; }
  case "$invalid" in
    digest) reason=DIGEST_MISMATCH ;; identity) reason=NAME_MISMATCH ;;
    version) reason=VERSION_MISMATCH ;; malformed) reason=ARCHIVE_UNREADABLE ;;
  esac
  grep -q "$reason" "$work/output" || { printf 'FAIL: local %s lost fixed reason\n' "$invalid"; exit 1; }
  printf 'ok: local %s rejected before any npm call (status40)\n' "$invalid"
done

# Missing tools and bounded extraction timeouts are environment failures, not
# evidence that the archive bytes or identity differ. Simulate timeout inertly.
node_path=$(command -v node)
bash_path=$(command -v bash)
mkdir "$work/tool-bin"
ln -s "$node_path" "$work/tool-bin/node"
: > "$CALLS"
status=0
MODE=success PATH="$work/tool-bin" "$bash_path" "$root/scripts/publish-npm-artifact.sh" "$PUBLISHED_TARBALL" fixture@1.0.0 "$EXPECTED" > "$work/output" 2>&1 || status=$?
[[ "$status" == 41 ]] && grep -q 'local validation TOOL_UNAVAILABLE' "$work/output" && [[ ! -s "$CALLS" ]] || { printf 'FAIL: missing tar must be tooling41 with no npm call\n'; exit 1; }
printf 'ok: missing tar classified as tooling41\n'
# The mirror case: a node that cannot be found at all. Its reason code has to
# differ from the missing-tar one, otherwise a missing toolchain and a missing
# tool stay indistinguishable to the caller.
mkdir "$work/no-node-bin"
: > "$CALLS"
status=0
MODE=success PATH="$work/no-node-bin" "$bash_path" "$root/scripts/publish-npm-artifact.sh" "$PUBLISHED_TARBALL" fixture@1.0.0 "$EXPECTED" >"$work/output" 2>&1 || status=$?
[[ "$status" == 41 ]] && grep -q 'NODE_UNAVAILABLE' "$work/output" && ! grep -q 'TOOL_UNAVAILABLE' "$work/output" && [[ ! -s "$CALLS" ]] || { printf 'FAIL: missing node must be tooling41 with its own reason code\n'; exit 1; }
printf 'ok: missing node classified as tooling41 with a distinct reason code\n'
cat > "$work/timeout.cjs" <<'PRELOAD'
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(command, ...args) {
  if (command === 'tar') { const error = new Error('fixture-sensitive-token'); error.code = 'ETIMEDOUT'; throw error; }
  return original.call(this, command, ...args);
};
PRELOAD
status=0
MODE=success NODE_OPTIONS="--require=$work/timeout.cjs" PATH="$work/bin:$PATH" bash "$root/scripts/publish-npm-artifact.sh" "$PUBLISHED_TARBALL" fixture@1.0.0 "$EXPECTED" > "$work/output" 2>&1 || status=$?
[[ "$status" == 41 ]] && grep -q 'TOOL_TIMEOUT' "$work/output" && ! grep -q fixture-sensitive-token "$work/output" && [[ ! -s "$CALLS" ]] || { printf 'FAIL: timeout must be tooling41 without raw output/npm call\n'; exit 1; }
printf 'ok: extraction timeout classified as tooling41 without leaking raw errors\n'
# A manifest that is not valid JSON is an artifact failure, distinct from a
# tooling failure, and it must be reported before any registry write.
mkdir -p "$work/bad-manifest/package"
printf 'this is not json\n' > "$work/bad-manifest/package/package.json"
tar -czf "$work/bad-manifest.tgz" -C "$work/bad-manifest" package
bad_manifest_integrity="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$work/bad-manifest.tgz")"
: > "$CALLS"
status=0
MODE=success PATH="$work/bin:$PATH" bash "$root/scripts/publish-npm-artifact.sh" "$work/bad-manifest.tgz" fixture@1.0.0 "$bad_manifest_integrity" >"$work/output" 2>&1 || status=$?
[[ "$status" == 40 ]] && grep -q 'MANIFEST_INVALID' "$work/output" && [[ ! -s "$CALLS" ]] || { printf 'FAIL: invalid manifest must be artifact40 with no npm call\n'; exit 1; }
printf 'ok: invalid manifest classified as artifact40\n'
# A node that faults wearing an exit code the publisher reserves for its own
# decisions must not be reported as an artifact or registry verdict, and the
# observed status has to survive into the message.
mkdir "$work/fault-node-bin"
printf '#!/bin/sh\nexit 4\n' > "$work/fault-node-bin/node"
chmod +x "$work/fault-node-bin/node"
: > "$CALLS"
status=0
MODE=success PATH="$work/fault-node-bin" "$bash_path" "$root/scripts/publish-npm-artifact.sh" "$PUBLISHED_TARBALL" fixture@1.0.0 "$EXPECTED" >"$work/output" 2>&1 || status=$?
[[ "$status" == 41 ]] && grep -q 'TOOL_FAILURE (node exited 4)' "$work/output" && [[ ! -s "$CALLS" ]] || { printf 'FAIL: node fault must be tooling41 with the observed status\n'; exit 1; }
printf 'ok: node fault classified as tooling41 with the observed status\n'

# An inert local mutant proves the stub detects publishing a different operand.
mkdir "$work/mutant"
cp "$root/scripts/verify-npm-publication-integrity.sh" "$work/mutant/"
node - "$root/scripts/publish-npm-artifact.sh" "$work/mutant/publish-npm-artifact.sh" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const mutant = source.replace('npm publish "$tarball" --access', 'npm publish "$integrity" --access');
if (source === mutant) process.exit(1);
fs.writeFileSync(process.argv[3], mutant);
NODE
: > "$CALLS"
status=0
MODE=success PATH="$work/bin:$PATH" bash "$work/mutant/publish-npm-artifact.sh" "$PUBLISHED_TARBALL" fixture@1.0.0 "$EXPECTED" > "$work/output" 2>&1 || status=$?
[[ "$status" == 5 ]] && grep -q 'status 97' "$work/output" && ! grep -q '^view ' "$CALLS" || { printf 'FAIL: wrong-tarball operand was not detected\n'; exit 1; }
printf 'ok: wrong-tarball operand negative control rejected (stub97/wrapper5)\n'
