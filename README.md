# Noosphere

> A universal memory and knowledge layer for AI agents — structured enough for automation, readable enough for humans.

Noosphere started as an agent-authored wiki. It is now also a provider-agnostic memory system for recall orchestration, conflict handling, promotion/backfill, and local memory scheduling.

> [!IMPORTANT]
> Agents can use Noosphere to store durable project knowledge, retrieve relevant context, synthesize articles from research, and promote frequently reused memories over time. **Humans can browse and edit the same knowledge through a responsive web UI**, export/import Markdown vaults, and sync with Obsidian.

<o **OpenClaw, Hermes Agent, Opencode, and Kilo Code support via plugins. Universal Support via API.** o>  

<img width="1536" height="1024" alt="noosphere-memory-system-explanation-overview" src="https://github.com/user-attachments/assets/f7cdb553-6d4d-4d7b-b3e3-741ecc59b8e3" />

# Quick Installation Guides:
**Prerequisites:** [Getting Started](#prerequisites)  
**Install for OpenClaw:** [OpenClaw](#openclaw-integration)  
**Install for Hermes Agent:** [Hermes Agent](#hermes-agent-integration)  
**Install for OpenCode and oh my opencode slim:** [OpenCode and OMOS](#opencode-integration)  
**Install for KiloCode:** [KiloCode](https://github.com/SweetSophia/noosphere#kilo-code-integration)  
**API for all systems without plugins:** [Universal API Integration](https://github.com/SweetSophia/noosphere#setup)

**Optional new Speed Boost Redis Cache:** [Redis Cache](#redis-recall-cache-add-on)

---

## Core Memory Features

| Feature | **Noosphere** | **Hindsight** | **QMD** | **memU** | **mem0** | **LanceDB Pro** |
|---|---|---|---|---|---|---|
| **Auto-Capture** | ✅ Bundled capture guidance + ingest API + backfill | ✅ Every turn | ❌ Manual indexing | ✅ Continuous learning | ✅ `memory.add()` | ✅ Smart extraction |
| **Auto-Recall** | ✅ Hook injection with dual-block (memory capture guidance + recall results) | ✅ Before each turn | ✅ Keyword search only | ✅ Proactive context loading | ✅ `memory.search()` | ✅ Before prompt build |
| **Manual Recall** | ✅ REST API + tools | ✅ MCP tools | ✅ CLI / tool query | ✅ REST API | ✅ SDK + REST | ✅ CLI + MCP tools |
| **Semantic Search** | ✅ PostgreSQL FTS (live) + vector (planned) + Redis recall cache | ✅ Vector + biomimetic | ⚠️ Keyword + pending vector | ✅ pgvector | ✅ Semantic + BM25 + entity fusion | ✅ Vector + BM25 hybrid |
| **Keyword Search** | ✅ PostgreSQL full-text | ✅ | ✅ Primary mode | ✅ | ✅ BM25 | ✅ BM25 |
| **Cross-Encoder Rerank** | ❌ (planned) | ❌ | ❌ | ❌ | ❌ | ✅ Cross-encoder |
| **Memory Types** | Articles (wiki) | world / experience / observation | Markdown files | Categories / Items / Resources | Facts (ADD-only v3) | 6-category classification |
| **Image Storing** | ✅ Image Article Support | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Curation Levels** | ✅ ephemeral → managed → curated | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Confidence Scoring** | ✅ low / medium / high | ❌ | ❌ | ❌ | ❌ | ❌ (decay model) |
| **Status Lifecycle** | ✅ draft → reviewed → published | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## What Noosphere Is For

Noosphere is useful when an AI system needs memory that is more durable and inspectable than a chat transcript.

Use it for:

- **Agent memory** — durable project facts, decisions, workflows, and learned patterns.
- **Automatic recall** — provider fan-out, ranking, deduplication, conflict resolution, and token-bounded prompt injection.
- **Human-readable knowledge** — wiki articles organized by topics, tags, relations, confidence, and status.
- **Research synthesis** — save answers or ingest external material into structured articles.
- **Memory promotion** — identify repeatedly useful ephemeral memories and promote them toward managed/curated knowledge.
- **Historical backfill** — synthesize older memory material into wiki articles with retryable jobs.
- **Local automation** — run memory maintenance jobs with the built-in scheduler.
- **Obsidian workflows** — export/import Markdown vaults and sync with an Obsidian-friendly structure.

## Harness / Agent System integration and plugins

Currently implemented: 
- **Openclaw plug-in** (Multiagent support, auto-recall and more)
- **Hermes Agent plug-in**
- **Opencode plug-in**
- **Kilo Code plug-in**

## Current Status

The universal memory MVP is feature-complete in the core Noosphere codebase.

Implemented memory modules:

- Provider abstraction for multiple recall sources.
- Noosphere article-backed memory provider.
- Hindsight HTTP recall provider.
- Recall orchestrator with concurrent provider fan-out.
- Composite ranking using relevance, confidence, recency, and curation.
- Cross-provider deduplication.
- Conflict detection and configurable resolution strategies.
- Context budget manager for prompt-safe recall blocks.
- Recall settings and conflict threshold configuration.
- Promotion candidate scoring and review lifecycle.
- Backfill/synthesis job lifecycle with retry support.
- Local scheduler baseline for memory jobs.
- Architecture documentation in [`docs/NOOSPHERE-MEMORY-ARCHITECTURE.md`](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md).

The OpenClaw plugin/skill bridge is implemented and ships in this repository at `openclaw-noosphere-memory/`. It provides explicit tools, optional auto-recall prompt injection, and memory corpus supplement wiring.

The Opencode plugin ships in this repository at `opencode-noosphere-memory/`. It provides prompt-time auto-recall through Opencode's `chat.message` hook, optional idle auto-save through `session.idle`, and explicit tools for status, recall, topic lookup, and draft memory saving. It is also compatible with `oh-my-opencode-slim`, which runs as a second Opencode plugin in the same `~/.config/opencode/opencode.json` plugin array.

The Kilo Code plugin ships in this repository at `kilocode-noosphere-memory/`. It mirrors the Opencode integration for Kilo's current plugin runtime with prompt-time auto-recall, optional idle auto-save, and explicit Noosphere tools.

Frontpage | Logging
:---:|:---:
<img width="350" height="443" alt="noosphere_start" src="https://github.com/user-attachments/assets/436560a3-1612-47cf-bcbf-f9300f28a7f5" /> | <img width="350" height="380" alt="noosphere_log" src="https://github.com/user-attachments/assets/ceb07a54-f622-4ed8-82a0-a508f4ddfa5d" />


## Feature Overview

### For Agents and Integrations

- **Write articles** through REST API with API key authentication.
- **Update articles** with PATCH support and revision tracking.
- **Ingest external sources** into multiple structured articles in one request.
- **Save synthesized answers** as durable wiki articles.
- **Search articles** using PostgreSQL full-text search with filters.
- **Traverse the wiki graph** by topic, tag, and article relations.
- **Run health checks** for stale content, orphans, and missing metadata.
- **Export/import** Markdown vault archives.
- **Use memory providers** through a normalized `MemoryProvider` interface.
- **Compose recall** across Noosphere, Hindsight, and future providers.
- **Generate prompt-ready recall blocks** with token/result budgets.
- **Bundled memory capture instructions** — auto-injected guidance telling agents when/how to use `noosphere_save`; no manual policy files needed.
- **Track promotion candidates** from repeated recall use.
- **Create backfill jobs** to synthesize curated articles from historical material.
- **Run scheduled memory jobs** locally via `npm run memory:scheduler`.
- **Images Support** agents can add images to articles

### For Humans

- **Browse topics** with unlimited-depth hierarchy.
- **Read articles** rendered from Markdown with code highlighting and tables.
- **Edit articles** in a Markdown editor with preview.
- **Review revision history** for changed articles.
- **Soft-delete and restore** articles from trash.
- **Use tags** for cross-cutting subjects.
- **Privacy lock icons** on restricted articles; only users with matching access scopes can view them.
- **Upload images** for embedded article media.
- **Search the wiki** by text, topic, tag, status, and confidence.
- **View activity logs** for create/update/delete/ingest/lint events.
- **Manage API keys** from the admin interface.
- **Scoped API keys** — assign per-key allowed scopes (e.g. `financial`, `health`) that control access to restricted articles.
- **Restricted articles** — tag articles with scopes to restrict access; unauthenticated web users and scoped API keys see only allowed content.
- **Sync/export** content for Obsidian and Markdown workflows.
- **Reverse Markdown scan** — inspect vault-side Markdown edits before later import/apply phases.
- **Images Support** you can add images to articles

## Getting Started

### Prerequisites

- Docker + Docker Compose
- Node.js 22+ for local development

### Setup for non-plugin systems

```bash
git clone https://github.com/SweetSophia/noosphere.git
cd noosphere

cp .env.example .env

# Generate secrets for .env
openssl rand -hex 32  # NEXTAUTH_SECRET
openssl rand -hex 32  # POSTGRES_PASSWORD
# Optional for non-Compose deployments; Compose includes Redis automatically
# REDIS_URL=redis://localhost:6379

docker compose up -d
# Navigate to http://localhost:6578/wiki in your browser.
```

### Create an Admin Account

```bash
docker compose exec app node scripts/create-admin.js
```

Then visit `/wiki/login`.


### Official Docker Compose image

For the published image flow, use the GHCR image directly:

```bash
docker pull ghcr.io/sweetsophia/noosphere:latest
```

Then copy `noosphere.env.example` next to the production Compose template and set strong secrets before starting:

```bash
cp noosphere.env.example .env
# edit .env: POSTGRES_PASSWORD, NEXTAUTH_SECRET, NOOSPHERE_ADMIN_PASSWORD, NOOSPHERE_BOOTSTRAP_API_KEY
docker compose -f docker-compose.noosphere.yml up -d
```

The production Compose template runs `ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION:-latest}` and exposes the app on `http://127.0.0.1:6578` by default. Override `NOOSPHERE_PORT`, `BIND_ADDRESS`, or `APP_URL` in `.env` when you need a different network binding.

The production Compose template includes a one-shot `init` service. It waits for Postgres, applies Prisma migrations with `docker/migrate-or-baseline.mjs`, bootstraps the admin/API key/topics, and only then lets the app start. This prevents `/api/health` from reporting healthy before the schema exists.

Database ports differ by caller:

- App container: `db:5432` on the internal Compose network.
- Host/local Prisma CLI: `localhost:5433` when using the development Compose mapping.

### Local Development

```bash
npm install
cp .env.example .env
# Update your local .env before starting:
# - DATABASE_URL should use the Postgres host port exposed by Docker Compose:
#   DATABASE_URL="postgresql://noosphere:YOUR_POSTGRES_PASSWORD@localhost:5433/noosphere"
# - Set NEXTAUTH_SECRET.
# - Set NEXTAUTH_URL="http://localhost:6578".
# - Set APP_URL="http://localhost:6578".
# - Set POSTGRES_PASSWORD.

docker compose up db -d
npx prisma migrate dev
PORT=6578 npm run dev
```

## Agent API Reference

Base URL: `http://localhost:6578/api`

Auth header:

```text
Authorization: Bearer <api_key>
```

### Articles

```bash
# Create article
POST /api/articles
# { title, slug, content, topicId, tags?, excerpt?, confidence?, status?, restrictedTags? }

# Update article
PATCH /api/articles/:id
# { title?, slug?, content?, topicId?, tags?, excerpt?, confidence?, status?, lastReviewed?, restrictedTags? }

# List/search articles
GET /api/articles?q=search&topic=slug&tag=tag&status=draft&confidence=high

# Get topics
GET /api/topics

# Human article route
GET /wiki/{topicSlug}/{articleSlug}
```

### Ingest and Save

```bash
# Bulk ingest from an external source
POST /api/ingest
# { source: { type: "url", url: "...", title: "..." }, articles: [...], tags?: [...], authorName?: "AgentName" }

# Save a synthesized answer as an article
POST /api/answer
# { title, content, topicId, tags?, excerpt?, sourceQuery?, confidence?, status? }
```

### Maintenance and Graph

```bash
# Wiki health check
POST /api/lint

# Activity log
GET /api/log?type=ingest&author=AgentName

# Wiki graph
GET /api/graph

# Service health
GET /api/health
```

### Export and Import

```bash
# Export all articles as a Markdown vault zip
GET /api/export

# Import from a Markdown vault zip
POST /api/import
# multipart form fields: file, defaultTopicSlug?, overwrite?

# Scan the configured Obsidian vault for reverse-import candidates.
# Read-only; requires ADMIN.
POST /api/sync/import-scan
# JSON body: includeUntracked?, maxFiles?
```

Export, import, and Obsidian sync share the same versioned frontmatter codec in
`src/lib/markdown/noosphere-markdown.ts`, including `noosphere.schemaVersion`,
`noosphere.contentHash`, topic metadata, tags, and restricted scopes.
The reverse import scanner compares tracked vault files against
`.noosphere-sync/manifest.json` and reports `modified`, `missing`,
`baseline-missing`, and `untracked` candidates without writing to the database
or filesystem.

## Memory Module API

The memory layer is exposed in two ways:

### TypeScript modules (for custom integrations)

Exposed from `src/lib/memory` via `@/lib/memory`:

```ts
import {
  createNoosphereProvider,
  createHindsightProvider,
  createRecallOrchestrator,
  createContextBudgetManager,
  createDeduplicator,
  createConflictResolver,
  scanForCandidates,
  recordRecall,
  createSynthesisJob,
  synthesize,
  createLocalMemoryScheduler,
} from "@/lib/memory";
```

Validation commands:

```bash
npm run test:memory
npm run test:scheduler
npx tsc --noEmit
```

### HTTP API (for agents and OpenClaw plugins)

Base URL: `http://localhost:6578/api`
Auth: `Authorization: Bearer <api_key>`

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/memory/status` | GET | Provider and settings overview |
| `/api/memory/recall` | POST | Multi-provider recall with ranking/dedup/conflict/budget |
| `/api/memory/get` | POST | Direct lookup by ID or canonical ref |
| `/api/memory/save` | POST | Save a memory candidate (draft only, never auto-publishes) |

Example recall request:

```bash
curl -s -X POST http://localhost:6578/api/memory/recall \
  -H "Authorization: Bearer noo_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "pk-pro database schema", "mode": "auto", "resultCap": 5}'
```

Example memory get:

```bash
curl -s -X POST http://localhost:6578/api/memory/get \
  -H "Authorization: Bearer noo_..." \
  -H "Content-Type: application/json" \
  -d '{"canonicalRef": "noosphere:article:abc123"}'
```

Example memory save:

```bash
curl -s -X POST http://localhost:6578/api/memory/save \
  -H "Authorization: Bearer noo_..." \
  -H "Content-Type: application/json" \
  -d '{"title": "PK-PRO Database Schema", "content": "...", "topicId": "...", "tags": ["pk-pro"]}'
```

## Web Routes

| Route | Description |
| --- | --- |
| `/wiki` | Home: topics and recently updated articles |
| `/wiki/login` | Human login |
| `/wiki/{topicSlug}` | Topic article list |
| `/wiki/{topicSlug}/{articleSlug}` | Article view |
| `/wiki/{topicSlug}/{articleSlug}/edit` | Edit article |
| `/wiki/{topicSlug}/{articleSlug}/history` | Revision history |
| `/wiki/{topicSlug}/new` | Create article in topic |
| `/wiki/search?q=keyword` | Full-text search |
| `/wiki/admin/keys` | Manage API keys |
| `/wiki/admin/scopes` | Manage access scopes |
| `/wiki/admin/log` | Activity timeline |
| `/wiki/admin/trash` | Soft-deleted articles |

## OpenClaw Integration

Noosphere ships an OpenClaw plugin at `openclaw-noosphere-memory/` and an official local Docker Compose install path for OpenClaw users.

For the full setup, operations, troubleshooting, upgrade, and uninstall guide, see:

- [`docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md)

### Quick install

On the machine running OpenClaw Gateway:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
openclaw noosphere doctor
openclaw noosphere status
```

In an interactive terminal, the installer asks which IP address Noosphere should bind to and prints the resulting URL. Choose `127.0.0.1` for a local-only install, or another network address (e.g., from Tailscale or your LAN) when OpenClaw and browsers need to reach Noosphere over that interface. For non-interactive installs, set `APP_URL` and `BIND_ADDRESS` explicitly when you need deterministic network binding.

A healthy run reaches these markers before the final summary banner:

```text
Applying database schema and bootstrap data...
Bootstrap completed successfully.
Installing OpenClaw plugin: ...
```

Default runtime locations:

- Runtime directory: `~/.noosphere`
- OpenClaw secret file: `~/.openclaw/secrets/noosphere-memory.json`
- Docker image: `ghcr.io/sweetsophia/noosphere:latest`
- Default port: `6578`
- Redis: bundled Compose service for recall/search cache acceleration

### Plugin capabilities

**Explicit tools:**

| Tool | Permission | Description |
| --- | --- | --- |
| `noosphere_status` | ADMIN | Health check: providers, settings, capabilities |
| `noosphere_recall` | READ | Multi-provider recall query in `auto` or `inspection` mode |
| `noosphere_get` | READ | Direct lookup by provider/id or canonical ref |
| `noosphere_save` | WRITE | Save a draft memory candidate; never auto-publishes |
| `noosphere_topics` | READ | List all topics in hierarchical tree form; use to find topic IDs before creating articles |
| `noosphere_topic_create` | ADMIN | Create a topic or subtopic when a target topic does not exist yet |
| `noosphere_article_create` | WRITE | Create a curated wiki article directly (published by default); strips injected memory blocks, validates content bounds, and handles Unicode/non-ASCII titles |

**Auto-injection:**

When `autoRecall: true`, OpenClaw permits hook injection, and recall returns non-empty prompt text, the plugin's `before_prompt_build` hook can inject:

1. `<noosphere_memory_capture>` — guidance telling agents when/how to call `noosphere_save`.
2. `<noosphere_auto_recall>` — ranked, deduplicated, conflict-resolved recall results within budget.

Important: OpenClaw requires this hook permission before any prompt text can be injected:

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

Without `hooks.allowPromptInjection: true`, explicit tools still work, but auto-recall and memory capture instructions will not appear in agent context.

**Memory corpus supplement:**

The plugin registers a Noosphere memory corpus supplement so OpenClaw shared memory flows can query Noosphere content through the unified memory interface.

**OpenClaw CLI helpers:**

The plugin registers `openclaw noosphere ...` helpers for status, diagnostics, logs guidance, setup guidance, and upgrade guidance. See the setup guide for the canonical command reference.

### Safety properties

- Default Docker Compose binding is localhost-only: `127.0.0.1:6578`.
- PostgreSQL stays internal to the production Compose network.
- API keys are permission-scoped; READ/WRITE/ADMIN are used for different actions.
- WRITE keys with specific scopes (e.g. `financial`) can only create or move articles into those scopes.
- Wildcard `*` scope grants full admin access to all content regardless of restrictions.
- Secrets are stored outside the repo in OpenClaw secret files and `~/.noosphere/.env`.
- Auto-recall fails open when Noosphere is unreachable.
- The installer enables broad prompt injection by default (`autoRecall: true`, `allowPromptInjection: true`, no agent/chat allowlist); restrict it with `enabledAgents`/`allowedChatTypes` if needed.
- `noosphere_save` creates draft candidates only.

## Hermes Agent Integration

Noosphere ships a Hermes Agent memory provider at `hermes-noosphere-memory/`. It is a first-class Hermes `MemoryProvider`, not a generic tool plugin.

### Quick install

From a cloned Noosphere repository:

```bash
cd hermes-noosphere-memory
./install-hermes.sh
```

The installer copies the provider to `$HERMES_HOME/plugins/noosphere` and installs a Hermes setup skill at `$HERMES_HOME/skills/noosphere-memory-hermes`. With that skill available, a user can give Hermes a Noosphere API key and ask it to connect Noosphere memory; the skill guides Hermes through writing `.env`, updating `noosphere.json`, activating the provider, and verifying the setup.

Manual setup:

```bash
mkdir -p "$HERMES_HOME/plugins"
cp -R plugins/memory/noosphere "$HERMES_HOME/plugins/noosphere"
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
```

Then create or edit `$HERMES_HOME/noosphere.json`:

```json
{
  "base_url": "http://127.0.0.1:6578",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 15.0
}
```

### Hermes capabilities

| Capability | Status | Description |
| --- | --- | --- |
| `noosphere_status` | Implemented | Checks `GET /api/memory/status`, with `/api/health` fallback for scoped non-admin keys. |
| `noosphere_recall` | Implemented | Calls Noosphere recall in inspection mode. |
| `noosphere_get` | Implemented | Fetches one memory by canonical ref or provider/id. |
| `noosphere_topics` | Implemented | Lists topics for save target selection. |
| `noosphere_save` | Implemented | Saves draft memory candidates; never auto-publishes. |
| Auto recall | Implemented | Uses Hermes `prefetch()` and Noosphere's prompt-ready recall text. |
| Explicit memory mirroring | Implemented | Mirrors Hermes `on_memory_write(add, ...)` when `topic_id` is configured. |
| Broad turn capture | Opt-in | Requires `auto_capture: true` and `topic_id`; default is disabled. |

Use a scoped Noosphere API key for each Hermes profile. Scoped keys control which restricted articles the provider can read and where it can write. On machines with multiple Noosphere integrations, prefer `HERMES_NOOSPHERE_API_KEY`; the generic `NOOSPHERE_API_KEY` remains a compatibility fallback.

## Opencode Integration

Noosphere ships an Opencode plugin at `opencode-noosphere-memory/`.

### Quick install

Add the package to `~/.config/opencode/opencode.json`. Opencode can auto-install
scoped npm plugins from this config:

```json
{
  "plugin": [
    "@sweetsophia/opencode-noosphere-memory"
  ]
}
```

Optional explicit global install:

```bash
npm install -g @sweetsophia/opencode-noosphere-memory
export OPENCODE_NOOSPHERE_API_KEY="noo_..."
```

If you use [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim),
install it normally and keep both Opencode plugins registered:

```json
{
  "plugin": [
    "oh-my-opencode-slim",
    "@sweetsophia/opencode-noosphere-memory"
  ]
}
```

`oh-my-opencode-slim` manages its own agent configuration in
`~/.config/opencode/oh-my-opencode-slim.json`; Noosphere keeps using
`OPENCODE_NOOSPHERE_*` environment variables and the same `noosphere_*` tools.
Opencode can auto-install the scoped npm plugin from this config; a global npm
install is optional.

### Opencode capabilities

| Capability | Status | Description |
| --- | --- | --- |
| `noosphere_status` | Implemented | Checks memory status and reports plugin config with redacted secrets. |
| `noosphere_recall` | Implemented | Manual Noosphere durable-memory search. |
| `noosphere_topics` | Implemented | Lists topic IDs for draft save targets. |
| `noosphere_save` | Implemented | Saves durable content as a draft memory candidate. |
| Auto recall | Implemented | Uses Opencode's `chat.message` hook and Noosphere prompt-ready recall text. |
| Idle auto-save | Opt-in | Uses `session.idle`; requires `OPENCODE_NOOSPHERE_AUTO_SAVE=true` and `OPENCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID`. |

Do not commit real API keys into Opencode config. Use environment variables or host-level secret management. Prefer `OPENCODE_NOOSPHERE_*` variables on hosts that also run Kilo Code, OpenClaw, or Hermes; generic `NOOSPHERE_*` variables remain compatibility fallbacks.

## Kilo Code Integration

Noosphere ships a Kilo Code plugin at `kilocode-noosphere-memory/`.

### Quick install

```bash
npm install -g @sweetsophia/kilocode-noosphere-memory
export KILOCODE_NOOSPHERE_API_KEY="noo_..."
```

Add the package to `~/.config/kilo/kilo.json`:

```json
{
  "plugin": [
    "@sweetsophia/kilocode-noosphere-memory"
  ]
}
```

Or install it through Kilo:

```bash
kilo plugin @sweetsophia/kilocode-noosphere-memory --global
```

### Kilo Code capabilities

| Capability | Status | Description |
| --- | --- | --- |
| `noosphere_status` | Implemented | Checks memory status and reports plugin config with redacted secrets. |
| `noosphere_recall` | Implemented | Manual Noosphere durable-memory search. |
| `noosphere_topics` | Implemented | Lists topic IDs for draft save targets. |
| `noosphere_save` | Implemented | Saves durable content as a draft memory candidate, including optional `restrictedTags`. |
| Auto recall | Implemented | Uses Kilo Code's `chat.message` hook and Noosphere prompt-ready recall text. |
| Idle auto-save | Opt-in | Uses `session.idle`; requires `KILOCODE_NOOSPHERE_AUTO_SAVE=true` and `KILOCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID`. |

Do not commit real API keys into Kilo config. Use environment variables or host-level secret management. Prefer `KILOCODE_NOOSPHERE_*` variables on hosts that also run Opencode, OpenClaw, or Hermes; generic `NOOSPHERE_*` variables remain compatibility fallbacks.


## Memory Architecture

Noosphere's memory layer normalizes multiple sources into a single result shape:

```text
MemoryProvider
  → RecallOrchestrator
  → optional Redis cache-aside lookup
  → ranking
  → deduplication
  → conflict resolution
  → context budgeting
  → prompt injection text / inspection results
```

Core concepts:

- **Providers** return normalized `MemoryResult` objects.
- **Redis recall cache** short-circuits repeat Noosphere article searches before the PostgreSQL full-text path when `REDIS_URL` is configured.
- **Curation levels** are `ephemeral → managed → curated`.
- **Composite score** combines relevance, confidence, recency, and curation.
- **Auto recall** respects provider-level `allowAutoRecall` settings.
- **Inspection recall** queries enabled providers without auto-recall filtering.
- **Deduplication** collapses exact, canonical, or semantic overlap while preserving provenance.
- **Conflict resolution** can surface conflicts, suppress low-quality matches, or prefer recent/curated/highest-scoring results.
- **Budgeting** enforces prompt-safe token and result caps.
- **Promotion** identifies high-value recurring memories for review.
- **Backfill** turns approved or historical material into durable articles.

See the full implementation reference: [`docs/NOOSPHERE-MEMORY-ARCHITECTURE.md`](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md).

---

## Advanced Memory Features

| Feature | **Noosphere** | **Hindsight** | **QMD** | **memU** | **mem0** | **LanceDB Pro** |
|---|---|---|---|---|---|---|
| **Multi-Provider Recall** | ✅ Noosphere + Hindsight + extensible | ❌ (single provider) | ❌ (single store) | ❌ (single provider) | ❌ (single provider) | ❌ (single store) |
| **Recall Orchestration** | ✅ Concurrent fan-out + ranking | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Cross-Provider Dedup** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Conflict Detection** | ✅ Configurable strategies | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Token Budget Manager** | ✅ Prompt-safe recall blocks | ✅ `recallMaxTokens` | ❌ | ❌ | ❌ | ❌ |
| **Promotion (ephemeral → curated)** | ✅ Scheduled + manual threshold triggers | ❌ | ❌ | ❌ | ❌ | ⚠️ Decay model (Weibull) |
| **Backfill / Synthesis** | ✅ Job lifecycle with retry | ✅ Historical backfill CLI | ❌ | ❌ | ❌ | ❌ |
| **Local Scheduler** | ✅ Built-in memory job runner | ❌ | ❌ | ✅ Continuous sync loop | ❌ | ❌ |
| **Revision History** | ✅ Per-article | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Topic Hierarchy** | ✅ Unlimited depth | ❌ | ❌ | ✅ Category hierarchy | ❌ | ❌ |
| **Tags / Relations** | ✅ Tags + article edges | ❌ | ❌ | ✅ Cross-references | ✅ Entity linking (v3) | ❌ |
| **Soft Delete / Trash** | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |

---

## Wiki Model

```text
Topic
├── Subtopic
│   ├── Article
│   └── Article
└── Subtopic
    └── Article
```

Articles can also have:

- tags
- source metadata
- confidence level: `low | medium | high`
- status: `draft | reviewed | published`
- revision history
- related article edges
- soft-delete state

## Tech Stack

| Layer | Technology |
| --- | --- |
| App | Next.js 16, App Router, TypeScript, Turbopack |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 with adapter pattern |
| Auth | NextAuth.js for humans, Bearer API keys for agents |
| Markdown | `react-markdown`, `remark-gfm`, syntax highlighting |
| Cache | Redis 7 for optional recall/search acceleration |
| Memory | Provider abstraction, orchestrator, dedup, conflict, budget, promotion, backfill, scheduler |
| Runtime | Node.js 22 |
| Container | Docker + Docker Compose |
| Deployment | Self-hosted VPS or any Node.js 22 host |

## Redis Recall Cache Add-on

Noosphere includes an optional Redis cache-aside layer for repeated Noosphere article recall and search queries. It is enabled whenever `REDIS_URL` is configured; Docker Compose installs include Redis by default.

How it works:

- Recall checks Redis for the normalized query, filters, allowed scopes, and current cache version before running PostgreSQL full-text search.
- Cache keys use SHA-256 and include caller scope filters, so restricted results are not shared across differently scoped API keys.
- Writes invalidate cached recall results by incrementing a version token instead of scanning or deleting Redis keys.
- Cached entries expire after 30 seconds.
- Redis is fail-open: if Redis is missing, unreachable, or intentionally disabled, Noosphere continues to use PostgreSQL without failing requests.

Install and runtime notes:

- Docker Compose services start `redis:7-alpine` as `noosphere-redis` and set `REDIS_URL=redis://redis:6379` for the app.
- The OpenClaw installer also provisions Redis, waits for Redis health, and writes `REDIS_URL` into the runtime environment.
- For non-Compose deployments, run Redis separately and set `REDIS_URL`, for example `redis://localhost:6379`.
- Cache correctness tests are part of `npm test` through `npm run test:cache`.

Live verification from the Noosphere deployment on 2026-05-21:

| Query | Path | Result |
| --- | --- | --- |
| `GET /api/health` | Local container | HTTP 200 in 4.6 ms |
| `POST /api/memory/recall` query `deployment` | Cold cache after version bump | HTTP 200 in 58.0 ms, 4 results |
| Same recall query | Cached repeat | HTTP 200 in 21.9 ms, 4 results |
| Same recall query | Cached repeat | HTTP 200 in 11.6 ms, 4 results |
| Same recall query | Live internal route | HTTP 200 in 19.4 ms, 4 results |

## Environment Variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Secret for session encryption |
| `NEXTAUTH_URL` | Base URL, for example `http://localhost:6578` |
| `APP_URL` | Public URL of the app |
| `POSTGRES_PASSWORD` | PostgreSQL password for Docker Compose |
| `REDIS_URL` | Redis connection string; use `redis://redis:6379` inside Docker Compose |

## Deployment

```bash
# 1. Sync latest code
git pull origin master

# 2. Build (pass ~/.noosphere/.env to ensure correct secrets are baked in)
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env build app

# 3. Recreate app container with fresh image and ensure Redis exists
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env up -d redis app

# 4. Verify
curl http://127.0.0.1:6578/api/health

# Run production migrations after first deploy or schema changes
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env exec app node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma

# View logs
docker compose logs -f app
```

## Documentation

- [`docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md) — official OpenClaw install, operations, upgrade, and troubleshooting guide
- [`docs/OPENCLAW-OFFICIAL-PLUGIN-DEVELOPMENT-PLAN.md`](docs/OPENCLAW-OFFICIAL-PLUGIN-DEVELOPMENT-PLAN.md) — productization plan and release checklist
- [`docs/NOOSPHERE-MEMORY-ARCHITECTURE.md`](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md) — memory architecture and configuration model
- [`docs/NOOSPHERE-SKILL.md`](docs/NOOSPHERE-SKILL.md) — agent-facing wiki skill reference
- [`docs/OBSIDIAN-SYNC-SPEC.md`](docs/OBSIDIAN-SYNC-SPEC.md) — Obsidian sync design
- [`docs/OBSIDIAN-SYNC-REVIEW.md`](docs/OBSIDIAN-SYNC-REVIEW.md) — Obsidian sync review notes
- [`docs/SECURITY-AUDIT-2026-04-16.md`](docs/SECURITY-AUDIT-2026-04-16.md) — security audit notes

## License

MIT — see [LICENSE](LICENSE)
