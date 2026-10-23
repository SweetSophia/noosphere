# TOML candidate publication and activation plan

Status: **publication approved on 2026-10-23; not published, not activated**.
Approval covers only the four exact dependency archives below. Adapter releases
require separate authorization. Pull-request qualification never publishes.

## Decision and exact artifacts

The currently published OpenCode and Kilo SDKs still declare an Effect version
whose TOML range excludes 5.0.1. The bounded temporary repair preserves their
runtime code and changes the declared dependency graph using these four artifacts:

| Package | Version | Archive SHA-256 |
| --- | --- | --- |
| `@sweetsophia/noosphere-effect` | `4.0.0-beta.65-noosphere.3` | `5174e0710593a000a244e656df482c941e11fff8d4a9046d1080515a3a295084` |
| `@sweetsophia/noosphere-effect` | `4.0.0-beta.57-noosphere.4` | `b29bb00619d18a52a333d692af8e1943375ce8c67e947e9b3b0db13ea378bba7` |
| `@sweetsophia/noosphere-opencode-plugin` | `1.15.5-noosphere.3` | `b3be7a902c22bf2e0fb0c19ac519fcbb6d1af1c4c446db0d30da7039695bce07` |
| `@sweetsophia/noosphere-kilocode-plugin` | `7.3.1-noosphere.4` | `030dca359fc9698cb71e6a11c1f8d644d4486a7c1c05c8e930e77980ea8ce239` |

These hashes identify the inspected archives, reproduced under Node 22/npm 12.1.
Use the generated `qualification.json` to compare the actual bytes before any
publication. A different archive hash requires inspection; do not silently replace
the table. Upstream provenance, licenses and exact member checks are in
`provenance.json` and the harness.

Accept explicitly that unchanged Effect calls retain Number-valued integers:
safe integers remain exact; unsafe integers now fail rather than round. Tables
have null prototypes. Do not add `bigint: true` as an invisible compatibility fix.
The tested adapter/host paths pass, but this is not full TOML conformance.

Carrying these packages also requires monitoring advisories against their
**upstream names and versions**. Registry audit matching of renamed forks is
incomplete. Retire the aliases when supported upstream SDKs declare a fixed TOML
path (or remove it), after repeating consumer and host checks.

## Publication, after approval and npm authentication

The repository's `toml-candidate.yml` workflow has a manual publication mode,
separate from the five-participant integration release workflow. Dispatch it from
the reviewed branch with `publish_dependencies=true` and `expected_sha` equal to
that branch's full commit SHA. Publication requires successful Node 22/24 consumer
qualification and application lint/typecheck, then reconstructs with npm 12.1.0.
Only the publication step receives `NPM_TOKEN`; it checks the npm identity,
verifies `release-artifacts.json`, publishes with the candidate tag, and verifies
the public registry archives. Existing versions are accepted only if their bytes
match approval. Partial publication can be retried without replacing packages.
The job submits in dependency order and then allows up to 20 minutes for npm's
publish-time scanning before requiring public availability and byte verification.
`submitted.json` records accepted submissions separately from `publication.json`;
an accepted submission alone is not verification or proof of installability.
The initial run accepted the first Effect archive before its immediate availability
check failed. `submitted-artifacts.json` preserves that accepted submission and
its run/commit reference so retries wait for it instead of uploading it again.
The recorded archive must still match approval and pass public byte verification.

These exact approved archives retain upstream `repository` URLs. npm requires a
matching publishing repository for provenance, so this workflow explicitly uses
`--provenance=false` and does not request an OIDC token. GitHub run/commit and
archive-hash evidence remain available; this is not an npm provenance attestation.
Correcting the manifests would create different archives requiring new review.

For inspection without publishing:

```sh
node vendor/toml5-candidate/publish-dependencies.mjs /absolute/qualification-output --check
```

The equivalent ordered publication procedure is:

1. Run the qualification harness on the final reviewed commit and preserve its
   exact output. Confirm `npm whoami --registry=https://registry.npmjs.org` is the
   intended account and that it may publish under `@sweetsophia`.
2. Publish the two Effect archives first, then the two plugin archives. Publish
   the **reviewed tarballs**, with `--access public --ignore-scripts` and an
   explicit `--tag noosphere-toml5-candidate`, not a default/latest tag. For example:

   ```sh
   npm publish /reviewed/output/sweetsophia-noosphere-effect-4.0.0-beta.65-noosphere.3.tgz --access public --ignore-scripts --tag noosphere-toml5-candidate
   ```

3. Retrieve each exact published version from the public registry. Compare its
   registry integrity and downloaded archive bytes with the approved receipts,
   then inspect the published manifests' alias edges and TOML 5.0.1 requirement.
   A successful publish response alone is not artifact-continuity evidence.

The private `@sweetsophia/noosphere-client` is **not** a publication participant.
No additional npm release-matrix entry is needed for it.

## Source activation and delivered adapter verification

1. In each active adapter manifest, change only the host-plugin dependency to
   the corresponding exact maintained alias from the proposal. Retain
   `@sweetsophia/noosphere-client: file:../noosphere-client` in source. Regenerate
   locks with npm against the actual public registry; never copy loopback locks.
2. Run clean source installs, tests, typechecks, builds, audits and package/version
   policy gates. Preserve the project's coordinated version policy for a release.
3. Pack each built adapter through the staging helper, with output outside its
   source directory:

   ```sh
   node vendor/toml5-candidate/pack-adapter.mjs /absolute/opencode-noosphere-memory /absolute/release-output
   ```

   This keeps the source manifest unchanged and normalizes only the packed client
   edge to its exact installed version. Publish this tarball when the adapter
   release is separately authorized; publishing the source directory would bypass
   that normalization. Wire the helper into the adapter publishing jobs before
   enabling their release. Do not publish the private shared client as a workaround.
4. Install each tarball into a fresh consumer using only the public registry:
   no overrides, alternate registry, builder sibling directory or preseeded
   `node_modules`. Require clean reinstall, `npm ls --all`, the existing audit
   threshold, runtime tests and strict public type checks. Verify the client is
   bundled and every installed TOML is 5.0.1.
5. Repeat actual host-managed npm loading against the published candidate, in
   isolated config/data paths. The recorded file-URI host tests establish loader
   and schema compatibility but do not replace this registry-install step.

Only after these checks may the active adapters' TOML blocker be called resolved.
Merging the inactive proposal or publishing only the four dependencies does not
deliver an updated adapter to existing users.
