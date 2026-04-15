# Code Review: Obsidian Shadow Sync

## Summary
The implementation is well-structured and closely follows the spec. The three-file architecture (config → sync engine → route) is clean, auth patterns match existing routes, and the core sync algorithm is sound. However, there are several security, correctness, and robustness issues that should be addressed before production use—most critically: the advisory lock fallback is broken, the cleanup logic incorrectly deletes articles when using filters, the frontmatter YAML serialization is non-standard and will break on special characters, and there's no vault path normalization (trailing slashes cause `safePath` bypass).

## Security Issues

### HIGH — Advisory lock fallback uses env var as mutex (index.ts ~`acquireLock`)
The fallback when `pg_try_advisory_lock` fails uses `process.env.OBSIDIAN_SYNC_LOCK` as an in-process "mutex". This is not a mutex at all—it's a flag that never gets cleared on success paths (only on `releaseLock` failure), and it's shared across all requests. If the advisory lock ever fails (e.g., Prisma query error), concurrent syncs will race. The env var is also visible to all code in the process.

**Fix:** Remove the env var fallback. If advisory locks fail, just return `false` (deny the lock).

### HIGH — `safePath` fails if vaultPath has a trailing slash (index.ts ~`safePath`)
`resolve("/data/vault/", "../etc/passwd")` → `/data/etc/passwd`, which starts with `/data/vault/` → passes the check. But `resolve("/data/vault", "../etc/passwd")` → `/data/etc/passwd`, which does NOT start with `/data/vault/` → correctly rejected. The issue is asymmetric behavior depending on whether `vaultPath` has a trailing `/`. If configured as `/data/vault/`, traversal succeeds.

**Fix:** Normalize both paths: `resolve(vaultPath) + "/"` check, or use `resolved.startsWith(resolve(vaultPath) + sep)`.

### MEDIUM — Git spawn commands are vulnerable to argument injection via paths (index.ts ~`gitAddManaged`)
The `managedPaths` array is built from article slugs and topic slugs from the database. While these come from the DB (not user input directly), they are not validated or escaped before being passed to `spawn("git", ["add", "--", ...managedPaths])`. A crafted slug like `--force` would be handled by `--` separator, but paths containing shell metacharacters could still cause issues with the `spawn` approach. Low risk since `spawn` doesn't use a shell, but slug validation at write time is not guaranteed.

**Fix:** Validate slugs are alphanumeric-with-hyphens only during sync, or at minimum during path building.

### MEDIUM — GET endpoint leaks vault path and config to any authenticated user (route.ts ~`GET`)
The GET handler returns `vaultPath`, `gitEnabled`, and all config details to any authenticated user or API key holder (READ permission suffices). This leaks server filesystem paths.

**Fix:** Require ADMIN/WRITE permission for GET, or redact sensitive fields.

### LOW — No request body size limit on POST (route.ts)
The request body is parsed with `request.json()` without size limits. While the body is expected to be small (just options), there's no guard.

**Fix:** Add a size check or rely on Next.js default body parser limits.

## Correctness Issues

### HIGH — Cleanup deletes articles outside filter scope (index.ts ~cleanup section)
When `clean=true` and `articleIds` or `topicIds` filters are used, the cleanup loop removes manifest entries whose IDs are not in `currentArticleIds`. But `currentArticleIds` only contains articles matching the filter. This means: syncing article A with `articleIds: ["A"]` will **delete** the mirrored files for articles B, C, D etc. because they're "not in the current result set."

**Fix:** When filters are active, only clean up entries whose articles were soft-deleted in the DB (not just absent from the filtered result). One approach: query for actually-deleted articles separately, or skip cleanup when filters are active.

### HIGH — Frontmatter uses `JSON.stringify` instead of YAML serialization (index.ts ~`buildFrontmatter`)
Each field is serialized as `${key}: ${JSON.stringify(value)}`. This is NOT valid YAML for many cases:
- Arrays: `tags: ["postgres","prisma"]` — valid YAML but not human-friendly; Obsidian expects `tags: [postgres, prisma]` or a list
- Nested objects (`noosphere`): `noosphere: {"entity":"article",...}` — valid YAML flow style but fragile
- Strings with special chars: a title like `Hello: "World"` would become `title: "Hello: \"World\""` — JSON escaping, not YAML escaping
- `null` values are already filtered, but `undefined` values could produce `undefined` as a string

The spec calls for `js-yaml` serialization with deterministic formatting, which the export route already uses.

**Fix:** Use `js-yaml.dump()` like the export route does, with a stable key order. The current approach will break on any title/content with colons, quotes, or special characters.

### MEDIUM — `computeContentHash` includes placeholder syncedAt but `renderMarkdown` uses real syncedAt
The hash is computed on a placeholder, but the actual written file has the real `syncedAt`. This means the manifest's `contentHash` never matches the on-disk file hash. This breaks conflict detection: `fileHash()` reads the full file and compares against manifest's `contentHash`, which will always differ because the syncedAt in the file differs from the placeholder used for hashing.

**Fix:** Either hash the final rendered output (excluding syncedAt), or compare only the stable portion. The current design intent is good but the implementation is inconsistent — `fileHash(safe)` computes hash of the full file including syncedAt, then compares against `existingEntry.contentHash` which was computed with the placeholder. They'll never match for the same content.

### MEDIUM — `full` shortcut and `mode` interaction has edge case (route.ts ~mode parsing)
`const mode = body["mode"] === "full" || body["full"] === true ? "full" : "incremental"` — if `mode: "full"` and `full: false`, mode is still "full". The validation then rejects if articleIds/topicIds are present. The spec says `full` is a "shortcut" for full rebuild but the logic makes `mode` take precedence silently.

**Fix:** Document or reconcile: `full: true` sets mode to full regardless of `mode` field. Consider treating them as independent (full overrides mode).

### LOW — `writeLastRun` passes empty object instead of actual result (index.ts ~`writeLastRun` call)
```ts
writeLastRun(vaultPath, config, {} as SyncResult);
```
The last-run file is always written with an empty object, making it useless for debugging.

**Fix:** Build the result object first, then write it to last-run.

### LOW — Manifest is updated even for unchanged articles in incremental mode
The manifest is always updated with the latest data for every scanned article, even `unchanged` ones. This means every sync writes the manifest even if nothing changed.

**Fix:** Minor, but consider only updating manifest entries that actually changed.

## Performance Issues

1. **No batching for directory creation**: `ensureDir` is called per file with `mkdirSync({ recursive: true })`. For large vaults, this is redundant. Pre-compute needed directories and create them once.

2. **Synchronous file I/O throughout**: The entire sync engine uses `readFileSync`, `writeFileSync`, `existsSync`, `renameSync`. This blocks the Node.js event loop for the entire sync duration. For a vault with hundreds of articles, this could block for seconds. Consider using `fs/promises` or offloading to a worker thread.

3. **Full topic table loaded every sync**: `prisma.topic.findMany()` with no select loads all topic fields every time. Fine for small wikis but should use `select: { id, slug, parentId, name }` to be lean.

4. **Descendant topic collection is O(n²)**: `collectDescendants` iterates all topics for each input topic. Could be linear with a proper tree traversal.

## Code Quality Issues

1. **`parseInt` shadows global `parseInt`** (config.ts): The local `parseInt` function shadows the global. Rename to `parseEnvInt` or similar.

2. **Missing `export const dynamic = "force-dynamic"`**: Other API routes that use Prisma need this. The sync route doesn't have it, which could cause Next.js to cache the response.

3. **No TypeScript strictness on Prisma query where clause**: `articleWhere` is typed as `Record<string, unknown>` instead of using Prisma's generated `ArticleWhereInput` type. This loses type safety.

4. **`spawn` without timeout**: Git commands (`isGitRepo`, `gitStatusPorcelain`, etc.) have no timeout. If git hangs, the sync hangs forever.

5. **Error swallowing in `trashFile`**: The catch block in `trashFile` silently ignores failures. Should at minimum log a warning.

6. **`SyncOptions.callerKeyId` is never used**: It's accepted but never referenced in the sync engine.

## Consistency Issues

1. **Auth pattern mostly matches**: The POST route uses the same auth structure as `/api/lint` and `/api/import` (API key + session dual check). Good.

2. **Permission level differs**: Spec recommends ADMIN for production. The route allows WRITE API keys but requires ADMIN for session users. This inconsistency should be documented or unified. The spec says "require ADMIN for production if Sophie wants this treated as infrastructure."

3. **ActivityLog `type` field**: Other routes use types like `"lint"`, `"ingest"`. The sync uses `"sync.obsidian"` with a dot. Not a problem functionally but breaks the pattern. Consider `"sync"` or `"sync-obsidian"`.

4. **No `export const dynamic`**: The import and other routes include `export const dynamic = "force-dynamic"`. The sync route should too.

5. **Frontmatter serialization differs from export route**: The export route uses `js-yaml.dump()`. The sync route uses manual `JSON.stringify` per field. These should be consistent.

6. **Missing `entityType` in ActivityLog**: The spec mentions `entityType: "system"` but the ActivityLog model doesn't have an `entityType` field. The implementation correctly omits it (matching the schema), but the spec should be updated.

## Missing Features / Incomplete

1. **No test files**: No unit or integration tests found. The spec has a detailed test plan but nothing is implemented.

2. **No `OBSIDIAN_SYNC_GIT_BRANCH` / `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` support**: These are listed in the spec as optional future env vars but aren't parsed in config. The git commit hardcodes the author.

3. **No vault path writability check**: Config validates that the path is absolute but doesn't check if it's writable.

4. **No timeout enforcement**: `OBSIDIAN_SYNC_TIMEOUT_MS` is parsed but never used. Long syncs will run indefinitely.

5. **`lastRunPath` config is parsed but `writeLastRun` writes empty data**: The last-run feature is non-functional.

6. **No `GET` last-run/manifest data**: The GET endpoint returns config but not the last run summary or manifest status as the spec suggests.

7. **Dry-run returns incomplete stats**: Dry-run doesn't compute what *would* be written, just skips the writes. Stats like `written`, `created`, `updated` are all 0 in dry-run mode, which isn't useful for previewing.

## Test Coverage

**None.** No test files exist for the obsidian sync feature. The spec outlines comprehensive unit and integration tests, but none are implemented. This is the most significant gap for production readiness.

At minimum, the following should be tested:
- Path building and traversal rejection
- Frontmatter rendering (especially special characters)
- Change detection logic
- Manifest read/write
- Conflict detection and archival
- Cleanup with and without filters
- Lock acquisition/release
- Dry-run stats accuracy

## Recommended Fixes (Priority Order)

1. **Fix cleanup logic for filtered syncs** (HIGH — data loss bug): Only clean up articles confirmed deleted in DB, not merely absent from the filtered result set.

2. **Fix frontmatter serialization** (HIGH — broken output): Replace manual `JSON.stringify` per field with `js-yaml.dump()` like the export route uses. This will break on titles with colons, quotes, etc.

3. **Fix `safePath` trailing slash vulnerability** (HIGH — security): Normalize `vaultPath` by stripping trailing slashes before comparison.

4. **Fix advisory lock fallback** (HIGH — race condition): Remove env var mutex; fail cleanly if advisory lock unavailable.

5. **Fix hash consistency for conflict detection** (MEDIUM): Ensure manifest hash and on-disk hash are comparable. Either hash the stable portion consistently or compute hash of the final rendered file minus syncedAt.

6. **Fix `writeLastRun` to write actual result** (LOW): Pass the real sync result instead of an empty object.

7. **Add `export const dynamic = "force-dynamic"`** to route.ts (LOW — caching bug).

8. **Add timeout enforcement** using `OBSIDIAN_SYNC_TIMEOUT_MS` (MEDIUM — operational safety).

9. **Switch to async file I/O** (`fs/promises`) to avoid blocking the event loop (MEDIUM — performance).

10. **Add basic test coverage** — at minimum path safety, frontmatter rendering, and change detection unit tests.

11. **Rename `parseInt` in config.ts** to avoid shadowing global (LOW — code quality).

12. **Use Prisma `ArticleWhereInput` type** instead of `Record<string, unknown>` (LOW — type safety).
