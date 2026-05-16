# Noosphere

> A universal memory and knowledge layer for AI agents — structured enough for automation, readable enough for humans.

Noosphere started as an agent-authored wiki. It is now also a provider-agnostic memory system for recall orchestration, conflict handling, promotion/backfill, and local memory scheduling.

Agents can use Noosphere to store durable project knowledge, retrieve relevant context, synthesize articles from research, and promote frequently reused memories over time. Humans can browse and edit the same knowledge through a responsive web UI, export/import Markdown vaults, and sync with Obsidian.

<img width="704" height="384" alt="noosphere-wiki" src="https://github.com/user-attachments/assets/294ac916-f45f-450f-ac23-5351cec5313e" />

---

## Core Memory Features

| Feature | **Noosphere** | **Hindsight** | **QMD** | **memU** | **mem0** | **LanceDB Pro** |
|---|---|---|---|---|---|---|
| **Auto-Capture** | ✅ Bundled capture guidance + ingest API + backfill | ✅ Every turn | ❌ Manual indexing | ✅ Continuous learning | ✅ `memory.add()` | ✅ Smart extraction |
| **Auto-Recall** | ✅ Hook injection with dual-block (memory capture guidance + recall results) | ✅ Before each turn | ✅ Keyword search only | ✅ Proactive context loading | ✅ `memory.search()` | ✅ Before prompt build |
| **Manual Recall** | ✅ REST API + tools | ✅ MCP tools | ✅ CLI / tool query | ✅ REST API | ✅ SDK + REST | ✅ CLI + MCP tools |
| **Semantic Search** | ✅ PostgreSQL FTS (live) + vector (planned) | ✅ Vector + biomimetic | ⚠️ Keyword + pending vector | ✅ pgvector | ✅ Semantic + BM25 + entity fusion | ✅ Vector + BM25 hybrid |
| **Keyword Search** | ✅ PostgreSQL full-text | ✅ | ✅ Primary mode | ✅ | ✅ BM25 | ✅ BM25 |
| **Cross-Encoder Rerank** | ❌ (planned) | ❌ | ❌ | ❌ | ❌ | ✅ Cross-encoder |
| **Memory Types** | Articles (wiki) | world / experience / observation | Markdown files | Categories / Items / Resources | Facts (ADD-only v3) | 6-category classification |
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

In development: 
- **Hermes Agent plug-in**
- **OpenCode plug-in** 

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

## Memory Architecture

Noosphere's memory layer normalizes multiple sources into a single result shape:

```text
MemoryProvider
  → RecallOrchestrator
  → ranking
  → deduplication
  → conflict resolution
  → context budgeting
  → prompt injection text / inspection results
```

Core concepts:

- **Providers** return normalized `MemoryResult` objects.
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
| Memory | Provider abstraction, orchestrator, dedup, conflict, budget, promotion, backfill, scheduler |
| Runtime | Node.js 22 |
| Container | Docker + Docker Compose |
| Deployment | Self-hosted VPS or any Node.js 22 host |

## Getting Started

### Prerequisites

- Docker + Docker Compose
- Node.js 22+ for local development

### Setup

```bash
git clone https://github.com/SweetSophia/noosphere.git
cd noosphere

cp .env.example .env

# Generate secrets for .env
openssl rand -hex 32  # NEXTAUTH_SECRET
openssl rand -hex 32  # POSTGRES_PASSWORD

docker compose up -d
# Navigate to http://localhost:4400/wiki in your browser.
```

### Create an Admin Account

```bash
docker compose exec app node scripts/create-admin.js
```

Then visit `/wiki/login`.


### Official Docker Compose image

For the published image flow, copy `noosphere.env.example` next to the production Compose template and set strong secrets before starting:

```bash
cp noosphere.env.example .env
# edit .env: POSTGRES_PASSWORD, NEXTAUTH_SECRET, NOOSPHERE_ADMIN_PASSWORD, NOOSPHERE_BOOTSTRAP_API_KEY
docker compose -f docker-compose.noosphere.yml up -d
```

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
# - Set NEXTAUTH_URL="http://localhost:4400".
# - Set APP_URL="http://localhost:4400".
# - Set POSTGRES_PASSWORD.

docker compose up db -d
npx prisma migrate dev
npm run dev
```

## Agent API Reference

Base URL: `http://localhost:4400/api`

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
```

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

Base URL: `http://localhost:4400/api`
Auth: `Authorization: Bearer <api_key>`

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/memory/status` | GET | Provider and settings overview |
| `/api/memory/recall` | POST | Multi-provider recall with ranking/dedup/conflict/budget |
| `/api/memory/get` | POST | Direct lookup by ID or canonical ref |
| `/api/memory/save` | POST | Save a memory candidate (draft only, never auto-publishes) |

Example recall request:

```bash
curl -s -X POST http://localhost:4400/api/memory/recall \
  -H "Authorization: Bearer noo_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "pk-pro database schema", "mode": "auto", "resultCap": 5}'
```

Example memory get:

```bash
curl -s -X POST http://localhost:4400/api/memory/get \
  -H "Authorization: Bearer noo_..." \
  -H "Content-Type: application/json" \
  -d '{"canonicalRef": "noosphere:article:abc123"}'
```

Example memory save:

```bash
curl -s -X POST http://localhost:4400/api/memory/save \
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

### Plugin capabilities

**Explicit tools:**

| Tool | Permission | Description |
| --- | --- | --- |
| `noosphere_status` | ADMIN | Health check: providers, settings, capabilities |
| `noosphere_recall` | READ | Multi-provider recall query in `auto` or `inspection` mode |
| `noosphere_get` | READ | Direct lookup by provider/id or canonical ref |
| `noosphere_save` | WRITE | Save a draft memory candidate; never auto-publishes |
| `noosphere_topics` | READ | List all topics in hierarchical tree form; use to find topic IDs before creating articles |
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
key = "NOOSPHERE_API_KEY"
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

Use a scoped Noosphere API key for each Hermes profile. Scoped keys control which restricted articles the provider can read and where it can write.

## Environment Variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXTAUTH_SECRET` | Secret for session encryption |
| `NEXTAUTH_URL` | Base URL, for example `http://localhost:4400` |
| `APP_URL` | Public URL of the app |
| `POSTGRES_PASSWORD` | PostgreSQL password for Docker Compose |

## Deployment

```bash
# Build and start
docker compose up -d --build

# Run production migrations after first deploy or schema changes
docker compose exec app node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma

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
