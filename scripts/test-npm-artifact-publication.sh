#!/usr/bin/env bash
# No registry writes: exercise the real publication wrapper against a stub npm.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
: > "$work/artifact.tgz"
export CALLS="$work/calls"
export EXPECTED="sha512-$(printf 'a%.0s' {1..86})=="
cat > "$work/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  publish)
    [[ "$3" == --access && "$4" == public && "$5" == --provenance ]] || exit 99
    case "$MODE" in
      success|mismatch) exit 0 ;;
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
for mode in success duplicate auth server misleading mismatch; do
  : > "$CALLS"
  status=0
  MODE="$mode" PATH="$work/bin:$PATH" bash "$root/scripts/publish-npm-artifact.sh" "$work/artifact.tgz" fixture@1.0.0 "$EXPECTED" >"$work/output" 2>&1 || status=$?
  case "$mode" in
    success|duplicate) expected=0 ;;
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
