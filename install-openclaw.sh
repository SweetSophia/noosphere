#!/usr/bin/env bash
# Noosphere OpenClaw Installer
# Interactive (recommended):  bash install-openclaw.sh
# Non-interactive:          curl -fsSL https://.../install-openclaw.sh | bash
#                          or:  NOOSPHERE_BIND=2 bash install-openclaw.sh
#
# Environment options:
#   NOOSPHERE_BIND=1|2|3|4|5   Skip menu, use this bind choice
#   NOOSPHERE_PORT=6578           Override port
#   NOOSPHERE_HOME=~/.noosphere  Override install directory

set -euo pipefail

NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-latest}"
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}}"
PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory}"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SECRETS_FILE="${NOOSPHERE_SECRETS_FILE:-$SECRETS_DIR/noosphere-memory.json}"
SECRET_PROVIDER_ID="${NOOSPHERE_SECRET_PROVIDER_ID:-noosphere-memory}"
PLUGIN_ID="noosphere-memory"
NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"

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

# ── Prerequisites ─────────────────────────────────────────────────────────────
need docker
need node
need curl
need openclaw

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Install: docker compose" >&2
  exit 1
fi

# ── Detect network addresses ─────────────────────────────────────────────────────
TAILSCALE_IP="$(ip addr show tailscale0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1 || true)"
DEFAULT_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1 || true)"

# ── Bind choice ─────────────────────────────────────────────────────────────────
# Set NOOSPHERE_BIND=1-5 to skip the menu entirely.
# When stdin is a TTY, read waits for real user input.
# When stdin is NOT a TTY (curl|bash), read times out after 5 seconds and
# uses the default — the menu is still shown so the user sees what's happening.

show_menu() {
  echo ""
  echo "Noosphere bind address setup"
  echo "=============================="
  echo "  1) localhost (127.0.0.1) — this machine only"
  if [ -n "$TAILSCALE_IP" ]; then
    echo "  2) Tailscale (${TAILSCALE_IP}) — recommended for VPN"
  fi
  echo "  3) All interfaces (0.0.0.0) — LAN/WAN"
  if [ -n "$DEFAULT_IP" ] && [ "$DEFAULT_IP" != "$TAILSCALE_IP" ]; then
    echo "  4) Server IP: ${DEFAULT_IP}"
  fi
  echo "  5) Custom (enter your own bind + URL)"
  echo ""
  if [ -n "$TAILSCALE_IP" ]; then
    echo "  Default: option 2 (Tailscale)"
  else
    echo "  Default: option 3 (all interfaces)"
  fi
  echo ""
}

default_choice() {
  if [ -n "$TAILSCALE_IP" ]; then echo "2"
  elif [ -n "$DEFAULT_IP" ]; then echo "3"
  else echo "3"
  fi
}

# Skip menu if NOOSPHERE_BIND is set
if [ -n "${NOOSPHERE_BIND:-}" ]; then
  BIND_CHOICE="$NOOSPHERE_BIND"
  echo ""
  echo "Using NOOSPHERE_BIND=$BIND_CHOICE (from environment)"
else
  show_menu

  if [ -t 0 ]; then
    # Real TTY — wait for user input
    read -p "Bind choice [$(default_choice)]: " BIND_CHOICE
    BIND_CHOICE="${BIND_CHOICE:-$(default_choice)}"
  else
    # Pipe / non-TTY — show menu, auto-advance after 5 seconds
    echo -n "Bind choice [$(default_choice)]: "
    read -t 5 -r BIND_CHOICE 2>/dev/null || true
    BIND_CHOICE="${BIND_CHOICE:-$(default_choice)}"
    echo "auto-selected: $BIND_CHOICE"
  fi
fi

BIND_CHOICE="$(echo "$BIND_CHOICE" | tr -cd '0-9')"
case "$BIND_CHOICE" in 1|2|3|4|5) ;; *) BIND_CHOICE="$(default_choice)" ;; esac

BIND=""
ACCESS_URL=""
case "$BIND_CHOICE" in
  1) BIND="127.0.0.1"; ACCESS_URL="http://127.0.0.1:${NOOSPHERE_PORT}" ;;
  2) BIND="0.0.0.0";   ACCESS_URL="http://${TAILSCALE_IP}:${NOOSPHERE_PORT}" ;;
  3) BIND="0.0.0.0";   ACCESS_URL="http://${DEFAULT_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
  4) BIND="$DEFAULT_IP"; ACCESS_URL="http://${DEFAULT_IP}:${NOOSPHERE_PORT}" ;;
  5)
    echo ""
    read -p "  Bind address [0.0.0.0]: " BIND_ADDR
    read -p "  Access URL [http://100.x.x.x:${NOOSPHERE_PORT}]: " ACCESS_URL
    BIND="${BIND_ADDR:-0.0.0.0}"
    ACCESS_URL="${ACCESS_URL:-http://100.x.x.x:${NOOSPHERE_PORT}}"
    ;;
  *) echo "Unknown choice, defaulting"; BIND="0.0.0.0"; ACCESS_URL="http://${TAILSCALE_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
esac

APP_URL="${ACCESS_URL:-http://${BIND}:${NOOSPHERE_PORT}}"

echo ""
echo "  Bind: $BIND  →  Access URL: $APP_URL"
echo ""

# ── Secrets (reuse or generate) ─────────────────────────────────────────────────
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

# ── Write .env ─────────────────────────────────────────────────────────────────
# docker compose run does NOT inherit shell exports — must use .env file.
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

echo "==> Pulling images..."
docker compose pull

echo "==> Starting PostgreSQL..."
docker compose up -d db

echo "  Waiting for PostgreSQL to be healthy..."
for i in $(seq 1 30); do
  status="$(docker inspect --format='{{.State.Health.Status}}' noosphere-openclaw-db 2>/dev/null || echo "not found")"
  if [ "$status" = "healthy" ]; then
    echo "  PostgreSQL is healthy."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "  PostgreSQL failed to become healthy." >&2
    exit 1
  fi
  sleep 2
done

# ── Bootstrap ─────────────────────────────────────────────────────────────────
echo "==> Running migrations and bootstrap..."
BOOTSTRAP_TMP=$(mktemp)
docker compose run --rm init > "$BOOTSTRAP_TMP" 2>&1
BOOTSTRAP_EXIT=$?

if [ $BOOTSTRAP_EXIT -ne 0 ]; then
  echo "Bootstrap failed with exit code $BOOTSTRAP_EXIT:" >&2
  cat "$BOOTSTRAP_TMP" >&2
  rm -f "$BOOTSTRAP_TMP"
  exit 1
fi

BOOTSTRAP_JSON=$(grep -v '^\[bootstrap\]' "$BOOTSTRAP_TMP" | grep -v '^$' | tail -n 1)
rm -f "$BOOTSTRAP_TMP"

if [ -z "$BOOTSTRAP_JSON" ]; then
  echo "Bootstrap produced no output." >&2
  exit 1
fi

echo "  Bootstrap OK."

# ── Credentials — written HERE before anything that could fail ─────────────────
echo "==> Saving credentials..."
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
echo "==> Starting Noosphere app..."
docker compose up -d app

echo "  Waiting for Noosphere to be healthy..."
for i in $(seq 1 40); do
  status="$(docker inspect --format='{{.State.Health.Status}}' noosphere-openclaw-app 2>/dev/null || echo "not found")"
  if [ "$status" = "healthy" ]; then
    echo "  Noosphere is healthy."
    break
  fi
  if [ $i -eq 40 ]; then
    echo "  Noosphere failed to become healthy." >&2
    exit 1
  fi
  sleep 2
done

# Verify HTTP health
if ! curl -fsS --max-time 10 "$APP_URL/api/health" >/dev/null 2>&1; then
  echo "  Warning: Noosphere HTTP health check failed." >&2
fi

# ── OpenClaw plugin ──────────────────────────────────────────────────────────
echo "==> Installing OpenClaw plugin..."
if openclaw plugins inspect "$PLUGIN_ID" >/dev/null 2>&1; then
  echo "  Updating existing plugin..."
  openclaw plugins update "$PLUGIN_ID" || openclaw plugins install "$PLUGIN_SPEC" --force
else
  openclaw plugins install "$PLUGIN_SPEC"
fi

# ── Patch OpenClaw config ────────────────────────────────────────────────────
echo "==> Patching OpenClaw config..."
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

if openclaw config patch --file "$PATCH_FILE"; then
  echo "  Config patched."
else
  echo "  Config patch failed — check OpenClaw config manually." >&2
fi
rm -f "$PATCH_FILE"

# ── Restart gateway ──────────────────────────────────────────────────────────
echo "==> Restarting OpenClaw Gateway..."
if openclaw gateway status >/dev/null 2>&1; then
  openclaw gateway restart
else
  echo "  Gateway not running. Start it manually to load the plugin."
fi

# ── Summary ─────────────────────────────────────────────────────────────────
cat <<DONE

====================================================================
Setup complete!
====================================================================

  URL:      ${APP_URL}
  Admin:    admin@noosphere.local
  Password: ${ADMIN_PASSWORD}

  Credentials saved in: ${SECRETS_FILE}

====================================================================
Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw noosphere status
====================================================================

DONE
