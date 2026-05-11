#!/usr/bin/env bash
set -euo pipefail

NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-latest}"
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}}"
PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory}"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SECRETS_FILE="${NOOSPHERE_SECRETS_FILE:-$SECRETS_DIR/noosphere-memory.json}"
SECRET_PROVIDER_ID="${NOOSPHERE_SECRET_PROVIDER_ID:-noosphere-memory}"
PLUGIN_ID="noosphere-memory"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

random_secret() {
  node -e "console.log(require('crypto').randomBytes(Number(process.argv[1])).toString('base64url'))" "$1"
}

json_get() {
  local file="$1"
  local key="$2"
  JSON_GET_FILE="$file" JSON_GET_KEY="$key" node -e '
    const fs=require("fs");
    const p=process.env.JSON_GET_FILE;
    const k=process.env.JSON_GET_KEY;
    if (!p || !k || !fs.existsSync(p)) process.exit(0);
    const data=JSON.parse(fs.readFileSync(p,"utf8"));
    if (typeof data[k] === "string") process.stdout.write(data[k]);
  '
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

# ── Prerequisites ─────────────────────────────────────────────────────────────
need docker
need node
need curl
need openclaw

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required: docker compose" >&2
  exit 1
fi

# ── Detect defaults ────────────────────────────────────────────────────────────
# Try to detect the machine's primary IP for Tailscale/LAN access suggestions.
DETECTED_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1 || true)"
if [ -z "$DETECTED_IP" ]; then
  DETECTED_IP=""
fi

NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"

# ── Binding choice: interactive if stdin is a TTY, otherwise auto-detect ────────
if [ -t 0 ]; then
  # Interactive mode — show menu
  echo ""
  echo "Noosphere bind address setup"
  echo "=============================="
  echo "  1) localhost (127.0.0.1) — accessible only on this machine"
  echo "  2) All interfaces (0.0.0.0) — accessible over LAN/Tailscale VPN"
  if [ -n "$DETECTED_IP" ]; then
    echo "  3) Use detected IP: $DETECTED_IP (recommended for Tailscale)"
  fi
  echo "  4) Custom IP or domain"
  echo ""

  default_choice() {
    if [ -n "$DETECTED_IP" ]; then echo "3"; else echo "2"; fi
  }

  read -p "How should Noosphere be accessible? [$(default_choice)]: " bind_choice
  bind_choice="${bind_choice:-$(default_choice)}"

  BIND=""        # Docker port bind address
  ACCESS_URL=""  # URL that clients use to reach Noosphere
  case "$bind_choice" in
    1) BIND="127.0.0.1"; ACCESS_URL="http://127.0.0.1:${NOOSPHERE_PORT}" ;;
    2) BIND="0.0.0.0";   ACCESS_URL="http://${DETECTED_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
    3) BIND="$DETECTED_IP"; ACCESS_URL="http://${DETECTED_IP}:${NOOSPHERE_PORT}" ;;
    4)
      read -p "Enter IP address or domain (include port if not $NOOSPHERE_PORT): " BIND
      ACCESS_URL="http://${BIND}"
      ;;
    *) echo "Invalid choice, defaulting to detected IP"; BIND="${DETECTED_IP:-0.0.0.0}"; ACCESS_URL="http://${DETECTED_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
  esac

  if [ -z "$ACCESS_URL" ]; then
    ACCESS_URL="http://${BIND}:${NOOSPHERE_PORT}"
  fi

  APP_URL="$ACCESS_URL"
  echo ""
  echo "  Noosphere will be accessible at: $APP_URL"
  echo ""
else
  # Non-interactive mode (curl | bash): auto-detect and use detected IP
  if [ -n "$DETECTED_IP" ]; then
    BIND="$DETECTED_IP"
    APP_URL="http://${DETECTED_IP}:${NOOSPHERE_PORT}"
  else
    BIND="0.0.0.0"
    APP_URL="http://127.0.0.1:${NOOSPHERE_PORT}"
  fi
  echo ""
  echo "Non-interactive mode — auto-detecting bind address..."
  echo "  Noosphere will be accessible at: $APP_URL"
  echo ""
fi

# ── Secrets (reuse existing or generate fresh) ─────────────────────────────────
mkdir -p "$NOOSPHERE_HOME" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

POSTGRES_PASSWORD="$(json_get "$SECRETS_FILE" postgresPassword)"
NEXTAUTH_SECRET="$(json_get "$SECRETS_FILE" nextAuthSecret)"
ADMIN_PASSWORD="$(json_get "$SECRETS_FILE" adminPassword)"
API_KEY="$(json_get "$SECRETS_FILE" apiKey)"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(random_secret 32)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(random_secret 32)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret 24)}"
API_KEY="${API_KEY:-noo_$(random_secret 32)}"

# ── Write .env BEFORE running docker compose ───────────────────────────────────
# Critical: docker compose run does not inherit shell exports reliably.
# All env vars must be in .env so the init container can authenticate.
cat > "$NOOSPHERE_HOME/.env" <<ENV
NOOSPHERE_VERSION=${NOOSPHERE_VERSION}
NOOSPHERE_PORT=${NOOSPHERE_PORT}
APP_URL=${APP_URL}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NOOSPHERE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
NOOSPHERE_BOOTSTRAP_API_KEY=${API_KEY}
ENV
chmod 600 "$NOOSPHERE_HOME/.env"

# Also export so docker compose up (which reads .env automatically) works
export NOOSPHERE_VERSION NOOSPHERE_PORT APP_URL POSTGRES_PASSWORD NEXTAUTH_SECRET
export NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"

# ── Docker Compose template ───────────────────────────────────────────────────
cat > "$NOOSPHERE_HOME/docker-compose.yml" <<YAML
services:
  init:
    image: ${NOOSPHERE_IMAGE}
    container_name: noosphere-openclaw-init
    restart: "no"
    environment:
      DATABASE_URL: postgresql://noosphere:\${POSTGRES_PASSWORD}@db:5432/noosphere
      NOOSPHERE_ADMIN_PASSWORD: \${NOOSPHERE_ADMIN_PASSWORD}
      NOOSPHERE_BOOTSTRAP_API_KEY: \${NOOSPHERE_BOOTSTRAP_API_KEY}
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL}
      APP_URL: \${APP_URL}
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
      - "${BIND}:\${NOOSPHERE_PORT:-6578}:3000"
    environment:
      DATABASE_URL: postgresql://noosphere:\${POSTGRES_PASSWORD}@db:5432/noosphere
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL}
      APP_URL: \${APP_URL}
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

# ── Start infrastructure ──────────────────────────────────────────────────────
cd "$NOOSPHERE_HOME"
echo "Pulling images..."
docker compose pull

echo "Starting database..."
docker compose up -d db
wait_for_container_healthy noosphere-openclaw-db 60

# ── Bootstrap (uses credentials from .env) ─────────────────────────────────────
echo "Applying database schema and bootstrap data..."
BOOTSTRAP_TMP=$(mktemp)
docker compose run --rm -T init > "$BOOTSTRAP_TMP" 2>&1
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

# Validate JSON
if ! printf '%s' "$BOOTSTRAP_JSON" | node -e '
  let s=""; process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    try { JSON.parse(s); process.exit(0); }
    catch { console.error(s); process.exit(1); }
  });
' >/dev/null 2>&1; then
  echo "Bootstrap output was not valid JSON:" >&2
  echo "$BOOTSTRAP_JSON" >&2
  exit 1
fi

# ── Start app ─────────────────────────────────────────────────────────────────
echo "Starting Noosphere app..."
docker compose up -d app
wait_for_container_healthy noosphere-openclaw-app 60

# ── Secrets file ──────────────────────────────────────────────────────────────
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

# ── OpenClaw plugin ───────────────────────────────────────────────────────────
echo "Installing OpenClaw plugin: ${PLUGIN_SPEC}"
if openclaw plugins inspect "$PLUGIN_ID" >/dev/null 2>&1; then
  openclaw plugins update "$PLUGIN_ID" || openclaw plugins install "$PLUGIN_SPEC" --force
else
  openclaw plugins install "$PLUGIN_SPEC"
fi

# ── Patch OpenClaw config ─────────────────────────────────────────────────────
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

if ! openclaw config patch --file "$PATCH_FILE" 2>&1; then
  echo "WARNING: Config patch failed. Plugin may need manual config." >&2
fi
rm -f "$PATCH_FILE"

# ── Restart gateway ────────────────────────────────────────────────────────────
if openclaw gateway status >/dev/null 2>&1; then
  echo "Restarting OpenClaw Gateway..."
  openclaw gateway restart
else
  echo "OpenClaw Gateway is not running. Start/restart it manually to load the plugin."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<DONE

Setup complete! 

  Noosphere URL:  ${APP_URL}
  Admin email:    admin@noosphere.local
  Admin password: saved in ${SECRETS_FILE}
  API key:        saved in ${SECRETS_FILE}

Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw noosphere status

DONE
