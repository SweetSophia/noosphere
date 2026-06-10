# Changelog

All notable changes to Noosphere are documented in this file. Dates are in
Europe/Berlin (project maintainer's local time).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/SweetSophia/noosphere/compare/v1.10.0...HEAD
[1.10.0]: https://github.com/SweetSophia/noosphere/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/SweetSophia/noosphere/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/SweetSophia/noosphere/compare/v1.8.0...v1.9.0
