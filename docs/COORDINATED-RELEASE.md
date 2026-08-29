# Coordinated Noosphere Release

This repository releases the application and four integration surfaces from one
reviewed commit. Do not publish an individual plugin ahead of the coordinated
release.

## Release surfaces

For version `X.Y.Z`, all of these must identify the same merge commit:

- `vX.Y.Z` — GitHub release and multi-platform application image
- `v-openclaw-X.Y.Z` — first `@sweetsophia/noosphere-injected-memory`,
  then `@sweetsophia/openclaw-noosphere-memory` after exact-integrity readback
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
4. Build the Hermes bundle and six-file installer asset set twice; require
   byte-identical archives, launchers, backends, and checksum files.
5. Build and smoke-test the application for `linux/amd64` and `linux/arm64`.
6. Exercise an isolated fresh install and installer rerun/upgrade path. Verify
   health, doctor/status, save, recall, and cleanup with no production identity
   or volume overlap.
7. Re-fetch `origin/master`; bind the exact merge commit and tree in the release
   receipt. A later commit invalidates the gate.

## Publication order

Default-branch and pull-request Docker runs build both architectures but do not
publish registry tags. Only the canonical application release tag may move
`latest`.

1. Wait for all exact merge-commit workflows; no registry artifact is promoted
   by the merge itself.
2. Create and push annotated `vX.Y.Z` at the exact reviewed merge commit. Wait
   for the canonical Docker publication and record its digest.
3. Create the four annotated plugin tags at that same commit, preferably one at
   a time, and wait for each npm/Hermes workflow. The Hermes and installer
   workflows produce read-only Actions artifacts; neither mutates a GitHub
   Release.
4. Verify every registry and workflow artifact independently. Require the
   Hermes archive/checksum from both workflows to be byte-identical. Unknown,
   interrupted, cancelled, or timed-out runs are failures, not passes.
5. Create a **draft** GitHub Release with `--verify-tag`, attach the complete
   six-file installer artifact, and read every asset back:
   - `install.sh` and `install.sh.sha256`;
   - `install-openclaw.sh` and `install-openclaw.sh.sha256`;
   - `hermes-noosphere-memory-X.Y.Z.tar.gz` and its checksum.
6. From a directory containing only the downloaded `install.sh`, resolve and
   verify its release backend and Hermes URLs before publishing the draft.
7. Publish that draft only after every artifact, URL, checksum, and tag target
   is verified. This is the final coordinated public promotion.
8. Never move, overwrite, or force-push a published release tag or replace a
   published release asset.

## Public readback

Verify independently of workflow exit status:

- GitHub release target commit, notes, all six installer assets, asset names,
  launcher/backend/Hermes checksum files, and independently recomputed hashes;
- npm registry versions, provenance, tarball URLs, downloaded tarball manifests,
  and version-bound public commands for injected memory, OpenClaw, Opencode,
  and Kilo Code;
- GHCR `X.Y.Z` and `latest` index digest, both `linux/amd64` and `linux/arm64`
  manifests, OCI version label, and an AMD64 runtime health smoke test;
- all five tag object targets equal the reviewed release commit;
- checksum-pinned installer bytes remain retrievable and match their advertised
  SHA-256.

Publication is not production activation. Upgrade a stateful installation only
after artifact readback, a fresh backup, environment-specific repair
reconciliation, rollback preparation, and explicit production verification.
