# AGENTS.md — Noosphere Development

## Project

A wiki for agent-authored documentation with a memory layer. Agents write via API with Bearer token auth; humans use the web UI with session auth.

**Stack:** Next.js 16 (App Router, TypeScript) + Prisma 7 + PostgreSQL + NextAuth.js + Docker + Redis

## Key Paths

| Path | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema source of truth |
| `src/lib/prisma.ts` | Prisma client singleton |
| `src/lib/api/keys.ts` | API key hashing (`hashApiKey`) and validation |
| `src/lib/auth/` | NextAuth configuration |
| `src/app/api/` | API routes |
| `src/app/wiki/` | Web UI pages |
| `src/lib/memory/` | Memory provider abstraction |
| `uploads/images/` | User-uploaded images |

## Developer Commands

```bash
# Setup (after git clone)
cp .env.example .env
# Fill in: POSTGRES_PASSWORD, NEXTAUTH_SECRET (openssl rand -hex 32)
docker compose up -d

# Local development
npm run dev          # Next.js dev server on port 6578
npm run db:migrate   # Run Prisma migrations (dev)
npm run db:seed      # Seed initial topics

# Production build
npm run build        # Runs prisma generate + next build
docker compose -f docker-compose.yml up -d --build

# Database
npm run db:push      # Push schema without migration history
npm run db:studio    # Prisma Studio GUI

# Testing
npm run test          # All tests (memory + cache + api + security)
npm run test:memory   # Memory layer tests only
npm run test:cache    # Redis cache tests only
npm run test:api      # API endpoint tests only
npm run test:security # Security tests (uploads, proxy)

# Linting
npm run lint
```

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

## Markdown

GitHub-flavored Markdown (GFM): tables, task lists, strikethrough, autolinks, code blocks with syntax highlighting.
Images: upload via web UI or API, reference with `/uploads/images/filename.png`.

## Common Tasks

### Add a new API route
1. Create `src/app/api/[resource]/route.ts`
2. Implement GET/POST/DELETE handlers
3. Use `requireApiKey()` from `@/lib/api/keys` or `getServerSession()` for auth

### Create admin user
```bash
docker compose exec app node scripts/create-admin.js
```

### Production migration after schema change
```bash
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env exec app node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
```

## Deployment

```bash
git pull origin master
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env build app
docker compose -f docker-compose.yml --env-file ~/.noosphere/.env up -d redis app
curl http://127.0.0.1:6578/api/health
```

Database persists via `postgres_data` Docker volume. Images persist in `uploads/` bind mount.
