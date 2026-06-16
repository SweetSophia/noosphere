# Noosphere Memory Provider

Noosphere gives Hermes Agent access to durable, scoped, human-readable memory.

This provider is currently in Phase 4:

- it registers with Hermes as a memory provider
- it exposes setup fields for the Noosphere API key and base URL
- it stores non-secret configuration in `$HERMES_HOME/noosphere.json`
- it reads the secret API key from `HERMES_NOOSPHERE_API_KEY`, with
  `NOOSPHERE_API_KEY` as a compatibility fallback
- it exposes status, recall, get, and topics tools
- it uses Noosphere's prompt-ready recall API for `prefetch()`
- it saves explicit durable memories as draft candidates
- it supports scoped draft saves through optional `restrictedTags`
- it validates `base_url` before sending authenticated requests
- it can mirror explicit Hermes memory writes when `topic_id` is configured

Direct article publication is intentionally added in later phases.

## Setup

```bash
hermes memory setup
```

Select `noosphere`, then provide:

- Noosphere API key from `/wiki/admin/keys`
- Noosphere base URL, for example `http://127.0.0.1:6578`

Manual setup:

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

## Config

Config file: `$HERMES_HOME/noosphere.json`

| Key | Default | Description |
| --- | --- | --- |
| `base_url` | `http://127.0.0.1:6578` | Noosphere deployment URL. |
| `auto_recall` | `true` | Enable prompt-time recall through Noosphere's prompt-ready recall API. |
| `auto_capture` | `false` | Keep broad turn capture disabled by default. |
| `capture_mode` | `explicit` | Capture policy; broad turn capture only runs when set up explicitly. |
| `max_recall_results` | `5` | Maximum results requested during prefetch and recall. |
| `token_budget` | `1200` | Prompt-ready recall token budget. |
| `topic_id` | `""` | Default topic for draft saves and optional turn capture. |
| `author_name_template` | `Hermes:{identity}` | Author name template for draft memory candidates. |
| `api_timeout` | `15.0` | HTTP timeout in seconds for explicit tools and saves. |
| `auto_recall_timeout` | `4.0` | Fail-fast HTTP timeout in seconds for prompt-time prefetch. |
| `status_timeout` | `5.0` | Fail-fast HTTP timeout in seconds for status and health probes. |

Secrets:

| Variable | Description |
| --- | --- |
| `HERMES_NOOSPHERE_API_KEY` | Preferred Noosphere API key for Hermes. |
| `NOOSPHERE_API_KEY` | Backward-compatible fallback API key. |
| `HERMES_NOOSPHERE_BASE_URL` | Preferred environment override for `base_url`. |
| `NOOSPHERE_BASE_URL` | Backward-compatible fallback base URL override. |

## Safety

`is_available()` checks only local environment. It does not make network calls during Hermes startup.

`base_url` rejects malformed URLs, embedded credentials, non-loopback
`http://` URLs, and literal private/reserved/link-local/multicast IPv4 or IPv6
targets. Local loopback installs such as `http://127.0.0.1:6578` remain allowed.

Writes are disabled during `cron`, `flush`, and `subagent` contexts.

## Tools

| Tool | Description |
| --- | --- |
| `noosphere_status` | Calls `GET /api/memory/status` and returns Noosphere memory status JSON. |
| `noosphere_recall` | Calls `POST /api/memory/recall` in inspection mode. |
| `noosphere_get` | Calls `POST /api/memory/get` by canonical ref or provider/id. For Noosphere, use `noosphere:article:<id>`; topic IDs from `noosphere_topics` are save/navigation targets, not `noosphere_get` canonical refs. |
| `noosphere_topics` | Calls `GET /api/topics` for topic selection. |
| `noosphere_save` | Calls `POST /api/memory/save` and creates a draft memory candidate. |

`noosphere_save` accepts optional `restrictedTags` for explicit scoped saves.
The provider validates the shape only; the Noosphere API enforces whether the
key may assign the requested scopes.

If `noosphere_get` returns a 400 canonical-ref type validation error such as
`Unsupported canonicalRef type for noosphere: topic`, the request used a
non-addressable type segment. Recover by searching with
`noosphere_recall(query="<topic name>")`, then fetch the returned article with
`canonicalRef="noosphere:article:<id>"`.
