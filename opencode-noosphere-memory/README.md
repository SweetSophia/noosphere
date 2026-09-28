# Noosphere Memory for OpenCode

Connect OpenCode to self-hosted Noosphere memory. Recall relevant knowledge,
save draft memories with explicit tools, and optionally enable idle auto-save.

## Quick start

You need a running Noosphere instance and a dedicated OpenCode WRITE key. For a
new local setup, select OpenCode in the [guided installer](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md#guided-installation)
after confirming the [v1.14.0 release](https://github.com/SweetSophia/noosphere/releases/tag/v1.14.0)
has all six installer assets. The [auditable download](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md#auditable-download)
explains checksum verification.

Already running Noosphere? Create a dedicated WRITE key at `/wiki/admin/keys`,
then [install the plugin](#install) and [set its key](#secrets). Never use the
bootstrap ADMIN key for an agent integration. See the [full OpenCode guide on GitHub](https://github.com/SweetSophia/noosphere/tree/master/opencode-noosphere-memory)
for remote setup and configuration details.

## Install

Add it to `~/.config/opencode/opencode.json`. Opencode can auto-install scoped
npm plugins from this config:

```json
{
  "plugin": [
    "@sweetsophia/opencode-noosphere-memory@1.14.0"
  ]
}
```

Or install the package globally first if you prefer explicit local installs:

```bash
npm install -g @sweetsophia/opencode-noosphere-memory@1.14.0
```

### oh-my-opencode-slim

`oh-my-opencode-slim` is an Opencode orchestration plugin, so Noosphere does not
need a separate fork. Install both plugins and keep both entries in
`~/.config/opencode/opencode.json`:

```bash
npx oh-my-opencode-slim@latest install
# Optional: Opencode can also auto-install npm plugins from opencode.json.
npm install -g @sweetsophia/opencode-noosphere-memory@1.14.0
export OPENCODE_NOOSPHERE_API_KEY="noo_..."
```

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "@sweetsophia/opencode-noosphere-memory@1.14.0"
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
      "@sweetsophia/opencode-noosphere-memory@1.14.0",
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

## Verified guided install

For a new local setup, first confirm the [v1.14.0 release](https://github.com/SweetSophia/noosphere/releases/tag/v1.14.0)
has all six installer assets. This pinned launcher verifies its SHA-256 before
execution; see the [GitHub installation guide](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md)
for upgrade behavior and other installation paths.

```bash
# Installer commit: 182e0dceade3f0ac31e5d14f42f091d4075793a2
# Expected SHA-256: 5fd69c4125ba02fdcc36e1bb54b66628dc5d324f7c04cea13d5dae3729035601
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/182e0dceade3f0ac31e5d14f42f091d4075793a2/install.sh -o "$installer"
  printf '%s  %s\n' '5fd69c4125ba02fdcc36e1bb54b66628dc5d324f7c04cea13d5dae3729035601' "$installer" | sha256sum -c -
  bash "$installer" --non-interactive --with opencode
)
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```
