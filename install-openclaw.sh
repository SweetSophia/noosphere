#!/usr/bin/env bash
# Noosphere OpenClaw Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
#   Or with options:
#   NOOSPHERE_BIND=2 NOOSPHERE_PORT=6578 bash install-openclaw.sh

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

wait_for_container() {
  local name="$1"
  local wanted="${2:-running}"  # running | healthy
  local attempts="${3:-60}"
  echo "  Waiting for $name ($wanted)..."
  for i in $(seq 1 "$attempts"); do
    local status
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [ "$status" = "$wanted" ]; then
      echo "  ✓ $name is $wanted"
      return 0
    fi
    if [ $i -eq $attempts ]; then
      echo "  ✗ $name did not become $wanted (status: $status)" >&2
      docker logs "$name" --tail 30 >&2 || true
      return 1
    fi
    sleep 2
  done
}

wait_for_http() {
  local url="$1"
  local name="$2"
  local attempts="${3:-60}"
  echo "  Waiting for $name HTTP health..."
  for i in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 5 "$url/api/health" >/dev/null 2>&1; then
      echo "  ✓ $name is responding"
      return 0
    fi
    if [ $i -eq $attempts ]; then
      echo "  ✗ $name health check failed: $url/api/health" >&2
      docker logs noosphere-openclaw-app --tail 30 >&2 || true
      return 1
    fi
    sleep 2
  done
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
TAILSCALE_IP=""
if [ -f /dev/tailscale ]; then
  TAILSCALE_IP="$(tailscale status --self --json 2>/dev/null | \
    python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(d.get("Self",{}).get("TailscaleIPs",[])))' 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$TAILSCALE_IP" ]; then
  TAILSCALE_IP="$(ip addr show tailscale0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1)"
fi

DEFAULT_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1 || true)"

# ── Bind choice: env var override OR interactive menu ─────────────────────────
# Set NOOSPHERE_BIND=2 (or any valid choice) to skip the menu entirely.
# Valid choices: 1 localhost | 2 tailscale | 3 all-interfaces | 4 server-ip | 5 custom
BIND_CHOICE="${NOOSPHERE_BIND:-}"

if [ -z "$BIND_CHOICE" ] && [ -t 0 ]; then
  # Interactive TTY mode — show menu
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
  echo "  Or set NOOSPHERE_BIND=2 before running to skip this menu."
  echo ""

  default_choice() {
    if [ -n "$TAILSCALE_IP" ]; then echo "2"
    elif [ -n "$DEFAULT_IP" ]; then echo "3"
    else echo "3"
    fi
  }

  read -p "Bind choice [$(default_choice)]: " BIND_CHOICE
  BIND_CHOICE="${BIND_CHOICE:-$(default_choice)}"
  BIND_CHOICE="$(echo "$BIND_CHOICE" | tr -cd '0-9')"  # strip non-digits
  case "$BIND_CHOICE" in 1|2|3|4|5) ;; *) BIND_CHOICE="$(default_choice)" ;; esac
fi

if [ -z "$BIND_CHOICE" ]; then
  # Non-interactive, no env var — auto-select based on Tailscale detection
  if [ -n "$TAILSCALE_IP" ]; then
    BIND_CHOICE="2"
  elif [ -n "$DEFAULT_IP" ]; then
    BIND_CHOICE="3"
  else
    BIND_CHOICE="1"
  fi
fi

BIND=""
ACCESS_URL=""

case "$BIND_CHOICE" in
  1) BIND="127.0.0.1"; ACCESS_URL="http://127.0.0.1:${NOOSPHERE_PORT}" ;;
  2) BIND="0.0.0.0";   ACCESS_URL="http://${TAILSCALE_IP}:${NOOSPHERE_PORT}" ;;
  3) BIND="0.0.0.0";   ACCESS_URL="http://${DEFAULT_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
  4) BIND="$DEFAULT_IP"; ACCESS_URL="http://${DEFAULT_IP}:${NOOSPHERE_PORT}" ;;
  5)
    read -p "  Bind address [0.0.0.0]: " BIND_ADDR
    read -p "  Access URL [http://100.x.x.x:${NOOSPHERE_PORT}]: " ACCESS_URL
    BIND="${BIND_ADDR:-0.0.0.0}"
    ACCESS_URL="${ACCESS_URL:-http://100.x.x.x:${NOOSPHERE_PORT}}"
    ;;
  *) echo "Unknown bind choice '$BIND_CHOICE', using Tailscale"; BIND="0.0.0.0"; ACCESS_URL="http://${TAILSCALE_IP:-127.0.0.1}:${NOOSPHERE_PORT}" ;;
esac

if [ -z "$ACCESS_URL" ]; then
  ACCESS_URL="http://${BIND}:${NOOSPHERE_PORT}"
fi

APP_URL="$ACCESS_URL"

echo ""
echo "  Using bind: $BIND  →  access URL: $APP_URL"
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

# ── Write .env BEFORE docker compose ────────────────────────────────────────────
# docker compose run does NOT reliably inherit shell exports — use .env file.
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
export NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD" NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"

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
echo "==> Starting PostgreSQL..."
docker compose up -d db
wait_for_container noosphere-openclaw-db healthy 60

# ── Bootstrap ─────────────────────────────────────────────────────────────────
echo ""
echo "==> Running database migrations and bootstrap..."
BOOTSTRAP_TMP=$(mktemp)
# Run in background so we can stream output AND capture exit code
docker compose run --rm init > "$BOOTSTRAP_TMP" 2>&1 &
BOOTSTRAP_PID=$!

# Stream output live
tail -f "$BOOTSTRAP_TMP" &
TAIL_PID=$!

# Wait for docker compose run to finish (with timeout)
bootstrap_timeout=120
bootstrap_elapsed=0
while kill -0 "$BOOTSTRAP_PID" 2>/dev/null; do
  sleep 2
  bootstrap_elapsed=$((bootstrap_elapsed + 2))
  if [ $bootstrap_elapsed -ge $bootstrap_timeout ]; then
    echo "Bootstrap timed out after ${bootstrap_timeout}s" >&2
    kill "$BOOTSTRAP_PID" "$TAIL_PID" 2>/dev/null || true
    exit 1
  fi
done

# Get exit code of docker compose run
wait "$BOOTSTRAP_PID"
BOOTSTRAP_EXIT=$?

# Stop tailing
kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

if [ $BOOTSTRAP_EXIT -ne 0 ]; then
  echo ""
  echo "Bootstrap failed (exit $BOOTSTRAP_EXIT):" >&2
  tail -20 "$BOOTSTRAP_TMP" >&2
  rm -f "$BOOTSTRAP_TMP"
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

echo ""
echo "  Bootstrap complete."

# ── Secrets written HERE — before anything long-running ────────────────────────
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
wait_for_container noosphere-openclaw-app healthy 60
wait_for_http "$APP_URL" "Noosphere" 60

# ── OpenClaw plugin ─────────────────────────────────────────────────────────
echo ""
echo "==> Installing OpenClaw plugin..."
if openclaw plugins inspect "$PLUGIN_ID" >/dev/null 2>&1; then
  echo "  Plugin already installed, updating..."
  openclaw plugins update "$PLUGIN_ID" 2>&1 || echo "  Update failed, trying install --force..."
  openclaw plugins install "$PLUGIN_SPEC" --force 2>&1 || true
else
  openclaw plugins install "$PLUGIN_SPEC" 2>&1 || echo "  Plugin install returned non-zero (may already be installed)"
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

echo ""
echo "==> Patching OpenClaw config..."
if openclaw config patch --file "$PATCH_FILE" 2>&1; then
  echo "  Config patched successfully."
else
  echo "  Config patch failed — check OpenClaw config manually." >&2
fi
rm -f "$PATCH_FILE"

# ── Restart gateway ────────────────────────────────────────────────────────────
echo ""
echo "==> Restarting OpenClaw Gateway..."
if openclaw gateway status >/dev/null 2>&1; then
  openclaw gateway restart 2>&1 || echo "  Gateway restart returned non-zero."
else
  echo "  Gateway not running. Start it manually to load the plugin."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
cat <<DONE

====================================================================
Setup complete!
====================================================================

  Noosphere URL:  ${APP_URL}
  Admin email:    admin@noosphere.local
  Admin password: ${ADMIN_PASSWORD}
  API key:        ${API_KEY}

  Credentials saved in: ${SECRETS_FILE}

====================================================================
Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw noosphere status
====================================================================

DONE
