# Noosphere

Noosphere is a self-hosted knowledge and memory layer for AI agents and humans.  
Agents use it to recall, save, and organize durable and detailed project knowledge; humans use
the same data as a browsable Markdown wiki with topics, revisions, scoped access,
and Obsidian-friendly export/import.  

**All agent systems and humans access the same memory data. You can start in Openclaw and continue in OpenCode and add new data yourself via web browser.** 
The system is database PostgreSQL based with Redis for fast recall. Markdown import and export is possible by the user and agents.
 

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
# Edit .env: POSTGRES_PASSWORD, POSTGRES_MIGRATION_PASSWORD,
# POSTGRES_APP_PASSWORD, NEXTAUTH_SECRET, NOOSPHERE_ADMIN_PASSWORD, and
# NOOSPHERE_BOOTSTRAP_API_KEY. Every PostgreSQL password must be distinct.
# Generate strong values, for example:
# openssl rand -hex 32
# printf 'noo_%s\n' "$(openssl rand -hex 32)"
# Set NOOSPHERE_ADMIN_PASSWORD_RESET=true only when intentionally rotating
# an existing bootstrap admin password.
# Set NOOSPHERE_FORCE_ADMIN=true to re-assert the ADMIN role on the existing
# bootstrap admin account (does not rotate the password).
mkdir -p .noosphere/postgres-pgvector-backups
chmod 700 .noosphere/postgres-pgvector-backups
guard=(./scripts/switch-pgvector-compose.sh --compose-file "$PWD/docker-compose.noosphere.yml" \
  --env-file "$PWD/.env" --db-container noosphere-openclaw-db \
  --app-container noosphere-openclaw-app --backup-dir "$PWD/.noosphere/postgres-pgvector-backups")
"${guard[@]}" --prepare-new-install
docker compose -f docker-compose.noosphere.yml --env-file .env up -d db redis
docker compose -f docker-compose.noosphere.yml --env-file .env run --rm -T init
"${guard[@]}" --record-new-install
docker compose -f docker-compose.noosphere.yml --env-file .env up -d app
```

That guarded sequence is for an absent PostgreSQL volume only. The candidate
Compose service requires an external authorization volume and refuses an
ordinary start without guard-created evidence. If `noosphere_postgres_data`
already exists, complete the existing-volume transition in
[PostgreSQL pgvector Compose upgrade](docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md)
first.

Then open `http://localhost:6578/wiki`.

If you omit `NOOSPHERE_ADMIN_PASSWORD` or `NOOSPHERE_BOOTSTRAP_API_KEY`, the
bootstrap init container writes generated credentials to
`/tmp/noosphere-bootstrap-secrets/secrets.json` inside that init container with
mode `0600` inside a `0700` parent directory and logs only the file path. The
default `/tmp/...` path is destroyed when the init container exits; set
`NOOSPHERE_BOOTSTRAP_SECRETS_FILE=/app/uploads/bootstrap-secrets/secrets.json`
to persist it in the `noosphere_uploads` volume. The file must live inside a
dedicated bootstrap-secrets directory; paths directly under shared directories
such as `/tmp` or `/app/uploads` are rejected.

The production template uses `ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION:-latest}`,
binds to `127.0.0.1:6578` by default, includes PostgreSQL and Redis, and runs a
one-shot init service before the app starts.

To run from source instead:

```bash
cp .env.example .env
# Edit the bootstrap, migration, and application database credentials plus
# NEXTAUTH_SECRET, NEXTAUTH_URL, and APP_URL.
docker network create noosphere-net 2>/dev/null || true
mkdir -p .noosphere/postgres-pgvector-backups
chmod 700 .noosphere/postgres-pgvector-backups
guard=(./scripts/switch-pgvector-compose.sh --compose-file "$PWD/docker-compose.yml" \
  --env-file "$PWD/.env" --db-container noosphere-db --app-container noosphere-app \
  --backup-dir "$PWD/.noosphere/postgres-pgvector-backups")
"${guard[@]}" --prepare-new-install
docker compose up -d db redis
docker compose run --rm -T init
"${guard[@]}" --record-new-install
docker compose up -d app
docker compose exec app node scripts/create-admin.js
```

## OpenClaw Install

OpenClaw users can install Noosphere and the OpenClaw plugin with the repository
installer:

```bash
# Installer commit: 6bb3a21648b441654f3fdffde2affe7358de6e63
# Expected SHA-256: 622df3c415d0380eb277fdd7036505215261229f114a4e1bab47faf1cfbaec9e
installer="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/6bb3a21648b441654f3fdffde2affe7358de6e63/install-openclaw.sh -o "$installer"
printf '%s  %s\n' '622df3c415d0380eb277fdd7036505215261229f114a4e1bab47faf1cfbaec9e' "$installer" | sha256sum -c -
bash "$installer" && rm -f "$installer"
openclaw noosphere doctor
openclaw noosphere status
```

The installer provisions Docker, Redis, Noosphere secrets, and the OpenClaw plugin
configuration. Existing installations are upgraded only through its offline,
restore-tested PostgreSQL image guard; unrestricted Compose upgrades are not a
supported database transition. For the full setup, upgrade, operations, and uninstall guide, see
[docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md).

Optional pgvector storage remains inactive after installation. See
[docker/hybrid-storage/README.md](docker/hybrid-storage/README.md) for the
separate Phase A3 activation and verification contract.

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

## Core Memory Features

| Feature | **Noosphere** | **Hindsight** | **QMD** | **memU** | **mem0** | **LanceDB Pro** |
|---|---|---|---|---|---|---|
| **Auto-Capture** | ⚠️ Disabled-by-default private capture API, principal/lineage storage, and cleanup foundation; OpenClaw turn hook/extraction planned | ✅ Every turn | ❌ Manual indexing | ✅ Continuous learning | ✅ `memory.add()` | ✅ Smart extraction |
| **Auto-Recall** | ✅ Capture guidance on clean misses + recall results when available; provider errors fail open | ✅ Before each turn | ✅ Keyword search only | ✅ Proactive context loading | ✅ `memory.search()` | ✅ Before prompt build |
| **Manual Recall** | ✅ REST API + tools | ✅ MCP tools | ✅ CLI / tool query | ✅ REST API | ✅ SDK + REST | ✅ CLI + MCP tools |
| **Semantic Search** | ✅ PostgreSQL FTS (live) + vector (planned) | ✅ Vector + biomimetic | ⚠️ Keyword + pending vector | ✅ pgvector | ✅ Semantic + BM25 + entity fusion | ✅ Vector + BM25 hybrid |
| **Keyword Search** | ✅ PostgreSQL full-text | ✅ | ✅ Primary mode | ✅ | ✅ BM25 | ✅ BM25 |
| **Cross-Encoder Rerank** | ❌ (planned) | ❌ | ❌ | ❌ | ❌ | ✅ Cross-encoder |
| **Memory Types** | Articles (wiki) | world / experience / observation | Markdown files | Categories / Items / Resources | Facts (ADD-only v3) | 6-category classification |
| **Curation Levels** | ✅ ephemeral → managed → curated | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Confidence Scoring** | ✅ low / medium / high | ❌ | ❌ | ❌ | ❌ | ❌ (decay model) |
| **Status Lifecycle** | ✅ draft → reviewed → published | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Advanced Memory Features

| Feature | **Noosphere** | **Hindsight** | **QMD** | **memU** | **mem0** | **LanceDB Pro** |
|---|---|---|---|---|---|---|
| **Multi-Provider Recall** | ✅ Noosphere + Hindsight + extensible | ❌ (single provider) | ❌ (single store) | ❌ (single provider) | ❌ (single provider) | ❌ (single store) |
| **Recall Orchestration** | ✅ Concurrent fan-out + ranking | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Cross-Provider Dedup** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Conflict Detection** | ✅ Configurable strategies | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Token Budget Manager** | ✅ Prompt-safe recall blocks | ✅ `recallMaxTokens` | ❌ | ❌ | ❌ | ❌ |
| **Promotion (ephemeral → curated)** | ⚠️ Pure threshold/review scaffolding; durable statistics and worker wiring planned | ❌ | ❌ | ❌ | ❌ | ⚠️ Decay model (Weibull) |
| **Backfill / Synthesis** | ⚠️ Pure job/content helpers; durable execution wiring planned | ✅ Historical backfill CLI | ❌ | ❌ | ❌ | ❌ |
| **Local Scheduler** | ⚠️ Health plus durable automatic-memory expiry/privacy cleanup; extraction/promotion workers planned | ❌ | ❌ | ✅ Continuous sync loop | ❌ | ❌ |
| **Revision History** | ✅ Per-article | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Topic Hierarchy** | ✅ Unlimited depth | ❌ | ❌ | ✅ Category hierarchy | ❌ | ❌ |
| **Tags / Relations** | ✅ Tags + article edges | ❌ | ❌ | ✅ Cross-references | ✅ Entity linking (v3) | ❌ |
| **Soft Delete / Trash** | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |

---

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
| `GET` | `/api/topics` | List the complete topic tree (maximum 500 topics; returns `409` above the limit) |
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
| `POST` | `/api/memory/captures` | Accept one private automatic-memory observation when explicitly enabled |
| `GET` | `/api/memory/captures` | Admin capture inspection (raw text is detail-only) |
| `GET` | `/api/memory/captures/:id` | Read eligible capture status/raw detail as its bound creator, or inspect quarantined evidence as a scope-authorized administrator |
| `GET/POST` | `/api/memory/principals` | Admin principal inspection/provisioning |
| `POST` | `/api/memory/revocations` | Admin session-lineage revocation |
| `GET` | `/api/memory/{candidates,jobs,tombstones,privacy-reviews}` | Admin Phase A lifecycle inspection |

JSON write endpoints reject malformed or excessively nested payloads and return
`413` when their route-specific body-size limit is exceeded. Most routes allow
64 KiB; article writes allow approximately 1 MiB, and batch ingest allows 4 MiB.
`POST /api/memory/recall` allows 120 requests per minute per client IP by
default so several local coding CLIs can use prompt-time recall concurrently.
Set `NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE` to tune that read-only
endpoint for your deployment.

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
# Edit the bootstrap, migration, and application database credentials plus
# NEXTAUTH_SECRET, NEXTAUTH_URL, and APP_URL.
docker network create noosphere-net 2>/dev/null || true
mkdir -p .noosphere/postgres-pgvector-backups
chmod 700 .noosphere/postgres-pgvector-backups
guard=(./scripts/switch-pgvector-compose.sh --compose-file "$PWD/docker-compose.yml" \
  --env-file "$PWD/.env" --db-container noosphere-db --app-container noosphere-app \
  --backup-dir "$PWD/.noosphere/postgres-pgvector-backups")
"${guard[@]}" --prepare-new-install
docker compose up -d db redis
docker compose run --rm -T init
"${guard[@]}" --record-new-install
set -a
. ./.env
set +a
DATABASE_URL="$NOOSPHERE_APP_DATABASE_URL" PORT=6578 npm run dev
```

The external `noosphere_postgres_authorization` volume is created only by the
guard, so an ordinary candidate Compose start fails closed. When the
development Compose project reuses an existing
`noosphere_postgres_data` volume created by the former source image, run the
guarded PostgreSQL image transition before the first `docker compose up` from
this revision.

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
NOOSPHERE_POSTGRES_EVIDENCE=/absolute/private/path/postgres-pgvector/noosphere_postgres_data.phase-a2b.json \
  npm run deploy:verify
docker compose logs -f app
```

Production deploys should preserve the pinned Compose project and named volumes:

- Compose project: `noosphere`
- PostgreSQL volume: `noosphere_postgres_data`
- Redis volume: `noosphere_redis_data`

Candidate verification requires the active completed Phase A2b journal through
`NOOSPHERE_POSTGRES_EVIDENCE`. `npm run deploy:verify` fails if that evidence
does not bind the running database image, data volume, authorization volume, and
template probe; if PostgreSQL exposes the wrong pgvector capability or has
activated `vector` in any database/template; or if there are no topics,
articles, or API keys. The guarded Phase A2b transition and recovery contract is
documented in
[docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md](docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md).

Keep detailed recovery work in deployment/runbook docs rather than this README.

## Documentation

| Document | Use it for |
| --- | --- |
| [README-legacy.md](README-legacy.md) | Previous full README content kept for reference during the docs split |
| [docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md) | OpenClaw install, operations, upgrade, troubleshooting, and uninstall |
| [docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md](docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md) | Guarded PostgreSQL image transition, proof, rollback, and recovery |
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

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Apache License 2.0 applies to all source code in this repository and to
the four plugins (`openclaw-noosphere-memory`, `opencode-noosphere-memory`,
`hermes-noosphere-memory`, `kilocode-noosphere-memory`). It does **not**
govern the article content stored inside a Noosphere wiki instance — content
licensing is a separate decision left to the wiki operator.

If you distribute or host a Noosphere-based service, the NOTICE file
specifies the attribution form that must be preserved (e.g. a "Powered by
Noosphere" link in the UI footer).
