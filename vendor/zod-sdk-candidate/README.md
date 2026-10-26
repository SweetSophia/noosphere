# Zod SDK-only dependency publication candidate

These guarded maintenance tools are consolidated from PR #364 into the coordinated
release candidate. The two approved SDK revisions are already public; this source
integration does not request another publication or change their immutable bytes.
The qualification/recovery contracts and historical approval evidence below remain
in force.

Owner approval covers only the two exact archives in `artifacts.json`, after two
sequential native reviews and the dedicated CI gate. This is separate from the
coordinated application/adapter release. No adapter manifests, locks, versions,
Effect artifacts, existing release artifacts, or production state are activated
by this publication branch. Existing active-adapter audits remain independently
visible until a separately verified activation uses the new public SDK bytes.

The source archives are the already-published maintained SDKs. Only their package
manifest version and exact Zod dependency change; all other members are preserved.
The existing Effect aliases, TOML repair, declarations, licenses and upstream
repository URLs remain unchanged. Advisory GHSA-mrhx-c7xc-m3w5 affects Zod below
4.6.6; this candidate pins 4.6.7. The advisory metadata was updated on 2026-10-23.

`reconstruct.mjs /absolute/new/output` downloads and checks the immutable source
archives, reconstructs the approved targets with npm 12.1.0, and rejects any
manifest/member/archive hash drift. Rebuilding is not compatibility qualification.

The dedicated qualification job must build both SDK prototype adapter paths,
perform clean install/reinstall, LOW audit, runtime and strict declaration checks
on Node 22 and 24, and retain receipts. Local private SDK file edges are explicit
pre-publication fixtures, not public-registry shipping proof. `qualification.json`
uses kind `zod-sdk-local-qualification`, completed=true, exact two target artifact
records, and checks with passed=true. Publisher must reject missing/incomplete or
mismatched qualification before any npm write.

Publication is GitHub Actions workflow_dispatch only, gated by the exact reviewed
SHA, repository, original and triggering actors SweetSophia, successful scoped
qualification, and npm identity sweetsophia. The publisher resolves its npm CLI
once, requires version 12.1.0, and reuses that exact CLI for identity and uploads. It publishes only the two tarballs, with ignore-scripts and
the explicit noosphere-zod-candidate tag, never latest. Retained upstream repository
URLs mean provenance=false is explicit; these are not npm provenance attestations.
Old Effect/SDK artifacts and their accepted-submission history remain immutable.

Preflight all existing registry metadata and tarball bytes before any submission.
Persist attempted/accepted/unknown submission state; never blindly resubmit a
pending or uncertain immutable version. Preserve receipts as Actions artifacts
on failure. Publication is allowed only on attempt 1 of a workflow dispatch;
rerunning a publication job is forbidden even when a journal was recovered.
404 alone is not proof that a previous upload was never accepted. Public byte
readback, identity/dependency checks and SHA256/SHA512 agreement are required.
A successful npm publish response is not delivery. Hold adapter activation and
all application/adapter publication, merges and production deployment until their
separate authorization and verification.

## Registered GitHub workflow and scoped gate

Use the already-registered `toml-candidate.yml` with `publish_zod_sdks=true`,
`expected_sha=REVIEWED_SHA`, and `zod_first_attempt=true` only for the first
approved upload. Both Node 22/24 SDK qualification jobs must pass. The original
four-artifact publication defaults to false and is mutually exclusive. Original
active-adapter audits remain visible; their old SDK pins cannot be cleared until
these prerequisite SDK bytes exist publicly. This scoped dependency gate is not
an assertion that the whole application/adapter PR is green or mergeable.

Never reuse first-attempt mode after an accepted/unknown submission. Do not use
GitHub's rerun controls for publication, including recovery dispatches: those
controls retain older recovery inputs and can discard a newer unknown upload.
Start a NEW workflow dispatch with `zod_first_attempt=false`,
`zod_receipt_run_id=LATEST_SUBMISSION_OR_RECOVERY_RUN` and
`zod_receipt_attempt=LATEST_ATTEMPT` to recover the newest journal, including any
journal produced by an intervening recovery run. Never restore an older ancestor.
Missing recovery artifacts fail closed. Every publication dispatch must itself
be on run attempt 1; publication-mode reruns fail before npm or registry access.
A newly-created run cannot independently detect a lost historical journal: the
operator must retain the accepted run ID and never falsely declare a new first
attempt. Set `verify_zod_sdks=true` with publication false for read-only public
verification; this mode receives no npm token and may be rerun. It polls for up to
20 minutes and fails with a partial receipt while metadata or tarball bytes remain
unavailable (`metadata-404` versus `tarball-404`). Refresh that observation with
read-only verification, never by blindly republishing. The journal must still bind the
reviewed commit for publication. Changed-code recovery is verify-only until
explicitly reviewed. Do not remove stale publication locks automatically.

## Qualification/publication trust boundary

SDK runtime, build, audit and consumer checks run only in isolated qualification
jobs without npm publishing credentials. The publishing job runs only the trusted
archive reconstructor, downloads BOTH current-run Node 22/24 qualification
artifacts, and verifies their exact source commit, runtime, npm packer, approved
archive records, all 32 mandatory gate results, and two complete consumer records.
It does not execute SDK/runtime tests before the privileged npm step. No prior-run
qualification may replace a current-run proof. Only the submission journal is
recoverable across dispatches, using the newest journal. In `--publish` mode the
publisher independently enforces the full Node 22 CI receipt/source-SHA contract
before npm identity or registry access. Standalone `--check` is an offline local
archive/basic-qualification check; standalone `--verify` is read-only public-byte
verification, not independent CI approval or proof this invocation submitted bytes.
The registered workflow validates both current-run CI receipts for either mode.
This remains explicit local-file qualification, not public adapter delivery.
