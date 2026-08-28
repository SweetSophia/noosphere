# Coordinated Noosphere Release

This repository releases the application and four integration surfaces from one
reviewed commit. Do not publish an individual plugin ahead of the coordinated
release.

## Release surfaces

For version `X.Y.Z`, all of these must identify the same merge commit:

- `vX.Y.Z` — GitHub release and multi-platform application image
- `v-openclaw-X.Y.Z` — `@sweetsophia/openclaw-noosphere-memory`
- `v-opencode-X.Y.Z` — `@sweetsophia/opencode-noosphere-memory`
- `v-kilocode-X.Y.Z` — `@sweetsophia/kilocode-noosphere-memory`
- `v-hermes-X.Y.Z` — deterministic Hermes provider bundle attached to `vX.Y.Z`

`VERSION`, all npm package manifests/lockfiles, the Hermes `plugin.yaml`, the
OpenClaw version-bound installer command, and Compose defaults must agree before
any tag is created.

## Pre-publication gate

1. Merge the release PR normally after exact-head local and hosted gates pass.
2. Verify all five proposed tags are absent locally and remotely.
3. Build every npm tarball with `npm pack --dry-run` and inspect its file list.
4. Build the Hermes bundle twice and require byte-identical archives.
5. Build and smoke-test the application for `linux/amd64` and `linux/arm64`.
6. Exercise an isolated fresh install and installer rerun/upgrade path. Verify
   health, doctor/status, save, recall, and cleanup with no production identity
   or volume overlap.
7. Re-fetch `origin/master`; bind the exact merge commit and tree in the release
   receipt. A later commit invalidates the gate.

## Publication order

The Hermes workflow attaches assets to the main GitHub release, so the release
must exist before the Hermes tag is pushed.

1. Create and push annotated `vX.Y.Z` at the exact reviewed merge commit.
2. Create the non-draft, non-prerelease GitHub release for `vX.Y.Z` and read it
   back.
3. Create all four annotated plugin tags at that same commit and push them in one
   explicit command.
4. Wait for the Docker, npm, and Hermes publication workflows. Unknown,
   interrupted, cancelled, or timed-out runs are failures, not passes.
5. Never move, overwrite, or force-push a published release tag.

## Public readback

Verify independently of workflow exit status:

- GitHub release target commit, notes, Hermes archive, checksum file, and archive
  checksum;
- npm registry versions, provenance, tarball URLs, downloaded tarball manifests,
  and version-bound public commands for OpenClaw, Opencode, and Kilo Code;
- GHCR `X.Y.Z` and `latest` index digest, both `linux/amd64` and `linux/arm64`
  manifests, OCI version label, and an AMD64 runtime health smoke test;
- all five tag object targets equal the reviewed release commit;
- checksum-pinned installer bytes remain retrievable and match their advertised
  SHA-256.

Publication is not production activation. Upgrade a stateful installation only
after artifact readback, a fresh backup, environment-specific repair
reconciliation, rollback preparation, and explicit production verification.
