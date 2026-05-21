# Noosphere Memory Provider for Hermes Agent

This package contains the Hermes Agent memory-provider integration for Noosphere.

Current implementation status: Phase 4 draft save and explicit memory mirroring.

## Layout

```text
plugins/memory/noosphere/
  __init__.py
  client.py
  formatting.py
  plugin.yaml
  README.md
  schemas.py
  skills/noosphere/SKILL.md
skills/noosphere-memory-hermes/SKILL.md
tests/
  test_noosphere_client.py
  test_noosphere_provider_phase1.py
  test_noosphere_recall_phase3.py
  test_noosphere_save_phase4.py
```

## Phase 4 Scope

Implemented:

- Hermes `MemoryProvider` registration entry point
- `hermes memory setup` config schema
- profile-scoped `$HERMES_HOME/noosphere.json` config persistence
- environment-based secret lookup through `HERMES_NOOSPHERE_API_KEY` with
  `NOOSPHERE_API_KEY` as a compatibility fallback
- safe initialization without network calls
- standard-library HTTP client with redacted errors
- `noosphere_status`, `noosphere_recall`, `noosphere_get`, `noosphere_topics`, and `noosphere_save` tools
- auto-recall prefetch through Noosphere's prompt-ready recall API
- fail-fast prompt/status timeouts separate from explicit API tool timeouts
- explicit Hermes memory-write mirroring through draft memory candidates
- optional `restrictedTags` pass-through for scoped draft saves
- optional `sync_turn` capture when `auto_capture=true` and `topic_id` is configured
- Hermes setup skill installed to `$HERMES_HOME/skills/noosphere-memory-hermes`

Not implemented yet:

- direct article publication tools

Those are intentionally left for later PRs so each step stays reviewable.

## Manual Install During Development
Manual setup looks like this:

    mkdir -p "$HERMES_HOME/plugins"
    cp -R plugins/memory/noosphere "$HERMES_HOME/plugins/noosphere"
    hermes config set memory.provider noosphere

Store your key in:

    $HERMES_HOME/.env

For example:

    HERMES_NOOSPHERE_API_KEY=noo_...

Then create or edit:

    $HERMES_HOME/noosphere.json

Example:

    {
      "base_url": "http://127.0.0.1:6578",
      "auto_recall": true,
      "auto_capture": false,
      "capture_mode": "explicit",
      "max_recall_results": 5,
      "token_budget": 1200,
      "topic_id": "",
      "author_name_template": "Hermes:{identity}",
      "api_timeout": 15.0,
      "auto_recall_timeout": 4.0,
      "status_timeout": 5.0
    }

Use scoped Noosphere API keys for each Hermes profile when you want different agents to see or write different knowledge areas.

#### Manual fallback condensed version instructions:

```bash
hermes config set memory.provider noosphere
python3 - <<'PY'
import os
from pathlib import Path

hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
env_path = hermes_home / ".env"
env_path.parent.mkdir(parents=True, exist_ok=True)
lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
key = "HERMES_NOOSPHERE_API_KEY"
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
[ ! -f "$HERMES_HOME/noosphere.json" ] && cat > "$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 15.0,
  "auto_recall_timeout": 4.0,
  "status_timeout": 5.0
}
JSON
```

Do not commit real API keys.

`base_url` is validated before use. The provider rejects malformed URLs,
credential-embedded URLs, non-loopback `http://` URLs, and literal private,
reserved, link-local, multicast, documentation, or unspecified IPv4/IPv6
targets for both HTTP and HTTPS. Query strings and fragments are stripped.

`noosphere_save` accepts optional `restrictedTags` with up to 16 non-empty
strings of at most 64 characters each. Noosphere enforces whether the API key
may use those scopes.

## Verification

```bash
python3 -m unittest discover -s hermes-noosphere-memory/tests
python3 -m compileall hermes-noosphere-memory/plugins/memory/noosphere
```
