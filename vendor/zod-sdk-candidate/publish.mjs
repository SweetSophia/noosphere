// Usage: node publish.mjs /absolute/artifacts-dir --check|--publish|--verify
// Recover submitted.json across runs; 404 NEVER authorizes retrying an attempted upload.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, open, rename, realpath, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { validateCiReceipt } from "./ci-receipt.mjs";

export const registry = "https://registry.npmjs.org";
const targets = [
  ["@sweetsophia/noosphere-opencode-plugin", "1.15.5-noosphere.4", "npm:@sweetsophia/noosphere-effect@4.0.0-beta.65-noosphere.3"],
  ["@sweetsophia/noosphere-kilocode-plugin", "7.3.1-noosphere.5", "npm:@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4"],
];
export const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export function approved(bytes, artifact) {
  assert.equal(digest(bytes, "sha256", "hex"), artifact.sha256, "Unapproved SHA256");
  assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, artifact.integrity, "Unapproved SHA512");
}
export function validateTargets(artifacts) {
  assert.equal(artifacts.length, 2, "Exactly two SDK targets required");
  artifacts.forEach((a, i) => {
    assert.deepEqual([a.name, a.version, a.effectAlias], targets[i], "Unapproved target/Effect alias");
    assert.equal(a.zod, "4.6.7");
    assert.equal(a.archive, `${a.name.slice(1).replace("/", "-")}-${a.version}.tgz`, "Noncanonical archive");
    assert.match(a.sha256, /^[a-f0-9]{64}$/);
    assert.match(a.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(a.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  });
}
export function validateQualification(q, artifacts) {
  assert.equal(q.kind, "zod-sdk-local-qualification");
  assert.equal(q.completed, true);
  assert.deepEqual(q.artifacts, artifacts, "Qualification artifacts differ");
  assert.ok(Array.isArray(q.checks) && q.checks.length > 0, "Qualification checks required");
  assert.ok(q.checks.every((check) => check.passed === true), "Qualification check failed");
}
export function guard(env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Publication requires GitHub Actions");
  assert.equal(env.GITHUB_REPOSITORY, "SweetSophia/noosphere");
  assert.equal(env.GITHUB_ACTOR, "SweetSophia");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.match(env.GITHUB_SHA || "", /^[a-fA-F0-9]{40}$/, "Invalid reviewed SHA");
  assert.equal(env.GITHUB_SHA, env.EXPECTED_REVIEWED_SHA, "Reviewed SHA mismatch");
  assert.match(env.GITHUB_RUN_ATTEMPT || "", /^[1-9][0-9]*$/, "Missing run attempt");
}
export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try { await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temp, file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function localArtifacts(directory, artifacts) {
  return Promise.all(artifacts.map(async (a) => {
    const archive = path.join(directory, a.archive);
    assert.equal(await realpath(archive), archive, "Archive symlinks are not approved");
    const bytes = await readFile(archive);
    approved(bytes, a);
    const options = { input: bytes, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] };
    const members = execFileSync("tar", ["-tzf", "-"], options).toString().trim().split("\n");
    assert.equal(members.filter((m) => m === "package/package.json").length, 1, "Ambiguous package manifest");
    const manifestBytes = execFileSync("tar", ["-xOzf", "-", "package/package.json"], options);
    assert.equal(digest(manifestBytes, "sha256", "hex"), a.manifestSha256, "Manifest hash mismatch");
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.name, a.name); assert.equal(manifest.version, a.version);
    assert.equal(manifest.dependencies?.zod, "4.6.7");
    assert.equal(manifest.dependencies?.effect, a.effectAlias);
    return { archive, manifest };
  }));
}
export async function publicState(artifact, manifest, request = fetch, deadline = Date.now() + 60_000, now = Date.now) {
  const get = (url) => {
    assert.ok(now() < deadline, "Public read deadline reached");
    return request(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))), redirect: "error" });
  };
  const response = await get(`${registry}/${encodeURIComponent(artifact.name)}/${artifact.version}`);
  if (response.status === 404) return "metadata-404";
  assert.equal(response.status, 200, "Registry metadata request failed");
  const metadata = await response.json();
  assert.equal(metadata.name, artifact.name); assert.equal(metadata.version, artifact.version);
  assert.equal(metadata.dist?.integrity, artifact.integrity, "Remote integrity mismatch");
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"])
    assert.deepEqual(metadata[key] || {}, manifest[key] || {}, `Remote ${key} mismatch`);
  const url = new URL(metadata.dist.tarball);
  assert.equal(url.origin, registry, "Unexpected tarball origin");
  assert.ok(!url.username && !url.password && !url.hash, "Invalid tarball URL");
  const tarball = await get(url);
  if (tarball.status === 404) return "tarball-404";
  assert.equal(tarball.status, 200, "Registry tarball request failed");
  approved(Buffer.from(await tarball.arrayBuffer()), artifact);
  return "verified";
}
async function npmCommand(args) {
  // npm config/environment supply credentials normally; never serialize output or env.
  const npm = await realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  return execFileSync(process.execPath, [npm, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
  }).trim();
}
export async function run(directory, mode, dependencies = {}) {
  assert.ok(path.isAbsolute(directory || ""), "Absolute artifact directory required");
  assert.ok(["--check", "--publish", "--verify"].includes(mode), "Invalid mode");
  directory = await realpath(directory);
  const { env = process.env, npm = npmCommand, request = fetch, sleep = setTimeout, now = Date.now,
    artifacts = await json(new URL("artifacts.json", import.meta.url)) } = dependencies;
  validateTargets(artifacts);
  const local = await localArtifacts(directory, artifacts);
  const qualification = await json(path.join(directory, "qualification.json"));
  validateQualification(qualification, artifacts);
  if (mode === "--check") return { completed: true, artifacts };
  if (mode === "--publish") {
    guard(env);
    validateCiReceipt(qualification, artifacts, env.GITHUB_SHA, 22);
    assert.equal(await npm(["whoami", `--registry=${registry}`]), "sweetsophia", "Unexpected npm identity");
  }
  // Preflight ALL public versions, dependencies and available tar bytes before npm writes.
  const states = await Promise.all(artifacts.map((a, i) => publicState(a, local[i].manifest, request)));
  const journalFile = path.join(directory, "submitted.json");
  let journal;
  try { journal = await json(journalFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (journal) {
    assert.equal(journal.kind, "zod-sdk-submission-journal");
    assert.deepEqual(journal.targets, artifacts, "Recovered journal target mismatch");
    assert.match(journal.commit || "", /^[a-fA-F0-9]{40}$/);
    if (mode === "--publish") assert.equal(journal.commit, env.GITHUB_SHA, "Journal reviewed SHA mismatch");
    assert.ok(Array.isArray(journal.submissions));
    const seen = new Set();
    for (const entry of journal.submissions) {
      assert.ok(Number.isInteger(entry.target) && entry.target >= 0 && entry.target < 2 && !seen.has(entry.target));
      seen.add(entry.target);
      assert.ok(["attempted", "accepted", "unknown"].includes(entry.state), "Invalid submission state");
    }
  }
  if (mode === "--publish" && !journal && Number(env.GITHUB_RUN_ATTEMPT) > 1)
    assert.ok(states.every((s) => s === "verified"), "Cross-run artifact recovery required: restore submitted.json; missing journal forbids rerun submissions");
  let locked = false;
  const lock = path.join(directory, ".publish-lock");
  try {
    if (mode === "--publish") {
      await mkdir(lock); locked = true; // Stale locks require explicit recovery, never automatic removal.
      // Another invocation may have finished between preflight/read and lock acquisition.
      let current;
      try { current = await json(journalFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.deepEqual(current, journal, "Submission journal changed concurrently; restart verification");
      journal ||= { kind: "zod-sdk-submission-journal", commit: env.GITHUB_SHA, targets: artifacts, submissions: [] };
      // Existing metadata with unavailable tar bytes cannot be fully preflighted: verify only.
      if (!states.includes("tarball-404")) for (const [i, artifact] of artifacts.entries()) {
        if (states[i] !== "metadata-404" || journal.submissions.some((s) => s.target === i)) continue;
        // Recheck all local bytes after network/identity awaits, before recording any attempt.
        await localArtifacts(directory, artifacts);
        const entry = { target: i, state: "attempted" };
        journal.submissions.push(entry);
        await atomicJSON(journalFile, journal); // Durable BEFORE invoking npm, including crashes/timeouts.
        try {
          await npm(["publish", local[i].archive, "--access=public", "--ignore-scripts", "--tag=noosphere-zod-candidate",
            "--provenance=false", `--registry=${registry}`, "--loglevel=error"]);
        } catch {
          entry.state = "unknown";
          await atomicJSON(journalFile, journal);
          break; // No error output: npm diagnostics can contain credentials.
        }
        entry.state = "accepted";
        await atomicJSON(journalFile, journal);
      }
    }
    const deadline = now() + 20 * 60_000;
    const receipt = { kind: "zod-sdk-publication", completed: false, registry, artifacts: [], pending: [] };
    do {
      receipt.artifacts = artifacts.filter((_, i) => states[i] === "verified");
      receipt.pending = artifacts.flatMap((artifact, i) => states[i] === "verified" ? [] : [{ artifact, state: states[i] }]);
      receipt.completed = receipt.pending.length === 0;
      await atomicJSON(path.join(directory, "publication.json"), receipt);
      if (receipt.completed || now() >= deadline) break;
      await sleep(Math.min(10_000, deadline - now()));
      if (now() >= deadline) break;
      for (const [i, artifact] of artifacts.entries()) if (states[i] !== "verified" && now() < deadline)
        states[i] = await publicState(artifact, local[i].manifest, request, deadline, now);
    } while (true);
    assert.ok(receipt.completed, "Public visibility deadline reached; partial publication.json retained; do not republish pending versions");
    return receipt;
  } finally { if (locked) await rmdir(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, "Expected artifact directory and exactly one mode");
    const result = await run(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ completed: result.completed, artifacts: result.artifacts.map((a) => `${a.name}@${a.version}`) }));
  } catch {
    // Do not print arbitrary exception text from fetch/npm/config or credential-bearing inputs.
    console.error("SDK publication guard failed; inspect credential-free qualification/submission/publication receipts. Recover submitted.json before reruns; never blindly resubmit.");
    process.exitCode = 1;
  }
}
