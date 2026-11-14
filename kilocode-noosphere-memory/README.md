# Noosphere Memory for Kilo Code

> **1.15.3 is published.** The coordinated release exists at
> [`v1.15.3`](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.3)
> with all six installer assets, the `ghcr.io/sweetsophia/noosphere:1.15.3`
> image (`linux/amd64` and `linux/arm64`), and the five `1.15.3` npm packages.
> The version-bound commands below are release-bound and may run now.
> Production activation remains a separate step and requires its own
> authorization.

Connect Kilo Code to self-hosted Noosphere memory. Recall relevant knowledge,
save draft memories with explicit tools, and optionally enable idle auto-save.

## Quick start

You need a running Noosphere instance and a dedicated Kilo Code WRITE key. For a
new local setup, select Kilo Code in the [guided installer](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md#guided-installation)
after confirming the [v1.15.3 release](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.3)
has all six installer assets. The [auditable download](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md#auditable-download)
explains checksum verification.

Already running Noosphere? Create a dedicated WRITE key at `/wiki/admin/keys`,
then [install the plugin](#install) and [set its key](#secrets). Never use the
bootstrap ADMIN key for an agent integration. See the [full Kilo Code guide on GitHub](https://github.com/SweetSophia/noosphere/tree/master/kilocode-noosphere-memory)
for remote setup and configuration details.

## Install

```bash
npm install -g @sweetsophia/kilocode-noosphere-memory@1.15.3
```

Add it to `~/.config/kilo/kilo.json`:

```json
{
  "plugin": [
    "@sweetsophia/kilocode-noosphere-memory@1.15.3"
  ]
}
```

You can also install it with Kilo's plugin command:

```bash
kilo plugin @sweetsophia/kilocode-noosphere-memory@1.15.3 --global
```

Or configure it with explicit options:

```json
{
  "plugin": [
    [
      "@sweetsophia/kilocode-noosphere-memory@1.15.3",
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
export KILOCODE_NOOSPHERE_API_KEY="noo_..."
```

Use `KILOCODE_NOOSPHERE_*` variables on machines that also run Opencode,
OpenClaw, or Hermes. Generic `NOOSPHERE_*` variables are still supported as
backward-compatible fallbacks.

The key needs:

- `READ` for recall and topic lookup
- `ADMIN` for full status information (falls back to `/api/health` automatically if key lacks ADMIN)
- `WRITE` for manual saves and auto-save

## Configuration

| Option | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `KILOCODE_NOOSPHERE_BASE_URL` or `KILOCODE_NOOSPHERE_URL`; fallback: `NOOSPHERE_BASE_URL` or `NOOSPHERE_URL` | `http://127.0.0.1:6578` | Noosphere deployment URL. |
| `apiKey` | `KILOCODE_NOOSPHERE_API_KEY`; fallback: `NOOSPHERE_API_KEY` | none | Noosphere API key. Prefer the tool-specific environment variable. |
| `timeoutMs` | `KILOCODE_NOOSPHERE_TIMEOUT_MS`; fallback: `NOOSPHERE_TIMEOUT_MS` | `5000` | Request timeout. |
| `autoRecall` | `KILOCODE_NOOSPHERE_AUTO_RECALL`; fallback: `NOOSPHERE_AUTO_RECALL` | `true` | Enable prompt-time recall injection. |
| `autoRecallInjectOn` | `KILOCODE_NOOSPHERE_AUTO_RECALL_INJECT_ON`; fallback: `NOOSPHERE_AUTO_RECALL_INJECT_ON` | `first` | `first` or `always`. |
| `autoRecallMax` | `KILOCODE_NOOSPHERE_AUTO_RECALL_MAX`; fallback: `NOOSPHERE_AUTO_RECALL_MAX` | `5` | Maximum recalled memories. |
| `autoRecallTokenBudget` | `KILOCODE_NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET`; fallback: `NOOSPHERE_AUTO_RECALL_TOKEN_BUDGET` | `1200` | Prompt injection token budget. |
| `autoSave` | `KILOCODE_NOOSPHERE_AUTO_SAVE`; fallback: `NOOSPHERE_AUTO_SAVE` | `false` | Enable idle auto-save. |
| `autoSaveDebounceMs` | `KILOCODE_NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS`; fallback: `NOOSPHERE_AUTO_SAVE_DEBOUNCE_MS` | `10000` | Idle debounce before auto-save. |
| `autoSaveTopicId` | `KILOCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID` or `KILOCODE_NOOSPHERE_TOPIC_ID`; fallback: `NOOSPHERE_AUTO_SAVE_TOPIC_ID` or `NOOSPHERE_TOPIC_ID` | none | Required for auto-save. |
| `authorName` | `KILOCODE_NOOSPHERE_AUTHOR_NAME`; fallback: `NOOSPHERE_AUTHOR_NAME` | `Kilo Code` | Draft candidate author display name. |

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
export KILOCODE_NOOSPHERE_AUTO_SAVE=true
export KILOCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID="<topic UUID>"
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

## Verified guided install

For a new local setup, first confirm the [v1.15.3 release](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.3)
has all six installer assets. This pinned launcher verifies its SHA-256 before
execution; see the [GitHub installation guide](https://github.com/SweetSophia/noosphere/blob/master/docs/INSTALLATION.md)
for upgrade behavior and other installation paths.

The source-pinned command below installs the **1.15.0 application and kilocode package**,
not 1.15.3: both follow the source launcher's embedded release version. To
install the coordinated 1.15.3 set, use the packaged launcher from the 1.15.3
release assets; the explicit npm command earlier on this page selects the
1.15.3 adapter when only the adapter needs installing.

```bash
# Installer commit: 824464d1936be2aa97cf4bbd574f5f32cdf165ae
# Expected SHA-256: 9aa72c134bf739bebd6451e06884057a48fd2f0351176860a2703cc93743baa3
(
  set -e
  installer_dir="$(mktemp -d)"
  trap 'rm -rf "$installer_dir"' EXIT
  installer="$installer_dir/install.sh"
  backend="$installer_dir/install-openclaw.sh"
  unset NOOSPHERE_BACKEND_PATH NOOSPHERE_BACKEND_OVERRIDE_SHA256
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/824464d1936be2aa97cf4bbd574f5f32cdf165ae/install.sh -o "$installer"
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/824464d1936be2aa97cf4bbd574f5f32cdf165ae/install-openclaw.sh -o "$backend"
  printf '%s  %s\n' '9aa72c134bf739bebd6451e06884057a48fd2f0351176860a2703cc93743baa3' "$installer" | sha256sum -c -
  printf '%s  %s\n' '5269de0467b812a48a229afa23dde1d837078d0fd9937e11bb82a8d1d1675bb1' "$backend" | sha256sum -c -
  bash "$installer" --non-interactive --with kilocode
)
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```
