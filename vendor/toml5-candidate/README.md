# TOML 5 candidate — reproducible qualification, not an activated dependency update

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
- The packed adapter's bundled shared client edge uses exact version `1.15.0`.
  Source builds retain the local `file:` dependency; `pack-adapter.mjs` normalizes
  only an isolated staging manifest. The private client stays unpublished and no
  consumer override is required.

These scoped names/versions are unpublished fixture placeholders, not reserved
registry names. Publishing dependency-local npm overrides alone was rejected:
npm ignores them for consumers. A bundled-subtree prototype also failed a clean
install and was rejected rather than bypassing that gate.

## Included material

- `patches/`: exact reviewed upstream-to-maintained-fork textual changes.
  Apply each patch with `git apply` from an unpacked upstream package root.
- `adapter-proposals/`: reviewed proposed manifests and adapter tests. The JSON
  manifests have the `.json.proposed` suffix to prevent accidental discovery as
  executable package roots. These describe packed artifacts, not manifests to
  copy verbatim into source builds: the client version is not on the registry.
- `consumer-fixtures/`: the actual installed-consumer runtime/type fixture bytes
  used in qualification, plus explicit numeric and object-prototype boundary
  cases. They require the assembled, installed candidate graph.
- `qualify.mjs`: reconstructs all four forks from hash-verified public upstream
  archives, verifies every patched/repacked member, and runs fresh downstream
  install/reinstall, dependency-tree, audit, runtime and strict type checks.
- `pack-adapter.mjs`: packs an already-built source adapter through isolated
  staging. It preserves source manifests, takes the private client's actual npm
  package contents, and changes only the staged client edge to its exact version.
- `host-probe.mjs`: probes tool registration and JSON-schema conversion through
  an actual host server. Run only inside the isolated container described below.
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

### Repeatable Node 22 qualification (2026-10-23)

Run from a checkout with Node 22 or newer, npm, Git and tar available:

```sh
node vendor/toml5-candidate/qualify.mjs /absolute/path/to/a-new-output-directory
```

The output directory must not exist. The harness uses only a temporary loopback
registry for the unpublished candidate packages; other dependencies retain public
npm registry URLs. It never publishes or edits shipping manifests/locks. Generated
fixture locks contain loopback URLs and must never become production locks.
The registry deliberately does not serve the private client. Builders use its
local source edge; consumers must get it from the adapter's bundled contents.
An unnormalized `file:` edge can install successfully yet fail `npm ls` downstream;
both clean reinstall and full-tree checks are required after staging normalization.
The four fork archives retain the recorded patched member bytes; repacked archive
digests are recorded separately in `qualification.json`, not substituted into the
historical provenance. Every subprocess runs on the invoking Node version.

The reconstructed candidate passed on Node **22.23.4**: 14 original consumer
runtime cases, 10 additional boundary cases, two strict TypeScript consumers and
11 adapter cases. Clean consumer reinstall and complete dependency-tree checks
passed. The boundary cases establish that safe integers remain exact Numbers,
unsafe integers fail explicitly through Effect, prototype-shaped keys remain own
data, and nested null-prototype tables decode through Effect schemas. They do not
establish arbitrary TOML compatibility or add a `bigint` opt-in.

The `Qualify inactive TOML candidate` workflow now independently runs the harness
on Node 22 and 24. It also checks application lint/types, with the consumer fixture
directory excluded from the application's root TypeScript compilation. Consumer
types are checked separately with `strict` and `skipLibCheck=false` after actual
installation. A successful workflow qualifies the local graph, not publication.

### Actual host loading (2026-10-23)

OpenCode **1.18.34** and Kilo **7.3.44** each loaded the installed candidate through
their real plugin loader, registered all four Noosphere tools, and serialized the
save tool's `restrictedTags` schema correctly. Tests used disposable Docker with
`--network none`, a read-only filesystem and candidate/binary mounts, and temporary
home/config/data paths. No session, prompt or model request was made.

`host-probe.mjs` expects the compiled host binary at `/usr/local/bin/opencode` or
`/usr/local/bin/kilo`, and an installed consumer mounted at `/fixture`. Invoke it
**inside** the disposable container with, for example:

```sh
node /probe.mjs opencode /fixture/node_modules/@sweetsophia/opencode-noosphere-memory
```

An outer invocation must provide only the binary, probe and installed consumer,
never a host home or configuration directory:

```sh
docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /root \
  --mount type=bind,src=/absolute/opencode-binary,dst=/usr/local/bin/opencode,readonly \
  --mount type=bind,src=/absolute/host-probe.mjs,dst=/probe.mjs,readonly \
  --mount type=bind,src=/absolute/installed-consumer,dst=/fixture,readonly \
  node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d \
  node /probe.mjs opencode /fixture/node_modules/@sweetsophia/opencode-noosphere-memory
```

The tested image was `node:22-bookworm-slim` at digest
`sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`.
Both hosts attempt a separate global-config SDK install; offline npm settings make
that unavailable bootstrap fail promptly, with an expected warning, while the
preinstalled candidate loads. Kilo also has a baseline semantic-search warning.
The hosts embed their own runtime: these checks complement the separate Node 22
execution tests. File-URI loading does not qualify host-managed npm installation,
its engine gate, or public-registry delivery. Never run a host's `--help` outside
isolation as a harmless probe: Kilo can execute startup database migrations first.

### Historical Node 24 snapshot

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

The historical private execution receipts/reports are not copied into Git: they
contain machine-local paths. The harness above makes new qualification repeatable;
it does not retroactively turn the historical local runs into hosted CI evidence.

## Blocking release gates

The concrete artifact identities and ordered activation steps are in
[RELEASE.md](RELEASE.md). Publication still requires explicit approval and an
authenticated account with access to the package scope.

1. Authorize and coordinate maintained-fork package publication, verify scope/name
   access, licenses and actual published bytes. GitHub push authority alone is
   **not** npm publication authority.
2. Regenerate production locks against real published dependencies; do not copy
   loopback-registry fixture locks into active packages. Keep the source client's
   local `file:` edge and use `pack-adapter.mjs` for release artifacts; do not copy
   the packed-manifest proposals verbatim into source or publish the private client.
3. Verify the actual published consumer dependency trees and artifact continuity.
4. Verify host-managed installation from the actual published graph. Node 22 and
   real-host file loading are qualified above; registry loading is still pending.
5. Accept the explicit TOML numeric compatibility boundary before release:
   TOML 5 uses null-prototype tables and rejects unsafe-range integers by default;
   unchanged Effect calls `Toml.parse(content)` without `bigint: true`.
6. Reconcile the other open security/PR gates independently. No Braces probe,
   substitute probe, KaTeX remediation, broad security stress, merge or deployment
   is part of this proposal.

Full TOML conformance, unsafe-large-integer compatibility, real-registry delivery
and overall PR readiness remain unqualified/NO_GO. The new workflow performs
qualification only; no release workflow is added or triggered by this draft.
