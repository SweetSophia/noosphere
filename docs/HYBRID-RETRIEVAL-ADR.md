# ADR: Authorization-safe hybrid retrieval

- Status: Proposed
- Issue: [#261](https://github.com/SweetSophia/noosphere/issues/261)
- Date: 2026-07-12
- Decision owners: Noosphere maintainers

## Context

Noosphere currently retrieves its own articles with PostgreSQL full-text search. The Noosphere memory provider builds one weighted document from the title, excerpt, content, and tags, applies article and restricted-scope filters, and ranks matches with `ts_rank`. This is precise for shared terms but cannot recover semantically related articles that use different language.

Issue #261 proposes pgvector embeddings and Reciprocal Rank Fusion (RRF). That change crosses database distribution, article persistence, remote data egress, background work, authorization, pagination, caching, and failure handling. It must therefore be delivered as a staged epic rather than as one application patch.

This ADR fixes the contracts that later implementation PRs must preserve. It does not enable embeddings, install pgvector, or change retrieval behavior.

## Decision

### 1. Scope and rollout

The first hybrid implementation will affect only the built-in Noosphere memory provider. Wiki search remains full-text-only until recall quality and operations are proven.

Hybrid recall will be disabled by default. Enabling it requires all of the following:

1. an activated pgvector storage feature;
2. an immutable embedding profile selected as active;
3. a healthy, separately operated embedding worker;
4. sufficient ready-vector coverage; and
5. explicit operator consent for any remote content or query egress.

Missing or stale embeddings do not exclude an article from lexical eligibility. The article can still be returned when it ranks within the lexical leg's fixed candidate depth; only the vector leg requires a ready, current embedding.

For a profile, an eligible article is non-deleted, has a canonical document, and satisfies that profile's local/remote and restricted-content egress policy. Ready-vector coverage is the percentage of eligible articles whose vector is ready for the same profile, current embedding revision, and current canonical content hash. Initial profile activation requires at least 95% ready-vector coverage. Uncovered or newly changed articles remain lexical-only; the numerator, denominator, and excluded-policy counts are exposed separately without article identifiers.

### 2. Database image and compatibility

The bundled database currently uses PostgreSQL 16 on Alpine. The upstream pgvector 0.8.1 images use Debian Bookworm or Trixie; there is no equivalent Alpine tag. Noosphere will not reuse an Alpine-created physical data volume in a Debian-based container.

The bundled path will instead use a Noosphere-owned, multi-architecture database image that:

- is based on an exact PostgreSQL 16 Alpine release and digest;
- compiles an exact pgvector release from a verified source artifact;
- publishes its PostgreSQL, Alpine, pgvector, and source identities as image metadata; and
- remains data-directory compatible with the existing bundled runtime family.

The first infrastructure PR will build and test that image in CI without changing production Compose. A later PR may switch bundled Compose only after a copied-volume rehearsal verifies backup and restore, PostgreSQL major version, volume identity, data counts, collation health, extension availability, and rollback.

External PostgreSQL is a separate compatibility boundary. Hybrid storage is an optional feature activation, not an unconditional standard Prisma migration. Activation must preflight extension availability and permissions, install and verify the extension and feature schema transactionally, and record its feature-schema version. The application must continue to run keyword-only against a supported external database when hybrid retrieval is not activated.

The activation design must pass `migrate deploy`, shadow-database, `migrate diff`, and `db push` drift tests before it can ship. Feature activation owns the vector DDL. Its Prisma representation must be selected from evidence in that drift matrix; candidates include introspected ignored models and `Unsupported("vector")` fields. Standard Prisma commands must neither create vector storage on an extension-less keyword-only database nor drop activated feature objects. Vector tables are accessed through a narrow raw-SQL repository; generated Prisma CRUD does not read or write vector values.

### 3. Immutable embedding profiles

An embedding profile is immutable after creation. Its identity covers every property that can change vector meaning:

- provider protocol and operator-classified locality (`local` or `remote`);
- exact model identifier and operator-supplied revision;
- vector dimensions;
- distance metric and normalization policy;
- embedded-document schema version;
- deterministic maximum UTF-8 input bytes; and
- endpoint identity fingerprint, excluding credentials and query parameters.

Generic OpenAI-compatible servers are not assumed to report a trustworthy model revision. The operator must supply one; changing it creates a new profile.

Multiple profiles may coexist. Activating a new profile is an explicit operation allowed only after a configured coverage threshold is met. Existing rows are not rewritten in place during a model migration.

The vector column may hold different dimensions across profiles, so storage must enforce:

- a denormalized dimensions value tied to the immutable profile identity;
- `vector_dims(embedding) = dimensions` for ready vectors;
- finite numeric values and exact response length before persistence; and
- dimension-guarded distance expressions, so PostgreSQL cannot evaluate a vector operator against a mismatched row before a profile filter.

Exact vector search is the initial implementation. No ANN index is created over the mixed-dimension vector column. Approximate indexes require a separately approved, measured design that isolates a fixed dimension and profile, such as a profile-specific table or guarded expression/partial index; they cannot assume the shared column is indexable across profiles.

### 4. Canonical embedded document and privacy

The initial embedded document contains only the stored article title, excerpt, and content after existing persistence sanitization. Document schema `noosphere-article-v1` serializes fields in this exact order:

```text
noosphere-article-v1
TITLE
<title>
EXCERPT
<excerpt-or-empty-string>
CONTENT
<content>
```

Each value is normalized with Unicode NFKC, then CRLF and lone CR are converted to LF. No other whitespace is trimmed, collapsed, or rewritten. The serialized document ends with one LF. It is UTF-8 encoded and truncated to the longest prefix that is at most the profile's `maxInputBytes` and ends on a Unicode code-point boundary. The SHA-256 content hash is computed over those exact submitted bytes. The schema ID, normalization rules, field order, truncation rule, and byte limit are part of profile identity; changing any of them creates a new document schema/profile. No tokenizer is involved in this first version.

Topic and tag metadata are excluded so topic/tag edits do not fan out embedding jobs. Chunking and multi-vector articles are deferred.

Embedding providers receive article text; query embeddings receive user query text. Remote egress is therefore opt-in and disabled by default. Credentials remain in environment or secret storage and never enter database rows, cache keys, logs, metrics, or error bodies.

Restricted articles are local-only by default. Sending them to a remote profile requires a second, explicit restricted-content egress consent. When an article transitions from unrestricted to restricted, every existing remote-profile vector row for that article is hard-deleted in the same transaction; zeroing or soft deletion is not sufficient. If restricted-content remote egress consent is active, the trigger enqueues the new restricted revision; otherwise pending remote jobs are cancelled. Local-profile vectors may be retained when the local profile remains eligible. When an article becomes eligible for a remote profile again, it is re-enqueued rather than restoring retained vector bytes. Remote clients must enforce bounded connection and response timeouts, response-size limits, finite values, exact dimensions, and sanitized error categories.

Consent is checked dynamically, not only when a job is created. Revoking general remote egress hard-deletes all vectors for every affected remote profile; revoking restricted-content egress hard-deletes the affected restricted-article vector rows. Revocation also cancels queued work and prevents new provider calls. Workers recheck consent immediately before dispatch and again before publication, including for leased work. A request that has already reached a remote provider cannot be recalled, but its response is not persisted after revocation. Re-enabling consent requires an explicit readiness transition and re-enqueues eligible work rather than silently resuming stale leases or vector bytes.

Soft-deleting an article hard-deletes all of its local- and remote-profile vector rows and cancels its pending jobs in the same transaction. Restore creates new work for the current embedding revision; it never restores retained vector bytes.

### 5. Atomic dirty tracking and worker ownership

Article writes are dispersed across API routes, server actions, imports, ingestion, memory save, answer generation, Markdown sync, trash, and restore. Route-level hooks are not a sufficient consistency boundary.

A database trigger will atomically mark embedding work in the same transaction as relevant article changes. It covers:

- create;
- title, excerpt, or content changes;
- soft delete and restore; and
- restricted-scope changes.

Because the canonical document excludes topic and tags, their edits do not enqueue work. A future document-schema version that includes them must add the corresponding fan-out triggers before activation.

One database-backed embedding-job table is sufficient; no separate outbox table or external broker is planned. Jobs support leases, `SKIP LOCKED`, bounded concurrency, exponential backoff with jitter, maximum attempts, sanitized error codes, and a terminal failed state. Enqueue operations coalesce safely per article and profile.

Next.js request processes do not own durable background work. A separate CLI process runs as a Compose worker service when the hybrid profile is enabled. It defines startup readiness, graceful shutdown, lease recovery, concurrency, backpressure, and health reporting. External deployments run the same worker command under their process manager.

Each relevant article change advances a monotonic embedding revision. A worker captures the revision and canonical content hash before calling the provider, then publishes a vector only if the article is still eligible and its revision and hash still match. Otherwise it discards the response and releases the stale lease, relying exclusively on the database trigger to have created or advanced work for the current revision. The worker never enqueues replacement work. Delete and privacy transitions cannot be undone by a late provider response.

Backfill uses the same idempotent job path and is resumable. Vector readiness, staleness, active-profile changes, and backfill transitions invalidate the search-cache version without placing endpoint data or credentials in cache keys.

### 6. Authorization-safe exact hybrid recall

Lexical and vector candidates must originate from one shared authorized base relation. Before either leg ranks or limits candidates, it applies:

- `deletedAt` filtering;
- caller-provided topic, tag, status, and confidence filters;
- the caller's restricted-tag scopes; and
- for the vector leg only, the active profile plus ready and current revision/hash state.

Restricted-scope semantics remain canonically defined by `buildScopeFilter()` and `canAccessScopes()` in `src/lib/api/scope-filter.ts`, publicly re-exported through `src/lib/api/auth.ts`. `buildArticleSearchFilters()` in `src/lib/memory/article-search.ts` is the existing raw-SQL adapter for those semantics; it is not a second source of truth. The authorization-conformance matrix covers unrestricted articles; `undefined` scopes; empty `[]` scopes; non-empty disjoint-scope denial; overlapping-scope access; and `"*"` bypass across the canonical predicate, Prisma filter, raw-SQL adapter, candidate generation, and final hydration. Phase A3 establishes shared adapters and proves the predicate/Prisma/raw-SQL cases; Phase C must run the complete matrix against hybrid candidate generation and final hydration before merge. Hybrid retrieval must not introduce another scope interpretation.

The hybrid query must preserve current semantics: it does not silently add a published-only filter when the caller did not request one. Final hydration re-applies authorization and deletion checks to close time-of-check/time-of-use gaps. On a cache miss, candidate generation, fusion, final authorized hydration, normalization, and pagination execute in one database statement/snapshot. The complete fused set is filtered by final authorization before it supplies the normalization denominator or page rows.

The first RRF version is deterministic:

- ranks start at 1;
- `k = 60`;
- each article contributes `1 / (k + rank)` from each leg in which it appears;
- candidates deduplicate by article ID;
- each leg retrieves a fixed 200 authorized candidates for every hybrid request;
- final offset and limit apply only after fusion; and
- ties sort by fused score descending, best individual rank ascending, `updatedAt` descending, then article ID ascending.

Hybrid mode is limited to requests where `offset + limit <= 200`. Deeper inspection pages use the existing lexical path rather than presenting unstable partial fusion. The fixed candidate universe prevents a later page from changing earlier fused ranks or the normalization denominator.

After final authorization, the fused candidate list is normalized before pagination. Its highest non-zero raw RRF score becomes the denominator for the provider's existing 0–1 relevance contract: `relevanceScore = rawRrfScore / maxRawRrfScore`. The top authorized fused result therefore remains 1.0, matching current Noosphere-provider behavior. Raw RRF score, lexical rank, and vector rank are retained as bounded provider metadata for inspection and are not used as cross-provider scores directly.

Cache identity includes the embedding profile ID, document-schema version, hybrid algorithm version, RRF parameters, candidate depth, and all existing filters and scopes.

Cache entries contain the complete bounded fused candidate set as article IDs and bounded rank metadata only, never a single page. They never contain article title, excerpt, content, vector bytes, canonical-document bytes, or article revision. The serialized value is authenticated with a server-held, domain-separated MAC covering its complete cache identity, ordered IDs, and rank metadata; a missing, invalid, incomplete, or version-mismatched value is a cache miss and emits only bounded, content-free diagnostics. A cache hit is not an authorization decision: one current database statement must hydrate the entire cached candidate set, re-apply authorization and deletion checks, discard ineligible rows, renormalize the remaining complete set, and only then paginate. The highest remaining authorized non-zero score therefore retains the 1.0 contract. If hydration leaves fewer than `offset + limit` authorized candidates while the cached set originally contained at least that many, the request discards the cached value and executes the cache-miss query once against the current authorized base relation; a short page is returned only when that current fused set is genuinely shorter.

### 7. Failure policy

The existing strict full-text query and bounded conversational fallback remain the lexical behavior.

Only classified transient embedding dependencies may degrade a request to lexical-only retrieval: connection timeout, temporary network failure, provider rate limiting, provider 5xx, or insufficient ready-vector coverage during rollout. Degradation emits bounded, content-free diagnostics and metrics.

Invalid configuration, missing required feature schema, dimension mismatch, non-finite vectors, SQL errors, authorization invariant failures, and malformed provider responses are correctness faults. They must surface through readiness/status and operator-visible errors rather than being silently relabeled as an outage.

Shadow mode is explicit opt-in because it can incur cost and egress. It must not alter returned rankings.

### 8. Quality and observability gates

The implementation requires:

- deterministic fake-provider tests;
- real PostgreSQL 16 plus pgvector integration tests;
- trigger coverage for every relevant article transition;
- stale-response, lease recovery, retry, and backfill tests;
- cache-transition tests;
- restricted-scope and final-hydration leakage tests;
- remote-egress consent tests;
- timeout and classified-fallback tests; and
- a versioned relevance benchmark with an approved lexical baseline and hybrid acceptance threshold.

Metrics cover coverage, queue depth, age, latency, classified errors, fallback rate, and RRF overlap. Labels must be bounded and must not contain article IDs, queries, content, endpoints, or credentials.

### Phase acceptance criteria

The deferred security and operations details are merge gates for their implementation phases:

- **Phase A3:** define and test separate least-privilege database roles for feature activation and worker runtime; the activation role may perform only the required feature DDL, while the worker role receives narrowly bounded job/vector DML and eligible article reads. Establish shared authorization adapters and prove canonical predicate, Prisma-filter, and raw-SQL conformance. Enforce profile immutability in the database; restrict profile creation and activation to an explicit administrative permission; set and validate a numeric upper bound for `maxInputBytes`; and record pgvector source, license, and redistribution evidence for the activated feature schema.
- **Phase B:** set numeric defaults and hard limits for worker concurrency, lease duration, and maximum attempts, plus numeric warning and critical thresholds for durable pending queue depth and age. Backpressure limits claims and chunks operator-initiated backfills; it never rejects article writes or drops/coalesces away the latest dirty revision. Authenticate the worker with the A3 runtime role, and define authenticated transport plus response-validation requirements for local and remote provider endpoints.
- **Phase C:** store the complete bounded fused set as only IDs and rank metadata in authenticated cache entries and require one-statement authorized hydration, post-hydration renormalization, and pagination on every hit. Run the complete authorization-conformance matrix against hybrid candidate generation and final hydration; derive cache identity from a cryptographic hash of normalized query text rather than raw text; HMAC the canonical scope set with a server-held secret rather than exposing plaintext scopes in cache keys; and test invalid/missing MACs, incomplete values, cache tampering, scope changes, deletion, and revocation transitions.
- **Phase D:** suppress aggregate coverage and overlap metrics below a documented anonymity floor; audit consent and eligibility revocations without content-bearing fields; and alert on abrupt eligible-denominator or coverage changes so a write-capable actor cannot silently hold activation below the 95% gate.

## Delivery sequence

1. **Phase 0 — this ADR:** settle contracts without runtime changes.
2. **Phase A1 — non-production capability:** build and test the pinned Alpine-based pgvector database image in CI.
3. **Phase A2 — bundled upgrade rehearsal:** prove backup, rollback, volume compatibility, collation health, extension availability, and data integrity without changing production Compose.
4. **Phase A2b — bundled Compose switch:** adopt the rehearsed database image in bundled and installer Compose only after every A2 gate passes; verify the live volume and rollback procedure again.
5. **Phase A3 — optional feature storage:** add preflighted feature activation, immutable profiles, vector storage, jobs, triggers, and raw-SQL integration tests.
6. **Phase B — provider and worker:** add the OpenAI-compatible client, separate worker, conditional publication, backfill, privacy controls, and cache invalidation.
7. **Phase C — exact hybrid recall:** add the shared authorized candidate relation, query embeddings, deterministic RRF, final authorization, and classified fallback behind the disabled flag.
8. **Phase D — rollout and quality:** run opt-in shadow evaluation, meet coverage and relevance gates, document operations, and decide whether wiki search or ANN indexing warrants a later ADR.

Each implementation phase is a separate PR with its own rollback and verification evidence.

## Consequences

This plan delays visible semantic search until its persistence, privacy, and database boundaries are safe. It also adds a maintained database image and worker process. In return, article writes remain available during provider outages, restricted content cannot influence unauthorized rankings, model changes do not corrupt existing vectors, and bundled database upgrades are rehearsed rather than assumed.

## Rejected alternatives

- **Switch directly to the upstream pgvector Debian image:** rejected because the current physical data volume was created under Alpine and an in-place libc/collation transition is not a safe default.
- **Install pgvector in the standard Prisma migration chain immediately:** rejected because it would make the extension mandatory for keyword-only external deployments.
- **Generate embeddings synchronously in article routes:** rejected because provider outages would block writes and the repo has many non-route write paths.
- **Enqueue from every application write path:** rejected because coverage would drift as new paths are added.
- **Run the worker inside Next.js:** rejected because request processes do not provide durable job ownership.
- **Store one mutable vector per article:** rejected because model and dimension changes require coexistence and controlled activation.
- **Apply offset independently to each search leg:** rejected because it produces incorrect and unstable RRF pages.
- **Treat every hybrid error as keyword fallback:** rejected because it would hide authorization, schema, and dimension faults.
