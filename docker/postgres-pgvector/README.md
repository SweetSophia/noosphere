# Noosphere PostgreSQL + pgvector image

This directory implements Phase A1 of [`HYBRID-RETRIEVAL-ADR.md`](../../docs/HYBRID-RETRIEVAL-ADR.md). It builds a Noosphere-owned PostgreSQL 16 Alpine image with pgvector, but does **not** change any Compose file or enable hybrid retrieval.

## Locked inputs

- PostgreSQL base: `postgres:16.14-alpine3.24`
- Multi-architecture base digest: `sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`
- Observed base identities: PostgreSQL `16.14`, Alpine `3.24.1`
- pgvector: `v0.8.1`
- pgvector tag commit: `778dacf20c07caf904557a88705142631818d8cb`
- Source: `https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz`
- Source SHA-256: `a9094dfb85ccdde3cbb295f1086d4c71a20db1d26bf1d6c39f07a7d164033eb4`
- License SPDX identifier: `PostgreSQL`
- Dockerfile frontend: `docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`
- QEMU/binfmt: `tonistiigi/binfmt:qemu-v9.2.0@sha256:ea2f0dd74e74f101df59f9a6b31d0960994060c7982a921cbceecee0f1841125`
- Buildx: `v0.35.0`
- BuildKit: `moby/buildkit:v0.26.3@sha256:5601811fde88bb9e8a577bfe804af82bccb712e1cd07ff94663bded5e628cf75`

The Dockerfile verifies the source checksum before extraction in both local and CI builds, pins the complete Alpine `build-base` dependency closure introduced for compilation, builds with `OPTFLAGS=""` to avoid host-specific CPU instructions, and copies the upstream license into the final image. Extension LLVM bitcode is explicitly disabled: the PostgreSQL runtime advertises LLVM support through PGXS but does not ship its matching `clang-21` build toolchain, and pgvector's runtime extension does not require bitcode.

GitHub generates tag archives dynamically. If the archive bytes change while the tag still resolves to the recorded commit, verify the tag and commit through the GitHub API, audit the regenerated archive, update `PGVECTOR_SOURCE_SHA256` and its matching Dockerfile checksum/label together, then rebuild and run the smoke test. A tag that resolves to a different commit is not a checksum rotation and must be treated as a supply-chain failure.

## CI and publication

Pull requests build and smoke-test independent `linux/amd64` and `linux/arm64` images. On `master`, each architecture is built and pushed by digest, that exact digest is smoke-tested, and only those tested digests are assembled into a uniquely tagged candidate index. CI verifies the candidate's platforms, SBOM, and provenance before promoting that exact digest to an immutable release tag.

The published package is `ghcr.io/sweetsophia/noosphere-postgres-pgvector` with:

- immutable release tag `16.14-pgvector0.8.1-sha-<12-character-commit>`;
- unique verification tag `candidate-<workflow-run>-<attempt>-<12-character-commit>`;
- BuildKit SBOM and provenance attestations for both platforms.

There is intentionally no broad repository-tag trigger, no mutable version tag, and no `latest` tag. Push publication runs queue rather than cancel one another. Release promotion distinguishes a confirmed missing tag from registry/authentication failures, refuses replacement when the commit-qualified tag already names another digest, and finishes by rechecking the tag against the verified candidate digest.

OCI distribution does not standardize atomic create-if-absent semantics for tags. The immutability boundary therefore requires this serialized workflow to be the package's only writer; out-of-band `packages: write` access is an administrative trust boundary and must remain restricted and audited. Only push jobs that must write untagged platform digests or promote their verified index receive `packages: write`; pull-request jobs remain read-only.

## Local verification

```bash
docker build -f docker/postgres-pgvector/Dockerfile -t noosphere-postgres-pgvector:test docker/postgres-pgvector
scripts/test-pgvector-image.sh noosphere-postgres-pgvector:test
```

The smoke test verifies OCI identity labels, platform architecture, PostgreSQL and Alpine versions, the bundled license, `CREATE EXTENSION vector`, the extension version, dimensions, and exact distance behavior.

## Phase A2 volume-upgrade rehearsal

Phase A2 uses the immutable multi-architecture image recorded in
[`rehearsal.env`](./rehearsal.env). It creates only cryptographically named,
ownership-labelled disposable containers and volumes. The rehearsal refuses
pre-existing resources, protects the mounted volumes of the bundled production
database containers, and removes only resources carrying its exact run label.

For each supported architecture it:

1. initializes PostgreSQL with the same defaults as bundled Compose, replays
   every committed migration through Noosphere's pinned Prisma startup path,
   verifies the exact migration history, and loads a deterministic fixture
   covering application tables, arrays, JSON, enums, nullable relationships,
   functions, triggers, constraints, indexes, and collation-sensitive text;
2. records a committed canonical all-table snapshot digest with normalized
   Prisma migration history, a schema signature, database/locale/collation
   identity, data-checksum state, and a custom-format logical backup;
3. cleanly stops PostgreSQL, copies the physical volume, starts the exact
   pgvector image on that copy, reruns the real migration path idempotently,
   and verifies the extension in a scratch database;
4. cleanly stops the candidate and starts the pinned source image on the same
   copied volume to prove physical rollback and migration compatibility; and
5. restores the backup independently into clean candidate-image and
   source-image volumes, reruns the real migration path, and repeats every
   integrity check.

Run the same commands used by CI:

```bash
scripts/rehearse-pgvector-volume-upgrade.sh linux/amd64
scripts/rehearse-pgvector-volume-upgrade.sh linux/arm64
```

The arm64 command requires binfmt/QEMU on an amd64 host. CI runs both
architectures independently. The candidate is the Phase A1 index built from
commit `d1eecc96a6a9b6d14ead2e3d352cadf1e69c8f27`, digest
`sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292`.
Before touching a disposable volume, the rehearsal verifies that the selected
platform's BuildKit provenance names that exact repository and source commit.

## Boundary and next phase

This image remains non-production capability only. Phase A2 is rehearsal
evidence; it does not edit either Compose file, mount the live database, or
activate hybrid retrieval. A later Phase A2b may propose a bundled Compose
switch only after the full rehearsal gate is accepted.
