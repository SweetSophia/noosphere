# Article Persistence-Layer Sanitizer

## Overview

The Noosphere Prisma client includes a query-layer extension that automatically
strips injected-memory blocks (`<recall>`, `<hindsight_memories>`,
`<noosphere_auto_recall>`) from `content` and `excerpt` fields on every
`article.create`, `article.update`, and `article.upsert` call.

This is the **hard boundary** for injected-memory defense. Even if a future
code path forgets to call route-level sanitization helpers, injected blocks
can never reach the database.

## Where It Lives

| File | Purpose |
|------|---------|
| `src/lib/prisma-extensions/article-sanitizer.ts` | Extension definition |
| `src/lib/prisma.ts` | Applied via `client.$extends(articleSanitizerExtension)` |
| `src/__tests__/persistence-layer/article-sanitizer-guard.test.ts` | Regression tests |

## What It Does

1. **Strips** injected-memory blocks from `content` and `excerpt` in
   `article.create`, `article.update`, and `article.upsert` data payloads.
2. **Rejects** writes where `content` becomes empty after stripping (throws
   `PERSISTENCE_LAYER_INJECTED_ONLY_ERROR`).
3. **Recurses** into nested write payloads (e.g., `revisions.create` inside
   `article.create`).
4. **Does NOT intercept** `updateMany` (used for bulk metadata updates like
   publish/unpublish that never touch content).

## What It Does NOT Do

- **Secret detection**: stays at the route/action level where caller context
  (HTTP request, auth session) is available for error responses.
- **Activity logging**: stays at the route/action level where `route` and
  `kind` metadata is known.
- **HTTP error responses**: the extension throws a plain `Error`. Routes
  should catch this and convert to HTTP 400 if it surfaces.

## Caller-Context Limitations

Because the extension operates at the Prisma query layer, it does not have
access to:

- The HTTP request object or route path
- The authenticated user session
- The API key scope context

This means strip observability (activity log entries) must remain at the
route level. The persistence-layer guard is a silent backstop — it logs
nothing, but it guarantees data safety.

## Testing

The regression test suite proves:

1. Direct `prisma.article.create()` with injected blocks strips them.
2. Direct `prisma.article.create()` with injected-only content is rejected.
3. Direct `prisma.article.update()` with injected blocks strips them.
4. Direct `prisma.article.update()` with injected-only content is rejected.
5. `article.updateMany()` (metadata-only) is not affected.
6. Nested `revisions.create` inside `article.create` is stripped.

## Related

- Issue: [#213](https://github.com/SweetSophia/noosphere/issues/213)
- Predecessor PRs: #206, #209, #210, #212 (route-level hardening)
- Neutral package: `@sweetsophia/noosphere-injected-memory`
