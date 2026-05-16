# Noosphere Memory Provider

Noosphere gives Hermes Agent access to durable, scoped, human-readable memory.

This provider is currently in Phase 4:

- it registers with Hermes as a memory provider
- it exposes setup fields for the Noosphere API key and base URL
- it stores non-secret configuration in `$HERMES_HOME/noosphere.json`
- it reads the secret API key from `NOOSPHERE_API_KEY`
- it exposes status, recall, get, and topics tools
- it uses Noosphere's prompt-ready recall API for `prefetch()`
- it saves explicit durable memories as draft candidates
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
printf '%s\n' 'NOOSPHERE_API_KEY=noo_...' >> "$HERMES_HOME/.env"
cat > "$HERMES_HOME/noosphere.json" <<'JSON'
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
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
| `auto_recall` | `true` | Enable prompt-time recall through Noosphere's prompt-ready recall API. |
| `auto_capture` | `false` | Keep broad turn capture disabled by default. |
| `capture_mode` | `explicit` | Capture policy; broad turn capture only runs when set up explicitly. |
| `max_recall_results` | `5` | Maximum results requested during prefetch and recall. |
| `token_budget` | `1200` | Prompt-ready recall token budget. |
| `topic_id` | `""` | Default topic for draft saves and optional turn capture. |
| `author_name_template` | `Hermes:{identity}` | Author name template for draft memory candidates. |
| `api_timeout` | `5.0` | HTTP timeout in seconds. |

Secrets:

| Variable | Description |
| --- | --- |
| `NOOSPHERE_API_KEY` | Required Noosphere API key. |
| `NOOSPHERE_BASE_URL` | Optional environment override for `base_url`. |

## Safety

`is_available()` checks only local environment. It does not make network calls during Hermes startup.

Writes are disabled during `cron`, `flush`, and `subagent` contexts.

## Tools

| Tool | Description |
| --- | --- |
| `noosphere_status` | Calls `GET /api/memory/status` and returns Noosphere memory status JSON. |
| `noosphere_recall` | Calls `POST /api/memory/recall` in inspection mode. |
| `noosphere_get` | Calls `POST /api/memory/get` by canonical ref or provider/id. |
| `noosphere_topics` | Calls `GET /api/topics` for topic selection. |
| `noosphere_save` | Calls `POST /api/memory/save` and creates a draft memory candidate. |
