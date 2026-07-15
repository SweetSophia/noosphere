# Automatic Memory Capture and Recall Enrichment ADR

**Status:** Proposed
**Date:** 2026-07-14
**Scope:** Noosphere server, OpenClaw memory plugin, recall providers, and curation lifecycle

Current implemented OpenClaw settings are documented in the
[official plugin setup guide](OPENCLAW-OFFICIAL-PLUGIN-SETUP.md). Configuration
examples introduced below for later phases are proposed and are not live keys.

## 1. Decision summary

Noosphere should add two connected but independently deployable capabilities:

1. **Recall enrichment:** generate a short factual recall summary plus separate
   search terms for each article. Lexical search indexes both fields, while the
   planned pgvector/RRF work remains the primary semantic-retrieval path.
2. **Automatic event capture:** an opt-in OpenClaw `agent_end` hook submits a
   bounded turn envelope to an agent-isolated, private-scope, TTL-bound capture
   inbox. A separate extraction step converts useful events into searchable
   ephemeral candidates that retain the same agent and scope boundary. Repeated
   useful retrieval can advance a candidate to a draft article, but automatic
   processing never publishes an article.

These capabilities must not be implemented by saving every raw turn directly as
an `Article`. Raw capture and durable wiki knowledge have different privacy,
retention, quality, and review requirements.

## 2. Why this is needed

The current system has strong explicit tools and curation primitives, but two
gaps make it less automatic than other memory systems.

### 2.1 Recall still depends too heavily on matching words

The live Noosphere provider uses PostgreSQL full-text search over article title,
excerpt, content, and tags. It has a bounded fallback term extractor and a few
hard-coded synonym groups. This works when the query and article share words,
but ordinary paraphrases can still miss the correct article and force an agent
to search manually.

The [proposed hybrid-retrieval ADR](HYBRID-RETRIEVAL-ADR.md) addresses the
broader semantic problem with embeddings and reciprocal-rank fusion. Recall
enrichment remains useful because:

- lexical search must continue to work when hybrid retrieval is disabled;
- exact names, aliases, acronyms, paths, and error strings remain lexical
  strengths;
- a concise factual summary improves prompt-budget efficiency after retrieval;
- generated search terms can cover terminology absent from the prose without
  turning the human-facing excerpt into keyword soup.

### 2.2 Save guidance is advisory and can disappear on a recall miss

The OpenClaw plugin currently exposes `noosphere_save` and injects instructions
that tell an agent when to use it. The agent must still choose to call the tool.
Before the Phase 0 fix in this change set, those instructions were only injected
when auto-recall returned non-empty prompt text. A turn containing genuinely new
information could therefore receive no capture reminder at all.

Noosphere also contains pure promotion and synthesis modules, but recall
statistics, candidates, and synthesis jobs are not persisted or wired into the
live recall path. The scheduler CLI currently runs only a health job. Existing
documentation describes the intended abstractions, not a completed automatic
promotion service.

## 3. Goals

- Recall articles when the user's wording differs from the article wording.
- Preserve exact lexical retrieval for names, commands, paths, and identifiers.
- Capture important completed-turn events without requiring a tool call from the
  primary agent.
- Keep automatic capture private, bounded, idempotent, and opt-in.
- Separate temporary evidence from durable articles.
- Let repeated useful retrieval accelerate promotion without making popularity
  the only quality signal.
- Preserve human review and explicit authorization for publication.
- Fail open: memory outages must not block the agent's response.

## 4. Non-goals

- Recording every token, tool result, or hidden prompt.
- Storing injected recall blocks as new memories.
- Automatically publishing model-generated articles.
- Replacing the pgvector/RRF hybrid-retrieval plan with generated keywords.
- Treating retrieval frequency as proof that a memory is true.
- Sending restricted or sensitive content to a remote model without explicit
  provider and scope consent.

## 5. Existing components to reuse

| Capability | Existing implementation | Reuse decision |
| --- | --- | --- |
| Explicit draft save | `POST /api/memory/save` and `noosphere_save` | Keep for deliberate agent-authored candidates. |
| Auto recall | OpenClaw `before_prompt_build` hook | Keep; add independent capture guidance and later register `agent_end`. |
| Article lexical search | `src/lib/memory/article-search.ts` | Extend with enrichment fields. |
| Recall orchestration | `RecallOrchestrator` | Record statistics only after final dedup, conflict handling, cap, and budget selection. |
| Promotion rules | `src/lib/memory/promotion.ts` | Preserve concepts; replace in-memory-only storage with a repository and durable records. |
| Synthesis helpers | `src/lib/memory/backfill.ts` | Preserve pure helpers; add a durable worker and validated model-output contract. |
| Scheduler foundation | `LocalMemoryScheduler` | Keep for local development only; production work needs durable leases/jobs. |
| Scope authorization | API-key scopes and `restrictedTags` | Apply to capture, candidate search, enrichment, and promotion. |
| Hybrid retrieval | [Hybrid Retrieval ADR](HYBRID-RETRIEVAL-ADR.md) | Treat enrichment as a complementary lexical/document layer. |

## 6. Architecture

```text
OpenClaw turn completes
        │
        │ agent_end (opt-in, fail-open)
        ▼
POST /api/memory/captures
        │
        │ validate, strip injected memory, secret scan,
        │ scope, bound, fingerprint, upsert
        ▼
MemoryCapture (private raw envelope, short TTL)
        │
        │ durable extraction lease
        ▼
MemoryCandidate (sanitized facts + recall summary + search terms)
        │
        ├── searchable as ephemeral memory
        │       │
        │       └── persisted retrieval/use statistics
        │
        ├── expire / reject / merge duplicate
        │
        └── promotion eligibility + review
                ▼
          Article(status=draft)
                │
                └── explicit review → reviewed/published
```

## 7. Data model

The exact Prisma names may change during implementation, but the boundaries are
required.

### 7.1 `MemoryCapture`

A capture is private temporary evidence, not a wiki page. Phase A adds an
optional `ApiKey.agentPrincipalId` binding backed by a database trigger that
rejects every post-creation change, including `NULL → principal`. Existing keys
remain unbound for compatibility; automatic capture remains disabled by default
and rejects unbound keys.

Required fields:

- `id`
- `dedupeKey` — unique, domain-separated, versioned keyed HMAC over canonical
  source identity and content; an unkeyed content hash is forbidden
- `agentPrincipalId` — server-derived from the authenticated API key's immutable agent
  principal binding; never accepted from request data
- `privateScopeTag` — required non-empty restricted tag authorized for the
  caller; capture is rejected if the key cannot write it
- `sourceSessionHash` — domain-separated, versioned keyed HMAC; never store raw
  session keys
- `sourceRunHash` — domain-separated, versioned keyed HMAC when a run ID is
  available
- `sourceType` — initially `openclaw_agent_end`
- `userText` and `assistantText` — bounded, sanitized text only
- `restrictedTags` — inherited from the narrow agent key/config
- `status` — `pending`, `processing`, `converted`, `ignored`, `failed`, `expired`
- `occurrenceCount`, `firstSeenAt`, `lastSeenAt`
- `leaseOwner`, `leaseExpiresAt`, `attemptCount`, `nextAttemptAt`
- `expiresAt`
- `createdAt`, `updatedAt`

Raw capture has a 30-day Phase A TTL; successful conversion may delete raw text
sooner. A database constraint enforces the upper bound, so a later configuration
option may shorten but cannot extend it through a direct or worker write.

Each capture schedules a durable expiry job. Disabling new ingestion never
disables expiry, revocation, or privacy cleanup; `npm run memory:scheduler`
continues to lease those jobs independently of the capture flag.

### 7.2 `MemoryCandidate`

A candidate is sanitized, searchable, and still ephemeral.

Required fields:

- `id`
- `dedupeKey` — domain-separated, versioned keyed HMAC over canonical sanitized
  candidate content
- `title`
- `content` — concise durable facts, not the full transcript
- `recallSummary` — two to four factual sentences for prompt injection
- `searchTerms` — bounded aliases, acronyms, entities, and likely query terms
- `confidence`
- `restrictedTags`
- `agentId` — inherited from the authenticated source-capture principal
- `privateScopeTag` — inherited unchanged from the source capture
- optional `sourceCaptureId` plus at least one complete, current, unrevoked
  principal-and-scope provenance group; the foreign key alone is not authority
- `status` — `ephemeral`, `pending_review`, `rejected`, `promoted`, `expired`
- `occurrenceCount`
- `retrievedCount`, `injectedCount`, `explicitGetCount`
- `relevanceSum`
- `distinctSessionCount` and `distinctDayCount`
- `firstSeenAt`, `lastSeenAt`, `lastRetrievedAt`
- `expiresAt`
- `promotedArticleId`
- `createdAt`, `updatedAt`

Candidates should be a separate provider in the recall orchestrator so scope,
ranking, TTL, and curation weights remain explicit. They must not appear in the
normal wiki article listing. Candidate retrieval requires both the `agentId`
derived from the requesting key's principal binding and authorization for
`privateScopeTag`; neither caller-supplied identity nor an unrestricted READ key
alone is sufficient to cross the agent boundary.

### 7.3 `ArticleRecallEnrichment`

Article enrichment is one-to-one with an article and derived from a specific
content revision.

Required fields:

- `articleId`
- `sourceHash` — canonical hash of title, excerpt, content, tags, and relevant
  scope-independent metadata
- `recallSummary`
- `searchTerms`
- `generatorKind` — deterministic, local model, or remote model
- `generatorId` and `promptVersion`
- `status` — `pending`, `ready`, `failed`, `stale`
- `attemptCount`, `errorCode`, `generatedAt`
- `createdAt`, `updatedAt`

Do not overwrite `Article.excerpt`. The excerpt is human-facing editorial data;
the recall summary is machine-generated retrieval metadata.

### 7.4 `MemoryRetrievalStat`

Promotion inputs must be durable. Record the final selected memory, provider,
retrieval mode, normalized relevance, and bounded source context. Do not store
the raw query. If correlation is necessary, use a domain-separated, versioned
keyed HMAC and retain only its algorithm/key-version identifier with the digest.

Statistics must distinguish:

- provider hit;
- final ranked result;
- injected result;
- explicit manual recall/get;
- distinct session/day recurrence.

Only final injected or explicitly fetched results count strongly toward
promotion. A provider returning the same broad result repeatedly is not evidence
of usefulness by itself.

### 7.5 Principal, lineage, tombstone, job, and privacy-review state

Phase A also adds:

- `MemoryAgentPrincipal` for server-managed active/revoked identity and one
  immutable concrete private scope;
- `MemoryLineageState` plus `MemoryProvenanceEdge` for principal, scope,
  session, capture, and future consent generations;
- `MemoryTombstone` to prevent a deleted lineage from being recreated by a
  late worker or a repeated event;
- `MemoryDurableJob` for bounded leases, retries, expiry, and privacy cleanup;
- `MemoryPrivacyReview` for reviewed/published articles that depend on revoked
  provenance and therefore require an explicit human decision.

The global lock order is API key, principal, lineage ordered by
`(kind, subjectHash, id)`, artifact, then durable job. Capture, revocation,
cleanup, and final recall hydration use the same order. Final publication paths
must call the shared provenance-generation check in the transaction that writes
the artifact.

Each provenance edge also carries a `sourceGroupId`. Lineages inside one source
group are conjunctive requirements; separate groups represent genuinely
independent authorized sources. Privacy cleanup removes an invalid group but
preserves a quarantined derived artifact when another complete group remains.
Raw captures and retrieval correlations are source-specific and are always
deleted when any required source lineage is revoked.

### 7.6 HMAC rotation contract

Session, run, capture-dedupe, candidate-dedupe, and query-correlation digests
are domain-separated and include the immutable principal ID. The configured
keyring contains one to three numbered keys and one active write version.
Deduplication and session deletion compute every retained version; new rows use
only the active version.

Because raw session IDs are never stored, an old key must remain available
until every capture written with it has exceeded the 30-day capture TTL and any
resulting tombstone has exceeded its 90-day TTL. The minimum safe retirement
window is therefore 120 days after the old key's last possible write. Rotation
adds a new active key first; retirement happens only after that bounded window
and after pending cleanup jobs are drained.

## 8. Capture endpoint

Add `POST /api/memory/captures` rather than overloading `/api/memory/save`.

The endpoint should:

1. require a WRITE-capable API key;
2. require exactly one non-empty private capture scope configured for the agent;
3. require the API key to carry an immutable server-managed agent-principal
   binding, derive `agentId` from that binding, and reject any caller-supplied
   agent identity;
4. derive the allowed scope set from the caller and reject capture unless that
   key is explicitly authorized to write the configured private scope;
5. never interpret an empty configured scope or an unrestricted key as
   permission to create unscoped automatic captures;
6. enforce strict per-field and total byte limits;
7. strip injected recall/memory blocks from both user and assistant text;
8. scan for known secret formats before persistence;
9. reject transient/no-content turns deterministically when possible;
10. compute the dedupe key server-side;
11. upsert occurrence metadata instead of creating duplicates;
12. return `202 Accepted` with a capture ID and status URL;
13. apply rate limits and bounded structured logging without content.

Credential rotation creates a new key with the same immutable principal binding
and revokes the old credential in one transaction. Credential invalidation is
not privacy revocation and does not quarantine prior captures. Principal,
session, scope, capture, and consent revocations use the separate lineage path.

The API must never accept a client request to mark a capture as promoted or
published.

Duplicate delivery increments occurrence metadata without extending the raw
capture's fixed 30-day expiry. An overdue row cannot be revived by replay.

## 9. OpenClaw `agent_end` hook

OpenClaw 2026.7 exposes `agent_end` with `messages`, `success`, run identity, and
agent/session context. The plugin should register this hook behind explicit
configuration:

```json5
{
  autoCapture: false,
  autoCaptureAgents: ["cylena"],
  autoCaptureChatTypes: ["telegram"],
  autoCaptureRestrictedTags: ["cylena-private"],
  autoCaptureTimeoutMs: 1500,
  autoCaptureMaxTurnChars: 12000,
  autoCaptureExtractionProvider: "local",
  autoCaptureAllowRemoteExtraction: false,
  autoCaptureAllowRestrictedRemoteExtraction: false
}
```

Required behavior:

- default `autoCapture` to `false` for existing installations;
- refuse to enable auto capture unless `autoCaptureRestrictedTags` contains
  exactly one non-empty private tag and the resolved per-agent key is authorized
  to write it;
- treat `autoCaptureAgents` as local routing configuration only; the server
  trusts the immutable principal bound to the resolved key, not an agent name in
  the payload;
- skip failed/aborted runs;
- select only the current turn's last user and final assistant messages;
- exclude tool payloads, hidden/system content, recalled-memory blocks, and
  runtime metadata;
- use the same ignored/stateless-session filters as auto recall;
- resolve the API key per agent;
- submit once per run ID, with a local in-flight dedupe guard;
- enforce a short timeout and fail open;
- never delay or alter the delivered assistant response.

The three extraction settings above are proposed Phase C fields, not current
plugin configuration. The README must not advertise them until implementation.
Remote extraction requires both `autoCaptureAllowRemoteExtraction: true` and a
non-local provider. A restricted capture additionally requires
`autoCaptureAllowRestrictedRemoteExtraction: true`; the general remote-consent
flag alone is insufficient.

The plugin submits evidence; it does not decide what is true or publishable.

## 10. Extraction and enrichment

### 10.1 Structured output

The extraction worker should request strict JSON with this logical shape:

```json
{
  "shouldSave": true,
  "reasonCode": "decision",
  "title": "Short factual title",
  "content": "Durable facts only",
  "recallSummary": "Two to four precise factual sentences.",
  "searchTerms": ["aliases", "acronyms", "likely query wording"],
  "confidence": "medium",
  "topicHints": ["projects"],
  "sensitivity": "private"
}
```

Model output is untrusted. Server-side validation must reapply length, secret,
scope, tag, and prose rules. Unknown fields are rejected. The model cannot
weaken restrictions, choose publication, or create topics.

### 10.2 Provider consent

Local extraction is preferred. Remote extraction receives user/assistant text
and therefore needs explicit egress consent separate from embedding consent.
Restricted captures require an additional restricted-content consent. Revoking
consent stops dispatch and prevents late responses from being persisted.

### 10.3 Enrichment quality

Keep `recallSummary` and `searchTerms` separate:

- `recallSummary` must remain readable, factual, and suitable for prompt
  injection;
- `searchTerms` may contain terse aliases and alternative terminology;
- neither field may invent facts not present in the source;
- every generated record carries source hash and generator version so stale
  enrichment can be detected and regenerated.

### 10.4 Deletion and consent revocation

Privacy deletion is a graph operation, not only a raw-capture delete. A durable
provenance edge and revocation generation must connect captures, candidates,
retrieval statistics, derived enrichment, and automatically generated drafts.
Deleting a capture, agent, session correlation, or private scope must, in one
transaction, advance the revocation generation, tombstone the source, and mark
all reachable candidates, drafts, and enrichment as quarantined or
recall-ineligible. Every candidate search and final hydration must verify active
provenance and the current revocation generation. Only after recall exclusion is
committed may the system enqueue idempotent physical cleanup of every derived
artifact. Cleanup must:

- remove candidate content and its searchable-provider membership;
- delete or irreversibly aggregate retrieval statistics so no source fact or
  stable query/session correlation remains;
- delete source-derived enrichment that has no remaining authorized provenance;
- delete an unreviewed auto-generated draft, or remove the deleted provenance
  and re-synthesize it when independent authorized sources remain;
- invalidate lexical, candidate, and hydration caches;
- mark affected vector profiles dirty and prevent stale jobs from republishing
  deleted content.

Consent revocation stops new dispatch immediately and uses the same atomic
quarantine/revocation-generation transaction before asynchronous cleanup. The
generation is checked during search, hydration, worker publication, and cache or
vector publication. Reviewed or published articles are never silently rewritten
by this automatic path; they enter an explicit privacy-review queue and are
excluded from recall until resolved.

## 11. Search integration

The lexical search document should use these relative weights:

- article title: A;
- enrichment search terms and aliases: A;
- article excerpt and recall summary: B;
- tags: B;
- article content: C.

Candidate search should use its sanitized title/search terms at A, summary at B,
and content at C, with lower default curation weight than articles.

The future hybrid-retrieval document may embed canonical article content plus
the recall summary, but not duplicate arbitrary keyword lists into the vector
document unless evaluation shows a measurable benefit. Because document schema
and normalization are immutable hybrid-profile identity, introducing
`recallSummary` requires a new profile and cannot alter an existing profile's
canonical document contract in place.

Search caches must invalidate when enrichment becomes ready/stale, a candidate
changes eligibility, or a promotion changes provider membership.

For a new profile whose immutable document contract includes `recallSummary`,
follow the hybrid ADR's `preparing` → backfill → coverage gate → `serving`
transition before it can replace the old profile. Thereafter, publishing,
replacing, staling, or deleting enrichment uses the hybrid dirty-tracking
protocol: in the same transaction, advance the article embedding revision or
content hash and enqueue every eligible profile whose immutable contract
includes that field. A worker must re-check profile identity, revision, source
hash, scope eligibility, and revocation generation before publication.
Search-cache invalidation does not substitute for vector re-embedding.

## 12. Promotion lifecycle

Proposed path:

```text
capture → ephemeral candidate → draft article → reviewed article → published article
```

Initial candidate eligibility should require all of:

- at least three strong uses (`injected` or explicit fetch);
- use across at least two distinct sessions or days;
- average normalized relevance of at least 0.5;
- no active contradiction or rejection flag;
- unexpired candidate and current scope eligibility;
- minimum confidence threshold;
- no existing equivalent article/candidate after deduplication.

Occurrence count helps confidence but cannot replace retrieval usefulness.
Promotion to **draft** may be automatic once thresholds and synthesis validation
pass. Promotion to `reviewed` or `published` remains an explicit operator or
authorized-agent decision.

Rejected candidates should retain only bounded tombstone metadata long enough
to prevent immediate recreation, then expire.

## 13. Deduplication and contradiction handling

Use two layers:

1. exact/near-exact canonical fingerprint to coalesce repeated captures;
2. semantic or hybrid candidate lookup before creating or promoting a candidate.

When new evidence updates an existing candidate, preserve provenance and update
facts through a validated synthesis step. Do not append transcripts blindly.

Contradictory candidates must be surfaced for review and excluded from automatic
promotion until resolved. A newer statement is not automatically more correct.

## 14. Privacy and security invariants

- Automatic capture is opt-in and agent-scoped.
- For the automatic capture endpoint and hook (§8–§9), extraction workers
  (§10), and promotion worker (§12), narrow agent-bound keys are the default;
  ADMIN/`*` keys are discouraged. This is not a global key-provisioning rule
  for unrelated Noosphere APIs.
- Each automatic-capture key has an immutable server-managed agent-principal
  binding used for capture and candidate retrieval; client identity is ignored.
- Raw session IDs and queries are never stored.
- Raw captures have TTL and deletion jobs.
- Automatic captures and candidates always retain a required private scope plus
  agent identity; empty-scope automatic capture is invalid.
- Privacy deletion and consent revocation propagate through candidates,
  statistics, enrichment, drafts, caches, and vector dirty tracking; atomic
  quarantine prevents recall while physical cleanup is pending.
- Restricted scopes are enforced before capture, extraction dispatch, candidate
  search, promotion, and final hydration.
- Injected memory and runtime instruction blocks are stripped before storage.
- Secret detection runs before raw capture persistence and again after model
  extraction.
- Logs and metrics contain IDs, status, sizes, counts, latency, and error codes;
  never content, queries, credentials, or generated facts.
- Automatic paths never create topics or publish articles.
- All worker leases, retries, and late-response publication checks are durable
  and race-safe.

## 15. Failure behavior

- OpenClaw capture failures are fail-open and do not alter the user response.
- Capture endpoint duplicates are idempotent successes.
- Extraction failures retry with bounded exponential backoff and terminal state.
- If no extraction provider is configured, captures remain pending until TTL or
  manual review; they are not converted with low-quality heuristics silently.
- Stale article enrichment never removes the article from lexical search; the
  base title/excerpt/content/tags document remains available.
- Promotion-worker outages stop promotion but not recall or explicit saves.
- `NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED=false` stops only new ingestion; the
  durable maintenance scheduler still expires and deletes retained private data.
- Redis search entries contain only article IDs and bounded relevance scores.
  Every hit is transactionally rehydrated from PostgreSQL while current lineage
  and article rows are locked; cached article text is never returned or stored.

## 16. Staged delivery

### Phase 0 — close the advisory capture gap

- inject save guidance even when eligible auto recall returns no prompt text;
- add regression tests and correct architecture/plugin documentation.

### Phase A — durable observation and enrichment contracts

- add capture, candidate, enrichment, retrieval-stat, and durable-job schemas;
- add repository interfaces and migrations;
- add the authenticated capture endpoint and admin inspection APIs;
- add source hashing, scope tests, and lifecycle invariants;
- add API-key agent-principal binding and server-derived identity enforcement;
- add provenance-graph deletion, tombstone, and revocation-generation jobs;
- keep all new ingestion behavior disabled by default.

Phase A implementation status in this change: complete pending PR review. It
includes principal administration, creation-time key binding, safe credential
rotation, private capture persistence, content-free recall caches with locked DB
rehydration, durable expiry/privacy jobs, and capture/candidate/job/tombstone/
privacy-review inspection APIs. Exact private-scope arrays are non-null at the
database boundary; database triggers bind capture/candidate scope to the
principal and require every candidate source group to carry active matching
canonical-principal/scope provenance while the principal remains active.
Independent provenance
groups survive only in quarantine. Lock-barrier regressions cover revocation
racing capture/recall and scope deletion racing key creation/update. Capture
detail is available to its bound creator only while capture and principal remain
eligible; scope-authorized administrators retain privacy-review access, while
API administrators still need the private scope. This phase does not register
the OpenClaw `agent_end` hook or generate candidates; those remain Phase C.

### Phase B — article recall enrichment

- add local/remote extraction provider contracts and consent controls;
- backfill existing articles into `ArticleRecallEnrichment`;
- extend lexical search and cache invalidation;
- evaluate recall quality against a curated paraphrase corpus;
- enable enrichment independently from auto capture.

### Phase C — OpenClaw automatic capture

- register the `agent_end` hook;
- enable capture for selected agents/chats only;
- run extraction into searchable ephemeral candidates;
- activate the Phase A TTL/deduplication foundation and add operations metrics.

### Phase D — useful-recall promotion

- persist final orchestrator selection/injection/get statistics;
- add candidate review UI and promotion worker;
- synthesize eligible candidates into draft articles;
- add contradiction and duplicate gates;
- keep reviewed/published transitions explicit.

### Phase E — hybrid convergence

- create a new immutable hybrid profile whose canonical document contract
  includes article enrichment;
- move that profile through `preparing`, backfill, coverage gating, and
  `serving` before replacing the old profile;
- atomically advance embedding revision/hash and enqueue eligible compatible
  profiles on every later enrichment publication, replacement, staleness, or
  deletion;
- evaluate lexical-only, vector-only, and fused recall quality;
- tune weights and thresholds from measured recall sets, not anecdotes.

## 17. Verification requirements

### Phase 0

- capture guidance appears with a non-empty recall;
- capture guidance appears on an empty/missing recall result;
- disabling capture guidance still yields no injection on an empty recall;
- auto recall continues to fail open on dependency errors.

### Capture and extraction

- duplicate `agent_end` delivery creates one capture and increments occurrence;
- failed/aborted/stateless/ignored sessions do not capture;
- injected blocks, tool payloads, runtime metadata, and secrets are not stored;
- scoped keys cannot widen `restrictedTags`;
- empty or unauthorized private capture scopes are rejected, and candidate
  recall requires the server-derived key principal plus authorized scope;
- caller-supplied `agentId` cannot create or retrieve another agent's capture;
- raw capture expires and is deleted after conversion/TTL;
- privacy deletion and consent revocation remove or quarantine every derived
  candidate, statistic, enrichment, draft, cache entry, and stale vector job;
- descendants become recall-ineligible atomically before asynchronous privacy
  cleanup begins;
- retry and late-response races cannot resurrect expired or revoked content.

Phase A additionally verifies that direct `NULL → principal` and
`principal → NULL` key updates fail at the database boundary; key rotation
preserves principal identity without quarantining memory; the same raw session
ID under two principals produces different HMACs and deletion blast radii;
historical HMAC versions deduplicate and tombstone correctly; reviewed articles
enter recall quarantine plus privacy review; creator/cross-principal/admin
capture-detail authorization preserves both identity and scope and removes
creator access immediately on capture/session/principal revocation; forged
capture/candidate scope, source relations, source-only candidates, and
unrelated/revoked/synthetic-principal candidate provenance fail at the database
boundary, including late publication after principal revocation;
scope deletion cannot be undone by a queued key create/update; raw expiry cannot
exceed 30 days; cleanup still runs with ingestion disabled; and a clean database
can apply the complete migration chain.

### Recall enrichment

- paraphrase queries retrieve expected articles without exact source keywords;
- exact identifiers retain or improve lexical rank;
- stale/failed enrichment falls back to the base article document;
- filters, deletion, pagination, and restricted scopes match existing behavior;
- cache invalidation covers every enrichment/candidate membership mutation.
- adding enrichment to the embedding document creates and gates a new immutable
  profile; later enrichment mutations advance revision/hash and enqueue all
  eligible compatible profiles atomically, and stale jobs cannot republish prior
  vectors.

### Promotion

- only final injected/explicitly fetched results earn strong promotion credit;
- repeated results from one session do not satisfy diversity thresholds;
- contradictions and duplicates block automatic promotion;
- automatic promotion creates drafts only;
- rejection tombstones prevent immediate candidate recreation.

## 18. Success criteria

- Agents no longer need exact article wording for common paraphrase queries.
- Important completed-turn events reach a searchable private candidate without a
  primary-agent tool call when auto capture is explicitly enabled.
- Candidate volume remains bounded by deduplication and TTL.
- Frequently useful candidates become reviewable draft articles faster.
- Publication quality and privacy remain at least as strict as the current
  explicit-save workflow.
- Noosphere's documentation distinguishes implemented behavior from planned
  scaffolding and no longer describes advisory guidance as automatic capture.

## 19. Decisions still requiring implementation evidence

- Which local and remote extraction providers meet latency, quality, and privacy
  requirements?
- What raw-capture TTL and per-agent rate limits fit real traffic?
- Should candidate retrieval require a minimum extraction confidence before it
  enters auto recall?
- Which benchmark queries and judgments define a meaningful recall-quality gain?
- Is automatic candidate-to-draft promotion enabled globally or per agent/topic?

These values should be chosen from a local capture/replay evaluation before any
default-on rollout.
