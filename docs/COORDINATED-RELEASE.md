# Coordinated Noosphere Release

This repository releases the application and five integration surfaces from one
reviewed commit. Do not publish an individual plugin ahead of the coordinated
release.

## Release surfaces

For version `X.Y.Z`, all of these must identify the same merge commit:

- `vX.Y.Z` — GitHub release and multi-platform application image
- `v-openclaw-X.Y.Z` — first `@sweetsophia/noosphere-injected-memory`,
  then `@sweetsophia/openclaw-noosphere-memory` after exact-integrity readback
- `v-opencode-X.Y.Z` — `@sweetsophia/opencode-noosphere-memory`
- `v-kilocode-X.Y.Z` — `@sweetsophia/kilocode-noosphere-memory`
- `v-mcp-X.Y.Z` — `@sweetsophia/noosphere-mcp`
- `v-hermes-X.Y.Z` — deterministic Hermes provider bundle attached to `vX.Y.Z`

`VERSION`, all npm package manifests/lockfiles, the Hermes `plugin.yaml`, the
OpenClaw version-bound installer command, and Compose defaults must agree before
any tag is created.

## Pre-publication gate

Before cutting a release tag, change that version's changelog heading from
`Unreleased` to its release date and close its compare link at `vX.Y.Z`; advance
the separate `[Unreleased]` link to start at that new tag. A candidate's `HEAD`
compare link is temporary and must not survive into published release notes.
This step is release preparation, not authorization to create tags or publish.

1. Merge the release PR normally after exact-head local and hosted gates pass.
2. Verify all six proposed tags are absent locally and remotely.
3. Build every npm tarball with `npm pack --dry-run` and inspect its file list.
4. Build the Hermes bundle and six-file installer asset set twice; require
   byte-identical archives, launchers, backends, and checksum files.
5. Build and smoke-test the application for `linux/amd64` and `linux/arm64`.
6. Exercise an isolated fresh install and installer rerun/upgrade path. Verify
   health, doctor/status, save, recall, and cleanup with no production identity
   or volume overlap.
7. Re-fetch `origin/master`; bind the exact merge commit and tree in the release
   receipt. A later commit invalidates the gate.

## Documentation follows publication

`README.md` and `docs/INSTALLATION.md` advertise one published release: the
`vX.Y.Z` launcher and its backend, with both SHA-256 digests.
`npm run postgres-image:check` checks these documents against the release and
digests pinned in the policy script, and checks the install block's guards
(the backend override unset, the three settings as defaults, explicit
non-interactive integration selection for every invocation, both release URLs
present on the same release tag, and both checksums verified before any launcher
invocation).
`npm run postgres-image:check -- --verify-remote` additionally downloads the
published release assets and compares their bytes against those pinned digests.
An HTTP 404 identifies the documents and reports that their advertised release
is not published or unavailable; a digest mismatch is reported separately.

Only the **release-asset download blocks in `README.md` and
`docs/INSTALLATION.md`** must wait until publication. The release PR must keep
those blocks and the policy script's `documentedReleaseVersion`,
`documentedReleaseInstallerSha256`, and `documentedReleaseBackendSha256` pins on
the last published release. After the new assets are published and read back,
update the two blocks and all three pins together in a follow-up change, then
run both policy modes above. The docs may therefore lag the release being built;
`--verify-release-files` rejects a release older than the advertised one, but
does not compare a local rebuild's digests with immutable published digests.

The guided immutable-commit download documents are different: their
`versionBoundInstallerCommand` is bound to `VERSION`, so the release PR updates
those commands as usual. They are not subject to the release-asset URL rule.

## Publication order

Default-branch and pull-request Docker runs build both architectures but do not
publish registry tags. Only the canonical application release tag may move
`latest`.

1. Wait for all exact merge-commit workflows; no registry artifact is promoted
   by the merge itself.
2. Create and push annotated `vX.Y.Z` at the exact reviewed merge commit. Wait
   for the canonical Docker publication and record its digest.
3. Create the five annotated integration tags at that same commit, preferably one at
   a time, and wait for each npm/Hermes workflow. The Hermes and installer
   workflows produce read-only Actions artifacts; neither mutates a GitHub
   Release.
4. Verify every registry and workflow artifact independently. Require the
   Hermes archive/checksum from both workflows to be byte-identical. Place the
   six installer files in an otherwise empty directory and run
   `node /absolute/path/to/noosphere/scripts/check-postgres-image-policy.mjs
   --verify-release-files` from that directory. Unknown, interrupted, cancelled,
   timed-out, or locally inconsistent artifacts are failures, not passes.
5. Create a **draft** GitHub Release with `--verify-tag`, attach the complete
   six-file installer artifact, and read every draft asset back through the
   authenticated GitHub API:
   - `install.sh` and `install.sh.sha256`;
   - `install-openclaw.sh` and `install-openclaw.sh.sha256`;
   - `hermes-noosphere-memory-X.Y.Z.tar.gz` and its checksum.
6. Publish that draft only after every artifact, checksum, tag target, registry
   digest, and authenticated readback is verified. This is the coordinated
   public promotion.
7. Download all six assets again from the **public** release into an otherwise
   empty directory. Keep that directory as the working directory and invoke the
   policy script by its absolute repository path, for example:
   `repo_root=$(git rev-parse --show-toplevel); release_dir=/path/to/public-assets;
   (cd "$release_dir" && node "$repo_root/scripts/check-postgres-image-policy.mjs"
   --verify-remote --verify-release-files --verify-release-assets)`. This final
   gate verifies the local checksum set, launcher/backend/Hermes ownership, and
   public bytes for all six release assets.
8. Never move, overwrite, or force-push a published release tag or replace a
   published release asset.

## Public readback

Verify independently of workflow exit status:

- GitHub release target commit, notes, all six installer assets, asset names,
  launcher/backend/Hermes checksum files, and independently recomputed hashes;
- npm registry versions, provenance, tarball URLs, downloaded tarball manifests,
  and version-bound public commands for injected memory, OpenClaw,
  Opencode, Kilo Code, and MCP;
- GHCR `X.Y.Z` and `latest` index digest, both `linux/amd64` and `linux/arm64`
  manifests, OCI version label, and an AMD64 runtime health smoke test;
- all six tag object targets equal the reviewed release commit;
- checksum-pinned installer bytes remain retrievable and match their advertised
  SHA-256.

Publication is not production activation. Upgrade a stateful installation only
after artifact readback, a fresh backup, environment-specific repair
reconciliation, rollback preparation, and explicit production verification.
