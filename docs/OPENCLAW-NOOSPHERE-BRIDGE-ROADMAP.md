# OpenClaw ↔ Noosphere Memory Bridge Roadmap

Status: implementation in progress — PRs 0–4 merged; PR 5 underway
Owner: Noosphere/OpenClaw integration workstream
Last updated: 2026-04-30

## Goal

Expose Noosphere as a provider-agnostic memory and knowledge layer for OpenClaw agents through a clean HTTP bridge and a thin OpenClaw plugin.

The bridge should let OpenClaw:

- inspect Noosphere memory health and provider configuration;
- explicitly recall durable Noosphere knowledge;
- eventually inject bounded Noosphere recall into prompts;
- eventually save durable candidates without directly publishing curated knowledge.

## Current Runtime Assumptions

Sophie's current OpenClaw runtime uses:

- `hindsight-openclaw` as the active memory slot;
- `lossless-claw` as the context engine;
- Noosphere as a standalone web/wiki/memory application.

Therefore the bridge must not assume OpenClaw `memory-core` or QMD (the local-first search sidecar described in the OpenClaw memory docs) is the active memory path.

## Shared API Rules

- **Authentication:** memory endpoints require API key auth via `Authorization: Bearer <key>`, matching the existing Noosphere API key convention.
- **Auth failures:** invalid or missing credentials return HTTP 401 with `{ "error": "Unauthorized" }`; the OpenClaw plugin should treat this as configuration failure, not as a transient outage.
- **Transient failures:** dependency failures and provider timeouts should return structured provider metadata where possible; plugin auto-recall must fail open and inject nothing.
- **Hard request limits:** implementation PRs should enforce a server-side timeout, max result cap, and max token budget even when the caller requests larger values. Initial target defaults: 5s HTTP timeout, 10 results, and 2,000 injected tokens unless the implementation PR justifies different limits.
- **Deduplication and conflicts:** recall responses should preserve `dedupStats` and `conflictStats` when available. Conflict strategies should use the existing `ConflictStrategy` semantics (`accept-highest`, `accept-recent`, `accept-curated`, `surface`, `suppress-low`) and expose surfaced conflicts as metadata rather than silently mutating source content.

## Design Principles

1. **HTTP boundary first**
   - OpenClaw should call Noosphere over HTTP.
   - The OpenClaw plugin must not import Noosphere internals directly.

2. **Provider-agnostic Noosphere**
   - Hindsight is a useful provider, not a hard dependency.
   - Noosphere must work with Hindsight, without Hindsight, and with future providers.

3. **Avoid duplicate automatic Hindsight injection**
   - Conservative coexistence mode: Hindsight keeps `autoRecall`; Noosphere auto-recalls curated Noosphere content only.
   - Coordinated mode: Hindsight `autoRecall=false`, Hindsight `autoRetain=true`, and Noosphere injects one coordinated recall block.

4. **Read-only before writes**
   - Start with status and recall.
   - Add save/candidate capture only after retrieval is stable.

5. **Fail open**
   - Noosphere outages must not block normal OpenClaw replies.
   - Timeouts and caps are mandatory.

6. **Verification per sub-phase**
   - Each sub-phase gets its own PR.
   - Each PR must include targeted verification and update this roadmap if scope changes.

## Sub-Phase PR Plan

### PR 0 — Roadmap and contract documentation

Status: merged.

Purpose: document architecture, operating modes, API contract, and PR split before code changes.

Deliverables:

- `docs/OPENCLAW-NOOSPHERE-BRIDGE-ROADMAP.md`
- clear sub-phase boundaries
- verification plan for each stage

Verification:

```bash
git diff --check
```

### PR 1 — Memory status API

Status: merged.

Purpose: expose a safe status endpoint for OpenClaw/plugin health checks.

Endpoint:

```http
GET /api/memory/status
```

Proposed response:

```ts
interface MemoryStatusResponse {
  ok: boolean;
  timestamp: string; // ISO 8601
  providers: Array<{
    id: string;
    displayName?: string;
    enabled: boolean;
    allowAutoRecall: boolean;
    capabilities: {
      search: boolean;
      getById: boolean;
      score: boolean;
      autoRecall: boolean;
    };
    sourceType: MemorySourceType;
  }>;
  settings: {
    autoRecallEnabled: boolean;
    maxInjectedMemories: number;
    maxInjectedTokens: number;
    recallVerbosity: BudgetVerbosity;
    deduplicationStrategy: DeduplicationStrategy;
    conflictStrategy: ConflictStrategy;
    conflictThreshold: number;
    summaryFirst: boolean;
  };
}
```

Constraints:

- require API key auth via `Authorization: Bearer <key>`;
- return HTTP 401 for auth failures and do not fail open for explicit status calls;
- return no secrets;
- include only safe provider metadata;
- initially report the built-in Noosphere provider.

Verification:

```bash
npm run test:memory
npx tsc --noEmit
git diff --check
```

Targeted tests should cover:

- missing/invalid API key;
- successful status response shape;
- no secret fields in response.

### PR 2 — Memory recall API

Status: merged.

Purpose: expose the Noosphere recall orchestrator over HTTP.

Endpoint:

```http
POST /api/memory/recall
```

Request:

```ts
interface MemoryRecallRequest {
  query: string;
  mode?: "auto" | "inspection";
  resultCap?: number;
  tokenBudget?: number;
  scope?: string;
  providers?: string[];
}
```

Response:

```ts
interface MemoryRecallResponse {
  results: RecallResultRanked[];
  totalBeforeCap: number;
  mode: "auto" | "inspection";
  tokenBudgetUsed?: number;
  promptInjectionText?: string; // present only when mode is "auto"
  providerMeta: RecallProviderMeta[];
  dedupStats?: DeduplicationStats;
  conflicts?: ConflictSignal[];
  conflictStats?: ConflictStats;
}
```

Contract notes:

- `RecallResultRanked` is the existing ranked memory result shape returned by the orchestrator. It should keep the provider-agnostic memory fields needed by clients: stable `id`, provider/source metadata, content or summary text, relevance/ranking score, optional token estimate, and optional conflict/dedup metadata.
- If the lookup endpoint later returns a non-ranked `MemoryResult`, document that exact shape in the implementation PR and keep it aligned with the shared memory provider types rather than inventing a second result contract.

Initial provider policy:

- default `auto` mode providers: `noosphere` only;
- default `inspection` mode providers: enabled providers available in Noosphere wiring;
- implement route-level provider filtering, because the current `RecallQuery` contract does not include `providers`;
- reject unknown provider IDs with a validation error or report them as skipped, depending on final route design.

Constraints:

- require API key auth via `Authorization: Bearer <key>`;
- validate query and caps;
- enforce server-side max result and token caps;
- keep `promptInjectionText` tied to orchestrator `auto` mode unless a future PR explicitly adds an inspection formatter;
- return provider errors as metadata instead of crashing where possible;
- do not expose provider secrets.

Verification:

```bash
npm run test:memory
npx tsc --noEmit
git diff --check
```

Targeted tests should cover:

- missing/empty query;
- auto mode prompt text and token budget;
- inspection mode without prompt text;
- provider filtering;
- result caps;
- provider error metadata/fail-open behavior.

### PR 3 — OpenClaw plugin skeleton and explicit tools

Status: merged.

Purpose: create a thin OpenClaw plugin that calls Noosphere HTTP endpoints manually.

Plugin tools:

- `noosphere_status`
- `noosphere_recall`
- `noosphere_get` if a lookup endpoint exists by then, otherwise defer

Core plugin files:

```text
openclaw-noosphere-memory/
  package.json
  openclaw.plugin.json
  src/index.ts
  src/client.ts
  src/config.ts
  src/format.ts
  src/shared-init.ts
  src/tools/status.ts
  src/tools/recall.ts
```

Constraints:

- use normal OpenClaw plugin APIs, not agent harness APIs;
- use focused SDK imports;
- redact secrets in status/errors;
- set strict request timeout;
- fail clearly for explicit tools, but do not crash the plugin.

Verification:

- plugin loads;
- tools appear;
- `noosphere_status` works against a running Noosphere;
- `noosphere_recall` works on a known query;
- timeout/error path is safe.

### PR 4 — Auto-recall prompt injection

Status: merged in PR #43.

Purpose: add optional bounded Noosphere recall injection to OpenClaw.

Hook:

- `before_prompt_build`

Config:

```ts
interface NoosphereAutoRecallConfig {
  autoRecall: boolean;
  autoProviders: string[];
  recallInjectionPosition: "prepend" | "system-prepend" | "system-append";
  maxInjectedMemories: number;
  maxInjectedTokens: number;
  timeoutMs: number;
  enabledAgents: string[];
  allowedChatTypes: string[];
}
```

Default mode:

- conservative coexistence;
- `autoProviders: ["noosphere"]`;
- do not query Hindsight automatically unless coordinated mode is explicitly enabled.

Verification:

- known prompt injects a bounded `<recall>` block;
- empty recall injects nothing;
- timeout injects nothing and logs warning;
- generated block is distinct from `<hindsight_memories>`;
- configuration prevents double Hindsight auto-injection by default.

### PR 5 — Lookup endpoint/tool

Purpose: support direct retrieval by provider-local memory identifier or canonical reference.

Endpoint:

```http
POST /api/memory/get
Authorization: Bearer <key with READ or higher>
Content-Type: application/json
```

Request shape:

```ts
interface MemoryGetRequest {
  provider?: string;
  id?: string;
  canonicalRef?: string; // e.g. "noosphere:article:<id>"
}
```

Response shape:

```ts
interface MemoryGetResponse {
  result: MemoryResult | null;
  providerMeta: Array<{
    providerId: string;
    enabled: boolean;
    found: boolean;
    error?: string;
    durationMs?: number;
  }>;
}
```

Constraints:

- support canonical refs like `noosphere:article:<id>`;
- return the normalized memory result shape used by `MemoryProvider.getById()`;
- preserve provider-agnostic shape for future providers;
- route-level provider selection mirrors recall API provider filtering;
- provider lookup failures fail open into `providerMeta.error` rather than 500ing the route.

### PR 6 — Save/candidate API and tool

Purpose: add explicit candidate memory saving.

Endpoint:

```http
POST /api/memory/save
```

Default behavior:

- candidate/draft only;
- never directly publish curated articles by default;
- require durable-value criteria;
- strip injected memory blocks before save.

Plugin tool:

- `noosphere_save`

Verification:

- saves candidate/draft;
- rejects empty/noisy/transient content;
- strips `<recall>`, `<hindsight_memories>`, and related injected blocks;
- no secrets in saved content or logs.

### PR 7 — Optional corpus supplement compatibility

Purpose: expose Noosphere as a searchable corpus for OpenClaw hosts that consume `registerMemoryCorpusSupplement()`.

`registerMemoryCorpusSupplement()` is the OpenClaw SDK registration point for adding an external corpus to shared memory search/get flows. The supplement should adapt Noosphere recall/get responses into the host's corpus item contract, including stable IDs, display titles, snippets/content, source labels, and safe metadata. Keep this optional until the target OpenClaw runtime is confirmed to consume corpus supplements.

This is not a first milestone because the current active memory slot is Hindsight, not `memory-core`.

Verification:

- only enable after confirming active host consumes supplements;
- `memory_search corpus=all` includes Noosphere results in compatible setups.

## Open Questions

- Should Noosphere memory API settings come from environment variables, database-stored settings, or request overrides first?
- Should unknown provider IDs be rejected or reported as skipped provider metadata?
- Should `GET /api/memory/get` be implemented before the plugin skeleton, or deferred until after explicit recall works?
- Where should the OpenClaw plugin live: inside Noosphere repo, separate repo, or OpenClaw extensions workspace?

## Release Discipline

Each sub-phase PR should include:

- concise scope statement;
- tests or explicit reason tests are not applicable;
- TypeScript check where code changed;
- no unrelated cleanup unless required by touched code;
- reviewer notes for security and runtime assumptions.
