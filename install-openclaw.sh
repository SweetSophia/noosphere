#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Installer failed near line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-latest}"
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}}"
PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory}"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SECRETS_FILE="${NOOSPHERE_SECRETS_FILE:-$SECRETS_DIR/noosphere-memory.json}"
SECRET_PROVIDER_ID="${NOOSPHERE_SECRET_PROVIDER_ID:-noosphere-memory}"
BIND_ADDRESS="${BIND_ADDRESS:-}"
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
  JSON_GET_FILE="$file" JSON_GET_KEY="$key" node -e 'try { const fs=require("fs"); const p=process.env.JSON_GET_FILE; const k=process.env.JSON_GET_KEY; if (!p || !k || !fs.existsSync(p)) process.exit(0); const data=JSON.parse(fs.readFileSync(p,"utf8")); if (typeof data[k] === "string") process.stdout.write(data[k]); } catch { process.exit(0); }'
}

env_get() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  awk -v key="$key" '
    {
      sub(/\r$/, "")
      eq = index($0, "=")
      if (eq > 1 && substr($0, 1, eq - 1) == key) {
        print substr($0, eq + 1)
        exit
      }
    }
  ' "$file"
}

is_placeholder_secret() {
  case "$1" in
    ""|CHANGE_ME*|replace-with-*|noo_replace_with_*) return 0 ;;
    *) return 1 ;;
  esac
}

env_get_secret() {
  local value
  value="$(env_get "$1" "$2")"
  if is_placeholder_secret "$value"; then
    return 0
  fi
  printf '%s' "$value"
}

write_runtime_env() {
  local env_tmp
  env_tmp="$(mktemp "$NOOSPHERE_HOME/.env.XXXXXX")" || {
    echo "Failed to create temporary file for runtime .env" >&2
    exit 1
  }
  cat > "$env_tmp" <<ENV
NOOSPHERE_VERSION=${NOOSPHERE_VERSION}
NOOSPHERE_PORT=${NOOSPHERE_PORT}
APP_URL=${APP_URL}
BIND_ADDRESS=${BIND_ADDRESS}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NOOSPHERE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
NOOSPHERE_BOOTSTRAP_API_KEY=${API_KEY}
ENV
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$NOOSPHERE_HOME/.env"
}

extract_bootstrap_json() {
  local file="$1"
  BOOTSTRAP_JSON_FILE="$file" node -e '
    const fs = require("fs");
    const path = process.env.BOOTSTRAP_JSON_FILE;
    const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith("[bootstrap]")) continue;
      try {
        JSON.parse(line);
        process.stdout.write(line);
        process.exit(0);
      } catch {
        // Keep walking upward; Docker/Prisma may emit status lines after JSON.
      }
    }
    process.exit(1);
  '
}

has_controlling_tty() {
  { : < /dev/tty; } 2>/dev/null
}

can_prompt() {
  [ -t 0 ] || has_controlling_tty
}

read_prompt() {
  local prompt="$1"
  local var_name="$2"

  if [ -t 0 ]; then
    read -r -p "$prompt" "$var_name"
  elif has_controlling_tty; then
    read -r -p "$prompt" "$var_name" < /dev/tty
  else
    return 1
  fi
}

# Validate an IPv4 address with proper octet range checking (0-255)
is_valid_ipv4() {
  local ip="$1"
  local IFS='.'
  local -a octets
  read -ra octets <<< "$ip"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]+$ ]] && (( 10#$octet >= 0 && 10#$octet <= 255 )) || return 1
  done
}

# Detect available IP addresses for the user to choose from
detect_ips() {
  local ips=()

  # Always include localhost
  ips+=("127.0.0.1")

  # Tailscale IP if available
  local tailscale_ip
  tailscale_ip="$(ip addr show tailscale0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1 || true)"
  if [ -n "$tailscale_ip" ]; then
    ips+=("$tailscale_ip")
  fi

  # Other local network IPs (exclude loopback and docker)
  local network_ips
  network_ips="$(ip -4 addr show 2>/dev/null | awk '/inet / && !/127\.0\.0\.1/ && !/docker/ && !/br-/ {print $2}' | cut -d/ -f1 | sort -u || true)"
  if [ -n "$network_ips" ]; then
    while IFS= read -r ip; do
      [ -n "$ip" ] && ips+=("$ip")
    done <<< "$network_ips"
  fi

  # Deduplicate while preserving order
  local uniq_ips=()
  local seen=""
  for ip in "${ips[@]}"; do
    if [[ "$seen" != *"|$ip|"* ]]; then
      uniq_ips+=("$ip")
      seen="${seen}|${ip}|"
    fi
  done

  printf '%s\n' "${uniq_ips[@]}"
}

# Prompt user to select an IP address
prompt_ip_selection() {
  local ips
  ips="$(detect_ips)"
  local ip_array=()
  local idx=1

  echo ""
  echo "==================================="
  echo "  Noosphere Network Configuration"
  echo "==================================="
  echo ""
  echo "Available network interfaces:"
  echo ""

  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    ip_array+=("$ip")
    echo "  [$idx] $ip"
    ((idx++))
  done <<< "$ips"

  echo "  [0] 0.0.0.0 (all interfaces)"
  echo "  [C] Custom IP address"
  echo ""

  local selection
  local selected_ip=""
  local bind_addr=""
  local explicit_choice=false

  while true; do
    read_prompt "Select an IP address for Noosphere [1]: " selection
    selection="${selection:-1}"

    if [[ "$selection" =~ ^[Cc]$ ]]; then
      read_prompt "Enter custom IP address: " selected_ip
      if [ -z "$selected_ip" ]; then
        echo "IP address cannot be empty."
        continue
      fi
      # Normalize localhost to 127.0.0.1 for reliable Docker binding
      if [ "$selected_ip" = "localhost" ]; then
        selected_ip="127.0.0.1"
      fi
      # Basic IPv4 validation (reject obvious garbage before Docker does)
      if ! is_valid_ipv4 "$selected_ip"; then
        echo "Invalid IP address format. Please enter a valid IPv4 address."
        continue
      fi
      bind_addr="$selected_ip"
      explicit_choice=true
      break
    elif [[ "$selection" == "0" ]]; then
      bind_addr="0.0.0.0"
      explicit_choice=true
      break
    elif [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#ip_array[@]}" ]; then
      selected_ip="${ip_array[$((selection - 1))]}"
      bind_addr="$selected_ip"
      if [ "$selection" != "1" ]; then
        explicit_choice=true
      fi
      break
    else
      echo "Invalid selection. Please try again."
    fi
  done

  # When binding to all interfaces, APP_URL needs a concrete reachable address
  if [ "$bind_addr" = "0.0.0.0" ]; then
    if [ "${#ip_array[@]}" -ge 2 ]; then
      # Use first non-localhost IP from the list
      selected_ip="${ip_array[1]}"
    elif [ "${#ip_array[@]}" -ge 1 ]; then
      selected_ip="${ip_array[0]}"
    else
      selected_ip="127.0.0.1"
    fi
  fi

  # Format APP_URL: IPv6 addresses need brackets
  if [[ "$selected_ip" == *":"* ]]; then
    APP_URL="http://[${selected_ip}]:${NOOSPHERE_PORT}"
  else
    APP_URL="http://${selected_ip}:${NOOSPHERE_PORT}"
  fi
  # Only override BIND_ADDRESS if not already set by user
  if [ -z "${BIND_ADDRESS}" ]; then
    BIND_ADDRESS="$bind_addr"
  fi

  echo ""
  echo "Noosphere will be accessible at: ${APP_URL}"
  if [ "$bind_addr" = "0.0.0.0" ]; then
    echo "WARNING: Binding to all interfaces (0.0.0.0) exposes Noosphere on all network interfaces."
  elif [ "$selected_ip" != "127.0.0.1" ]; then
    echo "Note: Binding to ${bind_addr} - ensure your firewall allows access to port ${NOOSPHERE_PORT}."
  fi
  echo ""

  if [ "$explicit_choice" = true ]; then
    local continue_ack=""
    read_prompt "Press Enter to continue or Ctrl+C to abort..." continue_ack
    echo ""
  fi
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

# Detect whether prompts can be shown. In `curl | bash`, stdin is the
# installer pipe, so use /dev/tty when a controlling terminal is available.
IS_INTERACTIVE=false
if can_prompt; then
  IS_INTERACTIVE=true
fi

# Auto-detect the best IP for non-interactive mode
auto_detect_ip() {
  local ts_ip
  ts_ip="$(ip addr show tailscale0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1 || true)"
  if [ -n "$ts_ip" ]; then
    APP_URL="http://${ts_ip}:${NOOSPHERE_PORT}"
    if [ -z "${BIND_ADDRESS}" ]; then
      BIND_ADDRESS="$ts_ip"
    fi
  else
    APP_URL="http://127.0.0.1:${NOOSPHERE_PORT}"
    if [ -z "${BIND_ADDRESS}" ]; then
      BIND_ADDRESS="127.0.0.1"
    fi
  fi
}

# IP selection happens BEFORE any container operations
if [ -z "${APP_URL:-}" ]; then
  if [ "$IS_INTERACTIVE" = true ]; then
    prompt_ip_selection
  else
    auto_detect_ip
    echo "No interactive terminal detected. Auto-selected: ${APP_URL}"
  fi
else
  # APP_URL was provided via environment variable
  if [ -z "${BIND_ADDRESS}" ]; then
    BIND_ADDRESS="127.0.0.1"
    # Extract host from APP_URL for binding using bash parameter expansion
    url_host="${APP_URL#*://}"
    url_host="${url_host%%:*}"
    url_host="${url_host%%/*}"
    # Only use the extracted host for binding if it's a valid IP literal.
    # Docker port bindings require an IP, not a hostname.
    if [ -n "$url_host" ] && is_valid_ipv4 "$url_host"; then
      BIND_ADDRESS="$url_host"
    fi
  fi
fi

POSTGRES_PASSWORD="$(json_get "$SECRETS_FILE" postgresPassword)"
NEXTAUTH_SECRET="$(json_get "$SECRETS_FILE" nextAuthSecret)"
ADMIN_PASSWORD="$(json_get "$SECRETS_FILE" adminPassword)"
API_KEY="$(json_get "$SECRETS_FILE" apiKey)"

# If a previous install started PostgreSQL but exited before writing the OpenClaw
# secret file, recover from the runtime .env so reruns use the original DB
# password and bootstrap credentials instead of generating incompatible ones.
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" POSTGRES_PASSWORD)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(env_get_secret "$NOOSPHERE_HOME/.env" NEXTAUTH_SECRET)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" NOOSPHERE_ADMIN_PASSWORD)}"
API_KEY="${API_KEY:-$(env_get_secret "$NOOSPHERE_HOME/.env" NOOSPHERE_BOOTSTRAP_API_KEY)}"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(random_secret 32)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(random_secret 32)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret 24)}"
API_KEY="${API_KEY:-noo_$(random_secret 32)}"

# Export Compose variables. Bootstrap credentials are exported too because
# docker compose up may run the init service again through app.depends_on; the
# second run must see the same admin/API credentials as the explicit bootstrap
# run below.
export NOOSPHERE_VERSION NOOSPHERE_PORT NOOSPHERE_IMAGE APP_URL BIND_ADDRESS POSTGRES_PASSWORD NEXTAUTH_SECRET
export NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"

# Persist runtime secrets before starting persistent containers. If bootstrap or
# plugin setup fails, a rerun can recover the original PostgreSQL password and
# finish the install instead of leaving an orphaned DB volume with unknown creds.
write_runtime_env

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
      - "\${BIND_ADDRESS:-127.0.0.1}:\${NOOSPHERE_PORT:-6578}:3000"
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
# Admin/API credentials are passed through exported Compose variables.
BOOTSTRAP_TMP=$(mktemp)
BOOTSTRAP_EXIT=0
docker compose run --rm -T init > "$BOOTSTRAP_TMP" 2>&1 || BOOTSTRAP_EXIT=$?
if [ "$BOOTSTRAP_EXIT" -ne 0 ]; then
  echo "Bootstrap failed with exit code $BOOTSTRAP_EXIT:" >&2
  cat "$BOOTSTRAP_TMP" >&2
  echo "" >&2
  echo "Runtime config was preserved at $NOOSPHERE_HOME/.env; fix the error and rerun the installer to continue." >&2
  rm -f "$BOOTSTRAP_TMP"
  exit 1
fi
# Bootstrap writes JSON to stdout, mixed with Docker/Prisma status output.
# Extract it in one Node process instead of a grep|tail pipeline so set -euo
# pipefail cannot silently abort before we can print a useful diagnostic.
BOOTSTRAP_JSON=""
if ! BOOTSTRAP_JSON="$(extract_bootstrap_json "$BOOTSTRAP_TMP")"; then
  echo "Bootstrap produced no parseable JSON output. Full bootstrap log:" >&2
  cat "$BOOTSTRAP_TMP" >&2
  rm -f "$BOOTSTRAP_TMP"
  exit 1
fi
rm -f "$BOOTSTRAP_TMP"

echo "Bootstrap completed successfully."

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

╔══════════════════════════════════════════════════════════════════════╗
║              Noosphere OpenClaw Setup Complete                       ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Noosphere URL:    ${APP_URL}
║  Admin email:      admin@noosphere.local
║  Admin password:   ${ADMIN_PASSWORD}
║                                                                      ║
║  ────────────────────────────────────────────────────────────────   ║
║  🔑 API KEY (save this - it will not be shown again):               ║
║     ${API_KEY}
║  ────────────────────────────────────────────────────────────────   ║
║                                                                      ║
║  Credentials also saved in: ${SECRETS_FILE}
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

Verify:
  curl -fsS ${APP_URL}/api/health
  openclaw plugins inspect ${PLUGIN_ID} --runtime --json

DONE
