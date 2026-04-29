# OpenClaw ↔ Noosphere Memory Bridge Roadmap

Status: planning document
Owner: Noosphere/OpenClaw integration workstream
Last updated: 2026-04-29

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

Therefore the bridge must not assume OpenClaw `memory-core` or QMD is the active memory path.

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

Purpose: expose a safe status endpoint for OpenClaw/plugin health checks.

Endpoint:

```http
GET /api/memory/status
```

Proposed response:

```ts
{
  ok: boolean;
  timestamp: string;
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
    sourceType: string;
  }>;
  settings: {
    autoRecallEnabled: boolean;
    maxInjectedMemories: number;
    maxInjectedTokens: number;
    recallVerbosity: string;
    deduplicationStrategy: string;
    conflictStrategy: string;
    conflictThreshold: number;
  };
}
```

Constraints:

- require API key auth;
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

Purpose: expose the Noosphere recall orchestrator over HTTP.

Endpoint:

```http
POST /api/memory/recall
```

Request:

```ts
{
  query: string;
  mode?: "auto" | "inspection";
  resultCap?: number;
  tokenBudget?: number;
  scope?: string;
  providers?: string[];
  includePromptText?: boolean;
}
```

Response:

```ts
{
  results: RecallResultRanked[];
  totalBeforeCap: number;
  mode: "auto" | "inspection";
  tokenBudgetUsed?: number;
  promptInjectionText?: string;
  providerMeta: RecallProviderMeta[];
  dedupStats?: DeduplicationStats;
  conflicts?: ConflictSignal[];
  conflictStats?: ConflictStats;
}
```

Initial provider policy:

- default `auto` mode providers: `noosphere` only;
- default `inspection` mode providers: enabled providers available in Noosphere wiring;
- reject unknown provider IDs with a validation error or report them as skipped, depending on final route design.

Constraints:

- require API key auth;
- validate query and caps;
- enforce server-side max result and token caps;
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
- inspection mode without prompt text by default;
- provider filtering;
- result caps;
- provider error metadata/fail-open behavior.

### PR 3 — OpenClaw plugin skeleton and explicit tools

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

Purpose: add optional bounded Noosphere recall injection to OpenClaw.

Hook:

- `before_prompt_build`

Config:

```ts
{
  autoRecall: boolean;
  autoProviders: string[];
  recallInjectionPosition: "prepend" | "append" | "system-prepend" | "system-append";
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

- known prompt injects a bounded `<noosphere_memories>` block;
- empty recall injects nothing;
- timeout injects nothing and logs warning;
- generated block is distinct from `<hindsight_memories>`;
- configuration prevents double Hindsight auto-injection by default.

### PR 5 — Lookup endpoint/tool

Purpose: support direct retrieval by Noosphere article/memory identifier.

Possible endpoint:

```http
GET /api/memory/get?provider=noosphere&id=<id>
```

or:

```http
POST /api/memory/get
```

Constraints:

- support canonical refs like `noosphere:article:<id>`;
- return normalized `MemoryResult`;
- preserve provider-agnostic shape for future providers.

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
- strips `<noosphere_memories>`, `<hindsight_memories>`, and related injected blocks;
- no secrets in saved content or logs.

### PR 7 — Optional corpus supplement compatibility

Purpose: expose Noosphere as a searchable corpus for OpenClaw hosts that consume `registerMemoryCorpusSupplement()`.

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
