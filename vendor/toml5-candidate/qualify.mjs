// Reconstruct and qualify the inactive candidate. Never publishes packages.
// Usage: node vendor/toml5-candidate/qualify.mjs /absolute/new/output-directory [--reconstruct-only]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { checkDiskBudget, runWithBudget } from "./resource-budget.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const [output, mode, ...extra] = process.argv.slice(2);
assert.ok(extra.length === 0 && (mode === undefined || mode === "--reconstruct-only"), "Unknown qualification mode");
assert.ok(output && path.isAbsolute(output), "Provide a new absolute output directory");
assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node 22 or newer required");
checkDiskBudget(path.dirname(output));
await fs.mkdir(output); // Refuse reuse: stale installations must not qualify a candidate.
const npm = realpathSync(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const provenance = JSON.parse(await fs.readFile(path.join(here, "provenance.json"), "utf8"));
const registry = "https://registry.npmjs.org";
const packages = new Map();
const receipts = [];
let sequence = 0;
const sha = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");

async function run(command, args, cwd, label) {
  const log = path.join(output, `${String(++sequence).padStart(3, "0")}-${label}.log`);
  try {
    const result = await runWithBudget(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    await fs.writeFile(log, result.stdout + result.stderr);
    console.log(`PASS ${label}`);
    return result.stdout;
  } catch (error) {
    await fs.writeFile(log, `${error.stdout || ""}${error.stderr || ""}\n${error.message}`);
    console.error(`${error.stdout || ""}${error.stderr || ""}`.slice(-20_000));
    throw new Error(`${label} failed; see ${log}`, { cause: error });
  }
}
const npmRun = (args, cwd, label) => run(process.execPath, [npm, ...args], cwd, label);
if (mode === "--reconstruct-only") {
  assert.equal((await npmRun(["--version"], output, "npm-version")).trim(), "12.1.0", "Historical archive reproduction requires the reviewed npm 12.1.0 packer");
}
async function hashes(directory) {
  const result = {};
  async function visit(current, prefix = "") {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      const name = prefix + item.name;
      const location = path.join(current, item.name);
      if (item.isDirectory()) await visit(location, `${name}/`);
      else {
        assert.ok(item.isFile(), `Unsupported archive member: ${name}`);
        result[`package/${name}`] = sha(await fs.readFile(location));
      }
    }
  }
  await visit(directory);
  return result;
}
async function unpack(archive, directory, label) {
  await fs.mkdir(directory);
  const listing = await run("tar", ["-tzf", archive], output, `${label}-list`);
  for (const name of listing.trim().split("\n")) {
    assert.ok(name.startsWith("package/") && !name.split("/").includes(".."), `Unsafe tar path: ${name}`);
  }
  await run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], output, `${label}-extract`);
}
async function pack(directory, label) {
  const result = JSON.parse(await npmRun(["pack", "--ignore-scripts", "--json", "--pack-destination", output], directory, `${label}-pack`));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  assert.equal(typeof packed?.filename, "string", "Unexpected npm pack JSON output");
  const archive = path.join(output, packed.filename);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  return recordArtifact(manifest, archive);
}
async function recordArtifact(manifest, archive) {
  const bytes = await fs.readFile(archive);
  const artifact = { manifest, archive, sha256: sha(bytes), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  packages.set(`${manifest.name}@${manifest.version}`, artifact);
  receipts.push({ name: manifest.name, version: manifest.version, archive: path.basename(archive), sha256: artifact.sha256, integrity: artifact.integrity });
  return artifact;
}

const sources = [
  ["@opencode-ai/plugin", "1.15.5"], ["effect", "4.0.0-beta.65"],
  ["@kilocode/plugin", "7.3.1"], ["effect", "4.0.0-beta.57"],
];
for (let i = 0; i < sources.length; i++) {
  const [name, version] = sources[i];
  const record = provenance.forks[i];
  const metadataResponse = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const download = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30_000) });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(sha(bytes), record.upstreamSha256, `Upstream archive changed: ${name}@${version}`);
  const archive = path.join(output, record.upstream);
  await fs.writeFile(archive, bytes);
  const directory = path.join(output, `fork-${i}`);
  await unpack(archive, directory, `fork-${i}`);
  const before = await hashes(directory);
  await run("git", ["init", "--quiet"], directory, `fork-${i}-init`);
  await run("git", ["apply", "--check", path.join(here, record.patch)], directory, `fork-${i}-patch-check`);
  await run("git", ["apply", path.join(here, record.patch)], directory, `fork-${i}-patch`);
  const after = await hashes(directory);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
  assert.deepEqual(changed.sort(), [...record.changedMembers].sort());
  assert.equal(Object.keys(before).length - changed.length, record.unchangedMemberCount);
  for (const member of changed) assert.equal(after[member], record.changedFileHashes[member], member);
  const artifact = await pack(directory, `fork-${i}`);
  const repacked = path.join(output, `repacked-${i}`);
  await unpack(artifact.archive, repacked, `fork-${i}-repacked`);
  assert.deepEqual(await hashes(repacked), after, "Repacking changed package members");
  // All proof is recorded; neither unpacked copy is needed by the consumers.
  await fs.rm(directory, { recursive: true });
  await fs.rm(repacked, { recursive: true });
}

// Historical provenance proof is separate from qualification of a shipping graph.
// Never rewrite the approved identities or claim that these old consumers passed.
if (mode === "--reconstruct-only") {
  const approved = JSON.parse(await fs.readFile(path.join(here, "release-artifacts.json"), "utf8"));
  const ordered = (entries) => [...entries].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  assert.deepEqual(ordered(receipts), ordered(approved), "Reconstructed archives differ from the historical approvals");
  await fs.writeFile(path.join(output, "reconstruction.json"), `${JSON.stringify({ node: process.version, artifacts: receipts, distribution: "historical-archives-only-not-consumer-qualification" }, null, 2)}\n`);
  process.exit(0); // All archive checks/writes awaited; no loopback server was started.
}

// The registry serves only the exact reconstructed candidate artifacts; upstream
// packages retain public-registry metadata and tarball URLs. It is loopback-only.
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (pathname.startsWith("/artifacts/")) {
      const artifact = [...packages.values()].find((entry) => path.basename(entry.archive) === pathname.slice(11));
      if (!artifact) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(await fs.readFile(artifact.archive));
      return;
    }
    const name = decodeURIComponent(pathname.slice(1));
    const matching = [...packages.values()].filter((entry) => entry.manifest.name === name);
    if (matching.length) {
      const versions = Object.fromEntries(matching.map((entry) => [entry.manifest.version, {
        ...entry.manifest,
        dist: { tarball: `${localRegistry}/artifacts/${path.basename(entry.archive)}`, integrity: entry.integrity },
      }]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, "dist-tags": { latest: matching.at(-1).manifest.version }, versions }));
      return;
    }
    // Fail closed for an unregistered maintained package rather than silently
    // falling back to a different candidate from the public registry.
    if (name.startsWith("@sweetsophia/")) { response.writeHead(404).end(); return; }
    const upstream = await fetch(`${registry}${request.url}`, { signal: AbortSignal.timeout(30_000) });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.writeHead(500).end(String(error.message));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const localRegistry = `http://127.0.0.1:${server.address().port}`;
const installArgs = ["--ignore-scripts", "--no-audit", "--no-fund", `--registry=${localRegistry}`];
try {
  const client = path.join(output, "shared-client");
  await fs.cp(path.join(repo, "noosphere-client"), client, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  for (const adapter of ["opencode-noosphere-memory", "kilocode-noosphere-memory"]) {
    const builder = path.join(output, `builder-${adapter}`);
    await fs.cp(path.join(repo, adapter), builder, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") && path.basename(source) !== "package-lock.json" });
    const proposed = JSON.parse(await fs.readFile(path.join(here, "adapter-proposals", adapter, "package.json.proposed"), "utf8"));
    const sourceManifest = structuredClone(proposed);
    sourceManifest.dependencies["@sweetsophia/noosphere-client"] = "file:../shared-client";
    await fs.writeFile(path.join(builder, "package.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await fs.cp(path.join(here, "adapter-proposals", adapter, "test"), path.join(builder, "test"), { recursive: true });
    await npmRun(["install", ...installArgs], builder, `${adapter}-install`);
    const compiler = path.join(builder, "node_modules/typescript/bin/tsc");
    await run(process.execPath, [compiler, "-p", "tsconfig.json", "--noEmit"], builder, `${adapter}-typecheck`);
    await run(process.execPath, [compiler, "-p", "tsconfig.json"], builder, `${adapter}-build`);
    const tests = (await fs.readdir(path.join(builder, "test"))).filter((name) => name.endsWith(".test.mjs")).map((name) => path.join("test", name));
    await run(process.execPath, ["--test", ...tests], builder, `${adapter}-tests`);
    const sourceBeforePack = await fs.readFile(path.join(builder, "package.json"), "utf8");
    const packed = JSON.parse(await run(process.execPath, [path.join(here, "pack-adapter.mjs"), builder, output], builder, `${adapter}-pack`));
    assert.equal(await fs.readFile(path.join(builder, "package.json"), "utf8"), sourceBeforePack, "Packing changed the source manifest");
    const packedDirectory = path.join(output, `packed-${adapter}`);
    await unpack(packed.archive, packedDirectory, `${adapter}-packed`);
    const packedManifest = JSON.parse(await fs.readFile(path.join(packedDirectory, "package.json"), "utf8"));
    assert.deepEqual(packedManifest, proposed, "Packed manifest differs from reviewed proposal");
    const artifact = await recordArtifact(packedManifest, packed.archive);
    const consumer = path.join(output, `consumer-${adapter}`);
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { [artifact.manifest.name]: `file:${artifact.archive}` }, devDependencies: { typescript: "5.9.3", "@types/node": "22.19.7" } }, null, 2));
    await fs.cp(path.join(here, "consumer-fixtures", adapter), consumer, { recursive: true });
    await fs.copyFile(path.join(here, "consumer-fixtures/toml-boundaries.test.mjs"), path.join(consumer, "toml-boundaries.test.mjs"));
    await npmRun(["install", ...installArgs], consumer, `${adapter}-consumer-install`);
    await npmRun(["ci", ...installArgs], consumer, `${adapter}-consumer-reinstall`);
    await npmRun(["ls", "--all"], consumer, `${adapter}-consumer-tree`);
    await npmRun(["audit", "--audit-level=low", `--registry=${registry}`], consumer, `${adapter}-consumer-audit`);
    await run(process.execPath, ["--test", "consumer.test.mjs", "toml-boundaries.test.mjs"], consumer, `${adapter}-consumer-runtime`);
    await run(process.execPath, [path.join(consumer, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "false", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"], consumer, `${adapter}-consumer-types`);
  }
  await fs.writeFile(path.join(output, "qualification.json"), JSON.stringify({ node: process.version, npm: (await run(process.execPath, [npm, "--version"], output, "npm-version")).trim(), artifacts: receipts, distribution: "loopback-registry-only-not-publication", output }, null, 2));
  console.log(`Qualified candidate: ${output}/qualification.json`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
