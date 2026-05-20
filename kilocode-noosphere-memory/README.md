# Noosphere Memory for Kilo Code

Kilo Code plugin for Noosphere memory integration.

It provides:

- prompt-time auto-recall through `POST /api/memory/recall`
- optional idle auto-save through `POST /api/memory/save`
- manual tools for status, recall, topic lookup, and draft memory saving

## Install

```bash
npm install -g @sweetsophia/kilocode-noosphere-memory
```

Add it to `~/.config/kilo/kilo.json`:

```json
{
  "plugin": [
    "@sweetsophia/kilocode-noosphere-memory"
  ]
}
```

You can also install it with Kilo's plugin command:

```bash
kilo plugin @sweetsophia/kilocode-noosphere-memory --global
```

Or configure it with explicit options:

```json
{
  "plugin": [
    [
      "@sweetsophia/kilocode-noosphere-memory",
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

Set the key in the environment used to launch Kilo Code:

```bash
export NOOSPHERE_API_KEY="noo_..."
```

The key needs:

- `READ` for recall and topic lookup
- `ADMIN` for full status information (falls back to `/api/health` automatically if key lacks ADMIN)
- `WRITE` for manual saves and auto-save

## Configuration

| Option | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `NOOSPHERE_BASE_URL` or `NOOSPHERE_URL` | `http://127.0.0.1:6578` | Noosphere deployment URL. |
| `apiKey` | `NOOSPHERE_API_KEY` | none | Noosphere API key. Prefer the environment variable. |
| `timeoutMs` | `NOOSPHERE_TIMEOUT_MS` | `5000` | Request timeout. |
| `autoRecall` | `NOOSPHERE_AUTO_RECALL` | `true` | Enable prompt-time recall injection. |
| `autoRecallInjectOn` | `NOOSPHERE_AUTO_RECALL_INJECT_ON` | `first` | `first` or `always`. |
| `autoRecallMax` | `NOOSPHERE_AUTO_RECALL_MAX` | `5` | Maximum recalled memories. |
| `autoRecallTokenBudget` | `NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET` | `1200` | Prompt injection token budget. |
| `autoSave` | `NOOSPHERE_AUTO_SAVE` | `false` | Enable idle auto-save. |
| `autoSaveDebounceMs` | `NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS` | `10000` | Idle debounce before auto-save. |
| `autoSaveTopicId` | `NOOSPHERE_AUTO_SAVE_TOPIC_ID` or `NOOSPHERE_TOPIC_ID` | none | Required for auto-save. |
| `authorName` | `NOOSPHERE_AUTHOR_NAME` | `Kilo Code` | Draft candidate author display name. |

## Auto-Recall

The plugin uses Kilo Code's `chat.message` hook. It extracts the user prompt, calls Noosphere in `auto` mode, and prepends the returned memory context as a synthetic text part.

Recall runs:

- on the first user message in a session by default
- after compaction
- on every message when `autoRecallInjectOn` is `always`

Recalled memory is wrapped in `<noosphere_auto_recall>` so Noosphere can strip injected context if it is later saved.

## Auto-Save

Auto-save is available but disabled by default to avoid unexpected writes from public installs.

To enable it:

```bash
export NOOSPHERE_AUTO_SAVE=true
export NOOSPHERE_AUTO_SAVE_TOPIC_ID="<topic UUID>"
```

When Kilo Code emits `session.idle`, the plugin waits for the configured debounce, extracts the latest user request and assistant response, and saves a draft memory candidate. It skips short and trivial prompts.

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
- `excerpt`, `tags`, `restrictedTags`, `source`, `confidence` optional

Use this for stable project facts, decisions, runbooks, and recurring fixes. Do not save secrets, raw prompt dumps, or transient task chatter.

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```
