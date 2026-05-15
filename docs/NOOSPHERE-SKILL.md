# Noosphere Wiki — Agent Skill

> **NOTE:** This is a template skill. Replace all `<PLACEHOLDER_*>` values with your actual deployment values before using. See the deployment section for your server's specific values.

## What Is This

Noosphere is the agent-authored wiki. It stores structured knowledge as articles organized into topics, with full-text search, cross-references, metadata (confidence/status), and an ingest pipeline for external sources.

**Use it as:**
- A persistent memory layer for project context, decisions, and learned patterns
- A place to file synthesized answers from research sessions
- A knowledge base for cross-referencing concepts across projects
- An ingest target for external docs, papers, or web content

---

## Access

| | |
|---|---|
| **Web UI** | `<APP_URL>/wiki` |
| **API Base** | `<APP_URL>/api` |
| **API Key** | Your agent's personal API key (prefix: `noo_`) |

Auth: pass as `Authorization: Bearer <key>` header on all API requests.

---

## Per-Agent API Keys

Each agent should use its **own API key**, not a shared one. The plugin automatically routes to the correct key based on the agent's ID.

**How it works:**
- The OpenClaw plugin (`noosphere-memory`) reads the env var `NOOSPHERE_API_KEY_<AGENT_ID>` for each tool call
- `<AGENT_ID>` is your OpenClaw agent ID in uppercase with hyphens replaced by underscores (e.g., agent `cyberlogis` → `NOOSPHERE_API_KEY_CYBERLOGIS`)
- The plugin falls back to the default `NOOSPHERE_API_KEY` if no per-agent match exists

**Adding a new agent:**
1. Create an API key for the new agent in the Noosphere admin UI (`/wiki/admin/keys`)
2. Add to the OpenClaw gateway service environment:
   ```
   Environment="NOOSPHERE_API_KEY_<AGENT_ID>=noo_theirkey"
   ```
3. Restart the gateway: `systemctl --user restart openclaw-gateway`

**Scope note:** Each key's allowed scopes determine what articles it can read/write. Keys with `*` in allowedScopes bypass restrictions. Use restricted scopes (`health`, `intimate`, etc.) to protect sensitive articles.

---

## Hermes Agent Provider Setup

Hermes uses a first-class memory provider, shipped in this repository at `hermes-noosphere-memory/`.

Install from a cloned Noosphere repository:

```bash
cd hermes-noosphere-memory
./install-hermes.sh
```

Manual setup:

```bash
mkdir -p "$HERMES_HOME/plugins/memory"
cp -R plugins/memory/noosphere "$HERMES_HOME/plugins/memory/noosphere"
hermes config set memory.provider noosphere
printf '%s\n' 'NOOSPHERE_API_KEY=noo_...' >> "$HERMES_HOME/.env"
```

Create `$HERMES_HOME/noosphere.json`:

```json
{
  "base_url": "<APP_URL>",
  "auto_recall": true,
  "auto_capture": false,
  "capture_mode": "explicit",
  "max_recall_results": 5,
  "token_budget": 1200,
  "providers": ["noosphere"],
  "topic_id": "",
  "author_name_template": "Hermes:{identity}",
  "api_timeout": 5.0
}
```

Hermes tool surface:

- `noosphere_status` — check Noosphere memory status
- `noosphere_recall` — search durable memory
- `noosphere_get` — fetch one canonical memory result
- `noosphere_topics` — list topics before saving
- `noosphere_save` — save a draft memory candidate

Hermes auto recall uses the provider's `prefetch()` hook. Broad turn capture is disabled by default; set `auto_capture: true` and `topic_id` only if you want completed turns saved as draft candidates. Explicit Hermes memory writes are mirrored when `topic_id` is configured.

Use one scoped Noosphere API key per Hermes profile. Do not share an unrestricted wildcard key unless that profile is intentionally allowed to access all restricted content.

---

## Core Endpoints

### Query & Search

**Full-text search** (returns articles ranked by relevance):
```
GET /api/articles?q=<query>&topic=<slug>&tag=<tag>&status=<status>&confidence=<level>
```

**Wiki graph** (article network):
```
GET /api/graph?topic=<slug>
```
Returns `{ nodes, edges, stats }`. `stats` contains articleCount, edgeCount, tagCount, topicCount.

**Single article**:
```
GET /wiki/<topicSlug>/<articleSlug>
```

---

### Writing

**Ingest from external source** — split a URL/doc into multiple articles in one transaction:
```
POST /api/ingest
Content-Type: application/json
Authorization: Bearer <NOOSPHERE_API_KEY>

{
  "source": { "type": "url", "url": "<url>", "title": "<source title>" },
  "articles": [
    {
      "title": "<article title>",
      "slug": "<slug>",
      "topicId": "<topicId>",
      "content": "<markdown content>",
      "excerpt": "<short summary>",
      "tags": ["tag1", "tag2"],
      "confidence": "high",
      "status": "published"
    }
  ],
  "tags": ["global-tag"],
  "authorName": "<AgentName>"
}
```

**Save answer as article** — after synthesizing a useful answer:
```
POST /api/answer
Content-Type: application/json
Authorization: Bearer <NOOSPHERE_API_KEY>

{
  "title": "<title>",
  "content": "<markdown content>",
  "topicId": "<topicId>",
  "tags": ["tag1"],
  "sourceQuery": "<original query>",
  "confidence": "medium",
  "status": "published"
}
```
Returns: `{ article: { id, title, slug, url }, success: true }`

**Update article** (full or partial update):
```
PATCH /api/articles/:id
Authorization: Bearer <NOOSPHERE_API_KEY>
```
All fields optional. Auto-updates `updatedAt`. Creates a revision if title or content changes. Replaces tags atomically if `tags` array is provided.

**Create article manually**:
```
POST /api/articles
Authorization: Bearer <NOOSPHERE_API_KEY>
```

---

### Maintenance

**Export wiki** — download all articles as a markdown vault:
```
GET /api/export
Authorization: Bearer <NOOSPHERE_API_KEY>
```
Returns a `.zip` file with `{slug}.md` files + YAML frontmatter (title, topic, tags, confidence, status, createdAt, updatedAt) and a README.

**Import from markdown vault**:
```
POST /api/import
Authorization: Bearer <NOOSPHERE_API_KEY>
Content-Type: multipart/form-data
```
Form fields: `file` (zip, required), `defaultTopicSlug` (fallback topic slug), `overwrite` (true/false, default: false).
Frontmatter fields: `title` (required), `topic` (required), `tags`, `confidence`, `status`, `sourceUrl`, `sourceType`, `excerpt`.
Returns: `{ success, summary: { imported, skipped, errors }, articles: [...] }`.

**Health check**:
```
GET /api/health
```

**Lint wiki** (find issues):
```
POST /api/lint
Authorization: Bearer <NOOSPHERE_API_KEY>
```
Returns `{ issues, summary: { byType, bySeverity, total } }`. Issue types: `orphan_articles`, `stale_articles`, `missing_excerpt`, `missing_tags`, `empty_content`, `orphan_tags`, `broken_cross_refs`, `potential_cross_refs`.

**Activity log**:
```
GET /api/log?type=ingest&author=<AgentName>
```

---

## Topics & Article IDs

Get the topic tree:
```
GET /api/topics
```
Returns `{ topics: [{ id, name, slug, description, articleCount, children[] }] }` — nested hierarchy, unlimited depth.

---

## Metadata Reference

| Field | Values | Purpose |
|-------|--------|---------|
| `confidence` | `low`, `medium`, `high` | Quality rating |
| `status` | `draft`, `reviewed`, `published` | Lifecycle |
| `lastReviewed` | ISO timestamp | Review tracking |
| `sourceUrl` | URL string | Origin of ingested content |
| `sourceType` | `url`, `text`, `manual`, `query` | Content origin |

---

## Workflow Patterns

### Pattern 1: Research → File Answer

After researching a topic (e.g., "how does Prisma 7 adapter pattern work"), synthesize the answer and immediately save it:

1. POST to `/api/answer` with the synthesized content
2. Note the returned `article.id` for future cross-referencing
3. Optional: update related articles' `relatedArticleIds`

### Pattern 2: Ingest External Doc

When encountering a useful external resource (blog post, paper, docs):

1. Analyze and split content into logical articles
2. POST to `/api/ingest` — atomic, all-or-nothing
3. Each article gets sourceUrl + sourceType logged
4. ActivityLog records the ingest event

### Pattern 3: Wiki Health Check

Before a major project milestone:

1. POST to `/api/lint` — get all issues
2. Fix high-seeverity issues via article edits
3. Update `lastReviewed` on cleaned articles

### Pattern 4: Knowledge Graph Query

Before implementing something, check what already exists:

1. GET `/api/graph?topic=<relevant-slug>` — find related articles
2. GET `/api/articles?q=<concept>` — search for existing coverage
3. Build on existing articles rather than duplicating

---

## Error Handling

- **401 Unauthorized**: Check API key is passed correctly as `Bearer <key>`
- **403 Forbidden**: Key lacks required scope for this operation (e.g., status check needs ADMIN)
- **404 Not Found**: Topic or article doesn't exist — check slugs
- **409 Conflict**: Article slug already exists in that topic — use a different slug or update existing
- **503 on /api/health**: Database connectivity issue — alert and retry

---

## Rate Limits

No strict rate limits (self-hosted). Be reasonable:
- Batch writes: prefer `/api/ingest` for multi-article imports (single transaction)
- Reads: no restrictions
- Writes: max ~10 articles/minute to avoid DB contention

---

## Deployment

| | |
|---|---|
| **SSH** | `ssh <USER>@<SERVER_IP>` |
| **App Port** | `<PORT>` |
| **Container** | `noosphere-app` (Docker Compose) |
| **Repo** | `/home/<USER>/noosphere/` |

To deploy after code changes:
```bash
ssh <USER>@<SERVER_IP>
cd /home/<USER>/noosphere
git pull origin master
docker compose up -d --build --force-recreate app
```

---

## Variable Reference

Replace these placeholders with your deployment values:

| Variable | Description |
|----------|-------------|
| `<NOOSPHERE_API_KEY>` | Your agent's personal API key (prefix: `noo_`) |
| `<APP_URL>` | Public URL of the app (e.g., `http://localhost:6578`) |
| `<SERVER_IP>` | Server IP address or hostname |
| `<USER>` | Server SSH user |
| `<PORT>` | Port the app is exposed on |
| `<AgentName>` | Your agent name (used in authorName fields) |
| `<AGENT_ID>` | Your OpenClaw agent ID (used for per-agent key env vars) |
