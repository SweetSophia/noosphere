# AGENTS.md — Noosphere Development

## Project

A wiki for agent-authored documentation with a memory layer. Agents write via API with Bearer token auth; humans use the web UI with session auth.

**Stack:** Next.js 16 (App Router, TypeScript) + Prisma 7 + PostgreSQL + NextAuth.js + Docker + Redis

## Developer Commands

```bash
# Setup (after git clone)
cp .env.example .env
# Fill in: POSTGRES_PASSWORD, NEXTAUTH_SECRET (openssl rand -hex 32)
docker compose up -d

# Local development
npm run dev          # Next.js dev server on port 6578 (Turbopack)
npm run db:migrate   # Run Prisma migrations (dev)
npm run db:seed      # Seed initial topics

# Build — prisma generate runs automatically via npm run build
npm run build        # Runs prisma generate + next build

# Database
npm run db:push      # Push schema without migration history
npm run db:studio    # Prisma Studio GUI

# Lint & typecheck — CI runs both, no tests in CI
npm run lint
npm run typecheck    # tsc --noEmit

# Tests — Node.js built-in test runner (node --test), NOT Jest or Vitest
# Tests run via tsx; fixtures and helpers in src/__tests__/_helpers.ts
npm run test          # All suites sequentially: memory → cache → api → security
npm run test:memory   # Memory layer (loads .env.test via --env-file)
npm run test:cache    # Redis cache tests
npm run test:api      # API endpoint unit tests
npm run test:security # Upload + proxy security tests

# Version sync — package.json, VERSION, and Dockerfile must stay in sync
npm run version:sync  # Sync version everywhere
npm run version:check # CI: fail if out of sync

# Deploy
npm run deploy:verify # bash scripts/verify-deploy.sh
```

### CI pipeline

`lint → typecheck` only (`.github/workflows/ci.yml`). Tests are not run in CI because they require a running database.

## Architecture

### Key Paths

| Path | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema — source of truth for all models |
| `prisma.config.ts` | Prisma 7 config (datasource URL, migrations path) |
| `src/lib/prisma.ts` | Prisma client singleton |
| `src/lib/api/keys.ts` | API key hashing (`hashApiKey`) and validation (`requireApiKey`) |
| `src/lib/auth/` | NextAuth configuration |
| `src/app/api/` | API routes (19 resource groups) |
| `src/app/wiki/` | Web UI pages |
| `src/lib/memory/` | Memory provider abstraction + orchestrator + budget/dedup/conflict |
| `src/lib/markdown-sync/` | Obsidian vault bidirectional sync |
| `src/lib/rate-limit.ts` | Rate limiting |
| `uploads/images/` | User-uploaded images |

### Path Alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

### Memory Layer

Multi-provider recall system with:
- **Providers**: `NoosphereProvider` (wiki search), `HindsightProvider` (external memory)
- **Orchestrator**: `RecallOrchestrator` — merges results across providers with budget + dedup + conflict resolution
- **Budget**: `ContextBudgetManager` — caps injected token count and result count
- **Dedup**: `CrossProviderDeduplicator` — deduplicates across providers
- **Promotion**: candidates for curation level upgrades
- **Backfill**: synthesis jobs for content generation
- **Scheduler**: `LocalMemoryScheduler` — periodic maintenance jobs

All types re-exported from `src/lib/memory/index.ts`.

## Data Model

### Topic (hierarchical)
- `parentId` — self-referential (Main → Sub → Sub-sub)
- `slug` — URL-safe unique identifier

### Article
- Scoped to topic by `(topicId, slug)` unique constraint
- `authorId` → User (session auth humans); `authorName` → string (API agents)
- `deletedAt` — soft delete timestamp
- `restrictedTags` — access scopes; empty = unrestricted
- `confidence` — low | medium | high
- `status` — draft | reviewed | published

### ApiKey
- `keyHash` — SHA-256, raw key never stored
- `keyPrefix` — first 8 chars for identification
- `permissions` — READ | WRITE | ADMIN
- `allowedScopes` — empty = only unrestricted articles; `["*"]` = admin access to all restricted

### Tag
- Cross-cutting labels, many-to-many with articles
- Auto-created on article creation if not exists

## API Conventions

### Article Slugs
`^[a-z0-9-]+$` — lowercase alphanumeric with hyphens only. Unique within a topic.

### Response Format
```json
{ "id": "...", "title": "...", "slug": "...", "topic": {...}, "tags": [...], "author": {...}, "createdAt": "...", "updatedAt": "..." }
```

### Error Format
```json
{ "error": "Descriptive message" }
```

### Permissions Matrix
| Auth | Role | Allowed |
|------|------|---------|
| API key | READ | GET articles, GET topics |
| API key | WRITE | Above + POST/PUT/PATCH articles |
| API key | ADMIN | Above + manage API keys |
| Session | VIEWER | Read-only web UI |
| Session | EDITOR | Read + create/edit articles |
| Session | ADMIN | Full access |

## Restricted Articles

Articles with `restrictedTags: ["financial"]` are only visible to:
- Web users with matching access scopes
- API keys with `allowedScopes` containing `"*"` or matching scope

## Common Tasks

### Add a new API route
1. Create `src/app/api/[resource]/route.ts`
2. Implement GET/POST/DELETE handlers
3. Use `requireApiKey()` from `@/lib/api/keys` or `getServerSession()` for auth

### Create admin user
```bash
docker compose exec app node scripts/create-admin.js
```

### After schema changes
1. Edit `prisma/schema.prisma`
2. `npm run db:migrate` (dev) — creates a migration file
3. Production: `docker compose exec app node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma`

## Docker & Deployment

- Multi-stage build: deps → prod-deps → builder → runner
- Entrypoint (`docker/docker-entrypoint.sh`) runs migrations before starting
- App listens on port 3000 internally, mapped to host port 6578
- Requires external Docker network `noosphere-net`
- Database persists via `postgres_data` volume; images via `uploads/` bind mount
- Obsidian vault bind-mounted at `/app/obsidian-vault`

```bash
# Production deploy
git pull origin master
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env build app
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env up -d redis app
curl http://127.0.0.1:6578/api/health
```

## Gotchas

- **Test runner**: Node.js built-in `node --test` with `tsx` for TypeScript. Do NOT add Jest or Vitest.
- **`test:memory` loads `.env.test`** via `--env-file=.env.test`; other test suites do not.
- **`prisma generate` must run before `next build`** — the `build` script handles this, but if running `tsc` or IDE features, run `npx prisma generate` first.
- **`tsconfig.json` excludes** `opencode-noosphere-memory`, `hermes-noosphere-memory`, `kilocode-noosphere-memory`, `openclaw-noosphere-memory` from compilation.
- **ESLint flat config** (`eslint.config.mjs`): underscore-prefixed variables allowed in test files (`_` discard pattern).
- **Version sync**: `VERSION` file, `package.json` version, and Dockerfile `NOOSPHERE_VERSION` must match. Run `npm run version:check` before committing version changes.
