// Only the four dependency archives approved in RELEASE.md may be published.
// Usage: node publish-dependencies.mjs /absolute/qualification-output --check|--publish|--verify
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const [directory, mode] = process.argv.slice(2);
assert.ok(directory && path.isAbsolute(directory), "An absolute artifact directory is required");
assert.ok(["--check", "--publish", "--verify"].includes(mode), "Select --check, --publish or --verify");
const registry = "https://registry.npmjs.org";
const artifacts = JSON.parse(await readFile(new URL("release-artifacts.json", import.meta.url), "utf8"));
assert.equal(artifacts.length, 4);
// Preserve the first run's successful submission even while npm returns 404.
// Re-submitting that immutable version cannot make its scan finish sooner.
const prior = JSON.parse(await readFile(new URL("submitted-artifacts.json", import.meta.url), "utf8"));
const previouslySubmitted = new Set();
for (const artifact of prior.artifacts) {
  assert.deepEqual(artifact, artifacts.find((entry) => entry.name === artifact.name && entry.version === artifact.version));
  previouslySubmitted.add(`${artifact.name}@${artifact.version}`);
}
const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const local = new Map();
for (const artifact of artifacts) {
  const archive = path.join(directory, artifact.archive);
  const bytes = await readFile(archive);
  assert.equal(digest(bytes, "sha256", "hex"), artifact.sha256, `${artifact.archive}: unapproved bytes`);
  assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, artifact.integrity);
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
  assert.equal(manifest.name, artifact.name);
  assert.equal(manifest.version, artifact.version);
  if (manifest.name === "@sweetsophia/noosphere-effect") assert.equal(manifest.dependencies.toml, "5.0.1");
  else assert.equal(manifest.dependencies.effect, `npm:@sweetsophia/noosphere-effect@${manifest.name.includes("opencode") ? "4.0.0-beta.65-noosphere.3" : "4.0.0-beta.57-noosphere.4"}`);
  local.set(artifact, { archive, manifest });
  console.log(`APPROVED ${artifact.name}@${artifact.version} ${artifact.sha256}`);
}
if (mode === "--check") process.exit(0);

async function metadata(artifact) {
  const response = await fetch(`${registry}/${encodeURIComponent(artifact.name)}/${artifact.version}`, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `Registry metadata failed: ${artifact.name}@${artifact.version}`);
  return response.json();
}
async function verify(artifact, published) {
  assert.ok(published, `${artifact.name}@${artifact.version} is not published`);
  assert.equal(published.name, artifact.name);
  assert.equal(published.version, artifact.version);
  assert.equal(published.dist.integrity, artifact.integrity);
  assert.deepEqual(published.dependencies, local.get(artifact).manifest.dependencies);
  const url = new URL(published.dist.tarball);
  assert.equal(url.origin, registry, "Unexpected registry tarball origin");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes, "sha256", "hex"), artifact.sha256, "Published archive differs from approval");
  assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, artifact.integrity);
  console.log(`VERIFIED public registry ${artifact.name}@${artifact.version}`);
}

let npm;
if (mode === "--publish") {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Publication runs only in GitHub Actions");
  assert.equal(process.env.GITHUB_REPOSITORY, "SweetSophia/noosphere");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  npm = await realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  const identity = execFileSync(process.execPath, [npm, "whoami", `--registry=${registry}`], { encoding: "utf8" }).trim();
  assert.equal(identity, "sweetsophia", "Unexpected npm publishing identity");
}
// Preflight every already-published version before making any registry mutation.
const existing = new Map();
for (const artifact of artifacts) {
  const published = await metadata(artifact);
  if (published) await verify(artifact, published);
  existing.set(artifact, published);
}
if (mode === "--publish") {
  const submitted = [];
  for (const artifact of artifacts) {
    const wasSubmitted = previouslySubmitted.has(`${artifact.name}@${artifact.version}`);
    if (!existing.get(artifact) && !wasSubmitted) {
      // The approved archives retain upstream repository URLs; npm provenance
      // requires those URLs to match the publishing repository. Keep approved bytes.
      execFileSync(process.execPath, [npm, "publish", local.get(artifact).archive, "--access=public", "--ignore-scripts", "--tag=noosphere-toml5-candidate", `--registry=${registry}`, "--provenance=false", "--loglevel=error"], { stdio: "inherit", timeout: 180_000 });
    }
    submitted.push({ ...artifact, alreadyVerified: Boolean(existing.get(artifact)), previouslySubmitted: wasSubmitted });
    await writeFile(path.join(directory, "submitted.json"), `${JSON.stringify({ commit: process.env.GITHUB_SHA || null, artifacts: submitted }, null, 2)}\n`);
  }
}
// npm scans new versions before making them installable. A successful publish
// response can precede public visibility by 5-15 minutes or longer. Submit in
// dependency order, then wait for all four without republishing a pending version.
const receipts = await Promise.all(artifacts.map(async (artifact) => {
  const deadline = Date.now() + 20 * 60_000;
  let published = await metadata(artifact);
  while (!published && mode === "--publish" && Date.now() < deadline) {
    console.log(`WAIT public availability ${artifact.name}@${artifact.version}`);
    await setTimeout(10_000);
    published = await metadata(artifact);
  }
  await verify(artifact, published);
  return { ...artifact, registry };
}));
await writeFile(path.join(directory, "publication.json"), `${JSON.stringify({ commit: process.env.GITHUB_SHA || null, artifacts: receipts }, null, 2)}\n`);
