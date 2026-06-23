# Article Persistence-Layer Sanitizer

## Overview

A Prisma client `$extends` query interceptor that acts as a **hard boundary** against injected-memory blocks (`<recall>`, `<hindsight_memories>`, `<noosphere_auto_recall>`) reaching the `article` and `articleRevision` tables in PostgreSQL.

The extension intercepts all write operations — `create`, `update`, `upsert`, `createMany`, `updateMany` — on both models. Even if a future route forgets route-level sanitization, injected blocks cannot reach those tables.

## What It Does

1. **Strips** injected-memory blocks from `content` and `excerpt` fields before write
2. **Rejects** writes where `content` becomes empty after stripping (injected-only content)
3. **Recurses** into nested Prisma write payloads (e.g. `revisions: { create: [...] }`) — handles all payload shapes including arrays, `connectOrCreate`, `{ where, data }` wrappers, and Prisma field operations (`content: { set: "..." }`)
4. **Skips** `where` clauses — query conditions are never stripped or rejected
5. **Rejects** `createMany`/`updateMany` calls that include `content` or `excerpt` fields — bulk operations are metadata-only
6. **Protects** both `article` and `articleRevision` tables

## What Stays at Route Level

- **Secret detection** — needs caller context (HTTP request, auth session) for proper error responses
- **Activity logging** — needs `route` and `kind` metadata
- **HTTP error responses** — the extension throws a plain `Error`; routes should catch via `isPersistenceLayerSanitizerError()` and convert to HTTP 400

## Files

| File | Purpose |
|------|---------|
| `src/lib/prisma-extensions/article-sanitizer.ts` | Extension implementation |
| `src/lib/prisma.ts` | Applies the extension to the Prisma client |
| `src/__tests__/persistence-layer/article-sanitizer-guard.test.ts` | Regression tests |
| `package.json` | `test:persistence-layer` script, chained into `npm test` |
| `.github/workflows/ci.yml` | CI `test` job runs persistence-layer and API tests |

## Testing

The persistence-layer regression suite (`npm run test:persistence-layer`) covers 16 cases:

| # | Test | What it proves |
|---|------|----------------|
| 1 | `article.create` strips injected blocks | Content + excerpt sanitized |
| 2 | `article.create` rejects injected-only content | Empty-after-strip throws |
| 3 | `article.update` strips injected blocks | Update path sanitized |
| 4 | `article.update` rejects injected-only content | Update path rejects empty |
| 5 | `article.upsert` strips (create branch) | Upsert create sanitized |
| 6 | `article.upsert` strips (update branch) | Upsert update sanitized |
| 7 | `article.updateMany` allows metadata-only | Bulk metadata not affected |
| 8 | `article.updateMany` rejects content fields | Bulk content blocked |
| 9 | `article.createMany` rejects content fields | Bulk create content blocked |
| 10 | Nested `revision.create` (single object) strips | Nested writes sanitized |
| 11 | Nested `revision.create` (array form) strips | Array nested writes sanitized |
| 12 | Excerpt-only stripping (clean content) | Excerpt independently sanitized |
| 13 | `{ set }` field operation strips | Prisma field ops unwrapped |
| 14 | `articleRevision.create` strips injected blocks | Revision model protected |
| 15 | `articleRevision.create` rejects injected-only | Revision model rejects empty |
| 16 | `where` clause content not stripped or rejected | Query conditions left alone |

The suite runs in CI via the `test` job (with a PostgreSQL 16 service container) and locally via `npm run test:persistence-layer`.

## Error Handling

The extension exports two type guards and one combined guard:

```typescript
isPersistenceLayerInjectedOnlyError(err)   // content empty after stripping
isPersistenceLayerBulkContentError(err)    // createMany/updateMany with content
isPersistenceLayerSanitizerError(err)      // either of the above
```

## Issue

- [#213](https://github.com/SweetSophia/noosphere/issues/213) — persistence-layer article sanitizer guard
