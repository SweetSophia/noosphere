# Maintained dependency candidate: braces

This directory contains a **local integration candidate**, not an upstream
security release or a claim that GHSA-vfj7-8cjw-p6xm is completely remediated.
The ordinary validation below does not establish publication or deployment
readiness. Tracking: [dependency stage #356](https://github.com/SweetSophia/noosphere/issues/356).

## What is pinned

- Upstream: npm `braces@3.0.3`, registry archive
  <https://registry.npmjs.org/braces/-/braces-3.0.3.tgz>.
- Private derivative: `@sweetsophia/noosphere-braces@3.0.3-noosphere.2`.
  It retains the original MIT license and author/contributor attribution. It is
  private and is not published to npm. Upstream repository URLs and README
  describe the original project, not endorsement or support of this derivative.
- Exact archive: `sweetsophia-noosphere-braces-3.0.3-noosphere.2.tgz`.
- SHA-256: `a3d16c774b609d0c43132e1b390f570544fd3e209ed7ca55a3e0b547f924ed8b`.
- [Machine-readable provenance](braces-provenance.json) records the verified
  upstream SHA-512 integrity, derivative integrity and per-file SHA-256 hashes.
- [Reviewable source diff](braces-3.0.3-noosphere.2.patch) compares the registry
  package with this exact derivative, including metadata and patch notes.
- [MIT license](braces-LICENSE) is byte-identical to upstream and to the archive.

The root dev dependency named `braces` points to this repository-relative archive.
The root override `"braces": "$braces"` makes transitive consumers, including
`fast-glob` -> `micromatch`, use that same candidate. No absolute local path,
registry authentication, audit waiver, or upstream-version impersonation is used.
The Docker dependency stages receive the archive before dependency installation.
At the initial integration freeze that wiring had not been exercised; later
root-only packaging evidence is recorded below.

## Changes and intentional restrictions

The advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
describes uncontrolled recursion. At the recorded assessment, it listed no
upstream fixed version. Merely selecting `braces@3.0.3` is not a fix.

This derivative adds fixed, non-configurable traversal budgets:

- String parsing rejects more than 64 nested brace/parenthesis containers.
- Internal compile, stringify and expand entry points inspect AST child edges
  iteratively before recursion, rejecting child cycles and depths above 65 edges.
  The additional edge permits a leaf beneath the parsed containers.
- Expansion's parent-chain walks have fixed hop limits.

Existing AST-object inputs bypass parsing, which is why a parser-only change
was insufficient. Parser-created parent/previous backlinks are not child edges
and are excluded from child traversal. AST child lists must be arrays.

These restrictions can reject inputs accepted by upstream. The preflight also
adds traversal work; no performance claim is made. It is not a general quota for
expansion cardinality, width, getters/proxies or arbitrary JavaScript objects.
Existing range limits are unchanged. This is not proof that every advisory path
or resource-exhaustion mechanism is covered.

## Initial evidence and explicit gaps (historical)

The exact `.2` archive and installed files matched their frozen hashes in a fresh
disposable root on Node `24.22.0` / npm `12.1.0`. Ordinary steps passed: lock
creation, full audit at the high threshold, clean `npm ci`, transitive resolution,
Prisma generation, lint, typecheck and production build. Lint reported zero errors
and two existing warnings. These results predate the integration-only docs and
Docker wiring in this directory; they are not fresh whole-candidate validation.

Audit inventory reported zero high/critical and five low findings. **Registry
audit metadata does not independently assess a renamed private derivative.** The
absence of its upstream advisory in that report is not evidence of code safety,
complete remediation or an exemption. Audit and lint thresholds remain unchanged;
the unresolved scope and verification limits must remain visible when evaluating
this candidate. Low-severity findings also remain outstanding.

The standalone regression probe was explicitly skipped by the owner. It is not
included, rerun, replaced, or counted as passing. No substitute boundary/stress
probe or new security test was run. Historical parser-only `.1` results are not
fresh behavioral coverage for `.2`. At that freeze, no complete upstream suite, dedicated `.2` security-regression,
Node 22/Alpine, hosted CI matrix, Docker-build, production or deployment
verification was claimed. The root-only ordinary and packaging evidence below
supersedes only the earlier ordinary-validation and Docker-build gaps. The
immutable archive's `SECURITY-PATCH.md` retains its original freeze-time status;
external evidence notes do not rewrite that archive.

## Later root-only validation and combined-candidate status (historical)

Recorded on 2026-10-20, after the initial integration freeze:

- A fresh disposable snapshot of the integrated root candidate passed nine
  ordinary checks on Node `24.22.0` / npm `12.1.0`: package policy, version
  policy, full audit at the existing high threshold, clean install, exact
  resolution, Prisma generation, lint, typecheck and production build.
- The same root integration snapshot passed a full native `linux/amd64` image
  build in 173.63 seconds using the existing `node:22-alpine` base. Both Docker
  dependency stages copied this exact archive before their normal installs;
  Prisma, Next production build and final non-root image assembly completed.
  The image was retained locally only, never started or published.
- These are existing **root-only ordinary and packaging results**, not new
  execution results for the combined scope/root/MCP candidate assembled here.
  No install, test, audit or build was rerun during combination. Hosted CI on
  the actual combined candidate and its review/publication gates remain open.

The combined candidate retains the scope restrictions and explicit wildcard UI,
the previously reviewed sharp/source-map regression file and security-test
script, and the exact reviewed MCP package/lock with SDK `1.31.0` and
`proxy-addr` `2.0.8`. Prior MCP/root reviews cover their identified earlier
artifacts, **not independent review of this private `.2` derivative or the
combined candidate**. No additional review round has been performed; it requires
an explicit owner request. Publication remains on hold and #356 stays open.

The exact archive and license remain unchanged. Five low root audit findings
remain disclosed. The registry audit blind spot, skipped probe and absence of
fresh `.2` behavioral/security-regression evidence still apply. No replacement
probe, boundary/stress check or new security test was introduced. No ARM64,
application-runtime, production, deployment or complete-advisory-coverage claim
is made; a Node 22 Alpine **build** is not runtime certification.

## 2026-10-22 combined-source validation and native reviews

This dated record supersedes the historical fresh-root-validation and review
status above, without extending the mitigation's stated guarantees:

- A new disposable snapshot of the combined scope/root/MCP source passed all
  nine ordinary root checks on Node `24.22.0` / npm `12.1.0`: package policy,
  version policy, clean `npm ci`, full audit at the existing high threshold,
  exact fork resolution, Prisma generation, lint, nonincremental typecheck and
  production build. No dependencies or generated declarations were reused.
  Installed fork files matched the exact archive. Audit inventory remained
  zero high/critical and five low; lint had zero errors and two existing warnings.
- Two independent native reviews completed **sequentially** against the same
  frozen candidate. Both inspected the derivative and combined integration
  statically; neither established an actionable implementation or packaging
  defect within the narrow mitigation contract. The first review identified
  the missing current evidence/status note, addressed by this documentation
  update. Neither review executed the fork, tests, replacement probes, installs,
  builds or audits. This is not behavioral security coverage or certification.
- The nine ordinary checks and both reviews precede this documentation-only
  amendment. All other candidate files, including the archive, source patch,
  provenance, license, dependency locks and Docker wiring, remain unchanged.
  The immutable archive's historical notes are not rewritten.

Fresh combined-source **root** validation is not a fresh MCP package install or
test run. No fresh combined Docker build, hosted combined CI, ARM64 verification,
application-runtime verification or complete advisory-coverage proof was added.
The skipped standalone probe remains skipped, with no substitute, boundary/stress
probe or new security test. Registry audit inventory still does not independently
assess this renamed private derivative, and five low findings remain outstanding.
No publication or deployment occurred. Publication remains on hold and #356 stays
open pending the subsequent publication/CI gate disposition.

## Maintenance and removal

The Noosphere maintainers own this derivative, its provenance and any follow-up
work; the original braces authors do not maintain these local changes. Never
silently replace bytes under the same candidate version. For a revised candidate,
bump its private version, review the source delta and license, record new hashes,
update the root dependency/lock and Docker archive copies, and repeat authorized
ordinary validation. Do not enable the owner-skipped probe or add replacements.

Revisit when upstream publishes a real fix, the advisory changes, dependency
consumers change, or ordinary compatibility gates fail. A scanner result alone is
not a reason to keep or remove this derivative.

Remove only after a supported upstream dependency path no longer needs the local
mitigation and its compatibility/security rationale has been reconciled:

1. Replace the affected lint dependency chain with the supported upstream path.
2. Remove the root direct `braces` dependency and its `$braces` override together;
   regenerate the lock without forced upgrades or waived audit findings.
3. Remove this archive, provenance, diff, license, this directory's documentation,
   its exact `.gitignore` exception and the two Docker archive-copy lines.
4. Run clean install, full audit at the existing threshold, resolution checks,
   Prisma generation, lint, typecheck and build through the normal review/CI
   workflow. Preserve the skip decision and disclose any remaining proof gaps.

Do not remove the override alone while the affected upstream chain remains.
