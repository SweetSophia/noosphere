#!/usr/bin/env bash
set -euo pipefail
trap 'printf "Installer failed near line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

RELEASE_VERSION='1.13.0'
BACKEND_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/624f8e93c57dfd0f048e9702a166b8b245e04008/install-openclaw.sh'
BACKEND_SHA256='450c2b8a826a207aa927e79ff3926b57215fd0ad7b6f685b156d53ad16cdc174'
HERMES_BUNDLE_URL='https://github.com/SweetSophia/noosphere/releases/download/v1.13.0/hermes-noosphere-memory-1.13.0.tar.gz'
HERMES_BUNDLE_SHA256='a560bd8607b512123e71975c188f5b924d4325adaeb86bbbd1424933423c5fde'
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
else
  SCRIPT_DIR=''
fi
NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
NOOSPHERE_CREDENTIALS_FILE="${NOOSPHERE_CREDENTIALS_FILE:-$NOOSPHERE_HOME/credentials.json}"
INTEGRATIONS=''
SELECTION_EXPLICIT=false
NON_INTERACTIVE=false
DRY_RUN=false
SHOW_CREDENTIALS=false

usage() {
  cat <<'EOF'
Noosphere installer

Usage:
  install.sh [options]

Options:
  --with LIST          Install integrations: openclaw,hermes,opencode,kilocode
  --core-only          Install or upgrade Noosphere without an agent integration
  --non-interactive    Disable prompts; requires --with or --core-only
  --show-credentials   Print the generated admin password and bootstrap API key
  --dry-run            Print the resolved plan without changing the machine
  -h, --help           Show this help

Examples:
  install.sh
  install.sh --core-only
  install.sh --with openclaw,hermes
  install.sh --non-interactive --with opencode
EOF
}

has_controlling_tty() {
  { : < /dev/tty; } 2>/dev/null
}

can_prompt() {
  [[ -t 0 ]] || has_controlling_tty
}

read_prompt() {
  local prompt=$1 variable=$2
  if [[ -t 0 ]]; then
    read -r -p "$prompt" "$variable"
  elif has_controlling_tty; then
    read -r -p "$prompt" "$variable" < /dev/tty
  else
    return 1
  fi
}

append_integration() {
  local candidate=$1
  case ",$INTEGRATIONS," in
    *",$candidate,"*) return 0 ;;
  esac
  INTEGRATIONS="${INTEGRATIONS:+$INTEGRATIONS,}$candidate"
}

normalize_integrations() {
  local input=$1 item
  IFS=',' read -ra requested <<< "$input"
  for item in "${requested[@]}"; do
    item=${item,,}
    case "$item" in
      openclaw|hermes|opencode|kilocode) append_integration "$item" ;;
      kilo) append_integration kilocode ;;
      ''|none) ;;
      *) printf 'Unknown integration: %s\n' "$item" >&2; exit 2 ;;
    esac
  done
  [[ -n "$INTEGRATIONS" ]] || {
    echo '--with requires at least one supported integration: openclaw, hermes, opencode, or kilocode.' >&2
    exit 2
  }
}

has_integration() {
  case ",$INTEGRATIONS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_detected_integrations() {
  local label command_name integration answer
  while IFS='|' read -r label command_name integration; do
    command -v "$command_name" >/dev/null 2>&1 || continue
    answer=''
    read_prompt "Configure Noosphere for detected ${label}? [Y/n]: " answer || answer='n'
    case "${answer:-Y}" in
      Y|y|yes|YES) append_integration "$integration" ;;
    esac
  done <<'EOF'
OpenClaw|openclaw|openclaw
Hermes Agent|hermes|hermes
OpenCode|opencode|opencode
EOF

  if command -v kilo >/dev/null 2>&1 || command -v kilocode >/dev/null 2>&1; then
    answer=''
    read_prompt 'Configure Noosphere for detected Kilo Code? [Y/n]: ' answer || answer='n'
    case "${answer:-Y}" in
      Y|y|yes|YES) append_integration kilocode ;;
    esac
  fi
}

detect_lifecycle_mode() {
  local journal="$NOOSPHERE_HOME/backups/postgres-pgvector/noosphere_postgres_data.phase-a2b.json"
  local controller_state="$NOOSPHERE_HOME/postgres-transition-controller/state.json"
  local phase=''

  for state_file in "$journal" "$controller_state"; do
    [[ -f "$state_file" ]] || continue
    if command -v node >/dev/null 2>&1; then
      phase=$(STATE_FILE="$state_file" node -e 'try { const s=JSON.parse(require("node:fs").readFileSync(process.env.STATE_FILE,"utf8")); process.stdout.write(typeof s.phase === "string" ? s.phase : ""); } catch {}' || true)
      if [[ "$phase" == complete ]]; then
        printf '%s\n' 'upgrade or verify complete installation'
      elif [[ -n "$phase" ]]; then
        printf '%s\n' 'resume or verify interrupted installation'
      else
        printf '%s\n' 'verify unclassified existing state before mutation'
      fi
    else
      printf '%s\n' 'verify unclassified existing state before mutation'
    fi
    return 0
  done

  if command -v docker >/dev/null 2>&1 &&
     { docker inspect noosphere-openclaw-db >/dev/null 2>&1 ||
       docker volume inspect noosphere_postgres_data >/dev/null 2>&1; }; then
    printf '%s\n' 'verify data-bearing existing state before mutation'
  elif [[ -f "$NOOSPHERE_HOME/.env" && -f "$NOOSPHERE_HOME/docker-compose.yml" ]]; then
    printf '%s\n' 'upgrade or verify complete installation'
  elif [[ -e "$NOOSPHERE_HOME/.env" || -e "$NOOSPHERE_HOME/docker-compose.yml" ]]; then
    printf '%s\n' 'verify partial existing state before mutation'
  else
    printf '%s\n' 'fresh installation'
  fi
}

while (($# > 0)); do
  case "$1" in
    --with)
      (($# >= 2)) || { echo '--with requires a comma-separated list.' >&2; exit 2; }
      SELECTION_EXPLICIT=true
      normalize_integrations "$2"
      shift 2
      ;;
    --with=*)
      SELECTION_EXPLICIT=true
      normalize_integrations "${1#*=}"
      shift
      ;;
    --core-only)
      SELECTION_EXPLICIT=true
      INTEGRATIONS=''
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --show-credentials)
      SHOW_CREDENTIALS=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/VERSION" && -f "$SCRIPT_DIR/install-openclaw.sh" ]]; then
  SOURCE_CHECKOUT=true
else
  SOURCE_CHECKOUT=false
fi

if [[ "$SELECTION_EXPLICIT" == false ]]; then
  if [[ "$NON_INTERACTIVE" == true ]]; then
    echo '--non-interactive requires --with or --core-only.' >&2
    exit 2
  fi
  if can_prompt; then
    printf 'Noosphere %s installer\n\n' "$RELEASE_VERSION"
    prompt_detected_integrations
  else
    echo 'No interactive terminal detected. Re-run with --with <list> or --core-only.' >&2
    exit 2
  fi
fi

if [[ "$NON_INTERACTIVE" == true ]]; then
  export APP_URL="${APP_URL:-http://127.0.0.1:${NOOSPHERE_PORT:-6578}}"
  export BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
fi

lifecycle_mode=$(detect_lifecycle_mode)
printf 'Install plan:\n'
printf '  Noosphere: %s\n' "$RELEASE_VERSION"
printf '  Runtime:   %s\n' "$NOOSPHERE_HOME"
printf '  Mode:      %s\n' "$lifecycle_mode"
printf '  Agents:    %s\n' "${INTEGRATIONS:-none}"
printf '  Secrets:   %s\n' "$NOOSPHERE_CREDENTIALS_FILE"

if [[ "$DRY_RUN" == true ]]; then
  printf '  Changes:   none (--dry-run)\n'
  exit 0
fi

if has_integration hermes && ! command -v tar >/dev/null 2>&1; then
  echo 'Hermes integration requires tar.' >&2
  exit 1
fi

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
backend=''
expected_backend_sha=$BACKEND_SHA256
if [[ -n "${NOOSPHERE_BACKEND_PATH:-}" ]]; then
  backend=$NOOSPHERE_BACKEND_PATH
  expected_backend_sha="${NOOSPHERE_BACKEND_OVERRIDE_SHA256:-}"
  [[ -f "$backend" && ! -L "$backend" ]] || {
    echo "NOOSPHERE_BACKEND_PATH is not a regular file: $backend" >&2
    exit 1
  }
  [[ "$expected_backend_sha" =~ ^[a-f0-9]{64}$ ]] || {
    echo 'NOOSPHERE_BACKEND_PATH requires NOOSPHERE_BACKEND_OVERRIDE_SHA256.' >&2
    exit 1
  }
elif [[ -f "$SCRIPT_DIR/install-openclaw.sh" ]]; then
  backend="$SCRIPT_DIR/install-openclaw.sh"
else
  backend="$work_dir/install-openclaw.sh"
  curl -fsSL "$BACKEND_URL" -o "$backend"
fi
[[ "$expected_backend_sha" =~ ^[a-f0-9]{64}$ ]] || {
  echo 'Packaged installer is missing its backend checksum.' >&2
  exit 1
}
actual_backend_sha=$(sha256sum "$backend" | awk '{print $1}')
[[ "$actual_backend_sha" == "$expected_backend_sha" ]] || {
  echo 'Refusing Noosphere backend with an unexpected checksum.' >&2
  exit 1
}
chmod 700 "$backend"

if [[ "${NOOSPHERE_INSTALLER_TEST_MODE:-}" == resolve-backend ]]; then
  printf 'resolved_backend_sha256=%s\n' "$(sha256sum "$backend" | awk '{print $1}')"
  exit 0
fi

install_openclaw=false
if has_integration openclaw; then
  install_openclaw=true
fi

NOOSPHERE_INSTALL_OPENCLAW="$install_openclaw" \
NOOSPHERE_SHOW_CREDENTIALS="$SHOW_CREDENTIALS" \
NOOSPHERE_CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" \
NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-$RELEASE_VERSION}" \
NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:$RELEASE_VERSION}" \
NOOSPHERE_PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory@$RELEASE_VERSION}" \
  bash "$backend"

if [[ -z "${NOOSPHERE_PORT:-}" ]]; then
  runtime_env="$NOOSPHERE_HOME/.env"
  [[ -f "$runtime_env" && ! -L "$runtime_env" ]] || {
    echo "Cannot determine the protected Noosphere port from $runtime_env." >&2
    exit 1
  }
  NOOSPHERE_PORT=$(RUNTIME_ENV="$runtime_env" node -e '
    const lines = require("node:fs").readFileSync(process.env.RUNTIME_ENV, "utf8").split(/\r?\n/);
    let port = "";
    for (const line of lines) {
      const match = line.match(/^NOOSPHERE_PORT=([0-9]+)$/);
      if (match) port = match[1];
    }
    process.stdout.write(port);
  ')
fi
[[ "$NOOSPHERE_PORT" =~ ^[0-9]+$ ]] && ((NOOSPHERE_PORT >= 1 && NOOSPHERE_PORT <= 65535)) || {
  echo 'Noosphere runtime port is missing or invalid.' >&2
  exit 1
}
export NOOSPHERE_PORT

# The stateful backend has consumed these inputs. Do not let later integration
# helpers or host CLIs inherit database, bootstrap, provider, or HMAC secrets.
unset \
  POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APP_PASSWORD \
  POSTGRES_HYBRID_ADMIN_PASSWORD POSTGRES_HYBRID_WORKER_PASSWORD \
  NEXTAUTH_SECRET REDIS_URL NOOSPHERE_ADMIN_PASSWORD NOOSPHERE_BOOTSTRAP_API_KEY \
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 \
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64 || true

[[ -f "$NOOSPHERE_CREDENTIALS_FILE" && ! -L "$NOOSPHERE_CREDENTIALS_FILE" ]] || {
  echo "Installer did not produce the expected credential file: $NOOSPHERE_CREDENTIALS_FILE" >&2
  exit 1
}
[[ $(stat -c '%a' "$NOOSPHERE_CREDENTIALS_FILE") == 600 ]] || {
  echo "Credential file has unsafe permissions: $NOOSPHERE_CREDENTIALS_FILE" >&2
  exit 1
}

credential_field() {
  local field=$1 integration=${2:-}
  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" CREDENTIAL_FIELD="$field" CREDENTIAL_INTEGRATION="$integration" \
    node -e 'try { const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(process.env.CREDENTIALS_FILE,"utf8")); const v=process.env.CREDENTIAL_INTEGRATION ? d[process.env.CREDENTIAL_FIELD]?.[process.env.CREDENTIAL_INTEGRATION] : d[process.env.CREDENTIAL_FIELD]; if (typeof v === "string") process.stdout.write(v); } catch { process.exit(0); }'
}

installer_validated_local_base_url() {
  local base_url
  base_url=$(credential_field baseUrl)
  APP_URL_INPUT="$base_url" EXPECTED_PORT="$NOOSPHERE_PORT" node -e '
    const os = require("node:os");
    const url = new URL(process.env.APP_URL_INPUT);
    const expectedPort = String(process.env.EXPECTED_PORT || "");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const local = new Set(["localhost", "127.0.0.1", "::1"]);
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) local.add(String(entry.address).toLowerCase());
    }
    if (url.protocol !== "http:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || !url.port ||
        url.port !== expectedPort || !local.has(host)) {
      throw new Error("Protected credentials contain a non-local Noosphere URL");
    }
    process.stdout.write(url.origin);
  '
}

installer_api_status_with_key() {
  local key=$1 endpoint=$2 config status base_url
  [[ "$key" =~ ^noo_[A-Za-z0-9_-]+$ ]] || { printf '000'; return 0; }
  base_url=$(installer_validated_local_base_url) || { printf '000'; return 0; }
  config=$(mktemp "$work_dir/curl-auth.XXXXXX")
  chmod 600 "$config"
  printf 'silent\nshow-error\nheader = "Authorization: Bearer %s"\n' "$key" > "$config"
  status=$(curl --config "$config" --output /dev/null --write-out '%{http_code}' \
    "$base_url$endpoint" 2>/dev/null || true)
  rm -f "$config"
  printf '%s' "${status:-000}"
}

installer_write_probe_status_with_key() {
  local key=$1 config body status base_url
  [[ "$key" =~ ^noo_[A-Za-z0-9_-]+$ ]] || { printf '000'; return 0; }
  base_url=$(installer_validated_local_base_url) || { printf '000'; return 0; }
  config=$(mktemp "$work_dir/curl-auth.XXXXXX")
  body=$(mktemp "$work_dir/write-probe.XXXXXX")
  chmod 600 "$config" "$body"
  printf 'silent\nshow-error\nheader = "Authorization: Bearer %s"\n' "$key" > "$config"
  printf '{}\n' > "$body"
  status=$(curl --config "$config" --request POST --header 'Content-Type: application/json' \
    --data-binary "@$body" --output /dev/null --write-out '%{http_code}' \
    "$base_url/api/articles" 2>/dev/null || true)
  rm -f "$config" "$body"
  printf '%s' "${status:-000}"
}

installer_key_is_scoped() {
  local key=$1 write_status admin_status
  [[ -n "$key" ]] || return 1
  write_status=$(installer_write_probe_status_with_key "$key")
  admin_status=$(installer_api_status_with_key "$key" '/api/keys')
  if [[ "$write_status" == 000 || "$admin_status" == 000 ]]; then
    return 2
  fi
  [[ "$write_status" == 400 && "$admin_status" == 403 ]]
}

create_tool_api_key() {
  local integration=$1 bootstrap config body response name raw base_url
  bootstrap=$(credential_field bootstrapApiKey)
  base_url=$(installer_validated_local_base_url) || {
    echo 'Refusing to send the bootstrap API key to a non-local Noosphere URL.' >&2
    return 1
  }
  [[ "$bootstrap" =~ ^noo_[A-Za-z0-9_-]+$ ]] || {
    echo 'Protected credentials do not contain a valid bootstrap API key.' >&2
    return 1
  }
  name="guided-${integration}-$(date +%s)-${RANDOM}"
  config=$(mktemp "$work_dir/curl-auth.XXXXXX")
  body=$(mktemp "$work_dir/key-request.XXXXXX")
  response=$(mktemp "$work_dir/key-response.XXXXXX")
  chmod 600 "$config" "$body" "$response"
  printf 'silent\nshow-error\nfail-with-body\nheader = "Authorization: Bearer %s"\n' "$bootstrap" > "$config"
  printf '{"name":"%s","permissions":"WRITE","allowedScopes":[]}\n' "$name" > "$body"
  if ! curl --config "$config" --request POST --header 'Content-Type: application/json' \
    --data-binary "@$body" --output "$response" "$base_url/api/keys"; then
    rm -f "$config" "$body" "$response"
    echo "Failed to create a scoped ${integration} API key." >&2
    return 1
  fi
  raw=$(CREDENTIALS_FILE="$response" node -e 'try { const d=JSON.parse(require("node:fs").readFileSync(process.env.CREDENTIALS_FILE,"utf8")); if (typeof d.key === "string") process.stdout.write(d.key); } catch { process.exit(0); }')
  rm -f "$config" "$body" "$response"
  [[ "$raw" =~ ^noo_[A-Za-z0-9_-]+$ ]] || {
    echo "Noosphere returned an invalid scoped ${integration} API key." >&2
    return 1
  }
  printf '%s' "$raw"
}

ensure_tool_api_key() {
  local integration=$1 key_file=$2 key status
  key=$(credential_field integrationApiKeys "$integration")
  if installer_key_is_scoped "$key"; then
    :
  else
    status=$?
    if [[ "$status" == 2 ]]; then
      echo "Could not verify the existing scoped ${integration} API key; refusing to rotate it after a transport failure." >&2
      return 1
    fi
    key=$(create_tool_api_key "$integration")
  fi
  INTEGRATION_KEY="$key" INTEGRATION_NAME="$integration" KEY_FILE="$key_file" \
  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" node <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const credentialsFile = process.env.CREDENTIALS_FILE;
const keyFile = process.env.KEY_FILE;
if (fs.lstatSync(credentialsFile).isSymbolicLink()) throw new Error("Refusing symlinked credentials");
const credentials = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
credentials.integrationApiKeys = credentials.integrationApiKeys && typeof credentials.integrationApiKeys === "object"
  ? credentials.integrationApiKeys : {};
credentials.integrationApiKeys[process.env.INTEGRATION_NAME] = process.env.INTEGRATION_KEY;
const atomicWrite = (target, content) => {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlinked key target: ${target}`);
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
};
atomicWrite(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`);
atomicWrite(keyFile, `${process.env.INTEGRATION_KEY}\n`);
NODE
}

configure_json_plugin() {
  local config_file=$1 package_name=$2 key_file=$3
  install -d -m 700 "$(dirname "$config_file")"
  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" \
  CONFIG_FILE="$config_file" \
  PACKAGE_NAME="$package_name" \
  KEY_FILE="$key_file" \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const credentials = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_FILE, "utf8"));
const integrationKey = fs.readFileSync(process.env.KEY_FILE, "utf8").trim();
if (!/^noo_[A-Za-z0-9_-]+$/.test(integrationKey)) throw new Error("Invalid scoped integration key");
const configFile = process.env.CONFIG_FILE;
const packageName = process.env.PACKAGE_NAME;
if (fs.existsSync(configFile) && fs.lstatSync(configFile).isSymbolicLink()) {
  throw new Error(`Refusing symlinked integration config: ${configFile}`);
}
let config = {};
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}
const packageIdentity = (spec) => {
  if (typeof spec !== "string") return "";
  const versionSeparator = spec.lastIndexOf("@");
  return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
};
const entries = Array.isArray(config.plugin) ? config.plugin : [];
const packageBase = packageIdentity(packageName);
config.plugin = entries.filter((entry) => {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return packageIdentity(spec) !== packageBase;
});
config.plugin.push([
  packageName,
  {
    baseUrl: credentials.baseUrl,
    apiKey: integrationKey,
    autoRecall: true,
    autoRecallInjectOn: "first",
    autoSave: false,
  },
]);
const temp = `${configFile}.tmp-${process.pid}-${require("node:crypto").randomBytes(6).toString("hex")}`;
const fd = fs.openSync(temp, "wx", 0o600);
try {
  fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(temp, configFile);
fs.chmodSync(configFile, 0o600);
NODE
}

configure_hermes() {
  local key_file=$1 bundle_root source_root plugin_source skill_source plugin_target skill_target hermes_home
  hermes_home="${HERMES_HOME:-$HOME/.hermes}"
  [[ ! -L "$hermes_home" ]] || {
    echo "Refusing symlinked Hermes home: $hermes_home" >&2
    return 1
  }
  if [[ "$SOURCE_CHECKOUT" == true ]]; then
    source_root="$SCRIPT_DIR/hermes-noosphere-memory"
  else
    [[ "$HERMES_BUNDLE_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
      echo 'Packaged installer is missing the Hermes bundle checksum.' >&2
      exit 1
    }
    bundle_root="$work_dir/hermes"
    mkdir -p "$bundle_root"
    archive="$work_dir/hermes-noosphere-memory-${RELEASE_VERSION}.tar.gz"
    curl -fsSL "$HERMES_BUNDLE_URL" -o "$archive"
    actual_hermes_sha=$(sha256sum "$archive" | awk '{print $1}')
    [[ "$actual_hermes_sha" == "$HERMES_BUNDLE_SHA256" ]] || {
      echo 'Refusing Hermes bundle with an unexpected checksum.' >&2
      exit 1
    }
    tar -xzf "$archive" -C "$bundle_root"
    source_root="$bundle_root/hermes-noosphere-memory-${RELEASE_VERSION}"
  fi

  plugin_source="$source_root/plugins/memory/noosphere"
  skill_source="$source_root/skills/noosphere-memory-hermes"
  plugin_target="$hermes_home/plugins/noosphere"
  skill_target="$hermes_home/skills/noosphere-memory-hermes"
  [[ -d "$plugin_source" && -d "$skill_source" ]] || {
    echo 'Hermes bundle is missing the plugin or setup skill payload.' >&2
    exit 1
  }
  [[ ! -L "$plugin_target" && ! -L "$skill_target" ]] || {
    echo 'Refusing to replace a symlinked Hermes plugin or skill target.' >&2
    exit 1
  }
  rm -rf -- "$plugin_target" "$skill_target"
  install -d -m 700 "$plugin_target" "$skill_target"
  tar -C "$plugin_source" -cf - . | tar -C "$plugin_target" -xf -
  tar -C "$skill_source" -cf - . | tar -C "$skill_target" -xf -
  if command -v python3 >/dev/null 2>&1; then
    python3 -m compileall -q "$plugin_target"
  fi

  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" HERMES_HOME="$hermes_home" KEY_FILE="$key_file" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const home = process.env.HERMES_HOME;
const credentials = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_FILE, "utf8"));
const integrationKey = fs.readFileSync(process.env.KEY_FILE, "utf8").trim();
if (!/^noo_[A-Za-z0-9_-]+$/.test(integrationKey)) throw new Error("Invalid scoped Hermes key");
const assertNotSymlink = (target) => {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing symlinked Hermes configuration: ${target}`);
  }
};
assertNotSymlink(home);
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
fs.chmodSync(home, 0o700);
const atomicWriteProtected = (target, content) => {
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
};
const envPath = path.join(home, ".env");
assertNotSymlink(envPath);
const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
const retained = lines.filter((line) => !line.startsWith("HERMES_NOOSPHERE_API_KEY="));
while (retained.at(-1) === "") retained.pop();
retained.push(`HERMES_NOOSPHERE_API_KEY=${integrationKey}`);
atomicWriteProtected(envPath, `${retained.join("\n")}\n`);
const configPath = path.join(home, "noosphere.json");
assertNotSymlink(configPath);
let config = {};
if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config = {
  auto_recall: true,
  auto_capture: false,
  capture_mode: "explicit",
  max_recall_results: 5,
  token_budget: 1200,
  topic_id: "",
  author_name_template: "Hermes:{identity}",
  api_timeout: 15,
  auto_recall_timeout: 4,
  status_timeout: 5,
  ...config,
  base_url: credentials.baseUrl,
};
atomicWriteProtected(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
  if command -v hermes >/dev/null 2>&1; then
    hermes config set memory.provider noosphere
    printf '✓ Hermes Agent configured\n'
  else
    printf '✓ Hermes Agent plugin installed (run `hermes config set memory.provider noosphere` after installing the Hermes CLI)\n'
  fi
}

if has_integration hermes; then
  hermes_key_file="$work_dir/hermes.key"
  ensure_tool_api_key hermes "$hermes_key_file"
  configure_hermes "$hermes_key_file"
fi
if has_integration opencode; then
  opencode_key_file="$work_dir/opencode.key"
  ensure_tool_api_key opencode "$opencode_key_file"
  configure_json_plugin \
    "${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}" \
    "@sweetsophia/opencode-noosphere-memory@$RELEASE_VERSION" \
    "$opencode_key_file"
  printf '✓ OpenCode configured with a scoped WRITE key\n'
fi
if has_integration kilocode; then
  kilocode_key_file="$work_dir/kilocode.key"
  ensure_tool_api_key kilocode "$kilocode_key_file"
  configure_json_plugin \
    "${KILOCODE_CONFIG_FILE:-$HOME/.config/kilo/kilo.json}" \
    "@sweetsophia/kilocode-noosphere-memory@$RELEASE_VERSION" \
    "$kilocode_key_file"
  printf '✓ Kilo Code configured with a scoped WRITE key\n'
fi

printf '\nNoosphere installation finished.\n'
printf 'Open: %s/wiki\n' "$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.baseUrl)' "$NOOSPHERE_CREDENTIALS_FILE")"
printf 'Credentials: %s (mode 0600)\n' "$NOOSPHERE_CREDENTIALS_FILE"
if has_integration openclaw || has_integration hermes || has_integration opencode || has_integration kilocode; then
  printf 'Each selected tool uses its own persisted WRITE key; the bootstrap ADMIN key is not written to tool config.\n'
fi
