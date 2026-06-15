# Noosphere Memory for Opencode

Opencode plugin for Noosphere memory integration.

It provides:

- prompt-time auto-recall through `POST /api/memory/recall`
- optional idle auto-save through `POST /api/memory/save`
- manual tools for status, recall, topic lookup, and draft memory saving

## Before you start

You need two things before this plugin will do anything useful:

1. **A reachable Noosphere instance.** The plugin defaults to
   `http://127.0.0.1:6578`. For a local install, the easiest path is the
   repository's one-shot installer:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
   ```

   It provisions Docker, Redis, the Noosphere container, and a bootstrap API key.
   To point at an existing Noosphere instead, set `baseUrl` in the plugin
   options (see [Configuration](#configuration)).

2. **A Noosphere API key for this tool.** The plugin will refuse to start
   without one. Create it in the Noosphere admin UI:

   ```text
   <NOOSPHERE_URL>/wiki/admin/keys
   ```

   (Admin login is required. The local installer creates an `admin@noosphere.local`
   admin account whose password is in `~/.noosphere/.env` as
   `NOOSPHERE_ADMIN_PASSWORD`.) Use a **tool-scoped key** rather than the
   bootstrap key for production installs — name it after the tool
   (e.g. `opencode`) and grant the permissions you need:

   - `READ` for prompt-time recall and topic lookup
   - `WRITE` for manual saves and idle auto-save
   - `ADMIN` for full `noosphere_status` output (the plugin falls back to
     `/api/health` automatically if the key lacks `ADMIN`)

   See [Secrets](#secrets) below for where to put the key once you have it.

## Install

Add it to `~/.config/opencode/opencode.json`. Opencode can auto-install scoped
npm plugins from this config:

```json
{
  "plugin": [
    "@sweetsophia/opencode-noosphere-memory"
  ]
}
```

Or install the package globally first if you prefer explicit local installs:

```bash
npm install -g @sweetsophia/opencode-noosphere-memory
```

### oh-my-opencode-slim

`oh-my-opencode-slim` is an Opencode orchestration plugin, so Noosphere does not
need a separate fork. Install both plugins and keep both entries in
`~/.config/opencode/opencode.json`:

```bash
npx oh-my-opencode-slim@latest install
# Optional: Opencode can also auto-install npm plugins from opencode.json.
npm install -g @sweetsophia/opencode-noosphere-memory
export OPENCODE_NOOSPHERE_API_KEY="noo_..."
```

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "@sweetsophia/opencode-noosphere-memory"
  ]
}
```

The `oh-my-opencode-slim` installer preserves non-matching plugin entries when
it updates `opencode.json`; rerunning it should not remove the Noosphere entry.
Opencode can auto-install the scoped npm package from the plugin array, so the
global `npm install -g` step is useful for explicit local installs but is not a
runtime compatibility requirement.

Or configure it with explicit options:

```json
{
  "plugin": [
    [
      "@sweetsophia/opencode-noosphere-memory",
      {
        "baseUrl": "http://127.0.0.1:6578",
        "autoRecall": true,
        "autoRecallInjectOn": "first",
        "autoSave": false
      }
    ]
  ]
}
```

## Secrets

Do not put real Noosphere API keys in repo files.

Set the key in the environment used to launch Opencode:

```bash
export OPENCODE_NOOSPHERE_API_KEY="noo_..."
```

Use `OPENCODE_NOOSPHERE_*` variables on machines that also run Kilo Code,
OpenClaw, or Hermes. Generic `NOOSPHERE_*` variables are still supported as
backward-compatible fallbacks.

The key needs:

- `READ` for recall and topic lookup
- `ADMIN` for full status information (falls back to `/api/health` automatically if key lacks ADMIN)
- `WRITE` for manual saves and auto-save

## Configuration

| Option | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `OPENCODE_NOOSPHERE_BASE_URL` or `OPENCODE_NOOSPHERE_URL`; fallback: `NOOSPHERE_BASE_URL` or `NOOSPHERE_URL` | `http://127.0.0.1:6578` | Noosphere deployment URL. |
| `apiKey` | `OPENCODE_NOOSPHERE_API_KEY`; fallback: `NOOSPHERE_API_KEY` | none | Noosphere API key. Prefer the tool-specific environment variable. |
| `timeoutMs` | `OPENCODE_NOOSPHERE_TIMEOUT_MS`; fallback: `NOOSPHERE_TIMEOUT_MS` | `5000` | Request timeout. |
| `autoRecall` | `OPENCODE_NOOSPHERE_AUTO_RECALL`; fallback: `NOOSPHERE_AUTO_RECALL` | `true` | Enable prompt-time recall injection. |
| `autoRecallInjectOn` | `OPENCODE_NOOSPHERE_AUTO_RECALL_INJECT_ON`; fallback: `NOOSPHERE_AUTO_RECALL_INJECT_ON` | `first` | `first` or `always`. |
| `autoRecallMax` | `OPENCODE_NOOSPHERE_AUTO_RECALL_MAX`; fallback: `NOOSPHERE_AUTO_RECALL_MAX` | `5` | Maximum recalled memories. |
| `autoRecallTokenBudget` | `OPENCODE_NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET`; fallback: `NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET` | `1200` | Prompt injection token budget. |
| `autoSave` | `OPENCODE_NOOSPHERE_AUTO_SAVE`; fallback: `NOOSPHERE_AUTO_SAVE` | `false` | Enable idle auto-save. |
| `autoSaveDebounceMs` | `OPENCODE_NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS`; fallback: `NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS` | `10000` | Idle debounce before auto-save. |
| `autoSaveTopicId` | `OPENCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID` or `OPENCODE_NOOSPHERE_TOPIC_ID`; fallback: `NOOSPHERE_AUTO_SAVE_TOPIC_ID` or `NOOSPHERE_TOPIC_ID` | none | Required for auto-save. |
| `authorName` | `OPENCODE_NOOSPHERE_AUTHOR_NAME`; fallback: `NOOSPHERE_AUTHOR_NAME` | `Opencode` | Draft candidate author display name. |

## Auto-Recall

The plugin uses Opencode's `chat.message` hook. It extracts the user prompt, calls Noosphere in `auto` mode, and prepends the returned memory context as a synthetic text part.

Recall runs:

- on the first user message in a session by default
- after compaction
- on every message when `autoRecallInjectOn` is `always`

Recalled memory is wrapped in `<noosphere_auto_recall>` so Noosphere can strip injected context if it is later saved.

## Auto-Save

Auto-save is available but disabled by default to avoid unexpected writes from public installs.

To enable it:

```bash
export OPENCODE_NOOSPHERE_AUTO_SAVE=true
export OPENCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID="<topic UUID>"
```

When Opencode emits `session.idle`, the plugin waits for the configured debounce, extracts the latest user request and assistant response, and saves a draft memory candidate. It skips short and trivial prompts.

## Tools

### `noosphere_status`

Checks plugin config and Noosphere memory status.

### `noosphere_recall`

Manual memory search.

Arguments:

- `query` required
- `resultCap` optional, 1-10
- `tokenBudget` optional, 100-2000
- `scope` optional

### `noosphere_topics`

Lists topics and IDs for use with `noosphere_save`.

### `noosphere_save`

Saves durable content as a draft memory candidate.

Arguments:

- `title` required
- `content` required
- `topicId` required
- `excerpt`, `tags`, `source`, `confidence` optional

Use this for stable project facts, decisions, runbooks, and recurring fixes. Do not save secrets, raw prompt dumps, or transient task chatter.

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```
