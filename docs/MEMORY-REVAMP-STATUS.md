# Memory Capture and Hybrid Retrieval Revamp Status

Status: active implementation status
Last verified: 2026-08-24 against `master` after PR #300

This document is the authoritative implementation matrix for Noosphere's
automatic-memory-capture and authorization-safe hybrid-retrieval revamp. It
separates four states that older plans sometimes conflated:

- **Merged capability** — code and its verification have landed on `master`.
- **Default runtime** — behavior a normal installation receives without an
  explicit activation decision.
- **Deployment state** — behavior verified in one named environment at a stated
  point in time; it is not inferred from repository defaults.
- **Operator rollout** — deployment-specific transition, backfill, quality, or
  serving work that must be approved and executed separately.

An implemented capability is not necessarily enabled, deployed, or serving.
This status document does not authorize a database transition, provider egress,
backfill, shadow evaluation, or hybrid serving.

## Executive status

- Explicit `noosphere_save` and prompt-time capture guidance are implemented.
- Automatic-capture Phase A persistence, privacy, lineage, TTL, and inspection
  foundations are merged but ingestion remains disabled by default.
- The OpenClaw `agent_end` hook, extraction into candidates, recall enrichment,
  and automatic promotion are not live.
- Hybrid-retrieval Phases A1, A2, A2b, A3, B, and C are merged. Storage,
  provider/worker, backfill, exact retrieval, and activation tooling exist.
- Current Compose templates use the guarded, digest-pinned pgvector database
  image. Feature-schema activation, provider/worker operation, backfill, and
  hybrid retrieval remain opt-in; retrieval defaults to
  `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`.
- The guarded existing-volume transition and its execution controller are
  implemented, but transition execution and Phase D rollout remain explicit
  operator actions. Issue #303 holds pre-transition controller hardening.

## Automatic capture and enrichment

| Capability | Merged capability | Default runtime | Remaining work |
| --- | --- | --- | --- |
| Explicit draft save (`noosphere_save`) | Implemented | Available when the plugin is configured; the agent deliberately invokes it | Continue normal curation and review |
| Capture guidance on successful recall results and clean misses (Phase 0) | Implemented in PR #281 | Available only after `autoRecall: true`, prompt injection, and session eligibility; successful results and clean misses can inject guidance, while unexpected modes, malformed provider metadata, total provider failure, and empty responses carrying any provider error fail open without guidance | None for the Phase 0 contract |
| Capture schema, authenticated endpoint, private scopes, lineage, revocation, TTL jobs, and inspection APIs (Phase A) | Implemented in PR #282 | New ingestion is disabled unless `NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED=true`; maintenance is a separate scheduler responsibility | Operate only after keys, private scopes, HMAC rotation, and cleanup are configured |
| Article recall enrichment (Phase B) | Not implemented | Lexical article documents have no generated recall-summary/search-term layer | Provider contract, consent, backfill, search integration, and measured quality gate |
| OpenClaw `agent_end` capture and extraction (Phase C) | Not implemented | No automatic turn submission or candidate extraction | Agent/chat allowlists, bounded hook, extraction worker, metrics, and operations runbook |
| Useful-recall promotion (Phase D) | Foundations only; no live promotion service | No automatic candidate-to-draft promotion | Durable selection statistics, review UI, contradiction/duplicate gates, and draft synthesis worker |
| Enrichment-aware hybrid convergence (Phase E) | Not implemented | Current hybrid canonical document excludes future enrichment fields | New immutable profile, full backfill, coverage gate, and measured replacement of the prior profile |

The detailed privacy and lifecycle contract remains in
[Automatic Memory Capture and Recall Enrichment](AUTOMATIC-MEMORY-CAPTURE-AND-ENRICHMENT-ADR.md).

## Hybrid retrieval and pgvector rollout

| Phase or capability | Merged capability | Default runtime | Remaining work |
| --- | --- | --- | --- |
| Architecture contract | Introduced in PR #280 and accepted by the current ADR | No behavior change by itself | Keep implementation and rollout aligned with the ADR |
| A1: owned PostgreSQL + pgvector image | Implemented in PR #284 | Current Compose templates select the digest-pinned image and require authorization markers | Existing source-image volumes still require the guarded transition |
| A2/A2b: rehearsal and guarded Compose switch | Implemented in PRs #285 and #286; later recovery/digest hardening landed through PR #299 | No unrestricted in-place upgrade; the guard remains mandatory | Execute only with deployment-specific approval and evidence |
| A3: optional feature storage | Implemented in PR #287 | Feature schema remains absent until explicit activation | Activate and validate against the target database |
| B: provider, worker, consent, profile, and backfill tooling | Implemented in PR #288 | No serving profile or worker is required by the keyword-only runtime | Configure an approved provider, activate the worker layer, create a preparing profile, and backfill |
| C: authorization-safe exact hybrid recall and RRF | Implemented in PR #289, with provider hardening in PR #291 | Disabled by `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`; lexical fallback remains authoritative | Complete Phase D gates before returning hybrid rankings |
| Existing-volume execution controller | Implemented in PR #300 | Does not run automatically | Resolve the production-safety subset of issue #303, then obtain explicit transition authorization |
| D: transition, coverage, shadow evaluation, quality acceptance, and serving | Not completed | Keyword-only recall remains the safe default | Transition the target database, activate layers, backfill to the coverage threshold, run opt-in shadow evaluation, and approve serving |

Issue #261 remains open until the operator rollout and Phase D acceptance work is
complete. Merged code alone does not satisfy that epic's serving outcome.

## Reference deployment state

| Environment | Last verified | Database state | Hybrid flag | Rollout state |
| --- | --- | --- | --- | --- |
| Local reference deployment | 2026-08-24 (read-only) | Source PostgreSQL 16 image with populated `noosphere_postgres_data` volume | `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false` | Guarded existing-volume transition not performed; not hybrid-serving |

This is a point-in-time environment observation, not an installation default or
authorization to change that environment. Other deployments must publish their
own transition, activation, profile, coverage, and serving evidence.

## Current gated milestones

1. Keep this matrix and the linked ADRs synchronized as the source of status
   truth.
2. Address the three production-safety mechanisms in issue #303 before any
   existing-volume transition: bound Compose interpolation, durable writer
   closure after post-authorization failure, and rejection of unsafe root-owned
   writable Compose parents.
3. Handle issue #303's remaining harness, documentation, and portability items
   as a separately bounded follow-up.
4. Obtain explicit operator approval for the PostgreSQL transition, then perform
   feature activation, profile backfill, shadow evaluation, coverage/relevance
   acceptance, and serving activation in that order.
5. Continue automatic-capture Phases B, C, and D. Defer importance decay
   (issue #262) until capture, promotion, and retrieval metrics are live enough
   to measure its effects.

## Status maintenance

Update this matrix when any of these events occur:

- a listed phase merges or is materially redesigned;
- a default flag changes;
- the reference deployment changes or its observation is re-verified;
- an operator rollout gate completes;
- issue #303 changes the transition boundary; or
- automatic capture begins generating or promoting candidates.

ADRs remain the decision and invariant records. Runbooks remain the operational
source of truth. This document records implementation and rollout status only.
