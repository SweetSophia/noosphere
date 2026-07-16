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

## Boundary and next phase

This image is non-production capability only. Phase A2 must rehearse backup, restore, copied-volume compatibility, collation health, extension availability, data integrity, and rollback before any bundled Compose switch is proposed.
