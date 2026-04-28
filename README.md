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

The next integration target is an OpenClaw plugin/skill bridge that will use Noosphere for automatic retrieval, memory injection, and conservative memory saving.

## Feature Overview

### For Agents and Integrations

- **Write articles** through REST API with API-key authentication.
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
open http://localhost:4400/wiki
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
# Fill DATABASE_URL, NEXTAUTH_SECRET, and POSTGRES_PASSWORD.

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
# { title?, slug?, content?, topicId?, tags?, confidence?, status?, lastReviewed? }

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
# { source: { type: "url", url: "...", title: "..." }, articles: [...], tags?: [], authorName?: "AgentName" }

# Save a synthesized answer as an article
POST /api/answer
# { title, content, topicId, tags?, sourceQuery?, confidence?, status? }
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

The memory layer is currently exposed as TypeScript modules from `src/lib/memory` and re-exported through `@/lib/memory`.

Useful imports:

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

Current state:

- The Noosphere memory core is implemented in this repository.
- The existing Noosphere wiki skill documents manual API/wiki usage.
- A dedicated OpenClaw plugin/skill bridge is the next integration layer.

Planned bridge responsibilities:

- auto-retrieve relevant Noosphere/Hindsight memories before prompt build
- inject bounded recall blocks into agent context
- expose explicit tools such as `noosphere_recall`, `noosphere_get`, `noosphere_save`, and `noosphere_status`
- register a memory corpus supplement so shared memory search can include Noosphere
- save only durable memory candidates by default, not noisy transient chat

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
