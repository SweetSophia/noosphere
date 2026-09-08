# Phase D evaluation protocol — issue #319

Pre-registered before any decision-grade run. Metrics, thresholds, and the
category mix below are fixed before scores are seen; changing them after a run
requires a new protocol revision and a fresh run. The harness itself is
documented in `docs/HYBRID-SHADOW-EVALUATION.md` (measurement tooling, private
reports, freshness preflight, denominator semantics).

## Scope and subjects

- Subject: hybrid retrieval (lexical + embeddings, RRF) vs keyword-only, same
  production `search` path, reference deployment profile
  `nomic-embed-text-v1.5` Q8_0, 768-d (llama.cpp; Ollama excluded by policy).
- Evaluation runs read-only against the authorized evaluation corpus
  (unscoped by default; admin scope only with explicit operator authorization).
- Serving posture is out of scope: this protocol produces the accept/tune/reject
  evidence for #319; it does not itself activate or deactivate anything.

## Query set

Versioned in `src/__tests__/fixtures/hybrid-shadow-queries.json`. Minimum 20
queries. Categories (encoded in query id prefixes):

- `exact-*` — near-title keyword lookup; keyword path should already do well.
- `paraphrase-*` — same intent, different wording than article titles.
- `mismatch-*` — vocabulary the corpus titles do not contain; the case hybrid
  embeddings are expected to win. A large hybrid advantage here is the primary
  signal that the capability earns its complexity.
- `cross-*` — answers spread across several articles.
- `noanswer-*` — nothing relevant exists; relevance is `{}`. These count in
  the MRR denominator as zero and are excluded from recall/nDCG. They detect
  hallucinated relevance (returning junk for unanswerable queries).

Judgments: 3 = on-topic core, 2 = related, 1 = background, 0 = off-topic.
Judgments are per slug; slugs are unique only per topic, so duplicate-slug
ambiguity must be resolved (or the query dropped) before a decision-grade run.
Slugs must pass the freshness preflight (`clear`) before scores are read.

A held-out subset (every second query by fixture order, recorded in the run
evidence) is reserved for the final acceptance run; tuning iterations use the
remainder only.

## Run procedure

1. Freshness preflight: `npm run hybrid:shadow-eval -- --preflight-only ...`.
   All judgments `visible` (outcome `clear`) is a precondition. Ambiguous or
   not-visible judgments block the run until resolved by editing the fixture
   (never by deleting difficult judgments to improve scores).
2. Dual-path run: `npm run hybrid:shadow-eval -- --limit 10 --k 5 ...`.
   Record: harness commit SHA, fixture version, corpus snapshot date, scope,
   Redis configured or not, and the keyword-first cache-warming caveat.
3. Keep raw JSONL/JSON/Markdown private (restricted titles possible). Publish
   only the aggregate table and per-category breakdown in the decision record.

## Primary metrics and thresholds

Primary: recall@5 and nDCG@5 (graded, linear gain), both paths. Secondary:
MRR@10, p50 latency, observed/unknown fallback counts.

| Decision | Rule |
| --- | --- |
| ACCEPT | hybrid nDCG@5 ≥ keyword nDCG@5, AND hybrid recall@5 ≥ keyword recall@5 − 0.05, AND no category regresses by > 0.10 nDCG@5, AND keyword-path metrics on the same run remain within 0.05 of their last accepted baseline (instrument sanity). |
| TUNE | hybrid wins overall but one category regresses > 0.10, OR fallbackUnknown > 20% of hybrid queries. Tune, then rerun the full protocol (both subsets). |
| REJECT | hybrid nDCG@5 < keyword nDCG@5, OR a primary category regresses > 0.20. |

Latency and fallback counts are reported, not gated: hybrid p50 may exceed
keyword p50; that is an operator tradeoff, not an automatic reject.

Thresholds are defaults ratified at PR review; record any change with rationale
in the decision record before the acceptance run.

## Over-context / lexical fallback

Articles exceeding the embedding context window fall back to lexical-only.
The harness reports per-query fallback metadata (unknown when results are
empty). The decision record must state the observed fallback rate and confirm
the keyword-only fallback path for over-context articles returned sane
rankings (spot-check the fallback queries' JSONL rows). A fallback rate above
10% on the evaluation corpus triggers a TUNE review of chunking/embedding,
not a silent accept.

## Decision record

Filed as a private report plus a public summary on #319 containing: decision
(ACCEPT/TUNE/REJECT), aggregate and per-category table for both subsets,
fallback and latency observations, exact run conditions, and protocol
revision used. #319 closes only when the acceptance run on the held-out
subset meets the ACCEPT rule and the record is attached.
