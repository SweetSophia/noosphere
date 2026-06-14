# Changelog

All notable changes to Noosphere are documented in this file. Dates are in
Europe/Berlin (project maintainer's local time).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.10.1] - 2026-06-14

Patch release bundling four bug fixes and security patches merged since
v1.10.0 (2026-06-10). No breaking changes, no new features, no DB schema
changes.

### Security

- **Bound legacy JSON request bodies (DoS amplification, issue #192)**
  ([#196](https://github.com/SweetSophia/noosphere/pull/196)): 14 legacy
  JSON write routes called `await request.json()` with no body-size or
  nesting-depth limit, allowing an unauthenticated client to pin
  arbitrary memory by streaming a deeply-nested or oversized payload
  into `JSON.parse`. Replaced with three shared helpers in
  `src/lib/api/body.ts`:
  - `readBoundedJsonBody(request, maxBytes)` — streaming reader that
    enforces a per-route byte cap via the `Content-Length` header and
    the chunked stream (rejects oversized chunks before accumulating).
  - `safeJsonParse(raw)` + `assertJsonDepth` — a streaming
    nesting-depth scanner capped at 20 levels. `assertJsonDepth`
    clamps unmatched closing delimiters at zero so a leading `}}}}`
    payload cannot offset the counter and bypass the guard. Malformed
    JSON still surfaces through the normal `JSON.parse` 400.
  - `readBoundedJsonObject(request, maxBytes)` — rejects `null`,
    arrays, and primitive JSON with 400 before any route destructures
    the body, closing the `Cannot destructure property 'x' of 'body'
    as it is null` 500 path that affected `PATCH /api/keys/:id`.
  Per-route `*_JSON_BODY_MAX_BYTES` constants preserve each endpoint's
  existing content contract (e.g. `/api/answer` keeps the ~1 MiB
  ceiling it already validated against, `/api/lint` returns 200 only
  when the body is empty, 400 for malformed JSON, 413 for
  size/depth). `getJsonBodyError(error)` centralizes the 413 vs 400
  mapping for `RequestBodyTooLargeError` and `JsonDepthExceededError`
  so the public response is stable across routes. The same depth
  guard is now applied to the three sync routes (`/api/sync/import-apply`,
  `/api/sync/import-scan`, `/api/sync/conflict-preferences`) and
  `memory/settings` was simplified to use `readBoundedJsonObject`
  directly. Coverage: unit tests in `body.test.ts`, static tests in
  `bounded-json-routes.test.ts` (asserting every legacy JSON route
  uses the bounded reader and the three sync routes use
  `safeJsonParse`), and an authenticated integration test in
  `bounded-json-routes.integration.test.ts` covering empty-body 200,
  malformed 400, oversized 413, deeply-nested 413, and null-body 400
  against `PATCH /api/keys/:id`.
- **Bump `tsx` 4.21.0 → 4.22.4 and `esbuild` 0.27.7 → 0.28.1 across
  all workspaces** ([#190](https://github.com/SweetSophia/noosphere/pull/190)):
  `esbuild` 0.28.1 is the first patched release for
  [GHSA-g7r7-m6w7-qqqr](https://github.com/advisories/GHSA-g7r7-m6w7-qqqr).
  `tsx` 4.22.4 picks up the dependency's own security bump. No
  functional changes; build is reproducible via `npm ci`.

### Fixed

- **Bound topic tree queries (issue #144)**
  ([#195](https://github.com/SweetSophia/noosphere/pull/195)):
  `GET /api/topics` previously issued an unbounded recursive
  topic-tree query, so a database with thousands of topics would
  return an unbounded response. Added a 500-topic contract with a
  501-row sentinel read, an explicit
  `409 TOPIC_TREE_LIMIT_EXCEEDED` response, scope-aware bounded
  ancestor loading, and a POST creation guard at the global ceiling
  so the same client cannot create the topics that overflow the read
  path. Route-level coverage for normal, scoped-hidden, overflow, and
  blocked-create behavior is included.

### Refactored

- **Consolidate PATCH restricted-tags validation into a shared helper**
  ([#191](https://github.com/SweetSophia/noosphere/pull/191)): the
  restrictedTags permission and same-set merge logic was duplicated
  between POST and PATCH article handlers. Both routes now route
  through `applyRestrictedTagsUpdate`, eliminating the drift surface
  for the issue #136 access-control contract.

## [1.10.0] - 2026-06-10

### Changed

- **License: MIT → Apache 2.0.** All source code in this repository and in the
  four plugins (`openclaw-noosphere-memory`, `opencode-noosphere-memory`,
  `hermes-noosphere-memory`, `kilocode-noosphere-memory`) is now licensed under
  the Apache License, Version 2.0. The license was previously MIT. See
  [LICENSE](LICENSE) and [NOTICE](NOTICE).
  - Practical effects:
    - **Attribution** must now follow the NOTICE file format (e.g. a
      "Powered by Noosphere" link in any hosted UI footer) — Apache 2.0
      Section 4(d) requires the NOTICE content to be reproduced in Derivative
      Works.
    - **Modifications** to source files must be marked (Section 4(b)).
    - **Trademark**: forks must use a name distinct from "Noosphere" to avoid
      implying endorsement (Section 6).
    - **Patent grant**: contributors grant patent rights to users, with a
      defensive termination clause if patent litigation is initiated (Section 3).
  - This change applies **from this commit forward**. Code previously
    distributed under MIT (any commit on or before `f5e0b51` / v1.9.1) remains
    MIT-licensed under those terms.

### Fixed

- **Schema drift on `Article.restrictedTags`** ([#143](https://github.com/SweetSophia/noosphere/issues/143),
  [#185](https://github.com/SweetSophia/noosphere/pull/185)): the live database
  had a GIN index hand-rolled into the original `20260514220000_add_restricted_tags_scope`
  migration, but `prisma/schema.prisma` never declared it. As a result,
  `prisma migrate diff` was actively trying to drop the index. The schema now
  declares `@@index([restrictedTags(ops: ArrayOps)], type: Gin, name: "Article_restrictedTags_idx")`,
  matching the live index. No DB change required.

### Added

- **`NOTICE` file** with structured attribution requirements and a note
  clarifying that the Apache 2.0 license covers the source code only, not
  wiki article content (which is a separate decision left to the operator).
- **Search cache invalidation versioning tests** ([#184](https://github.com/SweetSophia/noosphere/pull/184)):
  cover the cache version bump behavior so future changes don't silently
  serve stale results.

## [1.9.1] - 2026-06-06

### Security

- **Import route validates that the caller can assign `restrictedTags`**
  ([#136](https://github.com/SweetSophia/noosphere/issues/136),
  [#181](https://github.com/SweetSophia/noosphere/pull/181)): a scoped WRITE
  API key can no longer create or update an article with a `restrictedTag`
  scope it does not hold. New helper `resolveImportRestrictedTags` enforces
  the same semantics as the create path, with the added nuance that omission
  preserves the existing restricted tag set on updates rather than clearing
  it.

### Build

- Mark sync vault filesystem access as runtime-only ([#180](https://github.com/SweetSophia/noosphere/pull/180)):
  prevents `next build` from attempting to read the user's local Obsidian
  vault during the static build pass.

## [1.9.0] - 2026-05-30

- No detailed changelog entry was kept prior to this version. Notable changes
  in the 1.9.0 series included the obsidian-sync revamp, the promotion and
  backfill pipeline, and the memory provider refactor. Refer to the commit
  history (`git log v1.8.0..v1.9.0`) for the full set of changes.

[Unreleased]: https://github.com/SweetSophia/noosphere/compare/v1.10.1...HEAD
[1.10.1]: https://github.com/SweetSophia/noosphere/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/SweetSophia/noosphere/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/SweetSophia/noosphere/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/SweetSophia/noosphere/compare/v1.8.0...v1.9.0
