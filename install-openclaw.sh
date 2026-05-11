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
  echo "  Waiting for $name to become healthy..."
  for _ in $(seq 1 "$attempts"); do
    local status
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      echo "  $name is up."
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
  echo "  Waiting for Noosphere HTTP health..."
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      echo "  Noosphere is healthy."
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

# ── Detect network addresses ─────────────────────────────────────────────────────
NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"

TAILSCALE_IP=""
if [ -f /dev/tailscale ]; then
  TAILSCALE_IP="$(tailscale status --self --json 2>/dev/null | \
    python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(d.get("Self",{}).get("TailscaleIPs",[])))' 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$TAILSCALE_IP" ]; then
  TAILSCALE_IP="$(ip addr show tailscale0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1)"
fi

DEFAULT_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1 || true)"

# ── Show menu and prompt for bind choice ───────────────────────────────────────
echo ""
echo "Noosphere bind address setup"
echo "=============================="
echo "  1) localhost (127.0.0.1) — accessible only on this machine"
if [ -n "$TAILSCALE_IP" ]; then
  echo "  2) Tailscale (${TAILSCALE_IP}) — recommended for VPN access"
fi
echo "  3) All interfaces (0.0.0.0) — accessible over LAN/WAN"
if [ -n "$DEFAULT_IP" ] && [ "$DEFAULT_IP" != "$TAILSCALE_IP" ]; then
  echo "  4) Use server IP: ${DEFAULT_IP}"
fi
echo "  5) Custom"
echo ""

default_choice() {
  if [ -n "$TAILSCALE_IP" ]; then echo "2"
  elif [ -n "$DEFAULT_IP" ]; then echo "3"
  else echo "3"
  fi
}

read -p "How should Noosphere be accessible? [$(default_choice)]: " bind_choice
bind_choice="${bind_choice:-$(default_choice)}"
bind_choice="$(echo "${bind_choice}" | tr -d '[:space:]')"
case "${bind_choice}" in 1|2|3|4|5) ;; *) bind_choice="$(default_choice)" ;; esac

BIND=""
ACCESS_URL=""

case "$bind_choice" in
  1) BIND="127.0.0.1"; ACCESS_URL="http://127.0.0.1:${NOOSPHERE_PORT}" ;;
  2) BIND="0.0.0.0";   ACCESS_URL="http://${TAILSCALE_IP}:${NOOSPHERE_PORT}" ;;
  3) BIND="0.0.0.0";   ACCESS_URL="http://${DEFAULT_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
  4) BIND="$DEFAULT_IP"; ACCESS_URL="http://${DEFAULT_IP}:${NOOSPHERE_PORT}" ;;
  5)
    read -p "Enter bind address (e.g. 0.0.0.0 or 127.0.0.1): " bind_addr
    read -p "Enter the URL clients will use to access Noosphere: " ACCESS_URL
    BIND="${bind_addr:-0.0.0.0}"
    ;;
  *) echo "Invalid choice, defaulting to Tailscale IP"; BIND="0.0.0.0"; ACCESS_URL="http://${TAILSCALE_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
esac

if [ -z "$ACCESS_URL" ]; then
  ACCESS_URL="http://${BIND}:${NOOSPHERE_PORT}"
fi

APP_URL="$ACCESS_URL"

echo ""
echo "  Bind: $BIND  |  Access URL: $APP_URL"
echo ""

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
echo ""
echo "==> Pulling images..."
docker compose pull

echo ""
echo "==> Starting PostgreSQL database..."
docker compose up -d db
wait_for_container_healthy noosphere-openclaw-db 60

# ── Bootstrap ─────────────────────────────────────────────────────────────────
echo ""
echo "==> Running database migrations and bootstrap (this may take a moment)..."
echo "    (output streams live below)"
BOOTSTRAP_TMP=$(mktemp)
# Stream output live to Sophie AND capture to temp file for parsing
docker compose run --rm init 2>&1 | tee "$BOOTSTRAP_TMP"
BOOTSTRAP_EXIT=${PIPESTATUS[0]}
if [ $BOOTSTRAP_EXIT -ne 0 ]; then
  echo "Bootstrap failed with exit code $BOOTSTRAP_EXIT" >&2
  exit 1
fi

BOOTSTRAP_JSON=$(grep -v '^\[bootstrap\]' "$BOOTSTRAP_TMP" | grep -v '^$' | tail -n 1)
rm -f "$BOOTSTRAP_TMP"

if [ -z "$BOOTSTRAP_JSON" ]; then
  echo "Bootstrap produced no parseable JSON output" >&2
  exit 1
fi

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

# ── Secrets file written HERE — before long-running steps ──────────────────────
# If everything below fails, credentials are already saved and accessible.
echo ""
echo "==> Writing credentials to ${SECRETS_FILE}..."
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

# ── Start app ─────────────────────────────────────────────────────────────────
echo ""
echo "==> Starting Noosphere app..."
docker compose up -d app
wait_for_container_healthy noosphere-openclaw-app 60

# ── Wait for HTTP health ───────────────────────────────────────────────────────
wait_for_http_health "$APP_URL" 60

# ── OpenClaw plugin ─────────────────────────────────────────────────────────
echo ""
echo "==> Installing OpenClaw plugin..."
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
  echo "WARNING: Config patch failed. Plugin may need manual configuration." >&2
fi
rm -f "$PATCH_FILE"

# ── Restart gateway ────────────────────────────────────────────────────────────
echo ""
echo "==> Restarting OpenClaw Gateway..."
if openclaw gateway status >/dev/null 2>&1; then
  openclaw gateway restart
else
  echo "OpenClaw Gateway is not running. Start it manually to load the plugin."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<DONE

====================================================================
Setup complete!
====================================================================

  Noosphere URL:  ${APP_URL}
  Admin email:    admin@noosphere.local
  Admin password: ${ADMIN_PASSWORD}

  All credentials saved in: ${SECRETS_FILE}

====================================================================
Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw noosphere status
====================================================================

DONE
