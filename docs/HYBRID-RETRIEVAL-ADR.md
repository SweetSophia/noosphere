# ADR: Authorization-safe hybrid retrieval

- Status: Proposed
- Issue: [#261](https://github.com/SweetSophia/noosphere/issues/261)
- Date: 2026-07-12
- Decision owners: Noosphere maintainers

Related decision: [Automatic Memory Capture and Recall Enrichment](AUTOMATIC-MEMORY-CAPTURE-AND-ENRICHMENT-ADR.md), which treats enrichment as a
complementary lexical/document layer and defines how enrichment participates in
embedding-profile versioning.

## Context

Noosphere currently retrieves its own articles with PostgreSQL full-text search. The Noosphere memory provider builds one weighted document from the title, excerpt, content, and tags, applies article and restricted-scope filters, and ranks matches with `ts_rank`. This is precise for shared terms but cannot recover semantically related articles that use different language.

Issue #261 proposes pgvector embeddings and Reciprocal Rank Fusion (RRF). That change crosses database distribution, article persistence, remote data egress, background work, authorization, pagination, caching, and failure handling. It must therefore be delivered as a staged epic rather than as one application patch.

This ADR fixes the contracts that later implementation PRs must preserve. It does not enable embeddings, install pgvector, or change retrieval behavior.

## Decision

### 1. Scope and rollout

The first hybrid implementation will affect only the built-in Noosphere memory provider. Wiki search remains full-text-only until recall quality and operations are proven.

Hybrid recall will be disabled by default. Enabling it requires all of the following:

1. an activated pgvector storage feature;
2. an immutable embedding profile in the `serving` lifecycle state;
3. a healthy, separately operated embedding worker;
4. sufficient ready-vector coverage; and
5. explicit operator consent for any remote content or query egress.

Missing or stale embeddings do not exclude an article from lexical eligibility. The article can still be returned when it ranks within the lexical leg's [fixed 200-candidate depth](#6-authorization-safe-exact-hybrid-recall); only the vector leg requires a ready, current embedding.

For a profile, an eligible article is non-deleted, has a canonical document, and satisfies that profile's local/remote and restricted-content egress policy. Ready-vector coverage is the percentage of eligible articles whose vector is ready for the same profile, current embedding revision, and current canonical content hash. The initial transition to `serving` requires at least 95% ready-vector coverage; this is a conservative initial rollout gate, and lowering it requires measured quality evidence in a later ADR. Uncovered or newly changed articles remain lexical-only; the numerator, denominator, and excluded-policy counts are exposed separately without article identifiers.

### 2. Database image and compatibility

The bundled database currently uses PostgreSQL 16 on Alpine. The upstream pgvector 0.8.1 images use Debian Bookworm or Trixie; there is no equivalent Alpine tag. Noosphere will not reuse an Alpine-created physical data volume in a Debian-based container.

The bundled path will instead use a Noosphere-owned, multi-architecture database image that:

- is based on an exact PostgreSQL 16 Alpine release and digest;
- compiles an exact pgvector release from a verified source artifact;
- publishes its PostgreSQL, Alpine, pgvector, and source identities as image metadata; and
- remains data-directory compatible with the existing bundled runtime family.

The first infrastructure PR will build and test that image in CI without changing production Compose. A later PR may switch bundled Compose only after a copied-volume rehearsal verifies backup and restore, PostgreSQL major version, volume identity, data counts, collation health, extension availability, and rollback.

External PostgreSQL is a separate compatibility boundary. Hybrid storage is an optional feature activation, not an unconditional standard Prisma migration. Activation must preflight extension availability and permissions, install and verify the extension and feature schema transactionally, and record its feature-schema version. The application must continue to run keyword-only against a supported external database when hybrid retrieval is not activated.

The activation design must pass `migrate deploy`, shadow-database, `migrate diff`, and `db push` drift tests before it can ship. Feature activation owns the vector DDL. Its Prisma representation must be selected from evidence in that drift matrix; candidates include introspected ignored models and `Unsupported("vector")` fields. Those four tests must prove the **no-create** invariant against an extension-less `postgresql:16-alpine` fixture, leaving no vector-typed columns or pgvector extension references after the command, and the **no-drop** invariant against an activated hybrid fixture, preserving the feature-schema tables and `vector` extension. Vector tables are accessed through a narrow raw-SQL repository; generated Prisma CRUD does not read or write vector values.

### 3. Immutable embedding profiles

An embedding profile's identity fields are immutable after creation. Activation is separate mutable administrative state and never changes profile identity. Its identity covers every property that can change vector meaning:

- provider protocol and operator-classified locality (`local` or `remote`);
- exact model identifier and operator-supplied revision;
- vector dimensions;
- distance metric and normalization policy;
- embedded-document schema version;
- deterministic maximum UTF-8 input bytes; and
- endpoint identity fingerprint, excluding credentials and query parameters.

Generic OpenAI-compatible servers are not assumed to report a trustworthy model revision. The operator must supply one; changing it creates a new profile. When a provider response does identify a model or revision, Phase B must validate it against the profile rather than silently accepting a mismatch.

Multiple profiles may coexist. Each profile has an explicit lifecycle state: `inactive`, `preparing`, or `serving`. `preparing` permits operator-approved enqueue, dispatch, and backfill while excluding the profile from query candidates; the coverage, consent, and readiness checks then gate one atomic transition to `serving`. Only `preparing` and `serving` profiles receive scope-change indexing work. Deactivation transitions to `inactive`, stops dispatch, cancels queued and leased jobs, excludes the profile from candidate generation, and advances the durable search-cache epoch. Reactivation must pass through `preparing` and enqueue a complete eligibility backfill, so a profile can rebuild coverage before it serves traffic. Deactivation is distinct from consent revocation: inactive vector rows may remain for an operator-approved rollback, but consent revocation still applies the mandatory hard-deletion rules below. Existing rows are not rewritten in place during a model migration.

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

Restricted articles are local-only by default. Sending them to a remote profile requires a second, explicit restricted-content egress consent. When an article transitions from unrestricted to restricted, every existing remote-profile vector row for that article is hard-deleted in the same transaction; zeroing or soft deletion is not sufficient. If restricted-content remote egress consent is active, the trigger enqueues the new restricted revision for each eligible `preparing` or `serving` profile; otherwise pending remote jobs are cancelled. Local-profile vectors may be retained when the local profile remains eligible. Removing restricted scopes re-evaluates every `preparing` or `serving` remote profile and re-enqueues each newly eligible article/profile pair rather than restoring retained vector bytes. Inactive profiles receive no incremental scope-change work; their mandatory complete eligibility backfill runs only after an administrative transition to `preparing`. Remote clients must enforce bounded connection and response timeouts, response-size limits, finite values, exact dimensions, and sanitized error categories.

Consent is checked dynamically, not only when a job is created. Revoking general remote egress hard-deletes all vectors for every affected remote profile; revoking restricted-content egress hard-deletes the affected restricted-article vector rows. Either revocation atomically transitions every affected remote profile from `serving` or `preparing` to `inactive`, cancels queued and leased work, prevents new provider calls, and advances the durable search-cache epoch. Vector publication and every eligibility mutation that can invalidate an article/profile pair—including soft delete, restore, restricted-scope change, consent change, and profile-state change—must participate in one documented, deadlock-safe serialization protocol. Inside that serialized publication transaction, the worker rechecks current article deletion/scope state, profile state, consent, embedding revision, and canonical hash before inserting. Phase B must select the mechanism and total lock order and prove adversarial interleavings; checking before the transaction is insufficient. Workers also recheck consent immediately before dispatch. A request that has already reached a remote provider cannot be recalled, but its response is not persisted after revocation. Re-enabling consent does not change lifecycle state automatically: an administrator must transition the profile to `preparing`, which creates a complete eligibility backfill, and only the coverage, consent, and readiness gate may return it atomically to `serving`. Stale leases or retained vector bytes are never silently resumed.

Soft-deleting an article hard-deletes all of its local- and remote-profile vector rows and cancels its pending jobs in the same transaction. Restore creates new work for the current embedding revision; it never restores retained vector bytes.

### 5. Atomic dirty tracking and worker ownership

Article writes are dispersed across API routes, server actions, imports, ingestion, memory save, answer generation, Markdown sync, trash, and restore. Route-level hooks are not a sufficient consistency boundary.

A database trigger will atomically mark embedding work in the same transaction as relevant article changes. It covers:

- create;
- title, excerpt, or content changes;
- soft delete and restore; and
- restricted-scope changes.

Because the canonical document excludes topic and tags, their edits do not enqueue embedding work. Status, confidence, and author changes are also query-time metadata and do not enqueue embedding work. A future document-schema version that includes any of these fields must add the corresponding fan-out triggers before activation.

One database-backed embedding-job table is sufficient; no separate outbox table or external broker is planned. Jobs support leases, `SKIP LOCKED`, bounded concurrency, exponential backoff with jitter, maximum attempts, sanitized error codes, and a terminal failed state. Enqueue operations coalesce safely per article and profile.

Next.js request processes do not own durable background work. A separate CLI process runs as a Compose worker service whenever at least one profile is `preparing` or `serving`. It defines startup readiness, graceful shutdown, lease recovery, concurrency, backpressure, and health reporting. External deployments run the same worker command under their process manager.

Each relevant article change advances a monotonic embedding revision. A worker captures the revision and canonical content hash before calling the provider, then publishes a vector only if the article is still eligible and its revision and hash still match. Otherwise it discards the response and releases the stale lease, relying exclusively on the database trigger to have created or advanced work for the current revision. The worker never enqueues replacement work. Delete and privacy transitions cannot be undone by a late provider response.

Backfill uses the same idempotent job path and is resumable. A durable database search-cache epoch advances in the same transaction as every mutation that can affect candidate membership, rank, filters, authorization, or final hydration. This includes every Article insert, update, soft delete, restore, or hard delete; relevant Topic, Tag, and ArticleTag mutations; vector readiness/staleness and embedding revision changes; profile lifecycle or consent changes; and backfill publication. Cache identity and authenticated values include the epoch, so a Redis-only or best-effort invalidation signal is insufficient. Endpoint data and credentials never enter cache keys.

### 6. Authorization-safe exact hybrid recall

Lexical and vector candidates must originate from one shared authorized base relation. Before either leg ranks or limits candidates, it applies:

- `deletedAt` filtering;
- caller-provided topic, tag, status, and confidence filters;
- the caller's restricted-tag scopes; and
- for the vector leg only, the `serving` profile plus ready and current revision/hash state.

Restricted-scope semantics remain canonically defined by `buildScopeFilter()` and `canAccessScopes()` in `src/lib/api/scope-filter.ts`, publicly re-exported through `src/lib/api/auth.ts`. `buildArticleSearchFilters()` in `src/lib/memory/article-search.ts` is the existing raw-SQL adapter used by `searchArticleIds()` and `countSearchArticles()` in `src/lib/wiki.ts`; none of these consumers is a second source of truth. The authorization-conformance matrix covers unrestricted articles; `undefined` scopes; empty `[]` scopes; non-empty disjoint-scope denial; single-scope overlap; multi-scope union access such as `["financial", "hr"]`; and `"*"` authorization bypass across the canonical predicate, Prisma filter, raw-SQL adapter, candidate generation, and final hydration. The `"*"` bypass removes only restricted-tag authorization filtering; it never bypasses profile lifecycle state, embedding readiness, deletion, or remote/restricted-content consent. Phase A3 establishes shared adapters and proves the predicate/Prisma/raw-SQL cases; Phase C must run the complete matrix against hybrid candidate generation and final hydration before merge. Hybrid retrieval must not introduce another scope interpretation.

The hybrid query must preserve current semantics: it does not silently require `Article.status = "published"` when the caller did not request that status filter. Final hydration re-applies authorization and deletion checks to close time-of-check/time-of-use gaps. On a cache miss, candidate generation, fusion, final authorized hydration, normalization, and pagination execute in one database statement/snapshot. The complete fused set is filtered by final authorization before it supplies the normalization denominator or page rows.

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

Cache identity includes the durable database search-cache epoch, embedding profile ID, document-schema version, hybrid algorithm version, RRF parameters, candidate depth, and all existing filters and scopes.

Cache entries contain the complete bounded fused candidate set as article IDs and bounded rank metadata only, never a single page. They never contain article title, excerpt, content, vector bytes, canonical-document bytes, or article revision. Each value carries an authenticated completeness marker, fused-set size, and search-cache epoch. The serialized value is authenticated with HMAC-SHA-256 under the domain label `noosphere-hybrid-cache-v1/value`, using a server-held key and covering its complete cache identity, completeness metadata, ordered IDs, and rank metadata; a missing, invalid, truncated, incomplete, epoch-mismatched, or version-mismatched value is a cache miss and emits only bounded, content-free diagnostics. The MAC authenticates integrity and origin but does not encrypt the content-free IDs/ranks.

A cache hit is not an authorization or eligibility decision. One current database statement must hydrate the entire cached candidate set through the same current base filters used by candidate generation, re-applying deletion, topic, tag, status, confidence, and restricted-scope predicates plus profile lifecycle, consent, and ready/current vector state for every stored leg contribution. Any current membership, contribution, or epoch mismatch discards the value and runs the cache-miss query once; a transactionally current, authenticated complete short or empty set is authoritative and does not cause repeated provider calls. Only after those checks may the statement renormalize the complete set and paginate. The highest remaining authorized non-zero score therefore retains the 1.0 contract.

### 7. Failure policy

The existing strict full-text query and bounded conversational fallback remain the lexical behavior.

Only classified request-shape or transient embedding conditions may degrade a
request to lexical-only retrieval: `window_exceeded`, `limit_unbounded`,
`authorized_candidate_limit_exceeded`, insufficient ready-vector coverage,
connection timeout, temporary network failure, or provider HTTP 408, 429, or
5xx. Degradation emits bounded, content-free diagnostics and metrics.

Invalid configuration, missing required feature schema, dimension mismatch, non-finite vectors, SQL errors, authorization invariant failures, and malformed provider responses are correctness faults. They must surface through readiness/status and operator-visible errors rather than being silently relabeled as an outage.

Shadow mode is explicit opt-in because it can incur cost and egress. For an eligible request it computes both lexical and hybrid results from the same authorized input, returns only the lexical result, stores no per-query text or result set, and emits only bounded aggregate quality deltas subject to the Phase D anonymity floor. It must not alter returned rankings.

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

- **Phase A3:** define and test separate least-privilege database roles for feature activation and worker runtime; the activation role may perform only the required feature DDL, while the worker role receives narrowly bounded job/vector DML and an eligibility-read capability exposing only eligible article/profile pairs and the canonical fields needed for embedding, not unrestricted base-table reads or raw `restrictedTags`. A3 must select the database primitive from measured locking and row-security behavior rather than mandate a function or view here. Any security-definer object requires a non-login owner, a pinned safe `search_path` with no attacker-writable schema, `PUBLIC` execution revoked, explicit row-security semantics, and privilege-escalation tests. Establish shared authorization adapters and prove canonical predicate, Prisma-filter, and raw-SQL conformance. Enforce profile-identity immutability separately from administrative lifecycle state; restrict profile creation and lifecycle transitions to an explicit administrative permission; set and validate a numeric upper bound for `maxInputBytes`; and record pgvector evidence with source URL, source SHA-256, pgvector version, SPDX license identifier, and built image digest. The `migrate deploy`, shadow-database, `migrate diff`, and `db push` matrix must explicitly prove both the extension-less no-create fixture and activated no-drop fixture described in Section 2.
- **Phase B:** set numeric defaults and hard limits for worker concurrency, lease duration, and maximum attempts, plus numeric warning and critical thresholds for durable pending queue depth and age. Backpressure limits claims and chunks operator-initiated backfills; it never rejects article writes or drops/coalesces away the latest dirty revision. Authenticate the worker with the A3 runtime role, define authenticated transport plus response-validation requirements for local and remote provider endpoints, and prove the documented publication/eligibility serialization protocol against adversarial soft-delete, scope-change, consent-change, and profile-state interleavings. The consent tests must cover the complete `serving` → revocation/`inactive` → re-consent/`preparing` → coverage-gated/`serving` sequence and prove that inactive profiles receive no incremental work.
- **Phase C:** store the complete bounded fused set as only IDs and rank metadata in authenticated cache entries and require one-statement current-filter hydration, post-hydration renormalization, and pagination on every hit. Run the complete authorization-conformance matrix against hybrid candidate generation and final hydration; derive cache identity from a cryptographic hash of normalized query text rather than raw text; HMAC the canonical scope set with a server-held secret rather than exposing plaintext scopes in cache keys; define cache-MAC key rotation and compromise recovery; and test invalid/missing MACs, false or missing completeness metadata, cache tampering, authoritative short/empty sets, epoch changes from every covered entity, scope/filter changes, deletion, vector staleness, profile-state changes, and consent revocation.
- **Phase D:** suppress aggregate coverage, overlap, and shadow-quality metrics below a documented numeric anonymity floor; audit consent revocations, all profile lifecycle transitions, and other eligibility revocations without content-bearing fields; alert on a documented numeric eligible-denominator or coverage delta so a write-capable actor cannot silently hold activation below the 95% gate; and version the benchmark corpus, ranking metric, lexical baseline, and numeric hybrid acceptance threshold before hybrid results can be returned.

### Phase A3 implementation decision

Phase A3 selects a security-barrier, security-definer view named
`noosphere_hybrid.worker_eligibility` instead of RLS on the private feature
tables. The locked non-login owner holds the narrow public-article column grants;
the worker has no base-table or internal-view privileges and receives eligible
identifiers, profile identity, dimensions, hashes, and canonical document bytes
only through `claim_jobs`. Phase A3 is deliberately stricter than the eventual
local-profile policy:
the internal view and enqueue path exclude every article with non-empty
`restrictedTags`, and the worker can execute only the `claim_jobs` byte-returning
API. That API locks the canonical `Article` row so restriction commits are
linearized against claims, including stale `REPEATABLE READ` snapshots. The
worker therefore cannot enumerate restricted identifiers or canonical bytes
before Phase B installs explicit local/remote restricted-content policy and
consent checks. The view uses owner semantics (`security_invoker=false`), every
definer routine pins `search_path` to `pg_catalog, pg_temp`, and every object reference
inside those routines is schema-qualified. PostgreSQL 16 integration tests run
the worker with malicious same-named temporary objects and assert that raw
`restrictedTags` and private feature tables remain unreadable.

The claim lock is isolation-aware without changing the worker login's global
transaction default. Under `READ COMMITTED`, EvalPlanQual follows a concurrently
updated Article tuple and rechecks eligibility; under `REPEATABLE READ`, a
restriction committed after the worker's transaction snapshot raises `40001`.
The live PostgreSQL contract matrix proves both interleavings.

Because pgvector 0.8.1 is not a trusted extension, extension provisioning and
feature activation are distinct privilege stages in one advisory-locked
transaction. A bootstrap superuser temporarily elevates an unloginable extension
owner only for `CREATE EXTENSION`; a separate unloginable activator receives
transaction-scoped database `CREATE` and feature-owner membership only for the
application feature DDL. Both authorities are removed before commit. Standard
runtime deployment now uses separate bootstrap, migration, and application
credentials, while optional feature administration and worker execution use two
additional limited credentials.

The durable job primitive is one unique `(article_id, profile_id)` row with
separate desired and claimed revisions/hashes, a random lease token, and a
monotonic lease generation. Publication is compare-and-swap: a completion for an
older desired revision releases its lease but cannot publish, erase, or replace
newer work. Soft delete hard-deletes vectors and jobs, restore advances revision
and enqueues current work, writes while deleted never enqueue, and physical
delete cascades all feature rows. A separate statement-level epoch path covers
every Article mutation plus Topic, Tag, ArticleTag, profile, and vector changes,
independent of embedding enqueue rules.

Profiles default to `inactive`. Administrative transitions to `preparing` and
`serving` are deliberately unreachable until Phase B installs the provider,
dynamic consent, complete-backfill, coverage, and readiness gates. The Phase A3
operator and verification contract is
[`docker/hybrid-storage/README.md`](../docker/hybrid-storage/README.md).

### Phase B implementation decision

Phase B is an independently evidenced `noosphere_hybrid_b` layer rather than a
rewrite of A3. Its activation hashes the feature, activation, and validation SQL
as one source identity. In the same uncommitted transaction it reconstructs the
original A3 capability ACL, runs the complete A3 validator, and then withdraws
the legacy A3 state/claim/publish/fail entry points before any B state commits.
Repeat B activation therefore proves the exact A3 base as well as B ownership,
security-definer configuration, ACLs, table columns/defaults/constraints/indexes,
routine/trigger manifests, and the exact Article-trigger inventory. After Phase
B is active, its activator is the supported repeat-validation entry point.

Eligibility-changing Article writes, consent changes, profile transitions,
backfill enqueue, claims, failures, and publication take the exclusive form of
one transaction-scoped advisory lock. A BEFORE Article trigger acquires it
before A3's AFTER trigger can touch a job; publication takes it before
profile/job locks. This total order avoids an Article-to-job/job-to-Article
cycle while making soft deletion, quarantine, restricted-scope change, consent
revocation, and profile deactivation linearize against publication. Publication
still requires the exact lease token, generation, desired revision/hash,
current canonical hash, active profile, current consent, exact dimensions, and
finite vector in the locked transaction.

The separate Node.js worker authenticates only as
`noosphere_hybrid_worker_login`. It receives canonical bytes solely from the B
claim function. Immediately before provider dispatch it takes the same advisory
lock in a short authorization transaction and rechecks the exact
lease/generation, profile, article revision/hash, and current consent. The
authorization commit is the dispatch linearization point: revocation that
commits first suppresses dispatch, while provider latency holds no database lock
and cannot block Article writes. Failed authorization CAS-releases the stale
lease; publication independently repeats the complete eligibility check. The
worker dispatches no more than 16 concurrent requests and validates
the provider protocol, immutable endpoint fingerprint, model/revision,
single-vector response shape, dimensions, finite components, normalization,
content type, response size, and timeout before conditional publication. Remote
providers require HTTPS and bearer authentication. Every `local` provider,
whether HTTP or HTTPS, is limited to loopback or Compose's statically mapped
`host.docker.internal:host-gateway`; credentials and endpoints remain
operator-owned configuration and never enter the database, cache, logs, or
durable error state.

Profiles transition `inactive` → `preparing` → `serving`; the final transition
requires a completed database-owned backfill generation created atomically by
`prepare` plus at least 95% current-hash coverage. Backfill is cursor-based,
resumable without a caller-supplied cursor, and capped at 1000 articles per
transaction, while the trigger path continues to coalesce the latest desired
revision without rejecting writes. The durable claim routine enforces maximum
attempts across worker crashes, and the lease must outlive the provider timeout
by at least five seconds. General or restricted
remote-consent revocation deletes the affected remote vectors and jobs and
demotes remote profiles to `inactive`. Re-consent requires an explicit prepare,
backfill, and coverage-gated serve cycle. Phase B remains opt-in behind the
disabled Compose `hybrid` profile and does not change keyword retrieval.

### Phase C implementation decision

Phase C is an independently evidenced `noosphere_hybrid_c` capability layer and
an exactly disabled application path. Its activation recomputes and validates
the A3, Phase B, and Phase C artifact hashes in one transaction. The application
role receives schema usage plus execute access to only profile snapshot,
query-dispatch authorization, bounded vector candidate, and current-vector
membership routines; it receives no direct access to hybrid tables, vectors,
consent, or feature-state evidence. Query dispatch linearizes against profile
and consent mutation through Phase B's eligibility lock in a short transaction
committed immediately before provider HTTP. Revocation that commits first
suppresses query egress; provider latency holds no database lock.

The runtime builds one materialized authorization-filtered article relation and
uses it for both lexical and vector legs. The vector leg partitions that same
relation into deterministic batches of at most 1,000 IDs, keeps the best 200
from each batch, then applies the exact distance/updatedAt/ID order globally and
keeps the best 200. This is exact: any row outside a batch's first 200 already
has 200 rows from that batch ahead of it and therefore cannot enter the global
first 200. Strict lexical search is attempted
first; only a zero-result strict set selects the bounded existing synonym
fallback. Each leg is deduplicated and capped at 200. RRF uses ranks beginning
at one and `k=60`; ties sort by raw score descending, best contributing rank
ascending, article `updatedAt` descending, and ID ascending. Final provenance
and article locks, current authorization, current content hydration, whole-set
normalization, and pagination occur in one serializable database statement.
There is no implicit article status filter.

Cache identities contain a SHA-256 digest of the normalized query, an HMAC of
the sorted scope set, epoch, profile, document schema, filters, algorithm
version, RRF parameters, and candidate depth. Signed values contain only the
complete bounded ID and rank set. A cache hit is only a hint: one database
statement rechecks the epoch, every lexical/vector contribution, current-vector
membership, authorization, provenance, and content before returning results.
Invalid hits become one miss; a valid empty set is authoritative. Cache-key
rotation reads the active namespace first and then up to two retained-key
namespaces during the 30-second cache TTL grace window. Writes always use the
active key; operators remove retired keys after the grace window.

The vector leg processes at most 100,000 authorized articles in deterministic
1,000-ID batches. Larger authorized sets make no lateral vector calls and use
the classified `authorized_candidate_limit_exceeded` lexical fallback rather
than truncating the exact vector set.

Only bounded request-shape classifications (`window_exceeded` and
`limit_unbounded`), the bounded authorization-cardinality classification
`authorized_candidate_limit_exceeded`, insufficient coverage, and transient provider network,
timeout, 408/429, or 5xx errors permit classified lexical fallback. Returned lexical results
carry the bounded fallback reason in metadata and the same content-free code is
logged. Profile/configuration drift,
unsupported protocol, provider response/model/revision/dimension errors,
non-finite vectors, SQL errors, and authorization defects surface as correctness
failures. Cosine query and stored-document vectors must have nonzero norm; zero
cosine documents do not count toward serving coverage or vector membership.
Requests beyond the bounded 200-result window use the explicit
`window_exceeded`/`limit_unbounded` lexical classifications; they never return
an incomplete hybrid page.
Compose and the installer publish all Phase C settings with
`NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`; activation, provider/profile
configuration, worker start, production backfill, and the rollout decision
remain separate operator actions for Phase D.

## Delivery sequence

1. **Phase 0 — this ADR:** settle contracts without runtime changes.
2. **Phase A1 — non-production capability:** build and test the pinned Alpine-based pgvector database image in CI. Its supply-chain lock, smoke tests, publication boundary, and local verification commands live in [`docker/postgres-pgvector/README.md`](../docker/postgres-pgvector/README.md).
3. **Phase A2 — bundled upgrade rehearsal:** prove backup, rollback, volume compatibility, collation health, extension availability, and data integrity without changing production Compose.
4. **Phase A2b — guarded bundled Compose switch:** pin the accepted image in bundled and installer Compose, require the offline restore-tested source → candidate → source → candidate transaction for existing volumes, and persist fail-closed crash-recovery evidence. The operator contract lives in [`POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md`](./POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md); `vector` remains uninstalled.
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
