# Phase D evaluation protocol — issue #319

**Protocol ID:** `noosphere-hybrid-shadow-v1` (revision 2)

This contract is pre-registered before a decision-grade run. Any change to its
queries, judgments, metrics, thresholds, partitions, or decision rules requires
a new committed protocol revision **before** another decision-grade run. The
decision record cites the protocol commit/blob and fixture Git blob.

The harness and its privacy, freshness, and denominator semantics are documented
in [`HYBRID-SHADOW-EVALUATION.md`](HYBRID-SHADOW-EVALUATION.md).

## Scope

- Compare hybrid retrieval (lexical + embeddings, RRF) with keyword-only through
  the same production `search` path, using the reference profile
  `nomic-embed-text-v1.5` Q8_0, 768-d (llama.cpp; Ollama excluded).
- Use the authorized evaluation corpus: unscoped by default; admin only with
  explicit operator authorization.
- Do not change serving state. This protocol supplies evidence for #319; it does
  not activate, deactivate, deploy, or serve either result path.

## Query set and categories

`src/__tests__/fixtures/hybrid-shadow-queries.json` contains 20 queries. IDs
with no recognized prefix are the original `exact` category; added queries use
these prefixes:

- `paraphrase-*` — same intent, different wording from the target titles.
- `mismatch-*` — deliberate vocabulary shift; hybrid semantic retrieval should
  earn its complexity here.
- `cross-*` — answers distributed across several articles.
- `noanswer-*` — no known relevant article; `relevance` is `{}`.

Grades: 3 = core, 2 = related, 1 = background, 0 = off-topic. Judgments are per
slug; duplicate-slug ambiguity must be resolved before scores are read. Any
resolution changes judgment identity and therefore requires a new committed
protocol/fixture revision and fresh preflight. A `clear` freshness result is a
precondition. Difficult judgments must not be removed merely to improve a
score.

No-answer queries are diagnostics, not relevance metrics: empty and irrelevant
result sets both produce recall/nDCG `null` and MRR 0. After each partition's
score-bearing run, and before its metrics are used, two reviewers independently
inspect `results[0:5]` in each path's JSONL ranking record for that partition's
single no-answer query. Do not score both no-answer IDs together. Any genuinely
relevant row invalidates that empty judgment and requires a committed
protocol/fixture revision and fresh run. Otherwise the rows are recorded as
diagnostic evidence and excluded from category/decision metrics. They are not
described as detecting hallucination automatically.

## Frozen partitions

Only the tuning partition may guide tuning. Its scores may be inspected during
iterations. Every tuning run must select only the tuning IDs with `--query-ids`.
The held-out partition is searched and scored once, in its final decision run.
Any earlier score-bearing search over a held-out ID is exposure, whether or not
the resulting report is opened; start a new protocol revision with a new
held-out set after such exposure. Freshness-only checks do not score queries and
may cover the full fixture. The harness refuses score-bearing runs that omit
both `--query-ids` and the explicit `--all-queries` compatibility escape hatch;
that escape hatch is forbidden for this protocol.

**Tuning (10):**

- `release-1-13-2`
- `pgvector-production`
- `pr-merge-verification`
- `openclaw-recovery`
- `pixel-agents-prs`
- `paraphrase-embedding-search`
- `paraphrase-auth-repair`
- `mismatch-data-safety`
- `cross-release-evidence`
- `noanswer-cooking-recipe`

**Held-out (10):**

- `hybrid-retrieval-status`
- `codex-mcp`
- `security-repair`
- `backup-automation`
- `residential-upgrade`
- `paraphrase-plugin-publish`
- `mismatch-release-trust`
- `mismatch-agent-knowledge`
- `cross-incident-hardening`
- `noanswer-travel-visa`

The split is stratified where the 20-query fixture permits it: exact 5/5,
paraphrase 2/1, mismatch 1/2, cross 1/1, no-answer 1/1. The small category sizes
are a declared limitation; do not choose a different split after seeing scores.

## Run and evidence procedure

1. Run freshness-only first. Every judgment must be `visible` and the outcome
   `clear`; resolve any ambiguity/not-visible result through a committed fixture
   revision before continuing.
2. During tuning, run both paths with `--limit 10 --k 5 --query-ids` followed by
   the comma-separated tuning IDs above. For the final decision, use the same
   options with exactly the held-out IDs above. Record harness commit, protocol
   ID and blob, fixture blob, corpus snapshot time, scope, profile, Redis state,
   selected query IDs, and SHA-256 digests of private aggregate/JSONL reports.
   Keyword runs first and may warm lexical fallback caches; therefore latency is
   not a cold-cache comparison (see `HYBRID-SHADOW-EVALUATION.md`).
3. Keep raw JSONL/JSON/Markdown private. Publish only sanitized aggregates,
   category/subset rollups, and decision rationale.
4. List the exact query IDs used in every subset table.

### Required rollup from the aggregate JSON

The harness emits overall metrics plus flat `perQuery` rankings. Produce the
required tables from the same aggregate JSON and exact fixture as follows:

- Map each query to the frozen partition above and to its recognized prefix;
  unprefixed queries map to `exact`.
- For each path × partition × answerable category, recompute the existing
  harness formulas from recorded `results[].grade`: recall@5 uses positive hits
  divided by all positive judgments for that scored query; nDCG@5 uses linear
  gain and IDCG from that query's complete fixture relevance map; average each
  only across queries with positive judgments. A category row's MRR@10 averages
  reciprocal rank across that category's selected queries with misses = 0.
- Produce an overall row per path/partition with the same formulas. Exclude
  `noanswer` from recall/nDCG and all decision/category gates; include it in MRR
  for the overall partition row only, preserving the harness's all-selected-query
  denominator.
- Report `evaluated` and `excluded` counts beside every aggregate. Assert that
  each path has exactly one ranking for every listed query; otherwise the rollup
  is invalid.
- Category regression means `hybrid nDCG@5 - keyword nDCG@5` for that category
  in the **held-out** partition. Publish the query IDs and values used, so the
  calculation is reproducible.

## Ordered decision procedure

Use the held-out partition only. Apply the first matching outcome; these rules
are exhaustive and mutually exclusive. “Overall” means the held-out aggregate
across answerable queries using the formulas above.

1. **REJECT** if hybrid overall nDCG@5 is below keyword overall nDCG@5, or any
   answerable category's nDCG@5 regression is less than -0.20.
2. **TUNE** (only if not REJECT) if hybrid overall recall@5 is more than 0.05
   below keyword, any answerable category regression is less than -0.10, the
   observed fallback rate exceeds 10%, or an observed-fallback answerable query
   returns no grade-positive result in its top five.
3. **ACCEPT** otherwise.

Observed fallback rate is the fraction of answerable held-out hybrid rankings
whose `hybridFallback` is `true`. `fallbackUnknown` is reported separately but
is not a gate: empty results already count as misses in the primary metrics, and
no-answer diagnostics are excluded from fallback gating. Latency is reported
but not gated.

There is no pre-existing accepted keyword baseline, so baseline comparison is
N/A for revision 1. An ACCEPT record becomes the first baseline: pin its
aggregate SHA-256, fixture blob, corpus snapshot, and keyword metrics. Future
protocol revisions may add a baseline gate only when those inputs are compatible
and named before their run.

## Decision record and issue state

The private record and sanitized #319 summary include: ACCEPT/TUNE/REJECT,
protocol/fixture identities, exact run conditions, overall and per-category
tables for both partitions, denominator counts, no-answer review, observed and
unknown fallback counts, fallback spot-checks, latency, and report digests.

ACCEPT on the held-out partition with complete evidence permits #319 to close.
TUNE leaves #319 open and requires tuning plus a new full run under an applicable
pre-registered revision. REJECT leaves #319 open and records that hybrid did not
meet the gate. This PR establishes the contract only; it does not close #319.
