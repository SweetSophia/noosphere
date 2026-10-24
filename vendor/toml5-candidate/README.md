# TOML 5 dependency repair and reproducible qualification

This directory preserves the dependency-path repair qualified against the source
at commit `412e132aa2ee380d16b74344c18c462974bb1337` (PR #362).
The four maintained dependency archives are now public and match their approved
hashes. Active OpenCode/Kilo manifests use the maintained aliases and their locks
were regenerated against the public npm registry. The adapters themselves have
not been released with this repair; existing installed versions require a new
coordinated adapter release. See [RELEASE.md](RELEASE.md).

## Active dependency path

### Current candidate pins (2026-10-24)

The active adapter manifests in this candidate select the Zod-patched SDK
revisions published on 2026-10-24:

- OpenCode adapter: `@opencode-ai/plugin` aliases
  `@sweetsophia/noosphere-opencode-plugin@1.15.5-noosphere.4`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.65-noosphere.3`.
- Kilo adapter: `@kilocode/plugin` aliases
  `@sweetsophia/noosphere-kilocode-plugin@7.3.1-noosphere.5`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4`.
- Both current SDK revisions declare `zod: 4.6.7`, and the packed adapter
  bundles the shared client at exact version `1.15.1`.

### Published 2026-10-23 repair (historical)

The pins below are the four-archive repair published on 2026-10-23. They remain
the approved archive identities recorded in [RELEASE.md](RELEASE.md) and are not
rewritten here.

- OpenCode adapter: `@opencode-ai/plugin` aliases
  `@sweetsophia/noosphere-opencode-plugin@1.15.5-noosphere.3`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.65-noosphere.3`.
- Kilo adapter: `@kilocode/plugin` aliases
  `@sweetsophia/noosphere-kilocode-plugin@7.3.1-noosphere.4`, whose `effect`
  dependency aliases `@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4`.
- Both maintained Effect artifacts explicitly depend on `toml: 5.0.1`.
- The packed adapter's bundled shared client edge uses exact version `1.15.0`.
  Source builds retain the local `file:` dependency; `pack-adapter.mjs` normalizes
  only an isolated staging manifest. The private client stays unpublished and no
  consumer override is required.

These scoped names/versions were originally qualified as unpublished fixtures.
The approved dependency archive identities and current publication procedure are
in [RELEASE.md](RELEASE.md); a registry placeholder is not proof that the approved
version is installable. Publishing dependency-local npm overrides alone was rejected:
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
- `qualify-active.mjs`: snapshots the current client/adapters with their locks,
  builds/tests/audits them, checks unchanged emitted bytes, then packs and qualifies
  fresh public-registry consumers. It never replaces active manifests with the
  historical proposals.
- `pack-adapter.mjs`: packs an already-built source adapter through isolated
  staging. It preserves source manifests, takes the private client's actual npm
  package contents, and changes only the staged client edge to its exact version.
- `host-probe.mjs`: probes tool registration and JSON-schema conversion through
  an actual host server. Run only inside the isolated container described below.
- `public-consumers.mjs`: installs the active adapters' exact tarballs into fresh
  consumers using only public npm dependencies, then requires clean reinstalls,
  complete dependency trees, low-threshold audits, runtime and strict type checks.
- `publish-dependencies.mjs` and `release-artifacts.json`: the manually triggered
  GitHub publication path for the four approved dependency archives, with exact
  hash checks and public-registry verification. `submitted-artifacts.json` records
  earlier accepted uploads so a retry does not re-upload pending versions.
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

The original command above is a historical replay, not a qualification of the
current release. Its proposed manifests pin the old client/SDKs, and its old Zod
graph is not audit-clean. Run that full replay from its matching historical source
checkout; do not rewrite approval records or weaken current fixtures to make it
pass in a newer checkout.

The `Qualify TOML dependency repair` workflow now separates two mandatory proofs
on Node 22 and 24:

```sh
# Exact historical archive/member/provenance proof with the reviewed npm 12.1.0:
node vendor/toml5-candidate/qualify.mjs /absolute/new/history-output --reconstruct-only
# Current manifests/locks, bundled current client, and full active consumer gates:
node vendor/toml5-candidate/qualify-active.mjs /absolute/new/active-output
```

The first command compares all four reconstructed archive hashes and integrities
with the unchanged `release-artifacts.json`; its `reconstruction.json` explicitly
does not claim historical consumer qualification. The second keeps install,
reinstall, full-tree, low-threshold audit, runtime and strict TypeScript checks on
the actual shipping dependency graph. Audit failures still fail the job; no
finding is ignored or allowlisted. The original default qualifier and manual
publication command remain unchanged and do not gain a reconstruction-only bypass.

Local resource limits are part of qualification, not optional operator cleanup:
start only with 10 GiB free reserve plus a conservative 2 GiB stage budget on the
output filesystem. Linux process-group ownership (`/proc` is required) monitors
that reserve and stops the complete disposable writer group on breach, timeout,
ordinary command completion or interruption. SIGINT/SIGTERM stop and quiesce
writers before cleanup and lock release; no interrupted run gets a success
receipt. Uncatchable owner death (SIGKILL or a machine crash) cannot execute JS
cleanup: inspect and terminate any surviving writer before removing its stale
lock; use an external supervisor if parent-death containment is required.
A shared per-user install lock
rejects simultaneous active qualifiers; run Node 22 and 24 serially. If an abrupt
termination leaves a lock, inspect its owner before removing it—never delete a
live qualifier's lock. On success or failure the active runner removes generated
installs, download caches and packer staging while retaining source, manifests,
locks, logs, archive hashes and qualification receipts. Historical reconstruction
releases each pair of unpacked source/repacked directories once its hashes pass.
That is not an automatic-cleanup guarantee for the full historical replay: its
failed source proof and legacy builder/consumer trees require stage-end cleanup;
never count that legacy path as the current self-cleaning qualification.
Do not retain installed dependency trees indefinitely as review evidence; recreate
one installation on demand and remove it at the end of that stage.

The workflow also checks application lint/types, with the consumer fixture
directory excluded from the application's root TypeScript compilation. Consumer
types are checked separately with `strict` and `skipLibCheck=false` after actual
installation. A successful workflow qualifies the local graph, not publication.

### Active public-registry consumers (2026-10-23)

The four published dependency archives were downloaded from npm and verified
against both approved digests and their declared dependency edges. Node 22.23.4
clean source installs, typechecks, builds and 11 adapter tests pass. The regenerated
locks also refresh compatible Effect transitives within their declared ranges.
Committed adapter runtime output remains unchanged.

The active `1.15.0` adapter tarballs produced by `pack-adapter.mjs` pass fresh public
consumer install/reinstall, full dependency-tree validation, `audit --audit-level=low`,
24 runtime cases and two strict TypeScript consumers. Every installed TOML in these
consumer trees is 5.0.1. The private client is bundled; no loopback registry,
consumer override, builder sibling directory or preseeded `node_modules` is used.

`public-consumers.mjs /absolute/archive-directory /absolute/new/output` repeats
these installed-consumer checks. The TOML workflow runs them on Node 22 and 24.
The normal integration workflow now runs them for packed OpenCode/Kilo artifacts,
including the exact archive used by each publishing job. No publishing token is
available to these qualification steps.

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
execution tests. File-URI loading alone does not qualify host-managed npm installation,
its engine gate, or public-registry delivery. Never run a host's `--help` outside
isolation as a harmless probe: Kilo can execute startup database migrations first.

### Actual host-managed tarball installation (2026-10-23)

Both pinned hosts also pass their real npm installation path with the active
adapter archives. The configuration uses a named file specification such as
`@sweetsophia/opencode-noosphere-memory@file:/artifacts/adapter.tgz`, rather than
a direct file-URI import. This reaches the hosts' npm compatibility check and
Arborist installation into empty host state. Each host-installed adapter resolves
its maintained SDK and Effect fork to TOML 5.0.1, registers exactly the four
Noosphere tools, and exposes the expected `restrictedTags` schema.

Repeat in the same network-none, read-only disposable container, mounting only
the binary, probe, adapter tarball and public-consumer npm cache. Copy that cache
from a read-only `/seed-cache` mount to writable tmpfs `/tmp/npm-cache`, then run:

```sh
node /probe.mjs opencode /artifacts/adapter.tgz npm-tarball /tmp/npm-cache
```

Use `kilo` for Kilo's binary and adapter archive. No preinstalled `node_modules`,
host home/configuration, credentials or model calls are used. The host's unrelated
global SDK bootstrap still warns because its original SDK is not in this offline
cache; Kilo's baseline semantic-search warning remains. This qualifies the
Noosphere adapter graph and host-managed installation of its tarball. Looking up
a newly released adapter version by registry name remains a release smoke check.

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

## Remaining release work

The concrete artifact identities and ordered activation steps are in
[RELEASE.md](RELEASE.md). Publication of the four dependency archives was approved
on 2026-10-23; adapter publication requires separate authorization. The manual
GitHub job uses the repository's npm token; pull-request jobs never publish.

1. Coordinate a new adapter release version and obtain its separate publication
   authorization. Keep the source client's local `file:` edge and publish only
   the qualified `pack-adapter.mjs` archive; the private client remains unpublished.
2. Repeat clean installed-consumer checks for that release archive, verify its
   registry bytes, and smoke-test host lookup of the released adapter version.
   Current public dependency and actual host-managed tarball checks are recorded
   above; an adapter release has not yet been delivered to installed users.
3. Reconcile the other open security/PR gates independently. No Braces probe,
   substitute probe, KaTeX remediation, broad security stress, merge or deployment
   is part of this proposal.

Full TOML conformance and unsafe-large-integer compatibility are not claimed:
TOML 5 uses null-prototype tables and unchanged Effect parsing rejects unsafe
integers without opting into bigint. Overall PR/release readiness requires the
remaining gates above.
Only explicit manual dispatch enables the dependency publication job; its accepted
submission receipts and verified-publication receipts are distinct evidence.
