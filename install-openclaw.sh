#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Installer failed near line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_PORT="${NOOSPHERE_PORT:-}"
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-}"
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-}"
APP_URL="${APP_URL:-}"
BIND_ADDRESS="${BIND_ADDRESS:-}"
REDIS_URL="${REDIS_URL:-}"
PG_POOL_MAX="${PG_POOL_MAX:-}"
PG_IDLE_TIMEOUT_MS="${PG_IDLE_TIMEOUT_MS:-}"
PG_CONN_TIMEOUT_MS="${PG_CONN_TIMEOUT_MS:-}"
NOOSPHERE_ADMIN_PASSWORD_RESET="${NOOSPHERE_ADMIN_PASSWORD_RESET:-}"
NOOSPHERE_FORCE_ADMIN="${NOOSPHERE_FORCE_ADMIN:-}"
NOOSPHERE_BOOTSTRAP_SECRETS_FILE="${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-}"
NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE="${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE:-}"
PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory}"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw/secrets}"
SECRETS_FILE="${NOOSPHERE_SECRETS_FILE:-$SECRETS_DIR/noosphere-memory.json}"
SECRET_PROVIDER_ID="${NOOSPHERE_SECRET_PROVIDER_ID:-noosphere-memory}"
PLUGIN_ID="noosphere-memory"
POSTGRES_SWITCH_SCRIPT_SHA256='46acd0f91c0db9474414d5c52e454e125a8e57641633b41d164d1e6c0a4df475'
POSTGRES_SWITCH_SCRIPT_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/a2067895023efc638e966ee827fea67385d8aa37/scripts/switch-pgvector-compose.sh'
POSTGRES_VERIFY_SCRIPT_SHA256='e6751d338f84e3c51cb2e5dd8691e372e704dbd20fb8cc9e960420e81d20b2fd'
POSTGRES_VERIFY_SCRIPT_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/a2067895023efc638e966ee827fea67385d8aa37/scripts/verify-deploy.sh'
EXPLICIT_POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
EXPLICIT_POSTGRES_MIGRATION_PASSWORD="${POSTGRES_MIGRATION_PASSWORD:-}"
EXPLICIT_POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-}"
EXPLICIT_NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-}"
EXPLICIT_ADMIN_PASSWORD="${NOOSPHERE_ADMIN_PASSWORD:-}"
EXPLICIT_API_KEY="${NOOSPHERE_BOOTSTRAP_API_KEY:-}"

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
NOOSPHERE_IMAGE=${NOOSPHERE_IMAGE}
NOOSPHERE_PORT=${NOOSPHERE_PORT}
APP_URL=${APP_URL}
BIND_ADDRESS=${BIND_ADDRESS}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_MIGRATION_PASSWORD=${POSTGRES_MIGRATION_PASSWORD}
POSTGRES_APP_PASSWORD=${POSTGRES_APP_PASSWORD}
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
NOOSPHERE_ADMIN_PASSWORD=${ADMIN_PASSWORD}
NOOSPHERE_ADMIN_PASSWORD_RESET=${NOOSPHERE_ADMIN_PASSWORD_RESET:-false}
NOOSPHERE_FORCE_ADMIN=${NOOSPHERE_FORCE_ADMIN:-false}
NOOSPHERE_BOOTSTRAP_API_KEY=${API_KEY}
NOOSPHERE_BOOTSTRAP_SECRETS_FILE=${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-/tmp/noosphere-bootstrap-secrets/secrets.json}
REDIS_URL=${REDIS_URL}
PG_POOL_MAX=${PG_POOL_MAX}
PG_IDLE_TIMEOUT_MS=${PG_IDLE_TIMEOUT_MS}
PG_CONN_TIMEOUT_MS=${PG_CONN_TIMEOUT_MS}
NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE=${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE}
ENV
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$NOOSPHERE_HOME/.env"
}

ensure_runtime_env_secret() {
  local key=$1 value=$2 current temp
  current="$(env_get_secret "$NOOSPHERE_HOME/.env" "$key")"
  [[ "$current" != "$value" ]] || return 0
  temp="$(mktemp "$NOOSPHERE_HOME/.env.XXXXXX")"
  {
    sed "/^${key}=/d" "$NOOSPHERE_HOME/.env"
    printf '%s=%s\n' "$key" "$value"
  } > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$NOOSPHERE_HOME/.env"
}

resolve_runtime_config() {
  local runtime_env="$NOOSPHERE_HOME/.env"

  NOOSPHERE_PORT="${NOOSPHERE_PORT:-$(env_get "$runtime_env" NOOSPHERE_PORT)}"
  NOOSPHERE_PORT="${NOOSPHERE_PORT:-6578}"
  NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-$(env_get "$runtime_env" NOOSPHERE_VERSION)}"
  NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-latest}"
  NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-$(env_get "$runtime_env" NOOSPHERE_IMAGE)}"
  APP_URL="${APP_URL:-$(env_get "$runtime_env" APP_URL)}"
  BIND_ADDRESS="${BIND_ADDRESS:-$(env_get "$runtime_env" BIND_ADDRESS)}"
  REDIS_URL="${REDIS_URL:-$(env_get "$runtime_env" REDIS_URL)}"
  REDIS_URL="${REDIS_URL:-redis://redis:6379}"
  PG_POOL_MAX="${PG_POOL_MAX:-$(env_get "$runtime_env" PG_POOL_MAX)}"
  PG_POOL_MAX="${PG_POOL_MAX:-20}"
  PG_IDLE_TIMEOUT_MS="${PG_IDLE_TIMEOUT_MS:-$(env_get "$runtime_env" PG_IDLE_TIMEOUT_MS)}"
  PG_IDLE_TIMEOUT_MS="${PG_IDLE_TIMEOUT_MS:-30000}"
  PG_CONN_TIMEOUT_MS="${PG_CONN_TIMEOUT_MS:-$(env_get "$runtime_env" PG_CONN_TIMEOUT_MS)}"
  PG_CONN_TIMEOUT_MS="${PG_CONN_TIMEOUT_MS:-5000}"
  NOOSPHERE_ADMIN_PASSWORD_RESET="${NOOSPHERE_ADMIN_PASSWORD_RESET:-$(env_get "$runtime_env" NOOSPHERE_ADMIN_PASSWORD_RESET)}"
  NOOSPHERE_ADMIN_PASSWORD_RESET="${NOOSPHERE_ADMIN_PASSWORD_RESET:-false}"
  NOOSPHERE_FORCE_ADMIN="${NOOSPHERE_FORCE_ADMIN:-$(env_get "$runtime_env" NOOSPHERE_FORCE_ADMIN)}"
  NOOSPHERE_FORCE_ADMIN="${NOOSPHERE_FORCE_ADMIN:-false}"
  NOOSPHERE_BOOTSTRAP_SECRETS_FILE="${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-$(env_get "$runtime_env" NOOSPHERE_BOOTSTRAP_SECRETS_FILE)}"
  NOOSPHERE_BOOTSTRAP_SECRETS_FILE="${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-/tmp/noosphere-bootstrap-secrets/secrets.json}"
  NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE="${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE:-$(env_get "$runtime_env" NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE)}"
  NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE="${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE:-120}"
  NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}}"
}

prepare_guard_script() {
  local relative_source=$1 url=$2 expected_sha=$3 target=$4 source='' temp actual_sha installer_dir
  installer_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ -f "$installer_dir/$relative_source" ]]; then
    source="$installer_dir/$relative_source"
  fi

  temp=$(mktemp "$NOOSPHERE_HOME/.guard-script.XXXXXX")
  if [[ -n "$source" ]]; then
    install -m 600 "$source" "$temp"
  else
    curl -fsSL "$url" -o "$temp"
    chmod 600 "$temp"
  fi
  actual_sha=$(sha256sum "$temp" | awk '{print $1}')
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -f "$temp"
    echo "Refusing PostgreSQL guard script with unexpected checksum: $relative_source" >&2
    exit 1
  fi
  install -m 700 "$temp" "$target"
  rm -f "$temp"
}

acquire_postgres_operation_lock() {
  local docker_context docker_host docker_socket engine_id lock_root lock_key lock_path
  docker_host=''
  if [[ -n ${DOCKER_CONTEXT:-} ]]; then
    docker_context=$DOCKER_CONTEXT
    docker_host=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}') || {
      echo "Could not inspect Docker context $docker_context" >&2
      exit 1
    }
  elif [[ -n ${DOCKER_HOST:-} ]]; then
    docker_host=$DOCKER_HOST
  else
    docker_context=$(docker context show) || {
      echo 'Could not determine the active Docker context.' >&2
      exit 1
    }
    docker_host=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}') || {
      echo "Could not inspect Docker context $docker_context" >&2
      exit 1
    }
  fi
  [[ "$docker_host" == unix://* ]] || {
    echo "Refusing non-local Docker endpoint: $docker_host" >&2
    exit 1
  }
  docker_socket=${docker_host#unix://}
  [[ "$docker_socket" == /* ]] || {
    echo "Docker Unix endpoint must use an absolute path: $docker_host" >&2
    exit 1
  }
  docker_host="unix://$(realpath -m "$docker_socket")"
  lock_root=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  [[ "$lock_root" == /* && -d "$lock_root" && ! -L "$lock_root" ]] || {
    echo "Runtime lock directory is unavailable or unsafe: $lock_root" >&2
    exit 1
  }
  [[ $(stat -c '%u' "$lock_root") == "$(id -u)" ]] || {
    echo 'Runtime lock directory is not owned by the current user.' >&2
    exit 1
  }
  engine_id=$(docker info --format '{{.ID}}') || {
    echo 'Could not determine the Docker engine ID.' >&2
    exit 1
  }
  [[ -n "$engine_id" ]] || {
    echo 'Docker engine ID is empty.' >&2
    exit 1
  }
  lock_key=$(printf '%s\0%s' "$engine_id" noosphere_postgres_data | sha256sum | awk '{print $1}')
  lock_path="$lock_root/noosphere-pgvector-switch-$lock_key.lock"
  exec 8>"$lock_path"
  flock -w 5 8 || {
    echo 'Another installer or PostgreSQL image switch is active for noosphere_postgres_data.' >&2
    exit 1
  }
  export NOOSPHERE_A2B_LOCK_FD=8
  export NOOSPHERE_A2B_LOCK_PATH="$lock_path"
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
need jq
need sha256sum
need flock
need realpath

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required: docker compose" >&2
  exit 1
fi

acquire_postgres_operation_lock

mkdir -p "$NOOSPHERE_HOME" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR" || true
resolve_runtime_config

POSTGRES_SWITCH_SCRIPT="$NOOSPHERE_HOME/switch-pgvector-compose.sh"
POSTGRES_VERIFY_SCRIPT="$NOOSPHERE_HOME/verify-deploy.sh"
POSTGRES_BACKUP_DIR="$NOOSPHERE_HOME/backups/postgres-pgvector"
prepare_guard_script scripts/switch-pgvector-compose.sh "$POSTGRES_SWITCH_SCRIPT_URL" \
  "$POSTGRES_SWITCH_SCRIPT_SHA256" "$POSTGRES_SWITCH_SCRIPT"
prepare_guard_script scripts/verify-deploy.sh "$POSTGRES_VERIFY_SCRIPT_URL" \
  "$POSTGRES_VERIFY_SCRIPT_SHA256" "$POSTGRES_VERIFY_SCRIPT"

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

POSTGRES_PASSWORD="$EXPLICIT_POSTGRES_PASSWORD"
POSTGRES_MIGRATION_PASSWORD="$EXPLICIT_POSTGRES_MIGRATION_PASSWORD"
POSTGRES_APP_PASSWORD="$EXPLICIT_POSTGRES_APP_PASSWORD"
NEXTAUTH_SECRET="$EXPLICIT_NEXTAUTH_SECRET"
ADMIN_PASSWORD="$EXPLICIT_ADMIN_PASSWORD"
API_KEY="$EXPLICIT_API_KEY"

# The installer-managed runtime file is the persistent source of truth. A
# non-empty process value wins for this run; otherwise prefer .env before the
# derived OpenClaw secret file so a deliberate .env edit is never shadowed by a
# stale credential copy.
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" POSTGRES_PASSWORD)}"
POSTGRES_MIGRATION_PASSWORD="${POSTGRES_MIGRATION_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" POSTGRES_MIGRATION_PASSWORD)}"
POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" POSTGRES_APP_PASSWORD)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(env_get_secret "$NOOSPHERE_HOME/.env" NEXTAUTH_SECRET)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(env_get_secret "$NOOSPHERE_HOME/.env" NOOSPHERE_ADMIN_PASSWORD)}"
API_KEY="${API_KEY:-$(env_get_secret "$NOOSPHERE_HOME/.env" NOOSPHERE_BOOTSTRAP_API_KEY)}"
NOOSPHERE_BOOTSTRAP_SECRETS_FILE="${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-$(env_get_secret "$NOOSPHERE_HOME/.env" NOOSPHERE_BOOTSTRAP_SECRETS_FILE)}"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(json_get "$SECRETS_FILE" postgresPassword)}"
POSTGRES_MIGRATION_PASSWORD="${POSTGRES_MIGRATION_PASSWORD:-$(json_get "$SECRETS_FILE" postgresMigrationPassword)}"
POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-$(json_get "$SECRETS_FILE" postgresAppPassword)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(json_get "$SECRETS_FILE" nextAuthSecret)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(json_get "$SECRETS_FILE" adminPassword)}"
API_KEY="${API_KEY:-$(json_get "$SECRETS_FILE" apiKey)}"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(random_secret 32)}"
POSTGRES_MIGRATION_PASSWORD="${POSTGRES_MIGRATION_PASSWORD:-$(random_secret 32)}"
POSTGRES_APP_PASSWORD="${POSTGRES_APP_PASSWORD:-$(random_secret 32)}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-$(random_secret 32)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_secret 24)}"
API_KEY="${API_KEY:-noo_$(random_secret 32)}"

# Export Compose variables. Bootstrap credentials are exported too because
# docker compose up may run the init service again through app.depends_on; the
# second run must see the same admin/API credentials as the explicit bootstrap
# run below.
[[ "$POSTGRES_PASSWORD" != "$POSTGRES_MIGRATION_PASSWORD" &&
   "$POSTGRES_PASSWORD" != "$POSTGRES_APP_PASSWORD" &&
   "$POSTGRES_MIGRATION_PASSWORD" != "$POSTGRES_APP_PASSWORD" ]] || {
  echo 'PostgreSQL bootstrap, migration, and application passwords must be distinct.' >&2
  exit 1
}

export NOOSPHERE_VERSION NOOSPHERE_PORT NOOSPHERE_IMAGE APP_URL BIND_ADDRESS POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD NEXTAUTH_SECRET REDIS_URL NOOSPHERE_BOOTSTRAP_SECRETS_FILE NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE
export NOOSPHERE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export NOOSPHERE_BOOTSTRAP_API_KEY="$API_KEY"

# Persist the effective role credentials atomically. This is append-only for
# an older file without the A3 keys, while an explicit password rotation must
# replace the corresponding assignment so the next restart cannot fall back
# to a stale credential.
if [[ ! -f "$NOOSPHERE_HOME/.env" ]]; then
  write_runtime_env
else
  chmod 600 "$NOOSPHERE_HOME/.env"
  ensure_runtime_env_secret POSTGRES_MIGRATION_PASSWORD "$POSTGRES_MIGRATION_PASSWORD"
  ensure_runtime_env_secret POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD"
fi

new_install_required=false
existing_switch_required=false
postgres_evidence="$POSTGRES_BACKUP_DIR/noosphere_postgres_data.phase-a2b.json"
incomplete_new_install=false
incomplete_switch=false
resume_recovered_switch=false
if [[ -f "$postgres_evidence" ]] &&
   jq -e '.mode == "new-install" and (.phase == "claim-created" or .phase == "provisioning")' \
     "$postgres_evidence" >/dev/null 2>&1; then
  incomplete_new_install=true
fi
if [[ -f "$postgres_evidence" ]] &&
   jq -e '.mode == "switch" and .phase != "complete"' "$postgres_evidence" >/dev/null 2>&1; then
  incomplete_switch=true
fi
if [[ -f "$postgres_evidence" ]] &&
   jq -e '.mode == "switch" and .phase == "recovered"' "$postgres_evidence" >/dev/null 2>&1; then
  resume_recovered_switch=true
fi

if docker inspect noosphere-openclaw-db >/dev/null 2>&1; then
  if [[ "$incomplete_new_install" == true ]]; then
    new_install_required=true
    docker stop --time 60 noosphere-openclaw-app >/dev/null 2>&1 || true
  else
    [[ -f "$NOOSPHERE_HOME/docker-compose.yml" ]] || {
      echo 'Existing database container has no installer-managed Compose file; refusing an unguarded upgrade.' >&2
      exit 1
    }
    existing_switch_required=true
  fi
elif docker volume inspect noosphere_postgres_data >/dev/null 2>&1; then
  if [[ "$incomplete_new_install" == true ]]; then
    new_install_required=true
    docker stop --time 60 noosphere-openclaw-app >/dev/null 2>&1 || true
  elif [[ "$incomplete_switch" == true ]]; then
    existing_switch_required=true
    docker stop --time 60 noosphere-openclaw-app >/dev/null 2>&1 || true
  else
    echo 'Existing PostgreSQL volume has no managed database container or durable new-install claim.' >&2
    exit 1
  fi
else
  if [[ -f "$postgres_evidence" && "$incomplete_new_install" != true ]]; then
    echo 'PostgreSQL transition evidence exists but its named volume is missing; refusing a new install.' >&2
    exit 1
  fi
  new_install_required=true
fi

# A durable recovered journal means the exact-source database, authorization
# marker, and source-gated Compose file have already crossed the rollback
# commit boundary. Let the guard verify and archive that state before this
# installer publishes any candidate desired state. The guard deliberately
# returns non-zero after recovery, so the operator must rerun from a fresh
# transaction rather than continuing in the same invocation.
if [[ "$resume_recovered_switch" == true ]]; then
  echo 'Finalizing the verified PostgreSQL source recovery before publishing the candidate template...'
  recovered_exit=0
  "$POSTGRES_SWITCH_SCRIPT" \
    --compose-file "$NOOSPHERE_HOME/docker-compose.yml" \
    --env-file "$NOOSPHERE_HOME/.env" \
    --db-container noosphere-openclaw-db \
    --app-container noosphere-openclaw-app \
    --backup-dir "$POSTGRES_BACKUP_DIR" \
    --defer-app-restart || recovered_exit=$?
  if (( recovered_exit == 0 )); then
    echo 'Recovered PostgreSQL evidence unexpectedly returned success; refusing to continue in the same installer run.' >&2
    exit 1
  fi
  exit "$recovered_exit"
fi

cat > "$NOOSPHERE_HOME/docker-compose.yml" <<YAML
name: noosphere

services:
  init:
    image: ${NOOSPHERE_IMAGE}
    container_name: noosphere-openclaw-init
    restart: "no"
    environment:
      NOOSPHERE_BOOTSTRAP_DATABASE_URL: postgresql://noosphere:\${POSTGRES_PASSWORD}@db:5432/noosphere
      DATABASE_URL: postgresql://noosphere_migrator:\${POSTGRES_MIGRATION_PASSWORD}@db:5432/noosphere
      NOOSPHERE_APP_DATABASE_URL: postgresql://noosphere_app:\${POSTGRES_APP_PASSWORD}@db:5432/noosphere
      NOOSPHERE_ADMIN_PASSWORD: \${NOOSPHERE_ADMIN_PASSWORD}
      NOOSPHERE_ADMIN_PASSWORD_RESET: \${NOOSPHERE_ADMIN_PASSWORD_RESET:-false}
      NOOSPHERE_FORCE_ADMIN: \${NOOSPHERE_FORCE_ADMIN:-false}
      NOOSPHERE_BOOTSTRAP_API_KEY: \${NOOSPHERE_BOOTSTRAP_API_KEY}
      # Keep the default in a dedicated directory because bootstrap tightens the
      # parent directory to 0700 before writing the 0600 credentials file.
      NOOSPHERE_BOOTSTRAP_SECRETS_FILE: \${NOOSPHERE_BOOTSTRAP_SECRETS_FILE:-/tmp/noosphere-bootstrap-secrets/secrets.json}
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL:-http://127.0.0.1:6578}
      APP_URL: \${APP_URL:-http://127.0.0.1:6578}
      UPLOAD_DIR: /app/uploads
      PG_POOL_MAX: \${PG_POOL_MAX:-20}
      PG_IDLE_TIMEOUT_MS: \${PG_IDLE_TIMEOUT_MS:-30000}
      PG_CONN_TIMEOUT_MS: \${PG_CONN_TIMEOUT_MS:-5000}
      REDIS_URL: \${REDIS_URL:-redis://redis:6379}
      NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE: \${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE:-120}
    entrypoint: ["/bin/sh", "-ceu", "--"]
    command:
      - |
          node docker/provision-database-roles.mjs
          node docker/migrate-or-baseline.mjs
          node docker/provision-database-roles.mjs
          node docker/bootstrap.mjs
    volumes:
      - noosphere_uploads:/app/uploads:rw
    depends_on:
      db:
        condition: service_healthy

  app:
    image: ${NOOSPHERE_IMAGE}
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/writer-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != 'ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292' ]; then
            echo 'Noosphere writer authorization is incomplete; finish the guarded transition.' >&2
            exit 78
          fi
          exec /app/docker/docker-entrypoint.sh "\$\$@"
      - --
    command: ["node", "server.js"]
    container_name: noosphere-openclaw-app
    restart: unless-stopped
    ports:
      - "\${BIND_ADDRESS:-127.0.0.1}:\${NOOSPHERE_PORT:-6578}:3000"
    environment:
      DATABASE_URL: postgresql://noosphere_app:\${POSTGRES_APP_PASSWORD}@db:5432/noosphere
      SKIP_MIGRATION: "1"
      NEXTAUTH_SECRET: \${NEXTAUTH_SECRET}
      NEXTAUTH_URL: \${APP_URL:-http://127.0.0.1:6578}
      APP_URL: \${APP_URL:-http://127.0.0.1:6578}
      UPLOAD_DIR: /app/uploads
      PG_POOL_MAX: \${PG_POOL_MAX:-20}
      PG_IDLE_TIMEOUT_MS: \${PG_IDLE_TIMEOUT_MS:-30000}
      PG_CONN_TIMEOUT_MS: \${PG_CONN_TIMEOUT_MS:-5000}
      REDIS_URL: \${REDIS_URL:-redis://redis:6379}
      NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE: \${NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE:-120}
    volumes:
      - noosphere_uploads:/app/uploads:rw
      - noosphere_postgres_authorization:/run/noosphere-pgvector:ro
    depends_on:
      init:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 45s

  db:
    image: ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292
    entrypoint:
      - /bin/sh
      - -ceu
      - |
          marker=/run/noosphere-pgvector/candidate-authorized
          actual="\$\$(cat "\$\$marker" 2>/dev/null || true)"
          if [ "\$\$actual" != 'ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292' ]; then
            echo 'PostgreSQL candidate authorization is missing; run the guarded installer or switch.' >&2
            exit 78
          fi
          exec /usr/local/bin/docker-entrypoint.sh "\$\$@"
      - --
    command: ["postgres"]
    container_name: noosphere-openclaw-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: noosphere
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: noosphere
    volumes:
      - noosphere_postgres_data:/var/lib/postgresql/data
      - noosphere_postgres_authorization:/run/noosphere-pgvector:ro
    healthcheck:
      test: ["CMD-SHELL", "[ \"\$\$(cat /proc/1/comm 2>/dev/null)\" = postgres ] && [ \"\$\$(psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere -c 'SELECT 1;' 2>/dev/null)\" = 1 ]"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  redis:
    image: redis:7-alpine
    container_name: noosphere-openclaw-redis
    restart: unless-stopped
    volumes:
      - noosphere_redis_data:/data
    command: redis-server --save "" --appendonly no
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

volumes:
  noosphere_postgres_data:
    name: noosphere_postgres_data
    driver: local
  noosphere_postgres_authorization:
    name: noosphere_postgres_authorization
    external: true
  noosphere_uploads:
    name: noosphere_uploads
    driver: local
  noosphere_redis_data:
    name: noosphere_redis_data
    driver: local
YAML

if [[ "$existing_switch_required" == true ]]; then
  # Publish the fail-closed candidate gate before invoking the transition.
  # The existing source container keeps running unchanged, while any
  # accidental Compose recreation is refused until the guard authorizes it.
  "$POSTGRES_SWITCH_SCRIPT" \
    --compose-file "$NOOSPHERE_HOME/docker-compose.yml" \
    --env-file "$NOOSPHERE_HOME/.env" \
    --db-container noosphere-openclaw-db \
    --app-container noosphere-openclaw-app \
    --backup-dir "$POSTGRES_BACKUP_DIR" \
    --defer-app-restart
fi

if [[ "$new_install_required" == true ]]; then
  "$POSTGRES_SWITCH_SCRIPT" --prepare-new-install \
    --compose-file "$NOOSPHERE_HOME/docker-compose.yml" \
    --env-file "$NOOSPHERE_HOME/.env" \
    --db-container noosphere-openclaw-db \
    --app-container noosphere-openclaw-app \
    --backup-dir "$POSTGRES_BACKUP_DIR"
fi

cd "$NOOSPHERE_HOME"
echo "Starting Noosphere at ${APP_URL}..."
docker compose pull
docker compose up -d db redis
wait_for_container_healthy noosphere-openclaw-db 60
wait_for_container_healthy noosphere-openclaw-redis 30

echo "Applying database schema and bootstrap data..."
# Run bootstrap to a temp file so we can check exit status separately.
# Admin/API credentials are passed through exported Compose variables.
BOOTSTRAP_TMP=$(mktemp)
BOOTSTRAP_EXIT=0
docker compose run --rm -T init < /dev/null > "$BOOTSTRAP_TMP" 2>&1 || BOOTSTRAP_EXIT=$?
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

install -m 600 /dev/null "$SECRETS_FILE"
cat > "$SECRETS_FILE" <<JSON
{
  "baseUrl": "${APP_URL}",
  "apiKey": "${API_KEY}",
  "adminEmail": "admin@noosphere.local",
  "adminPassword": "${ADMIN_PASSWORD}",
  "postgresPassword": "${POSTGRES_PASSWORD}",
  "postgresMigrationPassword": "${POSTGRES_MIGRATION_PASSWORD}",
  "postgresAppPassword": "${POSTGRES_APP_PASSWORD}",
  "nextAuthSecret": "${NEXTAUTH_SECRET}"
}
JSON

if [[ "$new_install_required" == true ]]; then
  "$POSTGRES_SWITCH_SCRIPT" --record-new-install \
    --compose-file "$NOOSPHERE_HOME/docker-compose.yml" \
    --env-file "$NOOSPHERE_HOME/.env" \
    --db-container noosphere-openclaw-db \
    --app-container noosphere-openclaw-app \
    --backup-dir "$POSTGRES_BACKUP_DIR" \
    --defer-app-restart
fi

"$POSTGRES_SWITCH_SCRIPT" --authorize-writer \
  --compose-file "$NOOSPHERE_HOME/docker-compose.yml" \
  --env-file "$NOOSPHERE_HOME/.env" \
  --db-container noosphere-openclaw-db \
  --app-container noosphere-openclaw-app \
  --backup-dir "$POSTGRES_BACKUP_DIR"
docker compose up -d app
wait_for_container_healthy noosphere-openclaw-app 30
wait_for_http_health "$APP_URL" 60

NOOSPHERE_APP_URL="$APP_URL" \
NOOSPHERE_DB_CONTAINER=noosphere-openclaw-db \
NOOSPHERE_EXPECTED_DB_VOLUME=noosphere_postgres_data \
NOOSPHERE_EXPECTED_POSTGRES_IMAGE_MODE=candidate \
NOOSPHERE_POSTGRES_EVIDENCE="$POSTGRES_BACKUP_DIR/noosphere_postgres_data.phase-a2b.json" \
  "$POSTGRES_VERIFY_SCRIPT"

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

# ── Per-Agent API Keys ──────────────────────────────────────────────────────────
#
# Each OpenClaw agent can have its own API key. The plugin auto-routes to the
# correct key based on the agent's ID. This avoids the shared-secrets-file problem
# where one agent overwrites another's key.
#
# HOW TO ADD A NEW AGENT KEY:
#
# 1. Create a key for the new agent via the Noosphere admin UI:
#    ${APP_URL}/wiki/admin/keys
#    (Admin login: admin@noosphere.local / ${ADMIN_PASSWORD})
#
# 2. Add the key as an environment variable in the OpenClaw gateway systemd unit.
#    The gateway must be restarted after each change:
#
#    mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d/
#    cat >> ~/.config/systemd/user/openclaw-gateway.service.d/override.conf <<'EOF'
#    [Service]
#    Environment="NOOSPHERE_API_KEY_<AGENT_ID>=noo_newagentkey"
#    EOF
#    systemctl --user daemon-reload
#    systemctl --user restart openclaw-gateway
#
#    Replace <AGENT_ID> with the agent's OpenClaw ID in UPPERCASE,
#    hyphens replaced by underscores (e.g., agent "cyberlogis" → NOOSPHERE_API_KEY_CYBERLOGIS).
#
# KEY ROUTING PRIORITY (highest to lowest):
#   1. NOOSPHERE_API_KEY_<AGENT_ID>  (env var, per-agent, recommended)
#   2. apiKeys[agentId]              (config map, plain text)
#   3. apiKey / NOOSPHERE_API_KEY    (default fallback)
#
# CURRENT KEYS ON THIS HOST:
#   Run: grep NOOSPHERE_API_KEY /proc/$(pgrep -f openclaw.*gateway | head -1)/environ
#   Or:  openclaw noosphere status
