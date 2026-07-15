# Noosphere Memory Architecture and Configuration

Implementation-facing reference for Noosphere's universal memory layer.

This document covers the provider abstraction, recall orchestration, budgeting,
deduplication, conflict handling, promotion/backfill, local scheduling, and the
configuration model used by the memory modules.

Related issue: [#18 — Document architecture and config model](https://github.com/SweetSophia/noosphere/issues/18)

Planned semantic retrieval is specified separately in the [authorization-safe hybrid retrieval ADR](HYBRID-RETRIEVAL-ADR.md) for [issue #261](https://github.com/SweetSophia/noosphere/issues/261). The ADR is proposed and does not describe current runtime behavior.

---

## 1. Scope and Constraints

The memory layer is a provider-agnostic recall system. It queries multiple memory
sources, normalizes results, ranks them, deduplicates overlap, handles conflicts,
and injects a bounded recall block into prompts.

Primary sources today:

- **Noosphere** — structured wiki articles through `NoosphereProvider`.
- **Hindsight** — external recall API through `HindsightProvider`.
- **Future providers** — any adapter implementing `MemoryProvider`.

Operational constraints:

- Local scheduler only; no Vercel cron or remote scheduler dependency.
- Core memory modules are pure logic where possible.
- Database and network effects belong in providers, API routes, scripts, or other wiring layers.
- Prefer public imports from `@/lib/memory`, which re-exports the module surface.

---

## 2. Module Map

| Concern | Main entry points | File |
| --- | --- | --- |
| Access control | `buildScopeFilter()`, `canAccessScopes()` | `src/lib/api/scope-filter.ts` (re-exported by `src/lib/api/auth.ts`) |
| Article search (SQL CTE) | `buildArticleSearchFilters()`, `searchArticleIds()`, `countSearchArticles()` | `src/lib/memory/article-search.ts`, `src/lib/wiki.ts` |
| Normalized schema/scoring | `MemoryResult`, `computeBaseCompositeScore()` | `src/lib/memory/types.ts` |
| Provider contract | `MemoryProvider`, `MemoryProviderConfig`, `getEffectiveAutoRecall()` | `src/lib/memory/provider.ts` |
| Hindsight adapter | `HindsightProvider`, `createHindsightProvider()` | `src/lib/memory/hindsight.ts` |
| Noosphere adapter | `NoosphereProvider`, `createNoosphereProvider()` | `src/lib/memory/noosphere.ts` |
| Recall orchestration | `RecallOrchestrator`, `createRecallOrchestrator()` | `src/lib/memory/orchestrator.ts` |
| Context budget | `ContextBudgetManager`, `createContextBudgetManager()` | `src/lib/memory/budget.ts` |
| Deduplication | `CrossProviderDeduplicator`, `createDeduplicator()` | `src/lib/memory/dedup.ts` |
| Conflict handling | `resolveConflicts()`, `createConflictResolver()` | `src/lib/memory/conflict.ts` |
| User settings | `RecallSettings`, `normalizeRecallSettings()`, `mergeRecallSettings()`, `toConflictConfig()` | `src/lib/memory/settings.ts` |
| Promotion | `scanForCandidates()`, `recordRecall()` | `src/lib/memory/promotion.ts` |
| Backfill/synthesis | `createSynthesisJob()`, `synthesize()` | `src/lib/memory/backfill.ts` |
| Local jobs | `LocalMemoryScheduler`, `createSchedulerHealthJob()`, `createDurableMemoryMaintenanceJob()` | `src/lib/memory/scheduler.ts`, `src/lib/memory/capture/maintenance.ts` |
| Automatic-memory capture | `executeMemoryCaptureRequest()`, `PrismaMemoryCaptureRepository` | `src/lib/memory/capture/api.ts`, `src/lib/memory/capture/repository.ts` |
| Privacy lineage | principal/session/scope/capture revocation, tombstones, cleanup | `src/lib/memory/capture/lifecycle.ts` |
| CLI | `npm run memory:scheduler` | `scripts/memory-scheduler.ts` |

Phase A provenance is grouped. All lineage edges sharing a `sourceGroupId` are
required together, while a different group represents an independent source.
Revocation quarantines the artifact immediately; cleanup deletes invalid groups
and preserves a derived artifact only when another complete group remains. Raw
captures and retrieval correlations are always removed on source revocation.
Database triggers bind each capture/candidate principal to its immutable private
scope and require every candidate source group to contain current, unrevoked
canonical-principal and exact-scope provenance while the principal is active. A
raw source-capture relation is not a substitute for those revocation-traversable
edges. The raw-capture expiry
constraint caps retention at 30 days.
Capture detail requires both permission and scope: its bound creator may read
its own status/raw detail only while the capture and principal remain eligible.
Scope-authorized administrators retain explicit privacy-review access; API
administrators do not bypass restricted scopes.

---

## 3. Normalized Memory Schema

Source: `src/lib/memory/types.ts`

Every provider returns `MemoryResult`. Providers may expose different backends,
but downstream policy code reads the normalized shape:

```ts
interface MemoryResult {
  id: string;
  provider: string;
  sourceType: MemorySourceType;
  title?: string;
  content: string;
  summary?: string;
  relevanceScore?: number;
  confidenceScore?: number;
  recencyScore?: number;
  curationLevel?: "ephemeral" | "managed" | "curated";
  createdAt?: string;
  updatedAt?: string;
  tokenEstimate?: number;
  canonicalRef?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

### Curation levels and score

Memory curation progresses through:

```text
ephemeral → managed → curated
```

`CURATION_SCORE_MAP` maps those levels to ranking values:

```ts
{
  curated: 1.0,
  managed: 0.7,
  ephemeral: 0.3,
}
```

### Composite scoring

`computeBaseCompositeScore()` is the shared scoring formula used by ranking,
deduplication, and conflict handling. Current weights:

```ts
COMPOSITE_WEIGHTS = {
  relevance: 0.4,
  confidence: 0.25,
  recency: 0.2,
  curation: 0.15,
}
```

Use `defineMemoryResult()` when constructing results from provider-specific
inputs; it normalizes scores and estimates tokens when needed.

---

## 4. Provider Contract

Source: `src/lib/memory/provider.ts`

Providers implement `MemoryProvider`:

```ts
interface MemoryProvider {
  readonly descriptor: MemoryProviderDescriptor;
  search(query: string, options?: MemoryProviderSearchOptions): Promise<MemoryResult[]>;
  getById(id: string, options?: MemoryProviderGetOptions): Promise<MemoryResult | null>;
  score?(result: MemoryResult, context?: MemoryProviderScoreContext): MemoryProviderScore;
}
```

`getById` is required on the interface. Providers that cannot perform direct
lookup should still implement it and return `null`; their descriptor capabilities
can advertise `getById: false` when appropriate.

Provider configuration uses `MemoryProviderConfig`:

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the provider can be queried. |
| `priorityWeight` | Ranking/dedup preference weight. |
| `maxResults` | Provider-level result cap. |
| `allowAutoRecall` | Whether the provider participates in automatic recall. |

Use `normalizeMemoryProviderConfig()` before merging arbitrary config. Use
`getEffectiveAutoRecall()` when deciding whether a provider participates in an
auto-mode request.

Built-in provider defaults differ intentionally: `NoosphereProvider` uses
`priorityWeight: 1.25` to mildly boost local structured knowledge, while
`HindsightProvider` uses `priorityWeight: 1.0`.

`NoosphereProvider` also depends on `src/lib/memory/article-search.ts`, which
contains the shared full-text search CTE helpers used by the local article-backed
provider. That helper module is internal rather than exported through
`@/lib/memory`.

#### Access control and scope filtering

Noosphere supports per-article access control via `restrictedTags` — an array of
scope strings stored on each article (e.g. `["financial", "health"]`).
Unauthenticated callers and API keys with limited scopes can only access articles
whose `restrictedTags` are either empty or overlap with the caller's allowed scopes.

`NoosphereProvider` applies this filter automatically:

- `allowedScopes = ["*"]` (human sessions) — no filter; all articles accessible.
- `allowedScopes = undefined or []` (unauthenticated / no-scope key) — only unrestricted
  articles (`restrictedTags` is empty) are returned.
- `allowedScopes = ["financial", "...*"]` (scoped key) — unrestricted articles **or**
  articles tagged with at least one of the caller's scopes.

The filtering is applied by independently implemented adapters:
`buildArticleSearchFilters()` for the full-text SQL CTE and `buildScopeWhere()`
for Noosphere-provider Prisma lookups. `buildScopeFilter()` and
`canAccessScopes()` in `src/lib/api/scope-filter.ts` (re-exported by
`src/lib/api/auth.ts`) define the canonical semantics that both adapters must
remain conformant with.
See the restricted-tags implementation docs in the codebase for the full access
control model.

Recall quarantine is an additional mandatory eligibility gate. Search SQL
excludes `recallQuarantinedAt` rows. Redis stores only IDs and bounded rank
metadata, and `NoosphereProvider` locks current lineage/article state and
rehydrates current content from PostgreSQL on every cache hit and direct get.
Best-effort cache invalidation is therefore an optimization, not a privacy
boundary.

---

## 5. Recall Orchestrator

Source: `src/lib/memory/orchestrator.ts`

`RecallOrchestrator` owns the recall flow:

```text
RecallQuery
  → provider fan-out
  → ranking
  → deduplication
  → conflict resolution
  → token/result budgeting
  → prompt injection formatting
  → RecallResponse
```

`RecallQuery.mode`:

- `auto` — used for prompt injection. Respects provider auto-recall settings and applies token budget behavior.
- `inspection` — used for explicit lookup/review. Queries enabled providers without auto-recall filtering.

`RecallResponse` includes ranked results, provider metadata, optional dedup stats,
optional conflicts, token budget usage, and `promptInjectionText` for auto-mode
injection.

Important options in `RecallOrchestratorOptions`:

| Option | Purpose |
| --- | --- |
| `deduplication` | Strategy and provider priority for collapsed duplicate results. |
| `conflict` | Conflict strategy, threshold, and provider weighting. |
| `autoRecallTokenBudget` | Default token cap for auto-mode prompt injection. |
| `globalResultCap` | Final cap on returned results. Defaults to `20`. |
| `concurrency` | Max providers queried concurrently. Defaults to all providers at once. |

`autoRecallTokenBudget` defaults to `2000`. Per-query overrides can still pass
`RecallQuery.tokenBudget` and `RecallQuery.resultCap`.

---

## 6. Context Budget Manager

Source: `src/lib/memory/budget.ts`

`ContextBudgetManager` enforces hard caps before recall results become prompt
context. It returns `BudgetResult`, which includes selected entries, token
usage, and aggregate drop/trim counts.

Configuration is `ContextBudgetConfig`:

| Field | Purpose |
| --- | --- |
| `maxResults` | Maximum entries injected. Defaults to `20`. |
| `maxTokens` | Maximum estimated tokens injected. Defaults to `2000`. |
| `verbosity` | `minimal`, `standard`, or `detailed`. Defaults to `standard`. |
| `summaryFirst` | Prefer summaries before full content when available. Defaults to `true`. |

---

## 7. Cross-Provider Deduplication

Source: `src/lib/memory/dedup.ts`

`CrossProviderDeduplicator` collapses equivalent results, usually by
`canonicalRef` with provider/id fallback. Strategies:

| Strategy | Behavior |
| --- | --- |
| `best-score` | Keeps highest composite score. |
| `provider-priority` | Prefers configured provider order/weights. |
| `most-recent` | Prefers newest `updatedAt`/`createdAt`, then score. |

Dedup output preserves provenance so callers can see every provider that
returned the winning memory.

---

## 8. Conflict Resolution

Source: `src/lib/memory/conflict.ts`

Conflict resolution detects contradictory or divergent results and then applies a
configured strategy:

| Strategy | Behavior |
| --- | --- |
| `surface` | Keep both results and attach conflict metadata. |
| `suppress-low` | Suppress the lower-scoring result. |
| `accept-highest` | Select the highest adjusted score for stats, keep both results, and suppress conflict metadata. |
| `accept-recent` | Select the most recently updated result for stats, keep both results, and suppress conflict metadata. |
| `accept-curated` | Select the more curated result for stats, keep both results, and suppress conflict metadata. |

`ConflictConfig.conflictThreshold` controls sensitivity. Use
`toConflictConfig()` from `settings.ts` to derive conflict config from
user-facing recall settings.

---

## 9. User-Facing Recall Settings

Source: `src/lib/memory/settings.ts`

`RecallSettings` is the stored/user-facing settings shape. It is normalized and
merged in `settings.ts`, but not every field is automatically wired into the
runtime by a single helper yet. Today, `toConflictConfig(settings)` maps the
conflict-related fields into the orchestrator's `ConflictConfig`; the remaining
settings must be translated by the API/UI/wiring layer when constructing
providers or `RecallOrchestratorOptions`.

| Setting | Purpose | Current wiring note |
| --- | --- | --- |
| `autoRecallEnabled` | Enables automatic recall injection. | Wiring layer should decide whether to run auto recall. |
| `maxInjectedMemories` | Result count cap for injected context. | Pass as `RecallQuery.resultCap` or orchestrator cap. |
| `maxInjectedTokens` | Token cap for injected context. | Pass as `RecallQuery.tokenBudget` or `autoRecallTokenBudget`. |
| `recallVerbosity` | `minimal`, `standard`, or `detailed`. | Normalized setting; budget verbosity translation is not automatic yet. |
| `deduplicationStrategy` | Dedup strategy. | Pass into orchestrator `deduplication` config. |
| `enabledProviders` | Provider allow-list. | Wiring layer chooses registered providers. |
| `providerPriorityWeights` | Provider ranking and conflict weights. | Used by `toConflictConfig()` for conflicts; provider ranking weights need explicit wiring. |
| `summaryFirst` | Prefer summaries before full content. | Normalized setting; budget `summaryFirst` translation is not automatic yet. |
| `conflictStrategy` | Conflict resolution behavior. | Mapped by `toConflictConfig()`. |
| `conflictThreshold` | Conflict sensitivity from 0 to 1. | Mapped by `toConflictConfig()`. |

Use:

- `normalizeRecallSettings(input)` to validate/clamp user input.
- `mergeRecallSettings(base, overrides)` to apply overrides safely.
- `toConflictConfig(settings)` to wire conflict settings into conflict resolution.

---

## 10. Promotion Pipeline

Source: `src/lib/memory/promotion.ts`

Promotion identifies frequently recalled, relevant memories that should move up
the curation ladder.

Key types:

- `MemoryRecallStats` — provider/memory recall count, relevance sum, curation level, and timestamps.
- `PromotionCandidate` — pending/approved/rejected promotion record.
- `PromotionConfig` — thresholds, target levels, and pending queue cap.

Default promotion config:

```ts
DEFAULT_PROMOTION_CONFIG = {
  minRecallCount: 3,
  minAvgRelevance: 0.5,
  promotionTargets: {
    ephemeral: "managed",
    managed: "curated",
    curated: null,
  },
  maxPendingCandidates: 100,
}
```

Important functions:

- `recordRecall(map, result)` — updates recall stats for a recalled memory.
- `scanForCandidates(statsList, existingKeys)` — creates eligible candidates and deduplicates by `provider:memoryId`.
- `applyReview(candidate, review)` — moves a candidate to approved/rejected.
- `prunePendingCandidates(candidates)` — bounds pending queue size.

Persistence is intentionally not owned by `promotion.ts`; callers store stats and
candidates in their own wiring layer.

---

## 11. Backfill and Synthesis

Source: `src/lib/memory/backfill.ts`

Backfill turns approved promotion candidates into synthesized article content.
The module tracks job state and content merge behavior, but does not write to the
database directly.

Job lifecycle:

```text
pending → in_progress → completed
                    ↘ failed ──retry action──▶ pending
```

`retry` is an action performed by `retryJob()`, not a `SynthesisStatus` value.

Content strategies:

| Strategy | Behavior |
| --- | --- |
| `append` | Append incoming content after a separator. |
| `replace` | Replace existing content entirely. |
| `merge` | Placeholder intelligent merge; currently append-like. |

Important functions:

- `createSynthesisJob(candidate)` — creates a pending job.
- `prepareSynthesisInput(candidate, memoryContent, ...)` — builds input.
- `synthesize(input, strategy)` — pure content resolution.
- `updateJobStatus(job, status, result)` — records completion/failure metadata.
- `canRetry(job)` / `retryJob(job)` — retry policy helpers.
- `getPendingJobs(jobs)` — filters approved pending work.

---

## 12. Local Scheduler

Source: `src/lib/memory/scheduler.ts`

`LocalMemoryScheduler` is the local-only scheduling foundation for maintenance
jobs. The scheduler core uses in-process `setTimeout` scheduling and has no
database, queue, network, Vercel, or hosted scheduler dependency. The CLI now
registers one database-backed durable automatic-memory maintenance job alongside
the pure health job.

Job definition:

```ts
interface SchedulerJobDefinition {
  id: string;
  name: string;
  intervalMs: number;
  enabled?: boolean;
  runOnStart?: boolean;
  run: (context: SchedulerRunContext) => void | Promise<void>;
}
```

Scheduler methods:

| Method | Purpose |
| --- | --- |
| `registerJob(job)` | Adds a validated job definition. |
| `start()` | Starts local timers for enabled jobs. |
| `stop()` | Clears timers and waits for in-flight jobs. |
| `runJob(id)` | Runs one job immediately, deduping concurrent callers. |
| `runDueJobs(now)` | Runs due jobs without starting timers. Useful for tests or external cron wrappers. |
| `getStatus()` | Returns `SchedulerStatusSnapshot` for observability. |

Status values:

```text
idle | running | succeeded | failed | disabled
```

The baseline health job is `createSchedulerHealthJob(intervalMs)`. It is a no-op
that proves the scheduler event loop can execute and report job status.
`createDurableMemoryMaintenanceJob(intervalMs)` leases due
`MemoryDurableJob` rows with `FOR UPDATE SKIP LOCKED` and runs capture expiry or
privacy cleanup. It does not consult the capture-ingestion feature flag.

---

## 13. Scheduler CLI

Source: `scripts/memory-scheduler.ts`

Commands:

```bash
# Long-running local scheduler process
npm run memory:scheduler

# Run health plus one durable-maintenance batch and print JSON status
npm run memory:scheduler -- --once

# Print a status snapshot without running jobs
npm run memory:scheduler -- --status
```

Environment:

```bash
MEMORY_SCHEDULER_HEALTH_INTERVAL_MS=60000
MEMORY_DURABLE_MAINTENANCE_INTERVAL_MS=60000
```

Default interval is 60 seconds. `SIGINT` and `SIGTERM` trigger graceful shutdown:
timers are cleared, in-flight jobs are awaited, and final status is printed.
Durable maintenance intervals below one second are rejected and fall back to
the 60-second default to prevent accidental hot loops.

---

## 14. Example Wiring

Example provider/orchestrator setup:

```ts
import {
  createHindsightProvider,
  createNoosphereProvider,
  createRecallOrchestrator,
} from "@/lib/memory";

const orchestrator = createRecallOrchestrator({
  providers: [
    { provider: createNoosphereProvider() },
    { provider: createHindsightProvider(hindsightSettings) },
  ],
});

const response = await orchestrator.recall({
  query: "authentication flow",
  mode: "auto",
  tokenBudget: 1200,
});

console.log(response.promptInjectionText);
```

Example local job registration:

```ts
import { createLocalMemoryScheduler } from "@/lib/memory";

const scheduler = createLocalMemoryScheduler([
  {
    id: "memory.promote",
    name: "Scan recall stats for promotion candidates",
    intervalMs: 15 * 60 * 1000,
    runOnStart: false,
    run: async () => {
      // Load persisted recall stats in the wiring layer.
      // Call scanForCandidates(stats, existingKeys), then persist new candidates.
    },
  },
]);

scheduler.start();
```

---

## 15. Test and Verification Commands

```bash
# All memory module tests
npm run test:memory

# Scheduler-only tests
npx tsx --test src/__tests__/memory/scheduler.test.ts

# TypeScript validation
npx tsc --noEmit

# Scheduler CLI smoke checks
npm run memory:scheduler -- --once
npm run memory:scheduler -- --status
```

Behavioral test coverage lives in `src/__tests__/memory/` and should be updated
with any changes to public contracts described here.

---

## 16. OpenClaw Bridge Architecture

Source: `openclaw-noosphere-memory/src/`

The OpenClaw bridge is a plugin that wires Noosphere into the OpenClaw agent runtime.
It provides explicit tools (`noosphere_status`, `noosphere_recall`, `noosphere_get`,
`noosphere_save`) and an optional `before_prompt_build` hook for auto-injection.

### Plugin Structure

```
openclaw-noosphere-memory/src/
├── index.ts           — plugin manifest (tools, hooks, capabilities)
├── config.ts          — NoosphereMemoryPluginConfig + defaults
├── client.ts          — NoosphereMemoryClient (HTTP API wrapper)
├── auto-recall.ts     — before_prompt_build hook implementation
├── cli.ts             — OpenClaw `noosphere` CLI helpers
├── corpus-supplement.ts — memory corpus supplement wiring
├── format.ts          — XML output formatting
├── types.ts           — shared TypeScript types
└── tools/
    ├── status.ts
    ├── recall.ts
    ├── get.ts
    └── save.ts
```

### NoosphereAutoRecallConfig

Source: `openclaw-noosphere-memory/src/config.ts` and
`openclaw-noosphere-memory/src/auto-recall.ts`

The auto-recall hook uses `NoosphereAutoRecallConfig` for prompt injection gates,
query construction, timeouts, and memory-capture guidance. The official installer
sets secure local connection defaults plus installer-specific prompt-injection
budget/timeout values that differ from the plugin's raw library defaults.

To avoid duplicated default tables drifting across documents, the canonical
operator-facing field reference lives in
[`OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`](OPENCLAW-OFFICIAL-PLUGIN-SETUP.md#plugin-configuration-fields).

Key groups:

- **Connection**: `baseUrl`, `apiKey`, `timeoutMs`
- **Auto-recall gates**: `autoRecall`, `enabledAgents`, `allowedChatTypes`,
  `ignoreSessionPatterns`, `statelessSessionPatterns`, `skipStatelessSessions`
- **Query construction**: `includeRecentTurns`, `recentTurnLimit`,
  `minQueryLength`, `autoProviders`
- **Prompt budget/placement**: `maxInjectedMemories`, `maxInjectedTokens`,
  `recallInjectionPosition`, `autoRecallTimeoutMs`
- **Capture guidance**: `memoryCaptureInstructionsEnabled`,
  `memoryCaptureInstructions`

### Memory Capture Instructions

The implemented advisory hook behavior is documented below. The proposed
deterministic capture, recall-enrichment, ephemeral-candidate, and promotion
pipeline is specified separately in
[`AUTOMATIC-MEMORY-CAPTURE-AND-ENRICHMENT-ADR.md`](AUTOMATIC-MEMORY-CAPTURE-AND-ENRICHMENT-ADR.md).

When `memoryCaptureInstructionsEnabled: true`, the `before_prompt_build` hook injects
a `<noosphere_memory_capture>` XML block containing guidance on when and how to use
`noosphere_save`. The guidance is independent of recall result content: an eligible
auto-recall turn still receives capture guidance when a successful recall returns
zero matches or omits prompt-injection text. If an empty response reports a provider
error, the hook fails open and injects neither guidance nor recall content. The
default instructions tell agents:

**WHEN TO SAVE:**
- After completing a significant task (deployment, bug fix, feature implementation)
- After fixing an error or resolving a technical issue
- After making an important architectural decision or trade-off
- When the user explicitly asks to remember something

**HOW TO SAVE (via `noosphere_save`):**
- `topicId`: which topic to file under
- `title`: concise description of what was learned
- `content`: detailed explanation (≥40 chars, ≥6 words)
- `confidence`: low/medium/high based on certainty
- `tags`: relevant topic tags

**WHAT NOT TO SAVE:**
- Transient acknowledgments ("I'll check...", "Got it", "Sure")
- Content that is too short (<40 chars or <6 words)
- Secrets, API keys, tokens, or credentials
- Non-durable operational text

### Hook Injection Flow

```
before_prompt_build hook
  → shouldAutoRecall() gates (enabled + agent + chat type + query length)
  → fetchRecallSettings() from DB (with 30s cache)
  → executeMemoryRecallRequest() via HTTP API
  → extractPromptInjectionText() from response
  → IF recall text is absent AND provider metadata reports an error: return undefined
  → Build injection parts independently:
      → IF memoryCaptureInstructionsEnabled: add <noosphere_memory_capture>
      → IF recall text exists: add <noosphere_auto_recall>
      → IF neither exists: return undefined
      → ELSE inject the available part(s)
```

### OpenClaw CLI Helpers

The plugin registers a `noosphere` CLI command group:

```bash
openclaw noosphere status
openclaw noosphere doctor
openclaw noosphere logs [service]
openclaw noosphere setup
openclaw noosphere upgrade
```

`status` and `doctor` use the Noosphere HTTP API and resolved OpenClaw plugin
config. `logs`, `setup`, and `upgrade` print operator commands instead of
executing Docker or shell commands from the plugin package.

### Settings Cache

The auto-recall hook caches recall settings from the DB for 30 seconds to avoid
excessive API calls. The effective settings are refreshed after the cache TTL;
changes made through the admin UI or API are picked up on the next refresh.

### Backward Compatibility

The plugin guards against older config shapes that may not have new fields:
- `memoryCaptureInstructionsEnabled` guarded with `?? true`
- `memoryCaptureInstructions` guarded with `?? DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS`
- `clientContext.client.settings` existence checked before calling

### Safety Properties

- **Fails open**: if the recall request times out or the server is unreachable,
  or an empty response reports a provider error, the hook returns `undefined` and
  the prompt proceeds without memory injection.
- **Instructions are informational**: they guide agent behavior but do not execute
  saves. Agents must explicitly call `noosphere_save` to persist anything.
- **No forced saves**: even with instructions enabled, saves only happen when the
  agent decides to call the tool.
- **Bounded results**: orchestrator enforces `maxInjectedMemories` and
  `maxInjectedTokens` caps at the server level.
- **Local-first setup**: the official OpenClaw setup binds Noosphere to
  `127.0.0.1:6578` by default and stores secrets outside the repository.

### Conversational Search Fallback

The Noosphere article provider first runs the normal weighted PostgreSQL
full-text query over title, excerpt, content, and tags. If that strict query
returns no rows, it retries once with a bounded fallback tsquery built from
distinctive terms plus a small synonym set for common conversational misses.

Example: a user may ask for a "photo" while the durable article says "portrait",
or ask for an "avatar" while the article says "profile". The fallback can bridge
that vocabulary gap, but only after the precise query has failed, so normal
exact search ranking remains unchanged.

See also: [`OPENCLAW-OFFICIAL-PLUGIN-SETUP.md`](OPENCLAW-OFFICIAL-PLUGIN-SETUP.md).
