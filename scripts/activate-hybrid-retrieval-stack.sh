#!/usr/bin/env bash
# Operator stack for hybrid retrieval (llama.cpp local embeddings).
# Default: dry-run. Mutating commands require --execute.
# Never prints database URLs, passwords, or HMAC material.
# Never starts Compose init. Never repairs mismatched A/B/C state.
set -euo pipefail
export LC_ALL=C

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

STATE_DIR="${HOME}/.noosphere/hybrid-stack"
PROFILE_ID_FILE="${STATE_DIR}/profile-id"

die() {
  printf '[hybrid-stack] ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/activate-hybrid-retrieval-stack.sh [--execute] <command>

Default (no command) is dry-run.

Commands:
  dry-run       Check stack + llama.cpp embeddings health; print plan
  snapshot      pg_dump -Fc and mode-0600 .env backup
  activate-sql  Phase A then B then C (existing activators)
  profile       Create/prepare/backfill local llama.cpp profile
  worker        docker compose --profile hybrid up -d --no-deps --force-recreate hybrid-worker
  enable-flag   HMAC + two app recreates (false, then true)
  all           snapshot → activate-sql → profile → worker → enable-flag

Local embeddings: llama.cpp llama-server only. Do not use Ollama.
Override defaults via .env or the environment:
  NOOSPHERE_HYBRID_DB_HOST NOOSPHERE_HYBRID_DB_PORT
  NOOSPHERE_HYBRID_EMBED_HOST NOOSPHERE_HYBRID_EMBED_PORT
  NOOSPHERE_HYBRID_EMBED_MODEL NOOSPHERE_HYBRID_EMBED_DIMS
  NOOSPHERE_HYBRID_PROFILE_ENDPOINT NOOSPHERE_HYBRID_PROFILE_REVISION
  NOOSPHERE_DB_CONTAINER NOOSPHERE_HYBRID_APP_HEALTH_URL
See docs/HYBRID-RETRIEVAL-ACTIVATION.md.
EOF
}

EXECUTE=0
COMMAND=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    dry-run|snapshot|activate-sql|profile|worker|enable-flag|all)
      [[ -z "$COMMAND" ]] || die "multiple commands"
      COMMAND=$1
      shift
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
COMMAND=${COMMAND:-dry-run}

require_execute() {
  [[ "$EXECUTE" -eq 1 ]] || die "refusing to mutate without --execute (command=$COMMAND)"
}

load_env_file() {
  [[ -f "$repo_root/.env" ]] || die ".env is missing"
  set -a
  # shellcheck disable=SC1091
  . "$repo_root/.env"
  set +a
}

resolve_settings() {
  DB_HOST=${NOOSPHERE_HYBRID_DB_HOST:-127.0.0.1}
  DB_PORT=${NOOSPHERE_HYBRID_DB_PORT:-5433}
  EMBED_HOST=${NOOSPHERE_HYBRID_EMBED_HOST:-172.17.0.1}
  EMBED_PORT=${NOOSPHERE_HYBRID_EMBED_PORT:-8741}
  EMBED_MODEL=${NOOSPHERE_HYBRID_EMBED_MODEL:-nomic-embed-text}
  EMBED_DIMS=${NOOSPHERE_HYBRID_EMBED_DIMS:-768}
  PROFILE_ENDPOINT=${NOOSPHERE_HYBRID_PROFILE_ENDPOINT:-http://host.docker.internal:8741/v1/embeddings}
  PROFILE_REVISION=${NOOSPHERE_HYBRID_PROFILE_REVISION:-Q8_0-b10783}
  COMPOSE_DB_CONTAINER=${NOOSPHERE_DB_CONTAINER:-noosphere-db}
  APP_HEALTH_URL=${NOOSPHERE_HYBRID_APP_HEALTH_URL:-http://127.0.0.1:6578/api/health}
}

is_loopback_host() {
  case "$1" in
    127.0.0.1|localhost|::1|localhost.localdomain) return 0 ;;
    *) return 1 ;;
  esac
}

validate_profile_endpoint() {
  need python3
  python3 - "$PROFILE_ENDPOINT" "$EMBED_PORT" <<'PY'
import sys
from urllib.parse import urlparse

raw, expected_port = sys.argv[1], sys.argv[2]
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
    print(
        "profile_endpoint_rejected: local providers require http(s)://"
        "{127.0.0.1|localhost|::1|host.docker.internal}/v1/embeddings "
        "(not the docker0 probe address 172.17.0.1)",
        file=sys.stderr,
    )
    sys.exit(1)
port = parsed.port or (443 if parsed.scheme == "https" else 80)
if str(port) != str(expected_port):
    print(
        f"profile_endpoint_port_mismatch endpoint_port={port} embed_port={expected_port}",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"profile_endpoint_ok host={host} port={port}")
PY
}

export_role_urls() {
  need python3
  load_env_file
  resolve_settings
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || die "POSTGRES_PASSWORD is unset"
  [[ -n "${POSTGRES_MIGRATION_PASSWORD:-}" ]] || die "POSTGRES_MIGRATION_PASSWORD is unset"
  [[ -n "${POSTGRES_APP_PASSWORD:-}" ]] || die "POSTGRES_APP_PASSWORD is unset"
  [[ -n "${POSTGRES_HYBRID_ADMIN_PASSWORD:-}" ]] || die "POSTGRES_HYBRID_ADMIN_PASSWORD is unset"
  [[ -n "${POSTGRES_HYBRID_WORKER_PASSWORD:-}" ]] || die "POSTGRES_HYBRID_WORKER_PASSWORD is unset"
  if is_loopback_host "$DB_HOST"; then
    eval "$(python3 - "$DB_HOST" "$DB_PORT" <<'PY'
import os, sys, urllib.parse

host, port = sys.argv[1], sys.argv[2]

def enc(name: str) -> str:
    return urllib.parse.quote(os.environ[name], safe="")

def line(var: str, user: str, pw_env: str) -> str:
    return f"export {var}='postgresql://{user}:{enc(pw_env)}@{host}:{port}/noosphere'"

print(line("NOOSPHERE_BOOTSTRAP_DATABASE_URL", "noosphere", "POSTGRES_PASSWORD"))
print(line("DATABASE_URL", "noosphere_migrator", "POSTGRES_MIGRATION_PASSWORD"))
print(line("NOOSPHERE_APP_DATABASE_URL", "noosphere_app", "POSTGRES_APP_PASSWORD"))
print(line("NOOSPHERE_HYBRID_ADMIN_DATABASE_URL", "noosphere_hybrid_admin_login", "POSTGRES_HYBRID_ADMIN_PASSWORD"))
print(line("NOOSPHERE_HYBRID_WORKER_DATABASE_URL", "noosphere_hybrid_worker_login", "POSTGRES_HYBRID_WORKER_PASSWORD"))
PY
)"
  else
    [[ -n "${NOOSPHERE_BOOTSTRAP_DATABASE_URL:-}" && -n "${DATABASE_URL:-}" && -n "${NOOSPHERE_APP_DATABASE_URL:-}" && -n "${NOOSPHERE_HYBRID_ADMIN_DATABASE_URL:-}" && -n "${NOOSPHERE_HYBRID_WORKER_DATABASE_URL:-}" ]] ||
      die "nonlocal DB_HOST=${DB_HOST}: set the five *DATABASE_URL values (include sslmode) instead of constructing cleartext URLs"
  fi
  export NOOSPHERE_DB_CONTAINER="$COMPOSE_DB_CONTAINER"
}

atomic_env_update() {
  need python3
  python3 /dev/fd/3 "$repo_root/.env" 3<<'PY'
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
env_path.chmod(0o600)
print("env_updated keys", len(updates), "deleted", len(deletes))
PY
}

check_embeddings() {
  need python3
  python3 - "$EMBED_HOST" "$EMBED_PORT" "$EMBED_MODEL" "$EMBED_DIMS" <<'PY'
import json, sys, urllib.error, urllib.request
host, port, model, dims = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
url = f"http://{host}:{port}/v1/embeddings"
body = json.dumps({"model": model, "input": "noosphere-hybrid-stack-ping", "encoding_format": "float"}).encode()
req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "accept": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        ctype = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        raw = resp.read(1_000_000)
        payload = json.loads(raw)
except urllib.error.HTTPError as exc:
    print(f"embeddings_http_{exc.code}", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError as exc:
    print(f"embeddings_unreachable {exc}", file=sys.stderr)
    sys.exit(1)
except (json.JSONDecodeError, ValueError, OSError) as exc:
    print(f"embeddings_invalid_body {exc}", file=sys.stderr)
    sys.exit(1)
emb = payload.get("data", [{}])[0].get("embedding") if isinstance(payload.get("data"), list) else None
ok_type = ctype == "application/json"
ok_model = payload.get("model") == model
ok_dims = isinstance(emb, list) and len(emb) == dims
if not (ok_type and ok_model and ok_dims):
    print(
        f"embeddings_contract_mismatch content_type={ctype!r} model={payload.get('model')!r} dims={len(emb) if isinstance(emb, list) else 'n/a'}",
        file=sys.stderr,
    )
    sys.exit(1)
print(f"embeddings_ok host={host} port={port} model={model} dims={dims}")
PY
}

check_marker() {
  docker exec "$COMPOSE_DB_CONTAINER" sh -c 'cat /run/noosphere-pgvector/writer-authorized 2>/dev/null' \
    || die "writer-authorization marker missing on $COMPOSE_DB_CONTAINER"
}

wait_for_app_health() {
  need curl
  local i
  for i in $(seq 1 45); do
    if curl -fsS -m 3 "$APP_HEALTH_URL" >/dev/null 2>&1; then
      printf '[hybrid-stack] app health ok\n'
      return 0
    fi
    sleep 2
  done
  printf '[hybrid-stack] app did not become healthy at %s\n' "$APP_HEALTH_URL" >&2
  return 1
}

wait_for_worker_health() {
  local id status i
  id=$(docker compose --profile hybrid ps -q hybrid-worker)
  [[ -n "$id" ]] || die "hybrid-worker container not found"
  for i in $(seq 1 45); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
    if [[ "$status" == "healthy" ]]; then
      printf '[hybrid-stack] worker health ok\n'
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      die "hybrid-worker $status"
    fi
    sleep 2
  done
  die "hybrid-worker did not become healthy"
}

cmd_dry_run() {
  need docker
  need python3
  load_env_file
  resolve_settings
  [[ -f "$repo_root/docker-compose.yml" ]] || die "docker-compose.yml is missing"
  docker inspect "$COMPOSE_DB_CONTAINER" >/dev/null 2>&1 || die "container $COMPOSE_DB_CONTAINER is not running"
  marker=$(check_marker)
  printf '[hybrid-stack] writer-authorization: %s\n' "$marker"
  printf '[hybrid-stack] flag=%s\n' "${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED:-unset}"
  for key in POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD; do
    eval "val=\${$key-}"
    [[ -n "$val" ]] || die "$key is unset"
    printf '[hybrid-stack] %s present len=%s\n' "$key" "${#val}"
  done
  check_embeddings
  validate_profile_endpoint
  printf '[hybrid-stack] dry-run plan (llama.cpp local provider; never Ollama):\n'
  printf '  1. snapshot pg_dump + .env\n'
  printf '  2. npm run hybrid-storage:activate && hybrid-worker:activate && hybrid-retrieval:activate\n'
  printf '  3. profile create --endpoint %s --model %s --dimensions %s\n' "$PROFILE_ENDPOINT" "$EMBED_MODEL" "$EMBED_DIMS"
  printf '  4. docker compose --profile hybrid up -d --no-deps --force-recreate hybrid-worker\n'
  printf '  5. serve at coverage >= 0.95, then two app recreates (flag false then true)\n'
  printf '[hybrid-stack] mutate with --execute <snapshot|activate-sql|profile|worker|enable-flag|all>\n'
}

cmd_snapshot() {
  require_execute
  need docker
  need pg_restore
  load_env_file
  resolve_settings
  umask 077
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="${HOME}/.noosphere/backups/pre-hybrid-A-${stamp}"
  mkdir -p "$dest"
  chmod 700 "$dest"
  cp -a "$repo_root/.env" "$dest/.env.bak"
  chmod 600 "$dest/.env.bak"
  docker exec "$COMPOSE_DB_CONTAINER" pg_dump -U noosphere -d noosphere -Fc >"$dest/pre-hybrid-A.dump"
  chmod 600 "$dest/pre-hybrid-A.dump"
  dump_bytes=$(wc -c <"$dest/pre-hybrid-A.dump")
  [[ "$dump_bytes" -gt 0 ]] || die "snapshot dump is empty"
  toc_list=$(pg_restore -l "$dest/pre-hybrid-A.dump") || die "pg_restore -l failed (dump unreadable)"
  toc=$(printf '%s\n' "$toc_list" | grep -c -v '^;' || true)
  [[ "$toc" -gt 0 ]] || die "snapshot dump TOC is empty"
  printf '[hybrid-stack] snapshot dir=%s dump_bytes=%s toc_nonzero=%s\n' \
    "$dest" "$dump_bytes" "$toc"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  printf '%s\n' "$dest" >"${STATE_DIR}/backup-dir"
  chmod 600 "${STATE_DIR}/backup-dir"
}

cmd_activate_sql() {
  require_execute
  need npm
  export_role_urls
  npm run hybrid-storage:activate
  npm run hybrid-worker:activate
  npm run hybrid-retrieval:activate
}

cmd_profile() {
  require_execute
  need jq
  need node
  need python3
  load_env_file
  resolve_settings
  check_embeddings
  validate_profile_endpoint
  export_role_urls
  profile_json=$(node scripts/hybrid-profile.mjs create \
    --locality local \
    --endpoint "$PROFILE_ENDPOINT" \
    --model "$EMBED_MODEL" \
    --revision "$PROFILE_REVISION" \
    --dimensions "$EMBED_DIMS")
  profile_id=$(printf '%s' "$profile_json" | jq -er .profileId)
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  printf '%s\n' "$profile_id" >"$PROFILE_ID_FILE"
  chmod 600 "$PROFILE_ID_FILE"
  printf '[hybrid-stack] profile_id=%s\n' "$profile_id"
  python3 - "$profile_id" "$PROFILE_ENDPOINT" <<'PY' | atomic_env_update
import json, sys, base64
cfg = [{"profileId": sys.argv[1], "locality": "local", "endpoint": sys.argv[2], "apiKey": ""}]
b64 = base64.b64encode(json.dumps(cfg, separators=(",", ":")).encode()).decode()
print(json.dumps({"set": {"NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64": b64}, "delete": ["NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON"]}))
PY
  node scripts/hybrid-profile.mjs prepare --profile "$profile_id"
  node scripts/hybrid-backfill.mjs --profile "$profile_id" --chunk 100
}

cmd_worker() {
  require_execute
  need docker
  load_env_file
  resolve_settings
  check_embeddings
  validate_profile_endpoint
  docker compose --profile hybrid up -d --no-deps --force-recreate hybrid-worker
  printf '[hybrid-stack] worker started with --no-deps --force-recreate (init not invoked)\n'
  wait_for_worker_health
}

cmd_enable_flag() {
  require_execute
  need node
  need python3
  need curl
  need docker
  export_role_urls
  profile_id=${NOOSPHERE_HYBRID_QUERY_PROFILE_ID:-}
  if [[ -z "$profile_id" && -f "$PROFILE_ID_FILE" ]]; then
    profile_id=$(cat "$PROFILE_ID_FILE")
  fi
  [[ -n "$profile_id" ]] || die "NOOSPHERE_HYBRID_QUERY_PROFILE_ID is unset (run profile first)"
  [[ "$profile_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || die "profile id is not a UUID"
  status_json=$(node scripts/hybrid-profile.mjs status --profile "$profile_id")
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); c=float(d['coverage']); completed=bool(d.get('backfill_completed'));
print('coverage', c, 'state', d['profile_state'], 'backfill_completed', completed);
sys.exit(0 if c>=0.95 and completed else 1)" "$status_json" || die "coverage below 0.95 or backfill incomplete; refuse to enable"
  node scripts/hybrid-profile.mjs serve --profile "$profile_id"
  python3 - "$profile_id" <<'PY' | atomic_env_update
import base64, json, secrets, sys
key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
hmac_b64 = base64.b64encode(json.dumps({"v1": key}, separators=(",", ":")).encode("ascii")).decode("ascii")
print(json.dumps({"set": {
    "NOOSPHERE_HYBRID_QUERY_PROFILE_ID": sys.argv[1],
    "NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION": "v1",
    "NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64": hmac_b64,
    "NOOSPHERE_HYBRID_RETRIEVAL_ENABLED": "false",
}}))
PY
  docker compose up -d --no-deps --force-recreate app
  printf '[hybrid-stack] app recreated with flag=false (keyword path)\n'
  wait_for_app_health || die "app did not become healthy at $APP_HEALTH_URL (flag still false)"
  # Re-running enable-flag mints a new v1 HMAC key (cache misses). It is not add-then-retire rotation.
  printf '%s\n' '{"set":{"NOOSPHERE_HYBRID_RETRIEVAL_ENABLED":"true"}}' | atomic_env_update
  docker compose up -d --no-deps --force-recreate app
  printf '[hybrid-stack] app recreated with flag=true\n'
  if ! wait_for_app_health; then
    printf '%s\n' '{"set":{"NOOSPHERE_HYBRID_RETRIEVAL_ENABLED":"false"}}' | atomic_env_update
    docker compose up -d --no-deps --force-recreate app || true
    die "app unhealthy after flag=true; restored NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false. See docs/HYBRID-RETRIEVAL-ACTIVATION.md Rollback"
  fi
}

case "$COMMAND" in
  dry-run) cmd_dry_run ;;
  snapshot) cmd_snapshot ;;
  activate-sql) cmd_activate_sql ;;
  profile) cmd_profile ;;
  worker) cmd_worker ;;
  enable-flag) cmd_enable_flag ;;
  all)
    require_execute
    load_env_file
    resolve_settings
    cmd_snapshot
    check_embeddings
    validate_profile_endpoint
    cmd_activate_sql
    cmd_profile
    cmd_worker
    cmd_enable_flag
    ;;
  *) die "unknown command: $COMMAND" ;;
esac
