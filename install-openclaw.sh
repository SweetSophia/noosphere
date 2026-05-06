#!/usr/bin/env bash
set -euo pipefail

NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-latest}"
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}}"
APP_URL="${APP_URL:-http://127.0.0.1:${NOOSPHERE_PORT}}"
PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory}"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SECRETS_FILE="${NOOSPHERE_SECRETS_FILE:-$SECRETS_DIR/noosphere-memory.json}"
SECRET_PROVIDER_ID="${NOOSPHERE_SECRET_PROVIDER_ID:-noosphereMemory}"
PLUGIN_ID="noosphere-memory"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

random_secret() {
  node -e "console.log(require('crypto').randomBytes(Number(process.argv[2])).toString('base64url'))" "$1"
}

json_get() {
  local file="$1"
  local key="$2"
  JSON_GET_FILE="$file" JSON_GET_KEY="$key" node -e 'const fs=require("fs"); const p=process.env.JSON_GET_FILE; const k=process.env.JSON_GET_KEY; if (!p || !k || !fs.existsSync(p)) process.exit(0); const data=JSON.parse(fs.readFileSync(p,"utf8")); if (typeof data[k] === "string") process.stdout.write(data[k]);'
}

wait_for_container_healthy() {
  local name="$1"
  local attempts="${2:-60}"
  for _ in $(seq 1 "$attempts"); do
    local status
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      return 0
    fi
    sleep 2
  done
  echo "Container did not become healthy/running: $name" >&2
  docker logs "$name" --tail 80 >&2 || true
  exit 1
}

wait_for_http_health() {
  local url="$1"
  local attempts="${2:-60}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Noosphere health check failed: $url/api/health" >&2
  docker logs noosphere-openclaw-app --tail 120 >&2 || true
  exit 1
}

need docker
need node
need curl
need openclaw

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required: docker compose" >&2
  exit 1
fi

mkdir -p "$NOOSPHERE_HOME" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR" || true

POSTGRES_PASSWORD="$(json_get "$SECRETS_FILE" postgresPassword)"
NEXTAUTH_SECRET="$(json_get "$SECRETS_FILE" nextAuthSecret)"
ADMIN_PASSWORD="$(json_get "$SECRETS_FILE" adminPassword)"
API_KEY="$(json_get "$SECRETS_FILE" apiKey)"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(random_secret 32)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(random_secret 32)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret 24)}"
API_KEY="${API_KEY:-noo_$(random_secret 32)}"

install -m 600 /dev/null "$NOOSPHERE_HOME/.env"
# Write a minimal .env before bootstrap. Bootstrap-only secrets
# (NOOSPHERE_ADMIN_PASSWORD, NOOSPHERE_BOOTSTRAP_API_KEY) are passed via -e flags
# to docker compose run. The full .env with all secrets is written after bootstrap succeeds.
cat > "$NOOSPHERE_HOME/.env" <<ENV
NOOSPHERE_VERSION=${NOOSPHERE_VERSION}
NOOSPHERE_PORT=${NOOSPHERE_PORT}
APP_URL=${APP_URL}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
ENV

cat > "$NOOSPHERE_HOME/docker-compose.yml" <<YAML
services:
  init:
    image: ${NOOSPHERE_IMAGE}
    container_name: noosphere-openclaw-init
    restart: "no"
    environment:
      DATABASE_URL: postgresql://noosphere:\${POSTGRES_PASSWORD}@db:5432/noosphere
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL:-http://127.0.0.1:6578}
      APP_URL: \${APP_URL:-http://127.0.0.1:6578}
      UPLOAD_DIR: /app/uploads
    command: ["sh", "-c", "node docker/migrate-or-baseline.mjs && node docker/bootstrap.mjs"]
    volumes:
      - noosphere_uploads:/app/uploads:rw
    depends_on:
      db:
        condition: service_healthy

  app:
    image: ${NOOSPHERE_IMAGE}
    container_name: noosphere-openclaw-app
    restart: unless-stopped
    ports:
      - "127.0.0.1:\${NOOSPHERE_PORT:-6578}:3000"
    environment:
      DATABASE_URL: postgresql://noosphere:\${POSTGRES_PASSWORD}@db:5432/noosphere
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL:-http://127.0.0.1:6578}
      APP_URL: \${APP_URL:-http://127.0.0.1:6578}
      UPLOAD_DIR: /app/uploads
    volumes:
      - noosphere_uploads:/app/uploads:rw
    depends_on:
      init:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 45s

  db:
    image: postgres:16-alpine
    container_name: noosphere-openclaw-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: noosphere
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: noosphere
    volumes:
      - noosphere_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U noosphere -d noosphere"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  noosphere_postgres_data:
    driver: local
  noosphere_uploads:
    driver: local
YAML

cd "$NOOSPHERE_HOME"
echo "Starting Noosphere at ${APP_URL}..."
docker compose pull
docker compose up -d db
wait_for_container_healthy noosphere-openclaw-db 60

echo "Applying database schema and bootstrap data..."
# Run bootstrap to a temp file so we can check exit status separately.
# Admin/API credentials passed via -e flags -- never written to .env before bootstrap succeeds.
BOOTSTRAP_TMP=$(mktemp)
docker compose run --rm -T \
  -e NOOSPHERE_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  -e NOOSPHERE_BOOTSTRAP_API_KEY="${API_KEY}" \
  init > "$BOOTSTRAP_TMP" 2>&1
BOOTSTRAP_EXIT=$?
if [ $BOOTSTRAP_EXIT -ne 0 ]; then
  echo "Bootstrap failed with exit code $BOOTSTRAP_EXIT:" >&2
  cat "$BOOTSTRAP_TMP" >&2
  rm -f "$BOOTSTRAP_TMP"
  exit 1
fi
# Bootstrap writes JSON to stdout. Filter out [bootstrap] log lines and extract last non-empty line.
BOOTSTRAP_JSON=$(grep -v '^\[bootstrap\]' "$BOOTSTRAP_TMP" | grep -v '^$' | tail -n 1)
rm -f "$BOOTSTRAP_TMP"
if [ -z "$BOOTSTRAP_JSON" ]; then
  echo "Bootstrap produced no parseable JSON output" >&2
  exit 1
fi
# Validate JSON is parseable
if ! printf '%s' "$BOOTSTRAP_JSON" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { JSON.parse(s); process.exit(0); } catch { console.error(s); process.exit(1); } });' >/dev/null 2>&1; then
  echo "Bootstrap output was not valid JSON:" >&2
  echo "$BOOTSTRAP_JSON" >&2
  exit 1
fi

# Write the full .env (including bootstrap-only secrets) only after bootstrap succeeded.
# These are not needed by the app at runtime but are kept for documentation/manual runs.
cat >> "$NOOSPHERE_HOME/.env" <<ENV
NOOSPHERE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
NOOSPHERE_BOOTSTRAP_API_KEY=${API_KEY}
ENV

docker compose up -d app
wait_for_container_healthy noosphere-openclaw-app 30

install -m 600 /dev/null "$SECRETS_FILE"
cat > "$SECRETS_FILE" <<JSON
{
  "baseUrl": "${APP_URL}",
  "apiKey": "${API_KEY}",
  "adminEmail": "admin@noosphere.local",
  "adminPassword": "${ADMIN_PASSWORD}",
  "postgresPassword": "${POSTGRES_PASSWORD}",
  "nextAuthSecret": "${NEXTAUTH_SECRET}"
}
JSON

wait_for_http_health "$APP_URL" 60

echo "Installing OpenClaw plugin: ${PLUGIN_SPEC}"
if openclaw plugins inspect "$PLUGIN_ID" >/dev/null 2>&1; then
  openclaw plugins update "$PLUGIN_ID" || openclaw plugins install "$PLUGIN_SPEC" --force
else
  openclaw plugins install "$PLUGIN_SPEC"
fi

PATCH_FILE="$(mktemp)"
cat > "$PATCH_FILE" <<JSON5
{
  secrets: {
    providers: {
      "${SECRET_PROVIDER_ID}": {
        source: "file",
        path: "${SECRETS_FILE}",
        mode: "json",
      },
    },
  },
  plugins: {
    entries: {
      "${PLUGIN_ID}": {
        enabled: true,
        config: {
          baseUrl: "${APP_URL}",
          apiKey: { source: "file", provider: "${SECRET_PROVIDER_ID}", id: "/apiKey" },
          autoRecall: true,
          autoProviders: ["noosphere"],
          maxInjectedMemories: 10,
          maxInjectedTokens: 1000,
          recallInjectionPosition: "system-prepend",
          autoRecallTimeoutMs: 5000,
        },
        hooks: {
          allowPromptInjection: true,
        },
      },
    },
  },
}
JSON5

openclaw config patch --file "$PATCH_FILE"
rm -f "$PATCH_FILE"

if openclaw gateway status >/dev/null 2>&1; then
  echo "Restarting OpenClaw Gateway..."
  openclaw gateway restart
else
  echo "OpenClaw Gateway is not running or status is unavailable; start/restart it when ready."
fi

cat <<DONE

Noosphere OpenClaw setup complete.

Noosphere URL: ${APP_URL}
Admin email: admin@noosphere.local
Admin password: saved in ${SECRETS_FILE}
API key: saved in ${SECRETS_FILE}

Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw plugins inspect ${PLUGIN_ID} --runtime --json

DONE
