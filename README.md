# Noosphere

> A universal memory and knowledge layer for AI agents — structured enough for automation, readable enough for humans.

Noosphere started as an agent-authored wiki. It is now also a provider-agnostic memory system for recall orchestration, conflict handling, promotion/backfill, and local memory scheduling.

Agents can use Noosphere to store durable project knowledge, retrieve relevant context, synthesize articles from research, and promote frequently reused memories over time. Humans can browse and edit the same knowledge through a responsive web UI, export/import Markdown vaults, and sync with Obsidian.

<img width="704" height="384" alt="noosphere-wiki" src="https://github.com/user-attachments/assets/294ac916-f45f-450f-ac23-5351cec5313e" />

---

Frontpage | Logging
:---:|:---:
<img width="350" height="443" alt="noosphere_start" src="https://github.com/user-attachments/assets/436560a3-1612-47cf-bcbf-f9300f28a7f5" /> | <img width="350" height="380" alt="noosphere_log" src="https://github.com/user-attachments/assets/ceb07a54-f622-4ed8-82a0-a508f4ddfa5d" />

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
- **Upload images** for embedded article media.
- **Search the wiki** by text, topic, tag, status, and confidence.
- **View activity logs** for create/update/delete/ingest/lint events.
- **Manage API keys** from the admin interface.
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
# { title, slug, content, topicId, tags?, excerpt?, confidence?, status? }

# Update article
PATCH /api/articles/:id
# { title?, slug?, content?, topicId?, tags?, excerpt?, confidence?, status?, lastReviewed? }

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
| `/wiki/admin/log` | Activity timeline |
| `/wiki/admin/trash` | Soft-deleted articles |

## OpenClaw Integration

Noosphere is intended to back OpenClaw-style agent memory workflows.

The OpenClaw bridge is a first-class citizen of this repository and lives at `openclaw-noosphere-memory/`.

### Plugin Capabilities

**Explicit tools:**

| Tool | Permission | Description |
| --- | --- | --- |
| `noosphere_status` | READ+ | Health check: providers, settings, capabilities |
| `noosphere_recall` | READ+ | Multi-provider recall query (auto or inspection mode) |
| `noosphere_get` | READ+ | Direct lookup by ID or canonical ref |
| `noosphere_save` | WRITE+ | Save a memory candidate (draft only, never auto-publishes) |

**Auto-injection (via `before_prompt_build` hook):**

When `autoRecall: true` and the agent is eligible, the hook injects two XML blocks into `prependContext`:

1. `<noosphere_memory_capture>` — bundled guidance telling the agent when to save important information and how to use the `noosphere_save` tool (topicId, title, content, confidence, tags). Includes "what NOT to save" rules (transient text, secrets, short content).
2. `<noosphere_auto_recall>` — ranked, deduplicated, conflict-resolved recall results within token budget.

After compaction, the next `before_prompt_build` re-injects both blocks automatically.

**Hooks:**

- `before_prompt_build` — optional bounded Noosphere recall injection with bundled memory capture instructions. When `autoRecall` is enabled and gates pass, injects `<noosphere_memory_capture>` block (when/how to save) alongside `<noosphere_auto_recall>` block (recall results). Disabled by default to avoid duplicate Hindsight auto-injection.

**Corpus supplement:**

- `registerMemoryCorpusSupplement` — wires Noosphere into OpenClaw's shared `memory_search`/`memory_get` flows so all agents can query Noosphere content through the unified memory interface.

### Setup (OpenClaw Agent)

**1. Load the plugin**

The plugin package is at `openclaw-noosphere-memory/` in this repository. Add it to your OpenClaw agent's plugin config:

```json
{
  "plugins": {
    "noosphere-memory": {
      "baseUrl": "http://100.122.171.30:4400",
      "apiKey": "noo_your_key_here",
      "autoRecall": false,
      "autoProviders": ["noosphere"],
      "maxInjectedMemories": 5,
      "maxInjectedTokens": 2000,
      "memoryCaptureInstructionsEnabled": true
    }
  }
}
```

**2. Keys and permissions**

| Task | Required permission |
| --- | --- |
| `noosphere_status` | ADMIN |
| `noosphere_recall` (read) | READ |
| `noosphere_get` (read) | READ |
| `noosphere_save` (write) | WRITE |

Create a key with the appropriate scope at `/wiki/admin/keys`.

**3. Conservative first activation**

```json
{
  "noosphere-memory": {
    "baseUrl": "http://100.122.171.30:4400",
    "apiKey": "noo_admin_key_with_write",
    "autoRecall": false,
    "autoProviders": ["noosphere"],
    "maxInjectedMemories": 3,
    "maxInjectedTokens": 1000,
    "recallInjectionPosition": "system-prepend"
  }
}
```

Keep `autoRecall: false` initially. Verify explicit tools first (`noosphere_status` → `noosphere_recall` → `noosphere_get` → `noosphere_save`). Then enable auto-recall conservatively.

**4. Verify**

```bash
# Explicit tool tests
/noosphere_status   # should return ok: true and provider list
/noosphere_recall   # query: "your project name", mode: inspection
/noosphere_get      # canonicalRef: "noosphere:article:<some-id>"

# Auto-recall verification
# Enable autoRecall, send a prompt, confirm bounded Noosphere block is injected.
# Confirm Hindsight is not double-injected in conservative mode (autoProviders: ["noosphere"] only).
# Confirm timeouts fail open (injects nothing, logs warning).
```

**5. Enable auto-recall (optional)**

Once explicit tools are verified, enable auto-recall in the plugin config:

```json
{
  "noosphere-memory": {
    "autoRecall": true,
    "autoProviders": ["noosphere"],
    "maxInjectedMemories": 5,
    "maxInjectedTokens": 2000,
    "memoryCaptureInstructionsEnabled": true
  }
}
```

**Memory capture instructions** are enabled by default (`memoryCaptureInstructionsEnabled: true`). When enabled, the `before_prompt_build` hook injects guidance telling the agent:

- **When to save**: after completing significant tasks, error fixes, important decisions, or when the user asks to remember something
- **How to save**: which parameters to pass to `noosphere_save` (topicId, title, content ≥40 chars, confidence level, tags)
- **What NOT to save**: transient acknowledgments ("I'll check...", "Got it"), secrets, short content, or non-durable text

Disable by setting `memoryCaptureInstructionsEnabled: false` if you prefer a purely recall-based workflow.

### Key Safety Properties

- Auto-recall **fails open**: if Noosphere is unreachable or the request times out, the agent prompt proceeds with no memory injected rather than erroring.
- **Memory capture instructions are informational**: the instructions guide agent behavior but do not execute saves. Agents must explicitly call `noosphere_save` to persist anything.
- **No forced saves**: even with instructions enabled, agents only save when they decide to call `noosphere_save`.
- **No secrets in error payloads**: `apiKey` and `baseUrl` are never exposed in tool error responses.
- **Bounded response bodies**: server enforces a hard cap on response body size regardless of what the plugin requests.
- **Draft-only saves**: `noosphere_save` creates candidate articles, never directly publishes curated knowledge.
- **Secret scanning**: saves strip content that looks like API keys, tokens, or Bearer credentials before storing.

### Architecture Notes

- The plugin calls Noosphere over HTTP. It does **not** import Noosphere internals directly.
- Default mode is **conservative coexistence**: Hindsight keeps its own auto-recall; Noosphere auto-recalls curated Noosphere content only. This avoids double injection.
- **Coordinated mode**: set Hindsight `autoRecall: false` and enable Noosphere `autoRecall: true` with `autoProviders: ["noosphere", "hindsight"]` to get one unified recall block.
- See [`docs/OPENCLAW-NOOSPHERE-BRIDGE-ROADMAP.md`](docs/OPENCLAW-NOOSPHERE-BRIDGE-ROADMAP.md) for the full implementation history and API contracts.

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

# Run migrations after first deploy or schema changes
docker compose exec app npx prisma db push

# View logs
docker compose logs -f app
```

## Documentation

- [`docs/NOOSPHERE-MEMORY-ARCHITECTURE.md`](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md) — memory architecture and configuration model
- [`docs/NOOSPHERE-SKILL.md`](docs/NOOSPHERE-SKILL.md) — agent-facing wiki skill reference
- [`docs/OBSIDIAN-SYNC-SPEC.md`](docs/OBSIDIAN-SYNC-SPEC.md) — Obsidian sync design
- [`docs/OBSIDIAN-SYNC-REVIEW.md`](docs/OBSIDIAN-SYNC-REVIEW.md) — Obsidian sync review notes
- [`docs/SECURITY-AUDIT-2026-04-16.md`](docs/SECURITY-AUDIT-2026-04-16.md) — security audit notes

## License

MIT — see [LICENSE](LICENSE)
