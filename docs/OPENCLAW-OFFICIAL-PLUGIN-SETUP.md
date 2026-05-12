# OpenClaw Noosphere Official Plugin Setup

This guide documents the official OpenClaw-facing Noosphere install path: a local Noosphere Docker Compose runtime plus the `noosphere-memory` OpenClaw plugin.

The default install is intentionally local-only:

- Noosphere web app: `http://127.0.0.1:6578`
- App container port: `3000`
- PostgreSQL: Compose-internal only
- Runtime directory: `~/.noosphere`
- OpenClaw secret file: `~/.openclaw/secrets/noosphere-memory.json`

## Prerequisites

Install these on the machine running OpenClaw Gateway:

- Docker
- Docker Compose v2 (`docker compose`)
- Node.js 22+
- OpenClaw CLI
- `curl`

Verify:

```bash
docker --version
docker compose version
node --version
openclaw --version
curl --version
```

## Quick install

Use the installer from the repository:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
```

The installer:

1. **Prompts for IP address selection** — detects available network interfaces (localhost, Tailscale, local network IPs) and lets you choose which address Noosphere will bind to. You can also select `0.0.0.0` (all interfaces) or enter a custom IP.
2. Creates `~/.noosphere/`.
3. Generates local secrets.
4. Writes a production `docker-compose.yml` using `ghcr.io/sweetsophia/noosphere`.
5. Starts PostgreSQL and Noosphere.
6. Runs Prisma migrations through `docker/migrate-or-baseline.mjs`.
7. Runs repeatable bootstrap through `docker/bootstrap.mjs` using the same generated admin/API credentials that are later written to `.env` and OpenClaw secrets.
8. Writes `~/.openclaw/secrets/noosphere-memory.json`.
9. Installs or updates `noosphere-memory` in OpenClaw.
10. Patches OpenClaw config with the Noosphere base URL, API key secret reference, and `hooks.allowPromptInjection: true`.
11. Restarts OpenClaw Gateway when available.

> **Note:** The interactive IP prompt is skipped in two cases: (1) when `APP_URL` is set as an environment variable, or (2) when the script is run non-interactively (e.g., piped via `curl | bash`, where stdin is not a TTY). In non-interactive mode, the script auto-detects the best available IP (Tailscale > localhost). Set `APP_URL` beforehand to force a specific address in either case.

Verify after install:

```bash
curl -fsS http://127.0.0.1:6578/api/health
openclaw noosphere doctor
openclaw noosphere status
openclaw plugins inspect noosphere-memory --runtime --json
```

## Installer options

Set these environment variables before running the installer when you need non-default behavior:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOOSPHERE_HOME` | `~/.noosphere` | Runtime directory for Compose files and `.env`. |
| `NOOSPHERE_PORT` | `6578` | Localhost port exposed by the app. |
| `NOOSPHERE_VERSION` | `latest` | GHCR image tag. |
| `NOOSPHERE_IMAGE` | `ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}` | Full image reference override. |
| `APP_URL` | `http://127.0.0.1:${NOOSPHERE_PORT}` | URL stored in Noosphere/OpenClaw config. When set, skips the interactive IP selection prompt. |
| `BIND_ADDRESS` | derived from `APP_URL` host (if a valid IP) or `127.0.0.1` | Docker port binding address. Set explicitly to override the derived value (e.g., `0.0.0.0` to bind all interfaces, or `127.0.0.1` to force localhost regardless of `APP_URL`). |
| `NOOSPHERE_PLUGIN_SPEC` | `npm:@sweetsophia/openclaw-noosphere-memory` | Plugin install spec. Useful for testing local tarballs. |
| `OPENCLAW_SECRETS_DIR` | `~/.openclaw/secrets` | OpenClaw secret directory. |
| `NOOSPHERE_SECRETS_FILE` | `${OPENCLAW_SECRETS_DIR}/noosphere-memory.json` | Secret file written by installer. |
| `NOOSPHERE_SECRET_PROVIDER_ID` | `noosphere-memory` | OpenClaw secret provider ID used in config. |

By default the installer enables Noosphere auto-recall for all OpenClaw agents and chat types (`autoRecall: true`, `hooks.allowPromptInjection: true`, no agent/chat allowlist). Restrict or disable this after install if you do not want global prompt injection.

Example using a pinned image tag and custom port:

```bash
NOOSPHERE_VERSION=v1.3.0 \
NOOSPHERE_PORT=6678 \
APP_URL=http://127.0.0.1:6678 \
bash install-openclaw.sh
```

## OpenClaw CLI helpers

After the plugin is installed, OpenClaw exposes:

```bash
openclaw noosphere status
openclaw noosphere doctor
openclaw noosphere logs [service]
openclaw noosphere setup
openclaw noosphere upgrade
```

Command behavior:

| Command | Behavior |
| --- | --- |
| `status` | Checks `/api/health` and authenticated `/api/memory/status`. Exits non-zero if the integration is unusable. |
| `doctor` | Audits base URL, API key, auto-recall config, `allowPromptInjection`, Noosphere health, memory status, and DB auto-recall setting. |
| `logs [service]` | Prints the Docker Compose logs command to run manually. It does not execute Docker from the plugin. |
| `setup` | Prints the recommended installer command. |
| `upgrade` | Prints the recommended upgrade flow. |

The plugin intentionally avoids shell execution. Docker/log operations are guidance-only so the third-party plugin package stays within OpenClaw package safety policy.

## Manual Docker Compose install

Use this when you want to run Noosphere yourself instead of using the installer. Run these commands from a Noosphere repository checkout:

```bash
git clone https://github.com/SweetSophia/noosphere.git
cd noosphere
mkdir -p ~/.noosphere
cp docker-compose.noosphere.yml ~/.noosphere/docker-compose.yml
cp noosphere.env.example ~/.noosphere/.env
chmod 600 ~/.noosphere/.env
```

If you do not want a checkout, download the two files directly:

```bash
mkdir -p ~/.noosphere
curl -fsSLo ~/.noosphere/docker-compose.yml https://raw.githubusercontent.com/SweetSophia/noosphere/master/docker-compose.noosphere.yml
curl -fsSLo ~/.noosphere/.env https://raw.githubusercontent.com/SweetSophia/noosphere/master/noosphere.env.example
chmod 600 ~/.noosphere/.env
```

Edit `~/.noosphere/.env` and set strong values for:

- `POSTGRES_PASSWORD`
- `NEXTAUTH_SECRET`
- `NOOSPHERE_ADMIN_PASSWORD`
- `NOOSPHERE_BOOTSTRAP_API_KEY`

Start and wait for health:

```bash
cd ~/.noosphere
docker compose pull
docker compose up -d
for i in {1..60}; do
  curl -fsS http://127.0.0.1:6578/api/health && break
  sleep 2
done
```

The production Compose template includes a one-shot `init` service. It waits for PostgreSQL, applies migrations, runs bootstrap, then allows the app service to start.

## Manual OpenClaw plugin install

Install the plugin package:

```bash
openclaw plugins install npm:@sweetsophia/openclaw-noosphere-memory
```

Create an OpenClaw secret file. Use an ADMIN-scoped Noosphere API key when you want `openclaw noosphere doctor` and `openclaw noosphere status` to pass; READ/WRITE-only keys can still work for narrower recall/save tools but will fail authenticated status checks. Do not paste real API keys into shared docs or commits:

```bash
mkdir -p ~/.openclaw/secrets
chmod 700 ~/.openclaw/secrets
cat > ~/.openclaw/secrets/noosphere-memory.json <<'JSON'
{
  "baseUrl": "http://127.0.0.1:6578",
  "apiKey": "REPLACE_WITH_NOOSPHERE_API_KEY"
}
JSON
chmod 600 ~/.openclaw/secrets/noosphere-memory.json
```

Patch OpenClaw config:

```bash
cat > /tmp/noosphere-openclaw-patch.json5 <<'JSON5'
{
  secrets: {
    providers: {
      noosphereMemory: {
        source: "file",
        path: "~/.openclaw/secrets/noosphere-memory.json",
        mode: "json",
      },
    },
  },
  plugins: {
    entries: {
      "noosphere-memory": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:6578",
          apiKey: { source: "file", provider: "noosphereMemory", id: "/apiKey" },
          autoRecall: true,
          autoProviders: ["noosphere"],
          maxInjectedMemories: 10,
          maxInjectedTokens: 1000,
          recallInjectionPosition: "system-prepend",
          autoRecallTimeoutMs: 5000,
        },
        hooks: {
          allowPromptInjection: true,
        },
      },
    },
  },
}
JSON5
openclaw config patch --file /tmp/noosphere-openclaw-patch.json5
openclaw gateway restart
```

Verify:

```bash
openclaw noosphere doctor
openclaw noosphere status
```

## Plugin configuration fields

This is the canonical operator-facing field reference. "Plugin default" is the
value used by the plugin when no config is supplied. "Installer value" is what
`install-openclaw.sh` writes for the official local setup path.

| Field | Plugin default | Installer value | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `http://localhost:3000` | `http://127.0.0.1:6578` | Noosphere server base URL. |
| `apiKey` | unset | file secret reference | String, `{ value }`, or OpenClaw file secret reference. Required for memory APIs. |
| `timeoutMs` | `5000` | default | Explicit HTTP request timeout. Max `30000`. |
| `autoRecall` | `false` | `true` | Enables `before_prompt_build` recall injection. |
| `autoProviders` | `["noosphere"]` | `["noosphere"]` | Providers requested from Noosphere auto recall. |
| `maxInjectedMemories` | `5` | `10` | Auto-recall result cap. Max `10`. |
| `maxInjectedTokens` | `1200` | `1000` | Auto-recall token budget. Max `2000`. |
| `recallInjectionPosition` | `prepend` | `system-prepend` | `prepend`, `system-prepend`, or `system-append`. |
| `autoRecallTimeoutMs` | `1500` | `5000` | Per-prompt auto-recall timeout. Max `5000`. Fails open. |
| `minQueryLength` | `8` | default | Skip auto-recall for shorter composed queries. |
| `enabledAgents` | `[]` | unset | Optional agent allowlist. Empty/unset means all agents. |
| `allowedChatTypes` | `[]` | unset | Optional chat/provider allowlist. Empty/unset means all chat types. |
| `includeRecentTurns` | `true` | default | Include recent user turns in the recall query. |
| `recentTurnLimit` | `4` | default | Recent turn cap. Max `10`. |
| `memoryCaptureInstructionsEnabled` | `true` | default | Adds guidance for when/how to call `noosphere_save` only when auto-recall succeeds and returns non-empty prompt text. |
| `memoryCaptureInstructions` | built-in text | default | Optional custom guidance override. |
| `ignoreSessionPatterns` | `[]` | unset | Glob patterns for sessions to skip. |
| `statelessSessionPatterns` | `[]` | unset | Glob patterns for stateless sessions. |
| `skipStatelessSessions` | `true` | default | Skip sessions matching stateless patterns. |

Important hook setting:

```json
{
  "plugins": {
    "entries": {
      "noosphere-memory": {
        "hooks": {
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

Without `hooks.allowPromptInjection: true`, tools still work, but auto-recall and
memory capture instructions are not injected into prompts.

## Security model

- **Localhost by default**: Compose binds the app to `127.0.0.1:${NOOSPHERE_PORT:-6578}`.
- **PostgreSQL is not exposed publicly** in the production Compose template.
- **API keys are permission-scoped**. READ is enough for recall/get; WRITE is required for save; ADMIN is required for status/settings/admin operations.
- **Secrets live outside the repo**. The installer writes OpenClaw secrets to `~/.openclaw/secrets/noosphere-memory.json` and runtime values to `~/.noosphere/.env`.
- **Auto-recall fails open**. If Noosphere is unavailable, OpenClaw continues without injected memory.
- **`noosphere_save` creates draft candidates only**. It never auto-publishes curated knowledge.
- **Prompt injection is explicit but broad by default in the installer**. OpenClaw requires `hooks.allowPromptInjection: true` before plugin hook text can enter the prompt; the installer enables it with no `enabledAgents` or `allowedChatTypes` allowlist.

## Restricting auto-recall scope

The installer opts all agents/chats into Noosphere auto-recall. To limit injection, patch the plugin config with `enabledAgents` and/or `allowedChatTypes`, or set `autoRecall: false` while keeping explicit tools enabled.

Example:

```json
{
  "plugins": {
    "entries": {
      "noosphere-memory": {
        "config": {
          "autoRecall": true,
          "enabledAgents": ["main", "cylena"],
          "allowedChatTypes": ["direct"]
        },
        "hooks": {
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

## Hindsight coexistence

- **Conservative mode**: keep Noosphere auto-recall scoped to `autoProviders: ["noosphere"]`. Hindsight, if installed, continues to manage its own recall/injection separately.
- **Coordinated mode**: disable Hindsight auto-recall and configure Noosphere to orchestrate both providers with `autoProviders: ["noosphere", "hindsight"]`. Use this only when the Noosphere server has a configured Hindsight provider and you want a single unified recall block.

Avoid enabling two independent broad prompt-injection systems without understanding the resulting token and duplication behavior.

## Upgrade

Recommended flow:

```bash
cd ~/.noosphere
docker compose pull
docker compose up -d
openclaw plugins update noosphere-memory
openclaw noosphere doctor
```

The Compose `init` service runs migration/bootstrap logic before app startup. Bootstrap is repeatable and preserves article/topic content, but it reconciles the bootstrap admin account: it may reset that account's name/password to the values in `.env`, and `NOOSPHERE_FORCE_ADMIN=true` can force its role back to ADMIN.

## Uninstall

Disable or remove the plugin:

```bash
openclaw plugins disable noosphere-memory
# or, when you want to remove the installed package:
openclaw plugins uninstall noosphere-memory
openclaw gateway restart
```

Stop Noosphere while preserving data:

```bash
cd ~/.noosphere
docker compose down
```

Remove runtime files and data only when you are sure you no longer need them. If you want to delete Compose volumes, do that before removing `~/.noosphere` so Docker can still read the Compose project:

```bash
cd ~/.noosphere
# DANGER: deletes Postgres/uploads volumes for this Compose project
docker compose down -v
cd ~
rm -f ~/.openclaw/secrets/noosphere-memory.json
rm -rf ~/.noosphere
```

## Troubleshooting

### Tools work but auto-recall does not inject

Check:

```bash
openclaw noosphere doctor
```

The usual cause is missing hook permission:

```json
"hooks": {
  "allowPromptInjection": true
}
```

Restart Gateway after changing config:

```bash
openclaw gateway restart
```

### Noosphere is unreachable

Check health and containers:

```bash
curl -fsS http://127.0.0.1:6578/api/health
cd ~/.noosphere
docker compose ps
docker compose logs --tail 80 app
```

### API key failures

Run:

```bash
openclaw noosphere doctor --json
```

Then verify the configured secret file exists, has restrictive permissions, and contains the expected JSON keys without printing values:

```bash
test -f ~/.openclaw/secrets/noosphere-memory.json
stat -c '%a %n' ~/.openclaw/secrets/noosphere-memory.json
node -e 'const fs=require("fs"); const p=process.env.HOME+"/.openclaw/secrets/noosphere-memory.json"; const j=JSON.parse(fs.readFileSync(p,"utf8")); for (const k of ["baseUrl","apiKey"]) console.log(`${k}: ${typeof j[k] === "string" && j[k] ? "present" : "missing"}`)'
```

Do not paste real keys or full secret files into issue comments, chats, terminal transcripts, or commits.

### Plugin installed but CLI commands are missing

Check package/runtime registration:

```bash
openclaw plugins inspect noosphere-memory --runtime --json
openclaw noosphere --help
```

If the package is stale:

```bash
openclaw plugins update noosphere-memory
openclaw gateway restart
```

### Port conflict

Choose a different local port:

```bash
NOOSPHERE_PORT=6678 APP_URL=http://127.0.0.1:6678 bash install-openclaw.sh
```

Or edit `~/.noosphere/.env`, then restart Compose.
