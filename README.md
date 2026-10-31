# Noosphere
**Now with OpenAI Codex Support as well as optional vector retrieval and auto-capture**

Noosphere is a self-hosted knowledge and memory layer for AI agents and humans.  
Agents use it to recall, save, and organize durable and detailed project knowledge; humans use
the same data as a browsable Markdown wiki with topics, revisions, scoped access,
and Obsidian-friendly export/import.  

**All agent systems and humans access the same memory data. You can start in OpenClaw, continue in Codex CLI or OpenCode, and add new data yourself through the web UI.**
The system is database PostgreSQL based with Redis for fast recall. Markdown import and export is possible by the user and agents.
 

It sits between a chat transcript and a full documentation site:

- **Agent memory**: recall relevant project context, save draft memory
  candidates, and promote useful facts into curated articles.
- **Human wiki**: browse, edit, review, restore, and search Markdown articles.
- **Scoped access**: give agents or users narrow API keys for only the knowledge
  they should read or write.
- **Integration-first design**: OpenClaw, Codex CLI, Hermes Agent, OpenCode,
  Kilo Code, any MCP client, and any REST client can use the same Noosphere
  instance.

The old long-form README is preserved at [README-legacy.md](README-legacy.md).

## Current release

**1.15.2 is published.** The coordinated release is live at
[`v1.15.2`](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.2) with all
six installer assets, the `ghcr.io/sweetsophia/noosphere:1.15.2` image for
`linux/amd64` and `linux/arm64`, and the five `1.15.2` npm packages. The
OpenClaw, OpenCode and Kilo Code adapters resolve their maintained SDK aliases
from the registry, so a fresh install no longer waits on a candidate.

Use the [packaged launcher](#install) from the release assets for a fully
coordinated install; the
[verified two-file download](docs/INSTALLATION.md#auditable-download) from the
source commit is the auditable alternative and still installs the OpenCode,
Kilo Code and Hermes surfaces at their previous **1.15.0** pins.

### Root application dependency remediation

The root application's own audit findings are remediated in this release. The
installed tree audits **0** vulnerabilities at `--audit-level=low`, down from 8
(2 high, 1 moderate, 5 low). That count does not cover the vendored `braces`
derivative, which registry audit cannot assess (see the changelog's `braces`
entry and `vendor/README.md`).

- `happy-dom` moves from `^20.10.6` to `21.0.4` (a semver-major 20.x -> 21.x
  bump of the DOM implementation)
  ([GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79)).
  It is a development-only dependency used by the DOM test suite. Like
  `katex`, it is now an exact pin and must be bumped manually to receive
  future security fixes.
- `katex` is pinned to `0.18.2`
  ([GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7)).
  `mermaid`, `rehype-katex` and `micromark-extension-math` each inherited that
  advisory through their own KaTeX dependency edge, and `remark-math` inherited
  it through `micromark-extension-math`. Three parent-scoped overrides
  (`mermaid`, `rehype-katex`, `micromark-extension-math` -> `$katex`) resolve
  them without a major upgrade or downgrade of any of those packages, and
  without touching the locked `sharp` 0.35.5 (an optional dependency of
  Next.js) or its parents. Each of those three
  parents declares `katex` as `^0.16.47` (mermaid) or `^0.16.0`
  (rehype-katex, micromark-extension-math), so the override deliberately installs
  0.18.2 outside that declared range: it needs re-qualification whenever a
  parent changes its range or a new `katex` release appears, and it should be
  dropped once a parent accepts 0.18.2 on its own. npm's v3 lockfile does not
  persist `overrides`, so `package.json` is the only durable record of that
  forcing. The `@types/katex` 0.16.8 package remains installed only because
  `micromark-extension-math` and `rehype-katex` declare `^0.16.0`; KaTeX 0.18.2
  ships its own bundled declarations, which TypeScript resolves in preference
  to `@types/katex`, so the typecheck surface tracks the 0.18.2 runtime.
- `fast-uri` (3.1.8 -> 3.1.9) and `undici` (7.30.0 -> 7.30.1) are refreshed
  inside their existing declared ranges.

For this remediation only `package.json` and `package-lock.json` change; no
application source changes.

**Qualification performed** for the published release: a full root install with
optional dependencies but with install scripts disabled (`npm ci
--ignore-scripts --include=optional`), the complete dependency tree, an
installed-tree audit, Prisma client generation, the focused
DOM/markdown/dependency test files (30 tests), a non-incremental typecheck,
lint, a production build, and a hydrated browser check of the real wiki
Markdown and Mermaid components on Node 22 - that browser check runs an
esbuild fixture bundle of those components, not the production build output.
The affected subset was repeated on Node 24. The release commit additionally
passed the hosted CI, Docker publication and installer-asset workflows, and the
published artifacts were read back from the registry and the release assets
before promotion.

The qualified KaTeX edge contract is enforced by `scripts/katex-override-policy.mjs`
through the existing package-policy gate: changes to the three parents' declared
ranges, the exact root pin or the scoped overrides fail until explicitly
re-qualified. This deliberately checks the approved exception, rather than an
ordinary range-satisfaction rule that would reject the current qualified graph.

## Quick Start

### Prerequisites

Install Docker with Docker Compose v2, Node.js 22 or newer, and `curl`. The
installer checks the remaining command-line prerequisites before changing the
machine.

### Install

The published `v1.15.2` release assets are coupled to the coordinated
`v1.15.2` image, packages, and Hermes archive. Before running the installer,
confirm that the
[`v1.15.2` release](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.2)
exists with all six installer assets; a merged commit alone is not a release.

**Packaged launcher (recommended).** The release assets are the coordinated
path: the launcher, its backend and the Hermes archive all carry the same
`1.15.2` pins, so every surface the launcher installs lands on one version.
Download both files from the release and verify both checksums before running
them.

```bash
(
  set -e
  installer_dir="$(mktemp -d)"
  trap 'rm -rf "$installer_dir"' EXIT
  installer="$installer_dir/install.sh"
  backend="$installer_dir/install-openclaw.sh"
  unset NOOSPHERE_BACKEND_PATH NOOSPHERE_BACKEND_OVERRIDE_SHA256
  curl -fsSL https://github.com/SweetSophia/noosphere/releases/download/v1.15.2/install.sh -o "$installer"
  curl -fsSL https://github.com/SweetSophia/noosphere/releases/download/v1.15.2/install-openclaw.sh -o "$backend"
  printf '%s  %s\n' 'fa38522104b10991cc85774fade4dffc559090e64838827cffeb74d200d547e0' "$installer" | sha256sum -c -
  printf '%s  %s\n' '7758cc2aab51da3af18551ad138eb08a8c2d50e546955c498840933cbef63c7c' "$backend" | sha256sum -c -
  NOOSPHERE_VERSION="${NOOSPHERE_VERSION:-1.15.2}" NOOSPHERE_IMAGE="${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:1.15.2}" NOOSPHERE_PLUGIN_SPEC="${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory@1.15.2}" bash "$installer" --non-interactive --with openclaw
)
```

The command is non-interactive and selects its integrations explicitly; it
never guesses which agent configuration to mutate. Add `hermes`, `opencode` or
`kilocode` to the `--with` list to configure those surfaces as well - the
packaged launcher resolves the Hermes archive and the OpenCode and Kilo Code
packages to `1.15.2` too.

Each setting is a default that the launcher applies when the environment does
not already carry one, so an operator who exported `NOOSPHERE_IMAGE`,
`NOOSPHERE_VERSION` or `NOOSPHERE_PLUGIN_SPEC` keeps their own value. One
caveat carries over from the audited block: for an existing installation using
a custom image, export `NOOSPHERE_IMAGE` explicitly before running this block.
The version-bound default does not reuse a persisted image automatically, so
without that export the stock `1.15.2` image replaces it.

The launcher detects an existing installation, preserves the named PostgreSQL
volume and its configuration, and uses the guarded stateful upgrade path. It
never treats the database as disposable.

**Audited source download (alternative).** The
[verified two-file download](docs/INSTALLATION.md#auditable-download) runs the
launcher from an immutable commit instead of the release assets. It prompts for
which integrations to configure, so it needs a terminal, and it is a
mixed-version path: that launcher's embedded pins still install the Hermes
archive and the OpenCode and Kilo Code packages at **1.15.0**. Use the
packaged launcher for a coordinated, non-interactive install.

The installer:

- shows its plan and detects fresh-install, interrupted-run, or upgrade state;
- when run interactively, offers the OpenClaw, Hermes Agent, OpenCode, and
  Kilo Code integrations it finds on the machine; the documented commands above
  skip that prompt and select explicitly;
- generates distinct runtime credentials without printing them;
- preserves the named PostgreSQL volume and uses the guarded stateful upgrade
  path when an existing installation is present;
- starts the services and verifies Noosphere health.

When it finishes, open `http://127.0.0.1:6578/wiki`. The actual URL is shown if
you selected another bind address.

Generated administrator credentials are stored at
`~/.noosphere/credentials.json` in a mode-`0700` directory with mode `0600`.
The normal output reports the path, not the password or API key.

For an independently verified download, automation flags, existing-installation
warnings, manual Compose deployment, and bootstrap-secret path rules, read
[Installing Noosphere](docs/INSTALLATION.md).

### Existing or customized installations

Do not replace the guided upgrade with an unrestricted `docker compose pull &&
docker compose up`. First inspect the plan without changing the machine:

Use the [verified two-file download](docs/INSTALLATION.md#auditable-download)
and add `--dry-run --core-only` to its final invocation.

Preserve your configuration, database backup, and local repair records before
upgrading. The installer keeps the `noosphere_postgres_data` volume and admits
an image transition only through its offline, restore-tested controller. See
[PostgreSQL pgvector Compose upgrade](docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md)
for the full stateful recovery contract.

Optional pgvector hybrid storage remains a separate activation step. Operator
how-to (llama.cpp local embeddings, no wiki toggle):
[docs/HYBRID-RETRIEVAL-ACTIVATION.md](docs/HYBRID-RETRIEVAL-ACTIVATION.md)
for a source Compose checkout, or
[docs/HERMES-INSTALLER-HYBRID.md](docs/HERMES-INSTALLER-HYBRID.md) for a
guided-installer runtime plus Hermes.
SQL/privilege contract:
[docker/hybrid-storage/README.md](docker/hybrid-storage/README.md).

## Choose an Integration

| System | What it gets | Start here |
| --- | --- | --- |
| OpenClaw | Explicit tools, optional prompt-time auto-recall, memory corpus supplement, CLI helpers | [openclaw-noosphere-memory/README.md](openclaw-noosphere-memory/README.md) |
| Codex CLI / MCP | Five native MCP tools, a Codex skill, and a secret-safe guided installer | [noosphere-mcp/README.md](noosphere-mcp/README.md) |
| Hermes Agent | First-class Hermes `MemoryProvider`, recall/get/topics/save tools, optional memory mirroring | [hermes-noosphere-memory/README.md](hermes-noosphere-memory/README.md) |
| Opencode | Prompt-time auto-recall, optional idle auto-save, manual memory tools | [opencode-noosphere-memory/README.md](opencode-noosphere-memory/README.md) |
| Kilo Code | Prompt-time auto-recall, optional idle auto-save, manual memory tools | [kilocode-noosphere-memory/README.md](kilocode-noosphere-memory/README.md) |
| REST clients | Article CRUD, ingest, memory recall/get/save, export/import, graph, health | [API Snapshot](#api-snapshot) |

Use integration-specific environment variables when multiple tools run on one
machine, for example `OPENCLAW_NOOSPHERE_API_KEY`,
`CODEX_NOOSPHERE_API_KEY`, `HERMES_NOOSPHERE_API_KEY`,
`OPENCODE_NOOSPHERE_API_KEY`, or `KILOCODE_NOOSPHERE_API_KEY`. The generic
`NOOSPHERE_API_KEY` fallback remains available for simple single-tool setups.

Install the Codex CLI integration independently of the core Docker installer:

```bash
npx -y @sweetsophia/noosphere-mcp@1.15.2 install-codex
```

The command stores the MCP launcher, skill, and approved environment-variable
names; it never writes the API key or any other environment-variable value. See
the integration guide for runtime environment and remote HTTPS-origin
configuration.

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
| **Semantic Search** | ✅ PostgreSQL FTS (default) + implemented opt-in pgvector/RRF; rollout pending | ✅ Vector + biomimetic | ⚠️ Keyword + pending vector | ✅ pgvector | ✅ Semantic + BM25 + entity fusion | ✅ Vector + BM25 hybrid |
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

Authentication (replace `<api_key>` with a scoped Noosphere API key):

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
| [docs/MEMORY-REVAMP-STATUS.md](docs/MEMORY-REVAMP-STATUS.md) | Authoritative implementation and rollout matrix for automatic capture and hybrid retrieval |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Guided installer, auditable download, upgrades, manual Compose, and credential handling |
| [docs/HERMES-INSTALLER-HYBRID.md](docs/HERMES-INSTALLER-HYBRID.md) | Installer-runtime work-VM hybrid runbook (`~/.noosphere`, sidecar A/B/C, llama.cpp) |
| [docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md](docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md) | OpenClaw install, operations, upgrade, troubleshooting, and uninstall |
| [docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md](docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md) | Guarded PostgreSQL image transition, proof, rollback, and recovery |
| [docs/NOOSPHERE-MEMORY-ARCHITECTURE.md](docs/NOOSPHERE-MEMORY-ARCHITECTURE.md) | Provider abstraction, recall orchestration, ranking, budgeting, and scheduler |
| [docs/NOOSPHERE_MEMORY_COMPARISON.md](docs/NOOSPHERE_MEMORY_COMPARISON.md) | Comparison with Hindsight, QMD, memU, mem0, and LanceDB Pro |
| [docs/NOOSPHERE-SKILL.md](docs/NOOSPHERE-SKILL.md) | Agent-facing wiki skill reference |
| [docs/OBSIDIAN-SYNC-SPEC.md](docs/OBSIDIAN-SYNC-SPEC.md) | Obsidian sync design and Markdown frontmatter contract |
| [docs/OBSIDIAN-SYNC-REVIEW.md](docs/OBSIDIAN-SYNC-REVIEW.md) | Obsidian sync review notes |
| [docs/TAXONOMY-CONCURRENCY.md](docs/TAXONOMY-CONCURRENCY.md) | Race-safe topic moves, in-use tag deletion and required migration |
| [docs/SECURITY-AUDIT-2026-04-16.md](docs/SECURITY-AUDIT-2026-04-16.md) | Security audit notes |
| [openclaw-noosphere-memory/README.md](openclaw-noosphere-memory/README.md) | OpenClaw plugin configuration and tools |
| [hermes-noosphere-memory/README.md](hermes-noosphere-memory/README.md) | Hermes Agent provider install and verification |
| [opencode-noosphere-memory/README.md](opencode-noosphere-memory/README.md) | Opencode plugin install, configuration, and tools |
| [kilocode-noosphere-memory/README.md](kilocode-noosphere-memory/README.md) | Kilo Code plugin install, configuration, and tools |

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Apache License 2.0 applies to all source code in this repository and to
the five integrations (`openclaw-noosphere-memory`, `opencode-noosphere-memory`,
`hermes-noosphere-memory`, `kilocode-noosphere-memory`, `noosphere-mcp`). It does **not**
govern the article content stored inside a Noosphere wiki instance — content
licensing is a separate decision left to the wiki operator.

Redistributions must preserve the applicable attribution notices as described
by Apache License 2.0 Section 4(d). The NOTICE file is informational and does
not add a UI-credit or hosted-service condition.
