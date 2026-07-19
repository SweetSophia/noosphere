# OpenClaw Noosphere Official Plugin Setup

This guide documents the official OpenClaw-facing Noosphere install path: a local Noosphere Docker Compose runtime plus the `noosphere-memory` OpenClaw plugin.

The default install is intentionally local-only:

- Noosphere web app: `http://127.0.0.1:6578`
- App container port: `3000`
- PostgreSQL: Compose-internal only
- Redis: Compose-internal only, used for optional recall/search caching
- Runtime directory: `~/.noosphere`
- OpenClaw secret file: `~/.openclaw/secrets/noosphere-memory.json`

## Prerequisites

Install these on the machine running OpenClaw Gateway:

- Docker
- Docker Compose v2 (`docker compose`)
- Node.js 22+
- OpenClaw CLI
- `curl`
- `jq`, `sha256sum`, and `flock`

Verify:

```bash
docker --version
docker compose version
node --version
openclaw --version
curl --version
jq --version
sha256sum --version
flock --version
```

## Quick install

Use the installer from the repository:

```bash
# Installer commit: 2193e967fa0666ed208816ccf761bb1837fb6b92
# Expected SHA-256: c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/2193e967fa0666ed208816ccf761bb1837fb6b92/install-openclaw.sh -o "$installer"
printf '%s  %s\n' 'c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008' "$installer" | sha256sum -c -
bash "$installer" && rm -f "$installer"
```

The installer:

1. **Prompts for IP address selection** — detects available network interfaces (localhost, Tailscale, local network IPs) and lets you choose which address Noosphere will bind to. You can also select `0.0.0.0` (all interfaces) or enter a custom IP.
2. Creates `~/.noosphere/`.
3. Generates local secrets.
4. For an existing install, takes an exclusive operation lock and writes a fail-closed candidate Compose gate while the source container keeps running unchanged.
5. Runs the offline, restore-tested PostgreSQL image switch; candidate recreation remains blocked until the guard creates exact authorization.
6. For a new database, durably claims the still-absent named volume, creates it with provenance labels, then starts PostgreSQL and Redis on the rehearsed candidate.
7. Runs Prisma migrations through `docker/migrate-or-baseline.mjs`.
8. Runs repeatable bootstrap through `docker/bootstrap.mjs` using the same generated admin/API credentials that are later written to `.env` and OpenClaw secrets.
9. Finalizes new-install provenance before starting Noosphere (or validates completed switch evidence), then runs full deployment verification.
10. Writes `~/.openclaw/secrets/noosphere-memory.json`.
11. Installs or updates `noosphere-memory` in OpenClaw.
12. Patches OpenClaw config with the Noosphere base URL, API key secret reference, and `hooks.allowPromptInjection: true`.
13. Restarts OpenClaw Gateway when available.

> **Note:** The installer can still prompt when run through `curl | bash` by reading from `/dev/tty` if a controlling terminal is available. The interactive IP prompt is skipped when `APP_URL` is set, or when no interactive terminal is available (for example CI/cron/background automation). In non-interactive mode, the script auto-detects the best available IP (Tailscale > localhost). Set `APP_URL` beforehand to force a specific address in any mode.

A successful installer run prints these progress markers before the final summary banner:

```text
Applying database schema and bootstrap data...
Bootstrap completed successfully.
Installing OpenClaw plugin: ...
```

By default, the plugin line ends with `npm:@sweetsophia/openclaw-noosphere-memory`; it differs only when `NOOSPHERE_PLUGIN_SPEC` is overridden.

Verify after install. Use the exact Noosphere URL printed by the installer, or the `APP_URL` value you supplied, for the health check. For a default localhost install:

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
| `REDIS_URL` | `redis://redis:6379` | Redis connection string used inside Compose. Leave default for the bundled Redis service. |
| `PG_POOL_MAX` | `20` | Maximum application PostgreSQL pool size. |
| `PG_IDLE_TIMEOUT_MS` | `30000` | Idle PostgreSQL connection timeout. |
| `PG_CONN_TIMEOUT_MS` | `5000` | PostgreSQL connection timeout. |
| `NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE` | `120` | Per-process automatic-recall request limit. |
| `APP_URL` | `http://127.0.0.1:${NOOSPHERE_PORT}` | URL stored in Noosphere/OpenClaw config. When set, skips the interactive IP selection prompt. |
| `BIND_ADDRESS` | derived from `APP_URL` host (if a valid IP) or `127.0.0.1` | Docker port binding address. Set explicitly to override the derived value (e.g., `0.0.0.0` to bind all interfaces, or `127.0.0.1` to force localhost regardless of `APP_URL`). |
| `NOOSPHERE_ADMIN_PASSWORD_RESET` | `false` | Forwarded into the generated `.env`; set to `true` only when intentionally rotating an existing bootstrap admin password. |
| `NOOSPHERE_FORCE_ADMIN` | `false` | Forwarded into the generated `.env`; set to `true` to re-assert the ADMIN role on the existing bootstrap admin account without rotating its password. |
| `NOOSPHERE_BOOTSTRAP_SECRETS_FILE` | `/tmp/noosphere-bootstrap-secrets/secrets.json` | Container path where bootstrap writes any auto-generated admin/API credentials with mode `0600` inside a `0700` parent directory; logs include only this path, not the secret values. Use `/app/uploads/bootstrap-secrets/secrets.json` to persist the file in the uploads volume. Paths directly under shared directories such as `/tmp` or `/app/uploads` are rejected. |
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
repo="$PWD"
mkdir -p ~/.noosphere
cp docker-compose.noosphere.yml ~/.noosphere/docker-compose.yml
cp noosphere.env.example ~/.noosphere/.env
chmod 600 ~/.noosphere/.env
```

The candidate Compose file intentionally cannot start without guard-created
authorization evidence. If you do not want a repository checkout, use the
checksum-pinned installer instead of downloading and starting Compose directly.

Edit `~/.noosphere/.env` and set strong values for:

- `POSTGRES_PASSWORD`
- `POSTGRES_MIGRATION_PASSWORD`
- `POSTGRES_APP_PASSWORD`
- `NEXTAUTH_SECRET`
- `NOOSPHERE_ADMIN_PASSWORD`
- `NOOSPHERE_ADMIN_PASSWORD_RESET=true` only when intentionally rotating an existing admin password
- `NOOSPHERE_BOOTSTRAP_API_KEY`

Start and wait for health:

```bash
cd ~/.noosphere
mkdir -p backups/postgres-pgvector
chmod 700 backups/postgres-pgvector
guard=("$repo/scripts/switch-pgvector-compose.sh" --compose-file "$PWD/docker-compose.yml" \
  --env-file "$PWD/.env" --db-container noosphere-openclaw-db \
  --app-container noosphere-openclaw-app --backup-dir "$PWD/backups/postgres-pgvector")
"${guard[@]}" --prepare-new-install
docker compose pull
docker compose up -d db redis
docker compose run --rm -T init
"${guard[@]}" --record-new-install
docker compose up -d app
for i in {1..60}; do
  curl -fsS http://127.0.0.1:6578/api/health && break
  sleep 2
done
```

The guard creates an external `noosphere_postgres_authorization` volume and
binds its marker to the candidate and PostgreSQL data volume. The production
Compose template refuses PostgreSQL startup without that evidence. Its one-shot
`init` service waits for PostgreSQL, applies migrations, and runs bootstrap;
new-install evidence is finalized before the app service starts.
It also starts a Redis service for recall/search caching; if Redis is unavailable, Noosphere fails open and continues serving search from PostgreSQL.
The template pins the Compose project and persistent volume names (`noosphere_postgres_data`, `noosphere_uploads`, and `noosphere_redis_data`) so moving the Compose file between directories does not silently create a second empty database.

These manual start commands are for a new database volume. Before upgrading an existing PostgreSQL volume, use the guarded flow in [PostgreSQL pgvector Compose upgrade](POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md).

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
| `baseUrl` | `http://localhost:3000` | `http://127.0.0.1:6578` | Noosphere server base URL. Config wins; otherwise `OPENCLAW_NOOSPHERE_BASE_URL`, then `NOOSPHERE_BASE_URL`, then default. |
| `apiKey` | unset | file secret reference | Default API key. Used when no per-agent key matches. String, `{ value }`, or OpenClaw file secret reference. Env fallback is `OPENCLAW_NOOSPHERE_API_KEY`, then `NOOSPHERE_API_KEY`. Required for memory APIs. |
| `apiKeys` | unset | unset | Per-agent API key map `{ [agentId]: keyString }`. Takes precedence over `apiKey` for matching agents. Use env vars for secret keys (see below). |
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
| `memoryCaptureInstructionsEnabled` | `true` | default | Adds advisory guidance for when/how to call `noosphere_save`. Guidance remains available on successful clean misses even when recall returns no injectable prompt text; provider or malformed-response failures still fail open. |
| `memoryCaptureInstructions` | built-in text | default | Optional custom guidance override. |
| `allowDefaultCorpusSupplement` | `false` | unset | Registers the shared memory corpus supplement using the default API key. Keep false unless a default corpus key is intentionally scoped for all agents. Use a READ-only key with the narrowest shared `allowedScopes` when corpus search does not need writes. |
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
- **API keys are permission-scoped**. READ is enough for recall/get/topic lookup; WRITE is required for save; ADMIN is required for status/settings/admin operations.
- **Scoped saves stay scoped**. If a scoped WRITE key saves without `restrictedTags`, Noosphere applies the key's allowed scopes by default. Scoped keys cannot assign scopes they do not have.
- **Secrets live outside the repo**. The installer writes OpenClaw secrets to `~/.openclaw/secrets/noosphere-memory.json` and runtime values to `~/.noosphere/.env`.
- **Auto-recall fails open**. If Noosphere is unavailable, OpenClaw continues without injected memory.
- **`noosphere_save` creates draft candidates only**. It never auto-publishes curated knowledge.
- **Release tags are package-specific**. Use `v-openclaw-*` for `@sweetsophia/openclaw-noosphere-memory`, `v-opencode-*` for `@sweetsophia/opencode-noosphere-memory`, and `v-kilocode-*` for `@sweetsophia/kilocode-noosphere-memory`; add a new `v-{package}-*` CI prefix before introducing another package.
- **Injected-memory stripping is bundled-only**. `@sweetsophia/noosphere-injected-memory` is a private internal helper package. It is still built and packed in CI, but it is not published under its own npm tag because the OpenClaw plugin bundles it.
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

## Per-Agent API Keys

When multiple agents share the same OpenClaw plugin, each agent should use its own API key to avoid overwriting one another's credentials. The plugin routes keys automatically by agent ID.

### Key routing priority (highest to lowest)

1. **`NOOSPHERE_API_KEY_<AGENT_ID>`** — Environment variable. Recommended. Key stays secret (not in any config file).
2. **`apiKeys[agentId]`** — Config map. Plain text, visible in `openclaw.json`.
3. **`apiKey` / `OPENCLAW_NOOSPHERE_API_KEY` / `NOOSPHERE_API_KEY`** — Default fallback.

### Adding a new agent key (recommended method)

1. **Create a key** for the new agent in the Noosphere admin UI: `https://<host>/wiki/admin/keys`.
2. **Add an env var** to the OpenClaw gateway systemd service:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d/
cat >> ~/.config/systemd/user/openclaw-gateway.service.d/override.conf <<'EOF'
[Service]
Environment="NOOSPHERE_API_KEY_<AGENT_ID>=noo_newagentkey"
EOF
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway
```

Replace `<AGENT_ID>` with the agent's OpenClaw ID in **UPPERCASE**, hyphens → underscores (e.g., `cyberlogis` → `NOOSPHERE_API_KEY_CYBERLOGIS`).

### Verifying which key an agent is using

```bash
# Find the gateway PID
grep NOOSPHERE_API_KEY /proc/$(pgrep -f openclaw.*gateway | head -1)/environ

# Test a specific key
curl -s https://<host>/api/memory/status \
  -H "Authorization: Bearer noo_testkey"
```

### Upgrading from shared key to per-agent keys

1. Create individual keys for each agent via the admin UI.
2. Add each key as an env var in the systemd override (see above).
3. Remove the shared `apiKey` from `openclaw.json` plugin config (or keep it as the fallback).
4. Restart the gateway — agents immediately begin using their own keys.

## Upgrade

Use the guarded installer for upgrades as well as first-time setup:

```bash
# Installer commit: 2193e967fa0666ed208816ccf761bb1837fb6b92
# Expected SHA-256: c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/2193e967fa0666ed208816ccf761bb1837fb6b92/install-openclaw.sh -o "$installer"
printf '%s  %s\n' 'c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008' "$installer" | sha256sum -c -
bash "$installer" && rm -f "$installer"
openclaw noosphere doctor
```

Do not replace this with an unrestricted `docker compose pull && docker compose up`. The installer preserves the existing `.env`, proves backup restoration and exact source rollback with writers stopped, promotes the candidate database image only after invariants pass, then runs migration/bootstrap and deployment verification. Existing bootstrap admin accounts keep their current password unless `NOOSPHERE_ADMIN_PASSWORD_RESET=true`; `NOOSPHERE_FORCE_ADMIN=true` re-asserts the ADMIN role without rotating the password.

The complete source/candidate contract, repository-checkout procedure, evidence paths, and interrupted-run recovery are documented in [PostgreSQL pgvector Compose upgrade](POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md).
After an upgrade, verify the database volume identity before treating API key errors as key rotation:

```bash
docker inspect noosphere-openclaw-db \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
```

The expected value is `noosphere_postgres_data`.

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

### Auto-recall misses a memory that manual wording can find

The plugin sends cleaned user text to Noosphere; the memory article provider
searches articles with strict full-text matching first. If that strict query
returns no rows, the provider retries once with a bounded synonym fallback for
conversational wording gaps such as "photo" versus "portrait", or "avatar"
versus "profile".

If a memory still does not surface:

- add the user's natural wording as article text or tags
- keep important personal/context articles reviewed or published when they are
  no longer raw draft captures
- test both the original message and a short concept query with the
  `noosphere_recall` plugin tool to separate query extraction from article
  vocabulary

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

### Installer stops after bootstrap starts

If the installer returns to your shell immediately after this line:

```text
Applying database schema and bootstrap data...
```

then the install did not complete. A healthy run must continue with `Bootstrap completed successfully.` and `Installing OpenClaw plugin: ...`.

First use the reviewed installer revision and verify its checksum before execution:

```bash
# Installer commit: 2193e967fa0666ed208816ccf761bb1837fb6b92
# Expected SHA-256: c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/2193e967fa0666ed208816ccf761bb1837fb6b92/install-openclaw.sh -o "$installer"
printf '%s  %s\n' 'c4285dd9dd629feda3d4052115401f71841088014c2b275d3003a163fd1fe008' "$installer" | sha256sum -c -
bash "$installer" && rm -f "$installer"
```

The current installer protects `curl | bash` runs by redirecting the bootstrap container's stdin from `/dev/null`, so Docker Compose cannot consume the remaining installer script before app/plugin setup. If the issue persists, inspect the partial state before retrying:

```bash
docker ps -a --filter 'name=noosphere-openclaw'
ls -l ~/.noosphere/.env ~/.openclaw/secrets/noosphere-memory.json
cd ~/.noosphere
docker compose logs --tail 80 db
```

The installer prints bootstrap failure output directly before exiting. It also preserves `~/.noosphere/.env` before starting persistent containers, so reruns after bootstrap failures keep the original database password.

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


### App crashes with SASL authentication error after redeploy

Symptom: container logs show `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` or `password authentication failed`.

Cause: `DATABASE_URL` has an empty password because the `.env` file was not passed to `docker compose`.

Fix: Always use `--env-file ~/.noosphere/.env` when building or starting the app:

```bash
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env build app
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env up -d --no-deps --force-recreate app
```

### NEXTAUTH_SECRET lost or sessions broken

If sessions are invalid and users cannot log in, recover or regenerate the secret:

```bash
# Option 1: Re-run installer (preserves .env if it exists)
cd ~/github/noosphere && ./install-openclaw.sh

# Option 2: Generate new secret (invalidates all active sessions)
openssl rand -base64 32
# Edit ~/.noosphere/.env → NEXTAUTH_SECRET=<new-value> → redeploy
```

To get the current PostgreSQL password (still works even if app is down):
```bash
docker exec noosphere-db printenv POSTGRES_PASSWORD
```

### Docker build fails with ENOSPC (no space left)

```bash
docker system df
docker builder prune -a
docker image prune -a
```
