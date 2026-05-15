# Noosphere Memory Provider

Noosphere gives Hermes Agent access to durable, scoped, human-readable memory.

This provider is currently in Phase 1:

- it registers with Hermes as a memory provider
- it exposes setup fields for the Noosphere API key and base URL
- it stores non-secret configuration in `$HERMES_HOME/noosphere.json`
- it reads the secret API key from `NOOSPHERE_API_KEY`

Recall and save tools are intentionally added in later phases.

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
printf '%s\n' 'NOOSPHERE_API_KEY=noo_...' >> "$HERMES_HOME/.env"
cat > "$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "providers": ["noosphere"],
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 5.0
}
JSON
```

## Config

Config file: `$HERMES_HOME/noosphere.json`

| Key | Default | Description |
| --- | --- | --- |
| `base_url` | `http://127.0.0.1:6578` | Noosphere deployment URL. |
| `auto_recall` | `true` | Enable prompt-time recall once Phase 3 lands. |
| `auto_capture` | `false` | Keep broad turn capture disabled by default. |
| `capture_mode` | `explicit` | Capture policy. Phase 1 stores only config. |
| `max_recall_results` | `5` | Future recall result cap. |
| `token_budget` | `1200` | Future recall token budget. |
| `providers` | `["noosphere"]` | Noosphere recall providers to query. |
| `topic_id` | `""` | Default save topic for later write phases. |
| `author_name_template` | `Hermes:{identity}` | Future author name template. |
| `api_timeout` | `5.0` | Future HTTP timeout in seconds. |

Secrets:

| Variable | Description |
| --- | --- |
| `NOOSPHERE_API_KEY` | Required Noosphere API key. |
| `NOOSPHERE_BASE_URL` | Optional environment override for `base_url`. |

## Safety

`is_available()` checks only local environment. It does not make network calls during Hermes startup.

Writes are disabled during `cron`, `flush`, and `subagent` contexts.
