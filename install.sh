#!/usr/bin/env bash
set -euo pipefail
trap 'printf "Installer failed near line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

RELEASE_VERSION='1.12.0'
BACKEND_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/81dc9d68ddd72ec0142b6ce0bcea611fcc7ba597/install-openclaw.sh'
BACKEND_SHA256='23879652c3724c8932656c259a0852c9f1fa7aed5273b68fa557b8d594d08a62'
HERMES_BUNDLE_URL='https://github.com/SweetSophia/noosphere/releases/download/v1.12.0/hermes-noosphere-memory-1.12.0.tar.gz'
HERMES_BUNDLE_SHA256='1fc5f938887832b0f9bb273cb78a90a4da0f12b11d9fd2eeef79f923445e4f17'
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
      if [[ -n "$phase" && "$phase" != complete ]]; then
        printf '%s\n' 'resume or verify interrupted installation'
        return 0
      fi
    fi
    printf '%s\n' 'upgrade or verify existing installation'
    return 0
  done

  if command -v docker >/dev/null 2>&1 &&
     { docker inspect noosphere-openclaw-db >/dev/null 2>&1 ||
       docker volume inspect noosphere_postgres_data >/dev/null 2>&1; }; then
    printf '%s\n' 'upgrade or verify existing installation'
  elif [[ -f "$NOOSPHERE_HOME/.env" || -f "$NOOSPHERE_HOME/docker-compose.yml" ]]; then
    printf '%s\n' 'upgrade or verify existing installation'
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
if [[ -n "${NOOSPHERE_BACKEND_PATH:-}" ]]; then
  backend=$NOOSPHERE_BACKEND_PATH
  [[ -f "$backend" && ! -L "$backend" ]] || {
    echo "NOOSPHERE_BACKEND_PATH is not a regular file: $backend" >&2
    exit 1
  }
elif [[ -f "$SCRIPT_DIR/install-openclaw.sh" ]]; then
  backend="$SCRIPT_DIR/install-openclaw.sh"
else
  [[ "$BACKEND_SHA256" =~ ^[a-f0-9]{64}$ ]] || {
    echo 'Packaged installer is missing its backend checksum.' >&2
    exit 1
  }
  backend="$work_dir/install-openclaw.sh"
  curl -fsSL "$BACKEND_URL" -o "$backend"
  actual_backend_sha=$(sha256sum "$backend" | awk '{print $1}')
  [[ "$actual_backend_sha" == "$BACKEND_SHA256" ]] || {
    echo 'Refusing Noosphere backend with an unexpected checksum.' >&2
    exit 1
  }
  chmod 700 "$backend"
fi

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

[[ -f "$NOOSPHERE_CREDENTIALS_FILE" && ! -L "$NOOSPHERE_CREDENTIALS_FILE" ]] || {
  echo "Installer did not produce the expected credential file: $NOOSPHERE_CREDENTIALS_FILE" >&2
  exit 1
}
[[ $(stat -c '%a' "$NOOSPHERE_CREDENTIALS_FILE") == 600 ]] || {
  echo "Credential file has unsafe permissions: $NOOSPHERE_CREDENTIALS_FILE" >&2
  exit 1
}

configure_json_plugin() {
  local config_file=$1 package_name=$2
  install -d -m 700 "$(dirname "$config_file")"
  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" \
  CONFIG_FILE="$config_file" \
  PACKAGE_NAME="$package_name" \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const credentials = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_FILE, "utf8"));
const configFile = process.env.CONFIG_FILE;
const packageName = process.env.PACKAGE_NAME;
let config = {};
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}
const entries = Array.isArray(config.plugin) ? config.plugin : [];
const packageBase = packageName.replace(/@[0-9].*$/, "");
config.plugin = entries.filter((entry) => {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec !== "string" || !spec.startsWith(`${packageBase}@`);
});
config.plugin.push([
  packageName,
  {
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    autoRecall: true,
    autoRecallInjectOn: "first",
    autoSave: false,
  },
]);
const temp = `${configFile}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, configFile);
fs.chmodSync(configFile, 0o600);
NODE
}

configure_hermes() {
  local bundle_root source_root plugin_source skill_source plugin_target skill_target hermes_home
  hermes_home="${HERMES_HOME:-$HOME/.hermes}"
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

  CREDENTIALS_FILE="$NOOSPHERE_CREDENTIALS_FILE" HERMES_HOME="$hermes_home" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HERMES_HOME;
const credentials = JSON.parse(fs.readFileSync(process.env.CREDENTIALS_FILE, "utf8"));
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const envPath = path.join(home, ".env");
const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
const retained = lines.filter((line) => !line.startsWith("HERMES_NOOSPHERE_API_KEY="));
while (retained.at(-1) === "") retained.pop();
retained.push(`HERMES_NOOSPHERE_API_KEY=${credentials.apiKey}`);
fs.writeFileSync(envPath, `${retained.join("\n")}\n`, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
const configPath = path.join(home, "noosphere.json");
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
const temp = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, configPath);
fs.chmodSync(configPath, 0o600);
NODE
  if command -v hermes >/dev/null 2>&1; then
    hermes config set memory.provider noosphere
    printf '✓ Hermes Agent configured\n'
  else
    printf '✓ Hermes Agent plugin installed (run `hermes config set memory.provider noosphere` after installing the Hermes CLI)\n'
  fi
}

if has_integration hermes; then
  configure_hermes
fi
if has_integration opencode; then
  configure_json_plugin \
    "${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}" \
    "@sweetsophia/opencode-noosphere-memory@$RELEASE_VERSION"
  printf '✓ OpenCode configured\n'
fi
if has_integration kilocode; then
  configure_json_plugin \
    "${KILOCODE_CONFIG_FILE:-$HOME/.config/kilo/kilo.json}" \
    "@sweetsophia/kilocode-noosphere-memory@$RELEASE_VERSION"
  printf '✓ Kilo Code configured\n'
fi

printf '\nNoosphere installation finished.\n'
printf 'Open: %s/wiki\n' "$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.baseUrl)' "$NOOSPHERE_CREDENTIALS_FILE")"
printf 'Credentials: %s (mode 0600)\n' "$NOOSPHERE_CREDENTIALS_FILE"
if has_integration opencode || has_integration kilocode; then
  printf 'OpenCode/Kilo keep the initial key in their mode-0600 user config. Replace it with a tool-scoped key from /wiki/admin/keys when convenient.\n'
fi
