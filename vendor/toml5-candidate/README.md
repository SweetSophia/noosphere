# TOML 5 candidate — draft, not an activated dependency update

This directory preserves the dependency-path repair qualified against the source
at commit `412e132aa2ee380d16b74344c18c462974bb1337` (PR #362).
**It is an inactive proposal, not a released or production-ready fix.** Root and
adapter production manifests/locks are deliberately unchanged. Do not merge this
as evidence that the existing adapters' TOML advisory is resolved.

## Proposed dependency path

- OpenCode adapter `1.15.0-noosphere.toml.1`: `@opencode-ai/plugin` aliases
  `@sweetsophia/noosphere-opencode-plugin@1.15.5-noosphere.3`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.65-noosphere.3`.
- Kilo adapter `1.15.0-noosphere.toml.2`: `@kilocode/plugin` aliases
  `@sweetsophia/noosphere-kilocode-plugin@7.3.1-noosphere.4`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4`.
- Both maintained Effect artifacts explicitly depend on `toml: 5.0.1`.
- The bundled shared client edge uses exact version `1.15.0`, not a sibling-source
  `file:` dependency. No consumer override is required.

These scoped names/versions are unpublished fixture placeholders, not reserved
registry names. Publishing dependency-local npm overrides alone was rejected:
npm ignores them for consumers. A bundled-subtree prototype also failed a clean
install and was rejected rather than bypassing that gate.

## Included material

- `patches/`: exact reviewed upstream-to-maintained-fork textual changes.
  Apply each patch with `git apply` from an unpacked upstream package root.
- `adapter-proposals/`: reviewed proposed manifests and adapter tests. The JSON
  manifests have the `.json.proposed` suffix to prevent accidental discovery as
  executable package roots. They are not installation instructions.
- `consumer-fixtures/`: the actual installed-consumer runtime/type fixture bytes
  used in qualification. They require the assembled, installed candidate graph;
  this directory is not a standalone replay harness.
- `provenance.json`: original and inspected fixture artifact SHA-256 hashes,
  exact changed members and patched-file hashes. The original artifact hashes
  identify the inspected historical archives; arbitrary repacking is not claimed
  to reproduce identical archive bytes.

Obtain original archives from the public npm registry and verify their hashes
before applying patches. All upstream runtime and license files remain unchanged.
The only non-manifest fork change is a Kilo Effect beta.57 declaration correction:
its JavaScript/TypeScript source already exports `SchemaErrorTypeId`; its generated
`.d.ts` omitted that declaration. The patch adds the literal declaration and one
empty source-map line segment. No runtime implementation is changed.

## Recorded qualification, not hosted CI claims

On Node 24.22.0 / npm 12.1.0, with isolated fixture installation and lifecycle
scripts disabled:

- 14 distinct installed-consumer runtime cases passed (7 per adapter).
- Both strict public TypeScript consumers passed with `skipLibCheck=false`.
- 11 adapter cases passed (OpenCode 6 including one existing regression, Kilo 5).
- Packed artifacts passed fresh-consumer installs, clean reinstalls, dependency
  tree checks and explicit public-registry audit snapshots. The final consumer
  trees contain TOML 5.0.1 only; the unrelated root TOML 4 controls were removed.
- Audit snapshots reported zero vulnerabilities. Renamed unpublished forks are
  not necessarily matched to all upstream advisories: zero is not complete fork
  security certification.
- Four upstream/fork archives were compared member-by-member. Two sequential,
  independent native static inspections found no local-qualification blocker.

Three LOW evidence/documentation notes were accepted: historical harness layout
coupling; enumerated-file hashing is not whole-directory/caches sealing; and the
retained bundled-client README still demonstrates a stale sibling `file:` edge.
That README example is inactive and must not be followed for consumer installs.
Correcting it in a future released artifact requires rebinding artifact hashes.
The second inspection's final reply timed out after saving its substantive report;
the same blind reviewer subsequently confirmed completion and its unchanged hash.
The timeout itself was not treated as approval and no third inspection was counted.

The private execution receipts/reports are not copied into Git: they contain
machine-local paths. This snapshot contains portable sources/provenance only;
it neither supplies a standalone harness nor claims that hosted CI reran the
recorded fixture qualification.

## Blocking release gates

1. Authorize and coordinate maintained-fork package publication, verify scope/name
   access, licenses and actual published bytes. GitHub push authority alone is
   **not** npm publication authority.
2. Regenerate production locks against real published dependencies; do not copy
   the discarded loopback-registry fixture locks into active packages.
3. Verify the actual published consumer dependency trees and artifact continuity.
4. Qualify the declared minimum Node 22 and real host/transport/filesystem loading.
5. Decide the TOML numeric compatibility boundary before claiming a general fix:
   TOML 5 uses null-prototype tables and rejects unsafe-range integers by default;
   unchanged Effect calls `Toml.parse(content)` without `bigint: true`.
6. Reconcile the other open security/PR gates independently. No Braces probe,
   substitute probe, KaTeX remediation, broad security stress, merge or deployment
   is part of this proposal.

Full TOML conformance, unsafe-large-integer compatibility, real-registry delivery
and overall PR readiness remain unqualified/NO_GO. No release workflow is added
or triggered by this draft.
