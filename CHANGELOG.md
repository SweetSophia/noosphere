# Changelog

All notable changes to Noosphere are documented here.

## [Unreleased]

### Added

- **`GET /api/export`** — Export all articles as a markdown vault (`.zip` of `.md` files with YAML frontmatter). Auth: API key or session.
- **`POST /api/import`** — Import articles from a markdown vault zip. Supports `overwrite=true` for updating existing articles. Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN).
- **`PATCH /api/articles/:id`** — Full update support for articles including title, slug, content, excerpt, topicId, tags, status, confidence, lastReviewed. Creates revision on title/content change. Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN).
- **`ArticleRelation` join table** — Replaced `relatedArticleIds` JSON text field with a proper many-to-many join table. Related articles now render as clickable title links in the UI.
- **Unlimited topic hierarchy depth** — Topic tree API and UI now support arbitrary nesting depth (previously hard-coded to 3 levels).
- **Graph API O(1) edge deduplication** — Replaced O(n²) `edges.some()` checks with O(1) Set lookups using composite keys. Scales gracefully to thousands of articles.

### Changed

- **`GET /api/topics`** — Tree built in JavaScript using Map instead of Prisma `include` chain. Unlimited nesting depth.
- **`GET /api/articles`** — `relatedArticles` field now returns full article objects `{id, title, slug, topicSlug}` instead of raw CUID arrays.
- **`POST /api/articles`** — Creates `ArticleRelation` records in same transaction as article creation.
- **`POST /api/ingest`** — Creates `ArticleRelation` records for ingested articles.
- **Topic tree in UI** — Recursive `TopicNode` component renders all nested levels with depth indicators.

### Security

- Page-level auth guards — edit, new article, and admin log pages now redirect to login before rendering (previously only enforced at server-action level).

## [0.1.0] — 2026-04-11

### Added

- **Core wiki**: Topic hierarchy, articles with markdown, tags, revision history
- **Auth**: NextAuth.js (humans) + API keys (agents)
- **Web UI**: Browse, view, edit, create articles; topic navigation; full-text search
- **Activity log**: Timeline of wiki events (ingest, create, update, delete, lint)
- **Wiki graph API**: Article connectivity with topic, tag, and cross-reference edges
- **Lint endpoint**: Health checks for orphan articles, stale content, missing metadata
- **Ingest endpoint**: Bulk article creation from external URLs
- **Answer-to-page flow**: Quick article creation for synthesized knowledge
- **Article metadata**: Confidence (low/medium/high), status (draft/reviewed/published), lastReviewed timestamps
- **Image upload**: Local filesystem storage with path traversal protection
- **Soft delete & trash**: Move articles to trash, restore, permanently delete
- **Markdown preview**: Live preview tab in article editor
- **Prisma 7**: Adapter pattern with `@prisma/adapter-pg` + `pg` Pool (no `url` in schema.prisma)
