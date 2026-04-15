# Obsidian Shadow Sync Specification

## 1. Feature Overview and Goals

### Summary
Add a one-way "shadow sync" that writes Noosphere articles to a local Obsidian-compatible markdown vault. The database remains the only source of truth. Markdown files are a materialized mirror for reading, browsing, search, graphing, and local note workflows in Obsidian.

### Primary goals
1. Mirror every non-deleted article to a `.md` file on local disk.
2. Preserve topic hierarchy in the filesystem.
3. Include structured YAML frontmatter plus article body content.
4. Support manual or automated triggering through `POST /api/sync/obsidian`.
5. Make the vault path configurable via environment variable.
6. Optionally commit the sync result to git when the target vault is a git repo.
7. Be safe, deterministic, and idempotent.

### Non-goals
1. No bidirectional sync.
2. No importing edits from Obsidian back into the database.
3. No real-time file watching in v1.
4. No per-file conflict resolution UI in v1.
5. No support for multiple output formats beyond markdown in v1.

### Key design rule
**Database wins, always.** If a markdown file differs from the database version, the sync process rewrites it from the DB state.

---

## 2. API Endpoint Design

### Endpoint
`POST /api/sync/obsidian`

### Auth
Same auth model as other write/admin maintenance endpoints:
- API key with `WRITE` or `ADMIN` permission, or
- authenticated admin/session user

Recommendation: require `ADMIN` for production if Sophie wants this treated as an infrastructure action.

### Purpose
Trigger a sync run that exports live articles into an Obsidian vault on the server filesystem.

### Request body
```json
{
  "mode": "incremental",
  "articleIds": ["clx123", "clx456"],
  "topicIds": ["clt123"],
  "full": false,
  "clean": true,
  "git": true,
  "dryRun": false
}
```

### Request fields
- `mode`: optional, `"incremental" | "full"`, default `"incremental"`
- `articleIds`: optional array, sync only these articles
- `topicIds`: optional array, sync only articles within these topics/subtopics
- `full`: optional boolean shortcut for full rebuild
- `clean`: optional boolean, default `true`, remove stale mirrored files
- `git`: optional boolean, default `false`, request git commit for this run if enabled server-side
- `dryRun`: optional boolean, default `false`, compute result without writing files or git changes

### Behavior rules
1. If `full: true` or `mode: "full"`, rebuild all mirrored files from current DB state.
2. If `articleIds` is supplied, only those articles are considered, but cleanup may still apply to stale paths for those same article records.
3. If `topicIds` is supplied, include descendant topics.
4. If no filters are provided, sync all non-deleted articles.
5. `git: true` is advisory and only works if git integration is enabled in config and the vault is a git repo.

### Success response
```json
{
  "success": true,
  "mode": "incremental",
  "dryRun": false,
  "vaultPath": "/data/obsidian/noosphere",
  "git": {
    "enabled": true,
    "attempted": true,
    "committed": true,
    "commitHash": "abc1234",
    "branch": "main"
  },
  "stats": {
    "scanned": 128,
    "written": 12,
    "updated": 9,
    "created": 3,
    "unchanged": 116,
    "deleted": 2,
    "skipped": 0,
    "conflictsDetected": 1,
    "durationMs": 842
  },
  "manifest": {
    "updated": true,
    "path": ".noosphere-sync/manifest.json"
  },
  "warnings": [
    "1 locally modified file was overwritten from database state"
  ]
}
```

### Error responses
- `400` invalid request body or invalid combination of filters
- `401` unauthorized
- `403` authenticated but lacking permission
- `409` sync lock already active
- `500` filesystem or DB failure

### Recommended extra endpoint
Optional but useful:
- `GET /api/sync/obsidian` returns config visibility, last run summary, manifest status, git availability

---

## 3. File Structure and Naming Conventions

### Vault root
Configured by environment variable, for example:
`/data/obsidian/noosphere`

### Article path format
```text
/{topicSlugPath}/{articleSlug}.md
```

Where `topicSlugPath` is the full hierarchy from root topic to leaf topic.

### Examples
- Topic tree: `engineering/backend/prisma`
- Article slug: `connection-pooling`
- Output path:
```text
/engineering/backend/prisma/connection-pooling.md
```

### Root-topic article example
If article belongs to top-level topic `inbox`:
```text
/inbox/note-template.md
```

### Internal sync metadata directory
Reserve a hidden folder inside the vault root:
```text
/.noosphere-sync/
  manifest.json
  last-run.json
  conflicts/
  trash/
```

### Naming rules
1. Use existing DB slugs as-is.
2. Do not derive filenames from titles during sync.
3. Topic directory names come from topic slugs, not names.
4. If a topic/article slug changes in DB, sync should write the new path and remove the old mirrored path.
5. All paths must be normalized and guaranteed to stay inside the configured vault root.

### Path safety
- Reject path traversal
- Resolve and normalize every output path before writing
- Refuse writes if final path escapes vault root
- Create directories recursively as needed

---

## 4. YAML Frontmatter Format

### Format goals
- Human-readable in Obsidian
- Stable enough for deterministic rewrites
- Rich enough to track origin and sync metadata
- Compatible with current import/export style where possible

### Proposed frontmatter
```yaml
---
id: clx123abc
slug: connection-pooling
title: Connection Pooling
topic: prisma
topicPath:
  - engineering
  - backend
  - prisma
confidence: high
status: published
tags:
  - postgres
  - prisma
excerpt: How connection pooling works in Prisma 7.
authorName: Cylena
sourceUrl: https://example.com/docs
sourceType: url
lastReviewed: 2026-04-14T12:00:00.000Z
createdAt: 2026-04-01T10:00:00.000Z
updatedAt: 2026-04-15T14:32:11.000Z
noosphere:
  entity: article
  syncedAt: 2026-04-15T14:35:00.000Z
  contentHash: sha256:...
  sourceOfTruth: database
  url: /wiki/prisma/connection-pooling
---
```

### Field rules
#### Required
- `id`
- `slug`
- `title`
- `topic`
- `topicPath`
- `createdAt`
- `updatedAt`
- `noosphere`

#### Optional when present in DB
- `confidence`
- `status`
- `tags`
- `excerpt`
- `authorName`
- `sourceUrl`
- `sourceType`
- `lastReviewed`

### Notes
1. Keep `topic` as the leaf topic slug for compatibility with current import/export habits.
2. Add `topicPath` because the filesystem mirrors full hierarchy and Obsidian users may want the full context in metadata.
3. `noosphere.contentHash` is the hash of the fully rendered markdown payload or article body plus canonical metadata fields.
4. `noosphere.syncedAt` is sync-time metadata, not article update time.
5. Frontmatter order should be stable for clean diffs.

### Body content
After frontmatter, write the raw article markdown body exactly as stored in DB.
No extra heading should be injected if the content already includes its own heading structure.

---

## 5. Sync Algorithm

### Overview
Use an incremental sync with a manifest file for speed and safe cleanup. Full sync remains available for recovery.

### Manifest structure
Store a JSON manifest at:
```text
/.noosphere-sync/manifest.json
```

### Suggested manifest shape
```json
{
  "version": 1,
  "vaultPath": "/data/obsidian/noosphere",
  "lastRunAt": "2026-04-15T14:35:00.000Z",
  "articles": {
    "clx123abc": {
      "path": "engineering/backend/prisma/connection-pooling.md",
      "updatedAt": "2026-04-15T14:32:11.000Z",
      "contentHash": "sha256:...",
      "deletedAt": null
    }
  }
}
```

### High-level steps
1. Acquire sync lock.
2. Load configuration and validate vault root.
3. Load prior manifest if it exists.
4. Query target article set from DB, including topic hierarchy and tags.
5. Build canonical output path and canonical markdown payload for each article.
6. Compare current article state against manifest entry.
7. Write changed/new files.
8. Delete or archive stale mirrored files if enabled.
9. Write updated manifest and last-run summary.
10. Optionally create git commit.
11. Release lock.
12. Log ActivityLog entry and return structured stats.

### Article selection
Default query: all `Article` rows where `deletedAt IS NULL`.
Include:
- topic
- ancestor topics needed to build full path
- tags

If topic hierarchy is deep, build paths in memory by preloading relevant topics once instead of recursive N+1 queries.

### Canonical path generation
For each article:
1. Walk topic ancestors from root to leaf.
2. Join topic slugs with `/`.
3. Append `/${article.slug}.md`.
4. Normalize path.

### Canonical markdown rendering
For each article:
1. Build stable frontmatter object in fixed field order.
2. Serialize with `js-yaml` using deterministic formatting.
3. Append `---` separator and article content.
4. Compute `contentHash`.

### Change detection
Treat an article as changed if any of the following is true:
1. No manifest entry exists.
2. Manifest path differs from canonical path.
3. Article `updatedAt` differs from manifest `updatedAt`.
4. Recomputed hash differs from manifest `contentHash`.
5. Output file is missing on disk.
6. Full sync mode is requested.

### Handling unchanged files
If manifest says unchanged and file exists, skip writing.
This keeps sync fast and avoids unnecessary git churn.

### Handling renamed or moved articles
A move happens when:
- article slug changes, or
- topic slug/path changes, or
- article is reassigned to another topic

Process:
1. Write new canonical path.
2. Delete or archive old mirrored path from manifest.
3. Update manifest entry to new path/hash.

### Handling soft deletions
Because articles already support `deletedAt`, soft-deleted articles should not remain visible in the shadow vault.

Recommended default behavior:
1. If an article is now soft-deleted, remove its mirrored file.
2. If `OBSIDIAN_SYNC_TRASH_DELETIONS=true`, move removed files into `/.noosphere-sync/trash/` with timestamp suffix instead of permanent delete.
3. Remove entry from active manifest or mark `deletedAt` in last-run summary.

### Handling local file modifications / conflicts
Since DB is source of truth, local edits in Obsidian are not imported.

Recommended conflict policy:
1. If a file exists and its current on-disk hash differs from manifest `contentHash`, mark it as a local modification.
2. If DB state also requires rewrite, overwrite from DB.
3. Before overwrite, optionally copy prior local file to:
   `/.noosphere-sync/conflicts/<timestamp>-<relativePath>.md`
   when `OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES=true`.
4. Record a warning in response stats and ActivityLog.

This gives safe observability without turning the feature into two-way sync.

### Cleanup of stale files
When `clean=true`:
1. Find manifest paths whose article IDs are absent from current DB result set because of deletion, move, filter scope, or slug/path change.
2. Remove/archive those files if they are managed mirror files.
3. Never delete files outside tracked manifest entries.

Important: cleanup must only operate on files known to be managed by Noosphere.

### Locking
Prevent overlapping runs.
Options:
1. In-memory process lock for simple single-instance deploys
2. Better: DB-backed lock row or advisory lock for Docker restarts/multi-instance safety

Recommendation for this stack: use a DB-backed lock or PostgreSQL advisory lock.
If lock is busy, return `409 Conflict`.

### Activity log
Create an `ActivityLog` entry after each sync, including:
- action: `sync.obsidian`
- entityType: `system`
- description: summary of run
- metadata: stats, mode, dryRun, git outcome, warnings
- authorName: API caller or `System`

---

## 6. Git Integration Approach (Optional)

### Goal
If the configured vault is a git repo, optionally commit sync changes so the Obsidian mirror is versioned independently.

### Preconditions
1. `git` binary is available in container/runtime.
2. Vault root contains `.git/`.
3. Git integration is enabled by config.
4. Sync run requested git commit, or config says always commit.

### Flow
1. After file writes and manifest update, run `git status --porcelain` in vault root.
2. If no changes, do nothing.
3. If changes exist:
   - `git add` only managed content paths and `.noosphere-sync/`
   - create a single commit
4. Return commit hash in API response.

### Commit message
Recommended format:
```text
chore(noosphere): sync obsidian shadow vault 2026-04-15T14:35:00Z
```

Optional richer format:
```text
chore(noosphere): sync obsidian vault

Created: 3
Updated: 9
Deleted: 2
Warnings: 1
```

### Safety rules
1. Do not run `git init` automatically.
2. Do not push to remote in v1.
3. Do not use `git add .`.
4. Only stage managed paths to avoid committing unrelated vault files.
5. If git commit fails, sync itself should still succeed unless config explicitly requires git success.

### Response behavior
If file sync succeeds but git fails:
- return `success: true`
- include git failure in `warnings`
- set `git.committed = false`

---

## 7. Configuration

### Required env vars
```env
OBSIDIAN_SYNC_ENABLED=true
OBSIDIAN_VAULT_PATH=/data/obsidian/noosphere
```

### Optional env vars
```env
OBSIDIAN_SYNC_GIT_ENABLED=false
OBSIDIAN_SYNC_AUTO_CLEAN=true
OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES=true
OBSIDIAN_SYNC_TRASH_DELETIONS=true
OBSIDIAN_SYNC_MANIFEST_PATH=.noosphere-sync/manifest.json
OBSIDIAN_SYNC_LAST_RUN_PATH=.noosphere-sync/last-run.json
OBSIDIAN_SYNC_TIMEOUT_MS=60000
```

### Recommended meanings
- `OBSIDIAN_SYNC_ENABLED`: master feature flag
- `OBSIDIAN_VAULT_PATH`: absolute path to vault root on server/container host
- `OBSIDIAN_SYNC_GIT_ENABLED`: allow git operations
- `OBSIDIAN_SYNC_AUTO_CLEAN`: remove/archive stale mirrored files by default
- `OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES`: backup locally modified files before overwrite
- `OBSIDIAN_SYNC_TRASH_DELETIONS`: archive deleted mirror files instead of unlinking immediately
- `OBSIDIAN_SYNC_MANIFEST_PATH`: relative path within vault root
- `OBSIDIAN_SYNC_LAST_RUN_PATH`: relative path within vault root
- `OBSIDIAN_SYNC_TIMEOUT_MS`: fail long-running syncs cleanly

### Optional future env vars
```env
OBSIDIAN_SYNC_GIT_BRANCH=main
OBSIDIAN_SYNC_GIT_AUTHOR_NAME=Noosphere Sync
OBSIDIAN_SYNC_GIT_AUTHOR_EMAIL=noosphere@example.local
OBSIDIAN_SYNC_ALWAYS_COMMIT=false
```

---

## 8. Implementation Steps

1. **Add config parsing**
   - Create `src/lib/obsidian-sync/config.ts`
   - Validate feature flag, vault path, and optional git settings
   - Ensure vault path is absolute and writable

2. **Add sync domain module**
   - Create `src/lib/obsidian-sync/index.ts`
   - Expose `runObsidianSync(options)`
   - Keep route handler thin

3. **Add topic path resolver**
   - Load all relevant topics once
   - Build ancestor chains for each article topic
   - Return deterministic `topicPath` arrays and relative output paths

4. **Add markdown renderer**
   - Create canonical frontmatter serializer
   - Render stable markdown payload
   - Compute SHA-256 content hash

5. **Add manifest read/write support**
   - Read previous manifest if present
   - Validate manifest version
   - Atomically write updated manifest after successful sync

6. **Add filesystem sync layer**
   - Ensure directories exist
   - Write changed files atomically using temp file + rename if practical
   - Delete or archive stale files safely
   - Never touch unmanaged files

7. **Add local modification detection**
   - Compare current disk hash vs manifest hash before overwrite
   - Preserve changed local copies when enabled
   - Collect warnings/stats

8. **Add sync locking**
   - Implement PostgreSQL advisory lock or equivalent DB lock
   - Return `409` if a run is already active

9. **Add optional git integration**
   - Detect `.git`
   - Stage only managed files
   - Commit when requested and allowed
   - Surface commit hash/warnings in result

10. **Add API route**
   - Implement `src/app/api/sync/obsidian/route.ts`
   - Validate auth and request body
   - Call sync service and map errors to HTTP responses

11. **Add activity logging**
   - Write `ActivityLog` entry for each run
   - Include run stats and warnings in metadata

12. **Add last-run status file**
   - Write `/.noosphere-sync/last-run.json` with timestamp, result, and summary
   - Useful for debugging outside the DB

13. **Add docs and operator notes**
   - Update README or ops docs with env vars, usage, and caveats
   - Document that this is one-way mirror only

14. **Optional follow-up**
   - Add cron/heartbeat trigger later if desired
   - Keep API-triggered sync as the initial release

---

## 9. Test Plan

### Unit tests
1. **Path building**
   - builds correct nested topic path
   - handles root topics
   - handles deep hierarchies
   - rejects invalid/path-traversal output

2. **Frontmatter rendering**
   - stable field order
   - optional fields omitted cleanly
   - valid YAML output
   - correct markdown payload shape

3. **Hashing/change detection**
   - unchanged article skips write
   - updated content triggers write
   - moved path triggers rewrite + cleanup
   - missing file triggers rewrite

4. **Manifest handling**
   - reads missing manifest as empty state
   - validates version
   - updates entries correctly

5. **Conflict detection**
   - local modification detected when disk hash differs from manifest
   - backup path created when preservation enabled
   - warning emitted

6. **Git helper**
   - no-op when repo clean
   - stages only managed files
   - parses commit hash
   - surfaces failure without crashing sync

### Integration tests
1. **Initial full sync**
   - create articles/topics in test DB
   - run sync
   - assert expected directory/file tree exists
   - assert frontmatter and content correctness

2. **Incremental sync**
   - run once
   - update one article
   - run again
   - assert only changed file rewritten

3. **Topic move / slug change**
   - move article to another topic or rename topic slug
   - run sync
   - assert new path exists and old path removed/archived

4. **Soft delete**
   - mark article deleted
   - run sync
   - assert mirrored file removed or moved to trash

5. **Local edit overwrite**
   - manually modify mirrored file
   - update article in DB
   - run sync
   - assert DB version wins
   - assert backup created when enabled

6. **Dry run**
   - run with `dryRun: true`
   - assert stats are reported
   - assert no filesystem changes
   - assert no git commit

7. **Git repo sync**
   - point sync at temp git repo
   - run sync with `git: true`
   - assert commit created and hash returned

8. **Concurrent sync protection**
   - start sync and hold lock
   - start second sync
   - assert `409 Conflict`

### Manual verification checklist
1. Open vault in Obsidian and confirm topic folders look sane.
2. Open several mirrored articles and confirm frontmatter is readable.
3. Confirm graph/search works on mirrored markdown.
4. Confirm local edit gets overwritten on next authoritative sync.
5. Confirm unrelated notes in the vault are untouched.
6. Confirm git history is clean and meaningful when enabled.

---

## Recommended v1 Decisions

To keep implementation practical, v1 should ship with these defaults:
1. Manual/API-triggered sync only
2. Incremental sync with manifest
3. Soft-deleted articles removed from mirror
4. Local edits overwritten, optionally backed up
5. Git commit optional and best-effort
6. No reverse import from Obsidian

This gives a robust one-way shadow vault without turning Noosphere into a bidirectional sync engine.