# Noosphere

Noosphere is a self-hosted knowledge and memory layer for AI agents and humans.
Agents use it to recall, save, and organize durable project knowledge; humans use
the same data as a browsable Markdown wiki with topics, revisions, scoped access,
and Obsidian-friendly export/import.

It sits between a chat transcript and a full documentation site:

- **Agent memory**: recall relevant project context, save draft memory
  candidates, and promote useful facts into curated articles.
- **Human wiki**: browse, edit, review, restore, and search Markdown articles.
- **Scoped access**: give agents or users narrow API keys for only the knowledge
  they should read or write.
- **Integration-first design**: OpenClaw, Hermes Agent, Opencode, Kilo Code, and
  any REST client can use the same Noosphere instance.

The old long-form README is preserved at [README-legacy.md](README-legacy.md).

## Quick Start

Use this path when you want the published Docker image and a local Noosphere
instance.

```bash
git clone https://github.com/SweetSophia/noosphere.git
cd noosphere

cp noosphere.env.example .env
# Edit .env: POSTGRES_PASSWORD, NEXTAUTH_SECRET, NOOSPHERE_ADMIN_PASSWORD,
# and NOOSPHERE_BOOTSTRAP_API_KEY. Generate strong values, for example:
# openssl rand -hex 32
# printf 'noo_%s\n' "$(openssl rand -hex 32)"
docker compose -f docker-compose.noosphere.yml up -d
```

Then open `http://localhost:6578/wiki`.

The production template uses `ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION:-latest}`,
binds to `127.0.0.1:6578` by default, includes PostgreSQL and Redis, and runs a
one-shot init service before the app starts.

To run from source instead:

```bash
cp .env.example .env
# Edit DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, APP_URL, and POSTGRES_PASSWORD.
docker network create noosphere-net 2>/dev/null || true
docker compose up -d
docker compose exec app node scripts/create-admin.js
```

## OpenClaw Install

OpenClaw users can install Noosphere and the OpenClaw plugin with the repository
installer:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
openclaw noosphere doctor
openclaw noosphere status
```

The installer provisions Docker, Redis, Noosphere secrets, and the OpenClaw plugin
configuration. For the full setup, upgrade, operations, and uninstall guide, see
[docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md).

## Choose an Integration

| System | What it gets | Start here |
| --- | --- | --- |
| OpenClaw | Explicit tools, optional prompt-time auto-recall, memory corpus supplement, CLI helpers | [openclaw-noosphere-memory/README.md](openclaw-noosphere-memory/README.md) |
| Hermes Agent | First-class Hermes `MemoryProvider`, recall/get/topics/save tools, optional memory mirroring | [hermes-noosphere-memory/README.md](hermes-noosphere-memory/README.md) |
| Opencode | Prompt-time auto-recall, optional idle auto-save, manual memory tools | [opencode-noosphere-memory/README.md](opencode-noosphere-memory/README.md) |
| Kilo Code | Prompt-time auto-recall, optional idle auto-save, manual memory tools | [kilocode-noosphere-memory/README.md](kilocode-noosphere-memory/README.md) |
| REST clients | Article CRUD, ingest, memory recall/get/save, export/import, graph, health | [API Snapshot](#api-snapshot) |

Use integration-specific environment variables when multiple tools run on one
machine, for example `OPENCLAW_NOOSPHERE_API_KEY`,
`HERMES_NOOSPHERE_API_KEY`, `OPENCODE_NOOSPHERE_API_KEY`, or
`KILOCODE_NOOSPHERE_API_KEY`. The generic `NOOSPHERE_API_KEY` fallback remains
available for simple single-tool setups.

## Core Concepts

### Topics and Articles

Topics form an unlimited-depth hierarchy. Articles live inside topics, render as
GitHub-flavored Markdown, and can include tags, source metadata, images,
confidence, status, revision history, and related-article edges.

### Memory Recall

The memory layer normalizes results from providers, ranks them, deduplicates
overlap, handles conflicts, and budgets the returned context for prompt use.
Current providers include Noosphere articles and Hindsight; the provider
contract is extensible.

See [docs/NOOSPHERE-MEMORY-ARCHITECTURE.md](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md)
for the implementation model.

### Draft Saves and Curation

Agent saves are draft memory candidates by default. That keeps automatic memory
capture inspectable before it becomes curated wiki knowledge.

### Scopes

Restricted articles use `restrictedTags`; scoped API keys and scoped users can
only read or write content allowed by their scopes. A wildcard `*` scope grants
full restricted-content access and should be reserved for admin workflows.

### Obsidian and Markdown

Noosphere can export/import Markdown vault archives and supports an Obsidian
sync workflow through a versioned frontmatter codec. The sync design lives in
[docs/OBSIDIAN-SYNC-SPEC.md](docs/OBSIDIAN-SYNC-SPEC.md).

## API Snapshot

Base URL:

```text
http://localhost:6578/api
```

Authentication:

```text
Authorization: Bearer <api_key>
```

Common endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/topics` | List topics |
| `GET` | `/api/articles` | Search/list articles |
| `POST` | `/api/articles` | Create an article |
| `PATCH` | `/api/articles/:id` | Update an article |
| `POST` | `/api/ingest` | Ingest external material into articles |
| `POST` | `/api/answer` | Save a synthesized answer as an article |
| `GET` | `/api/graph` | Read the wiki graph |
| `GET` | `/api/export` | Export a Markdown vault ZIP |
| `POST` | `/api/import` | Import a Markdown vault ZIP |
| `GET` | `/api/memory/status` | Memory provider/settings overview |
| `POST` | `/api/memory/recall` | Recall ranked memory results |
| `POST` | `/api/memory/get` | Fetch one memory by canonical ref or ID |
| `POST` | `/api/memory/save` | Save a draft memory candidate |

Example recall request:

```bash
curl -s -X POST http://localhost:6578/api/memory/recall \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{"query":"deployment runbook","mode":"auto","resultCap":5}'
```

## Local Development

Prerequisites:

- Node.js 22+
- Docker and Docker Compose

Setup:

```bash
npm install
cp .env.example .env
# Edit DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, APP_URL, and POSTGRES_PASSWORD.
docker network create noosphere-net 2>/dev/null || true
docker compose up -d db redis
npm run db:migrate
PORT=6578 npm run dev
```

Useful checks:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Package-specific plugin checks live in each plugin README.

## Operations

Health and deployment checks:

```bash
curl http://127.0.0.1:6578/api/health
npm run deploy:verify
docker compose logs -f app
```

Production deploys should preserve the pinned Compose project and named volumes:

- Compose project: `noosphere`
- PostgreSQL volume: `noosphere_postgres_data`
- Redis volume: `noosphere_redis_data`

`npm run deploy:verify` fails if the database container is mounted to the wrong
PostgreSQL volume or if the live database has no topics, articles, or API keys.
That catches the empty-volume failure mode where `/api/health` can pass while
authenticated tools return `Unauthorized`.

Keep detailed recovery work in deployment/runbook docs rather than this README.

## Documentation

| Document | Use it for |
| --- | --- |
| [README-legacy.md](README-legacy.md) | Previous full README content kept for reference during the docs split |
| [docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md) | OpenClaw install, operations, upgrade, troubleshooting, and uninstall |
| [docs/NOOSPHERE-MEMORY-ARCHITECTURE.md](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md) | Provider abstraction, recall orchestration, ranking, budgeting, and scheduler |
| [docs/NOOSPHERE_MEMORY_COMPARISON.md](docs/NOOSPHERE_MEMORY_COMPARISON.md) | Comparison with Hindsight, QMD, memU, mem0, and LanceDB Pro |
| [docs/NOOSPHERE-SKILL.md](docs/NOOSPHERE-SKILL.md) | Agent-facing wiki skill reference |
| [docs/OBSIDIAN-SYNC-SPEC.md](docs/OBSIDIAN-SYNC-SPEC.md) | Obsidian sync design and Markdown frontmatter contract |
| [docs/OBSIDIAN-SYNC-REVIEW.md](docs/OBSIDIAN-SYNC-REVIEW.md) | Obsidian sync review notes |
| [docs/SECURITY-AUDIT-2026-04-16.md](docs/SECURITY-AUDIT-2026-04-16.md) | Security audit notes |
| [openclaw-noosphere-memory/README.md](openclaw-noosphere-memory/README.md) | OpenClaw plugin configuration and tools |
| [hermes-noosphere-memory/README.md](hermes-noosphere-memory/README.md) | Hermes Agent provider install and verification |
| [opencode-noosphere-memory/README.md](opencode-noosphere-memory/README.md) | Opencode plugin install, configuration, and tools |
| [kilocode-noosphere-memory/README.md](kilocode-noosphere-memory/README.md) | Kilo Code plugin install, configuration, and tools |

## License

MIT. See [LICENSE](LICENSE).
