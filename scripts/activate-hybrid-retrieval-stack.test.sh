#!/usr/bin/env bash
# Fast, docker-free regression checks for the hybrid stack operator script.
set -euo pipefail
export LC_ALL=C

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/activate-hybrid-retrieval-stack.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$script" || fail "bash -n"

help_out=$(bash "$script" --help)
[[ "$help_out" == *"--force-recreate hybrid-worker"* ]] || fail "help missing --force-recreate"

snap_out=$(bash "$script" snapshot 2>&1) && fail "snapshot without --execute should die" || true
[[ "$snap_out" == *"refusing to mutate without --execute"* ]] || fail "snapshot missing execute gate: $snap_out"

unknown_out=$(bash "$script" --not-a-command 2>&1) && fail "unknown arg should die" || true
[[ "$unknown_out" == *"unknown argument"* ]] || fail "unknown arg message: $unknown_out"

python3 - <<'PY' || fail "password percent-encoding"
import urllib.parse
encoded = urllib.parse.quote("p@ss/word:x", safe="")
assert encoded == "p%40ss%2Fword%3Ax", encoded
assert "@" not in encoded and "/" not in encoded
print("url_encode_ok")
PY

python3 - <<'PY' || fail "profile endpoint allowlist"
from urllib.parse import urlparse

def ok(raw: str, expected_port: str) -> bool:
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    allowed = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}
    if (
        parsed.scheme not in {"http", "https"}
        or host not in allowed
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/v1/embeddings"
    ):
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return str(port) == str(expected_port)

assert ok("http://host.docker.internal:8741/v1/embeddings", "8741")
assert not ok("http://172.17.0.1:8741/v1/embeddings", "8741")
assert not ok("http://host.docker.internal:11434/v1/embeddings", "8741")
print("endpoint_allowlist_ok")
PY

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf 'FOO=old\nFOO=stale-tail\nNOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON=stale\n' >"$tmp"
printf '%s\n' '{"set":{"FOO":"new","NOOSPHERE_HYBRID_RETRIEVAL_ENABLED":"false"},"delete":["NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON"]}' | python3 /dev/fd/3 "$tmp" 3<<'PY'
import json, os, pathlib, re, sys, tempfile
env_path = pathlib.Path(sys.argv[1])
payload = json.loads(sys.stdin.read())
updates = payload.get("set") or {}
deletes = payload.get("delete") or []
text = env_path.read_text()
for key in deletes:
    text = re.sub(rf"^{re.escape(key)}=.*\n?", "", text, flags=re.M)
for key, value in updates.items():
    text = re.sub(rf"^{re.escape(key)}=.*\n?", "", text, flags=re.M)
    if not text.endswith("\n"):
        text += "\n"
    text += f"{key}={value}\n"
fd, tmp_name = tempfile.mkstemp(prefix=".env.", dir=str(env_path.parent))
try:
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp_name, 0o600)
    os.replace(tmp_name, env_path)
except Exception:
    try:
        os.unlink(tmp_name)
    except OSError:
        pass
    raise
print(env_path.read_text())
PY
grep -qx 'FOO=new' "$tmp" || fail "atomic set missed FOO"
grep -q 'FOO=stale-tail' "$tmp" && fail "atomic set left duplicate FOO" || true
grep -qx 'NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false' "$tmp" || fail "atomic append missed flag"
if grep -q 'NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON' "$tmp"; then
  fail "atomic delete left JSON"
fi

printf 'activate-hybrid-retrieval-stack.test.sh ok\n'
