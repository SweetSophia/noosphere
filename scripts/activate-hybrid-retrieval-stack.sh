#!/usr/bin/env bash
# Operator stack for hybrid retrieval (llama.cpp local embeddings).
# Default: dry-run. Mutating commands require --execute.
# Never prints database URLs, passwords, or HMAC material.
# Never starts Compose init. Never repairs mismatched A/B/C state.
set -euo pipefail
export LC_ALL=C

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

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
  worker        docker compose --profile hybrid up -d --no-deps hybrid-worker
  enable-flag   HMAC + two app recreates (false, then true)
  all           snapshot → activate-sql → profile → worker → enable-flag

Local embeddings: llama.cpp llama-server only. Do not use Ollama.
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

DB_HOST=${NOOSPHERE_HYBRID_DB_HOST:-127.0.0.1}
DB_PORT=${NOOSPHERE_HYBRID_DB_PORT:-5433}
EMBED_HOST=${NOOSPHERE_HYBRID_EMBED_HOST:-172.17.0.1}
EMBED_PORT=${NOOSPHERE_HYBRID_EMBED_PORT:-8741}
EMBED_MODEL=${NOOSPHERE_HYBRID_EMBED_MODEL:-nomic-embed-text}
EMBED_DIMS=${NOOSPHERE_HYBRID_EMBED_DIMS:-768}
PROFILE_ENDPOINT=${NOOSPHERE_HYBRID_PROFILE_ENDPOINT:-http://host.docker.internal:8741/v1/embeddings}
PROFILE_REVISION=${NOOSPHERE_HYBRID_PROFILE_REVISION:-Q8_0-b10783}
COMPOSE_DB_CONTAINER=${NOOSPHERE_DB_CONTAINER:-noosphere-db}

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

export_role_urls() {
  load_env_file
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || die "POSTGRES_PASSWORD is unset"
  [[ -n "${POSTGRES_MIGRATION_PASSWORD:-}" ]] || die "POSTGRES_MIGRATION_PASSWORD is unset"
  [[ -n "${POSTGRES_APP_PASSWORD:-}" ]] || die "POSTGRES_APP_PASSWORD is unset"
  [[ -n "${POSTGRES_HYBRID_ADMIN_PASSWORD:-}" ]] || die "POSTGRES_HYBRID_ADMIN_PASSWORD is unset"
  [[ -n "${POSTGRES_HYBRID_WORKER_PASSWORD:-}" ]] || die "POSTGRES_HYBRID_WORKER_PASSWORD is unset"
  export NOOSPHERE_BOOTSTRAP_DATABASE_URL="postgresql://noosphere:${POSTGRES_PASSWORD}@${DB_HOST}:${DB_PORT}/noosphere"
  export DATABASE_URL="postgresql://noosphere_migrator:${POSTGRES_MIGRATION_PASSWORD}@${DB_HOST}:${DB_PORT}/noosphere"
  export NOOSPHERE_APP_DATABASE_URL="postgresql://noosphere_app:${POSTGRES_APP_PASSWORD}@${DB_HOST}:${DB_PORT}/noosphere"
  export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="postgresql://noosphere_hybrid_admin_login:${POSTGRES_HYBRID_ADMIN_PASSWORD}@${DB_HOST}:${DB_PORT}/noosphere"
  export NOOSPHERE_HYBRID_WORKER_DATABASE_URL="postgresql://noosphere_hybrid_worker_login:${POSTGRES_HYBRID_WORKER_PASSWORD}@${DB_HOST}:${DB_PORT}/noosphere"
  export NOOSPHERE_DB_CONTAINER="$COMPOSE_DB_CONTAINER"
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
        payload = json.loads(resp.read())
except urllib.error.URLError as exc:
    print(f"embeddings_unreachable {exc}", file=sys.stderr)
    sys.exit(1)
except urllib.error.HTTPError as exc:
    print(f"embeddings_http_{exc.code}", file=sys.stderr)
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

cmd_dry_run() {
  need docker
  need jq
  need openssl
  need npm
  [[ -f "$repo_root/.env" ]] || die ".env is missing"
  [[ -f "$repo_root/docker-compose.yml" ]] || die "docker-compose.yml is missing"
  docker inspect "$COMPOSE_DB_CONTAINER" >/dev/null 2>&1 || die "container $COMPOSE_DB_CONTAINER is not running"
  marker=$(check_marker)
  printf '[hybrid-stack] writer-authorization: %s\n' "$marker"
  load_env_file
  printf '[hybrid-stack] flag=%s\n' "${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED:-unset}"
  for key in POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD; do
    eval "val=\${$key-}"
    [[ -n "$val" ]] || die "$key is unset"
    printf '[hybrid-stack] %s present len=%s\n' "$key" "${#val}"
  done
  check_embeddings
  printf '[hybrid-stack] dry-run plan (llama.cpp local provider; never Ollama):\n'
  printf '  1. snapshot pg_dump + .env\n'
  printf '  2. npm run hybrid-storage:activate && hybrid-worker:activate && hybrid-retrieval:activate\n'
  printf '  3. profile create --endpoint %s --model %s --dimensions %s\n' "$PROFILE_ENDPOINT" "$EMBED_MODEL" "$EMBED_DIMS"
  printf '  4. docker compose --profile hybrid up -d --no-deps hybrid-worker\n'
  printf '  5. serve at coverage >= 0.95, then two app recreates (flag false then true)\n'
  printf '[hybrid-stack] mutate with --execute <snapshot|activate-sql|profile|worker|enable-flag|all>\n'
}

cmd_snapshot() {
  require_execute
  need docker
  load_env_file
  stamp=$(date +%Y%m%d-%H%M%S)
  dest="${HOME}/.noosphere/backups/pre-hybrid-A-${stamp}"
  mkdir -p "$dest"
  cp -a "$repo_root/.env" "$dest/.env.bak"
  chmod 600 "$dest/.env.bak"
  docker exec "$COMPOSE_DB_CONTAINER" pg_dump -U noosphere -d noosphere -Fc >"$dest/pre-hybrid-A.dump"
  toc=$(pg_restore -l "$dest/pre-hybrid-A.dump" | grep -c -v '^;' || true)
  printf '[hybrid-stack] snapshot dir=%s dump_bytes=%s toc_nonzero=%s\n' \
    "$dest" "$(wc -c <"$dest/pre-hybrid-A.dump")" "$toc"
  printf '%s\n' "$dest" > /tmp/noosphere-hybrid-stack-backup-dir
}

cmd_activate_sql() {
  require_execute
  export_role_urls
  npm run hybrid-storage:activate
  npm run hybrid-worker:activate
  npm run hybrid-retrieval:activate
}

cmd_profile() {
  require_execute
  need jq
  check_embeddings
  export_role_urls
  profile_json=$(npm run --silent hybrid:profile -- create \
    --locality local \
    --endpoint "$PROFILE_ENDPOINT" \
    --model "$EMBED_MODEL" \
    --revision "$PROFILE_REVISION" \
    --dimensions "$EMBED_DIMS")
  profile_id=$(printf '%s' "$profile_json" | jq -er .profileId)
  printf '%s\n' "$profile_id" > /tmp/noosphere-hybrid-stack-profile-id
  printf '[hybrid-stack] profile_id=%s\n' "$profile_id"
  python3 - "$repo_root/.env" "$profile_id" "$PROFILE_ENDPOINT" <<'PY'
import base64, json, pathlib, re, sys
env_path = pathlib.Path(sys.argv[1])
profile_id, endpoint = sys.argv[2], sys.argv[3]
cfg = [{"profileId": profile_id, "locality": "local", "endpoint": endpoint, "apiKey": ""}]
raw = json.dumps(cfg, separators=(",", ":")).encode("utf-8")
b64 = base64.b64encode(raw).decode("ascii")
text = env_path.read_text()
line = f"NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64={b64}"
if re.search(r"^NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64=", text, re.M):
    text = re.sub(r"^NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64=.*$", line, text, count=1, flags=re.M)
else:
    if not text.endswith("\n"):
        text += "\n"
    text += line + "\n"
env_path.write_text(text)
env_path.chmod(0o600)
print("provider_b64_len", len(b64))
PY
  npm run --silent hybrid:profile -- prepare --profile "$profile_id"
  npm run --silent hybrid:backfill -- --profile "$profile_id" --chunk 100
}

cmd_worker() {
  require_execute
  check_embeddings
  docker compose --profile hybrid up -d --no-deps hybrid-worker
  printf '[hybrid-stack] worker started with --no-deps (init not invoked)\n'
}

cmd_enable_flag() {
  require_execute
  need openssl
  export_role_urls
  profile_id=${NOOSPHERE_HYBRID_QUERY_PROFILE_ID:-}
  if [[ -z "$profile_id" && -f /tmp/noosphere-hybrid-stack-profile-id ]]; then
    profile_id=$(cat /tmp/noosphere-hybrid-stack-profile-id)
  fi
  [[ -n "$profile_id" ]] || die "NOOSPHERE_HYBRID_QUERY_PROFILE_ID is unset (run profile first)"
  status_json=$(npm run --silent hybrid:profile -- status --profile "$profile_id")
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); c=float(d['coverage']);
print('coverage', c, 'state', d['profile_state']);
sys.exit(0 if c>=0.95 else 1)" "$status_json" || die "coverage below 0.95; refuse to enable"
  npm run --silent hybrid:profile -- serve --profile "$profile_id"
  python3 - "$repo_root/.env" "$profile_id" <<'PY'
import base64, json, pathlib, re, secrets, sys
env_path = pathlib.Path(sys.argv[1])
profile_id = sys.argv[2]
text = env_path.read_text()
key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
payload = json.dumps({"v1": key}, separators=(",", ":")).encode("ascii")
b64 = base64.b64encode(payload).decode("ascii")
updates = {
    "NOOSPHERE_HYBRID_QUERY_PROFILE_ID": profile_id,
    "NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION": "v1",
    "NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64": b64,
    "NOOSPHERE_HYBRID_RETRIEVAL_ENABLED": "false",
}
for k, v in updates.items():
    line = f"{k}={v}"
    if re.search(rf"^{k}=", text, re.M):
        text = re.sub(rf"^{k}=.*$", line, text, count=1, flags=re.M)
    else:
        if not text.endswith("\n"):
            text += "\n"
        text += line + "\n"
env_path.write_text(text)
env_path.chmod(0o600)
print("hmac_written len", len(b64), "flag false")
PY
  docker compose up -d --no-deps --force-recreate app
  printf '[hybrid-stack] app recreated with flag=false (keyword path)\n'
  python3 - "$repo_root/.env" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
text2, n = re.subn(r"^NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=.*$", "NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=true", text, count=1, flags=re.M)
if n != 1:
    raise SystemExit(f"flag replace count {n}")
p.write_text(text2)
p.chmod(0o600)
print("flag_now_true")
PY
  docker compose up -d --no-deps --force-recreate app
  printf '[hybrid-stack] app recreated with flag=true\n'
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
    cmd_snapshot
    cmd_activate_sql
    cmd_profile
    cmd_worker
    cmd_enable_flag
    ;;
  *) die "unknown command: $COMMAND" ;;
esac
