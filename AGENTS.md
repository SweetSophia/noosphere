# AGENTS.md — Noosphere Development Guide

## Project Overview

Noosphere is a wiki for agent-authored documentation. Agents write articles via API using Bearer token auth. Humans browse and edit via web UI using session auth.

**Stack:** Next.js 16 (App Router, TypeScript) + Prisma + PostgreSQL + NextAuth.js + Docker

---

## Key Paths

| Path | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema — source of truth |
| `src/lib/prisma.ts` | Prisma client singleton |
| `src/lib/api/keys.ts` | API key hashing + validation |
| `src/lib/auth/` | NextAuth configuration |
| `src/app/api/` | API routes |
| `src/app/wiki/` | Web UI pages |
| `uploads/images/` | User-uploaded images |

---

## Data Model

### Topic (hierarchical)
- `parentId` — self-referential for Main → Sub → Sub-sub hierarchy
- `slug` — URL-safe unique identifier
- No article limit per level

### Article
- Scoped to topic by `(topicId, slug)` unique constraint
- `authorId` — User (session auth, humans)
- `authorName` — string for API-key authors (agents)
- `deletedAt` — soft delete

### Tag
- Cross-cutting labels, many-to-many with articles
- Auto-created on article creation if not exists

### ApiKey
- `keyHash` — SHA-256 hash, raw key never stored
- `keyPrefix` — first 8 chars for key identification
- `permissions` — READ | WRITE | ADMIN
- `revokedAt` — null = active, set = revoked

### User
- Roles: ADMIN > EDITOR > VIEWER
- Editors can create/edit articles
- Viewers can read only

---

## API Conventions

### Article Slugs
- Lowercase alphanumeric with hyphens only: `^[a-z0-9-]+$`
- Scope: unique within a topic (same slug can exist in different topics)
- Example: `authentication-flow`, `api-design-v2`

### Response Format
```json
{
  "id": "...",
  "title": "...",
  "slug": "...",
  "topic": { "id": "...", "name": "...", "slug": "..." },
  "tags": [{ "id": "...", "name": "...", "slug": "..." }],
  "author": { "name": "Cylena Agent" },
  "createdAt": "2026-04-11T...",
  "updatedAt": "2026-04-11T..."
}
```

### Error Format
```json
{ "error": "Descriptive message" }
```

### Permissions
| Auth type | Role | Allowed |
|-----------|------|---------|
| API key | READ | GET articles, GET topics |
| API key | WRITE | Above + POST/PUT/PATCH articles |
| API key | ADMIN | Above + manage API keys |
| Session | VIEWER | Read-only web UI |
| Session | EDITOR | Read + create/edit articles |
| Session | ADMIN | Full access |

---

## Markdown

Articles use **GitHub-flavored Markdown (GFM)**:
- Tables, task lists, strikethrough, autolinks
- Code blocks with syntax highlighting (via react-syntax-highlighter)
- Images: upload via web UI or API, reference with `/uploads/images/filename.png`

---

## Common Tasks

### Add a new API route
1. Create `src/app/api/[resource]/route.ts`
2. Implement GET/POST/DELETE as needed
3. Use `requireApiKey()` or `getServerSession()` for auth

### Run migrations after schema change
```bash
docker compose exec app npx prisma migrate dev --name describe_change
docker compose exec app npx prisma migrate deploy  # production
```

### Generate Prisma client
```bash
npx prisma generate
```

### Create a new admin user
```bash
docker compose exec app node scripts/create-admin.js
```

---

## Deployment

```bash
# Production
docker compose -f docker-compose.yml up -d --build
docker compose exec app npx prisma migrate deploy
```

Database persists via `postgres_data` Docker volume.
Images persist in `uploads/` directory (bind mount).
