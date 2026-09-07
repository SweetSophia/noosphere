# Shadow evaluation: denominators and fixture freshness

The local operator CLI `npm run hybrid:shadow-eval` runs keyword then hybrid
search without serving results. This is measurement tooling, not a serving
acceptance gate. Reports remain private; admin runs can include restricted
rankings. Search may write caches, authorize dispatch, and call embeddings.

## Freshness before evaluation

Every dual-path run performs an exact article lookup **before searching** and
persists `freshness-<uuid>.json`, even if subsequent retrieval fails. It also
includes freshness scope, timestamps, outcome and counts in aggregate JSON and
Markdown. A database lookup failure aborts the run; it is not evidence of absence.
To inspect only freshness, without search or embedding configuration:

```sh
npm run hybrid:shadow-eval -- --preflight-only --scopes unscoped --out <private-dir>
```

Supply `DATABASE_URL` for the authorized evaluation corpus (the extension-less
application identity). Do not use production access without separate approval.
The standalone preflight emits only private JSON, not an empty metric report.
Files are created exclusively with owner-only permissions; directories created
by the harness use mode 0700. Do not publish these files.

Scope is a trusted local-operator choice, **not authentication**. Like the
existing `--scopes admin`, the following option asserts that the operator is
already authorized to inspect all scopes. Never expose these flags through an
untrusted API or hand an unauthorized user an all-corpus database credential.

```sh
# Only an authorized administrator may request broader freshness evidence.
# Retrieval remains unscoped; the preflight may distinguish hidden from missing.
npm run hybrid:shadow-eval -- --preflight-only --scopes unscoped --freshness-admin --out <private-dir>
```

Without `--freshness-admin`, preflight evidence is limited to the evaluation
scope. `--scopes admin` already explicitly selects all scopes for both phases.
There is no automatic privilege escalation after a lookup/search miss.
The exported freshness helper likewise supports only unscoped (`undefined` or
`[]`) and admin (`["*"]`) scopes; named or mixed scopes are rejected.

Judgments include grade-zero entries and are reported per query/slug:

- `visible`: exactly one match in the authorized evidence, visible to evaluation.
- `excluded-by-scope`: one active match, outside evaluation scope; only emitted
  with explicit admin evidence.
- `corpus-absent`: no active match; only emitted with admin evidence.
- `unknown/not-visible`: no authorized visible match. Missing and restricted
  slugs are indistinguishable; this is **not** a claim of global absence.
- `ambiguous`: more than one match in the authorized evidence, since article
  slugs are unique only within a topic. No article is silently selected.

Soft-deleted articles are outside the corpus. Draft, reviewed and published
statuses are all included, matching the provider; this is not published-only
mode. Hidden duplicates cannot be detected by unscoped evidence: `visible` and
`clear` describe only the inspected scope. The lookup projects only fixture
slugs and aggregate counts, not titles, tags, topic names or article IDs.

`needs-review` warns about any non-visible judgment but does not stop exploratory
measurement or alter the fixture. Before using a report for a decision, review
these outcomes explicitly. A `clear` preflight alone is not decision-grade
retrieval evidence. It checks presence/ambiguity, not semantic relevance, and is
a point-in-time observation: corpus or permission changes after it can invalidate
it. Search misses never establish stale judgments. No scores, judgments or
metric denominators are automatically changed; fixture revisions require review.

## Metric denominators

For each path, `metrics.<path>.denominators` records `evaluated` and `excluded`
query counts separately for `recall`, `ndcg`, and `mrr`. Markdown prints the same
counts. Recall@k and nDCG@k exclude queries with no positive judgments; if every
query is excluded, their values are null (`n/a`). MRR@limit includes every query,
including no-positive queries and misses as zero, so its excluded count is zero.
The MRR cutoff remains the returned limit, not k. Existing metric formulas and
single-credit duplicate-slug ranking semantics are unchanged.

## Isolated verification

```sh
npm run test:hybrid-shadow
SHADOW_TEST_DATABASE_URL=<disposable-app-role-url> npm run test:hybrid-shadow-db
```

The database test creates a connection-local temporary Article table, includes
restricted/deleted/duplicate fixtures, and never modifies the application corpus.
CI runs it against its disposable database. Production retrieval quality and
serving acceptance remain outside these tests.
