#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Installer failed near line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/plugins/memory/noosphere"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
TARGET_DIR="${HERMES_HOME}/plugins/noosphere"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
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

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Cannot find Hermes Noosphere plugin source at: $SOURCE_DIR" >&2
  exit 1
fi

need tar

mkdir -p "$TARGET_DIR"
tar -C "$SOURCE_DIR" -cf - . | tar -C "$TARGET_DIR" -xf -

if command -v python3 >/dev/null 2>&1; then
  if ! python3 -m compileall -q "$TARGET_DIR"; then
    echo "Warning: installed plugin has Python syntax errors. Check $TARGET_DIR." >&2
  fi
fi

echo ""
echo "Noosphere Hermes memory provider installed."
echo ""
echo "Plugin path:"
echo "  $TARGET_DIR"
echo ""

if command -v hermes >/dev/null 2>&1; then
  if can_prompt; then
    answer=""
    read_prompt "Run 'hermes memory setup' now? [Y/n]: " answer || answer=""
    answer="${answer:-Y}"
    case "$answer" in
      Y|y|yes|YES)
        hermes memory setup
        ;;
      *)
        echo "Skipped interactive Hermes setup."
        ;;
    esac
  else
    echo "Hermes CLI detected. Non-interactive mode: run setup manually when ready."
  fi
else
  echo "Hermes CLI not found in PATH. Install Hermes first, then run the commands below."
fi

cat <<EOF

Manual setup:

  hermes config set memory.provider noosphere
  python3 - <<'PY'
import os
from pathlib import Path

hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
env_path = hermes_home / ".env"
env_path.parent.mkdir(parents=True, exist_ok=True)
lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
key = "NOOSPHERE_API_KEY"
value = "noo_..."
updated = False
for index, line in enumerate(lines):
    if line.split("=", 1)[0].strip() == key:
        lines[index] = f"{key}={value}"
        updated = True
        break
if not updated:
    lines.append(f"{key}={value}")
env_path.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
env_path.chmod(0o600)
PY
  [ ! -f "\$HERMES_HOME/noosphere.json" ] && cat > "\$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 15.0
}
JSON

Create the API key in Noosphere at:
  <NOOSPHERE_APP_URL>/wiki/admin/keys

Use a scoped key for the Hermes profile. The plugin reads NOOSPHERE_API_KEY and
does not print or store secrets in the repository.
EOF
