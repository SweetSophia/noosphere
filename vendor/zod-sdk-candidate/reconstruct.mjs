// Reproduce only the two approved SDK revisions; this never publishes anything.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as callback, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
const execFile = promisify(callback);
const here = path.dirname(fileURLToPath(import.meta.url));
const registry = "https://registry.npmjs.org";
export const approved = JSON.parse(await fs.readFile(path.join(here, "artifacts.json"), "utf8"));
assert.deepEqual(approved.map(({ name, version }) => [name, version]), [
  ["@sweetsophia/noosphere-opencode-plugin", "1.15.5-noosphere.4"],
  ["@sweetsophia/noosphere-kilocode-plugin", "7.3.1-noosphere.5"],
]);
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
async function command(binary, args, cwd) {
  return (await execFile(binary, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
async function hashes(directory) {
  const entries = {};
  async function visit(current, prefix = "") {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) await visit(path.join(current, item.name), `${name}/`);
      else {
        assert.ok(item.isFile(), `Unsupported member: ${name}`);
        entries[name] = digest(await fs.readFile(path.join(current, item.name)));
      }
    }
  }
  await visit(directory);
  return entries;
}
async function unpack(archive, directory, cwd) {
  const members = (await command("tar", ["-tzf", archive], cwd)).trim().split("\n");
  for (const member of members) {
    const parts = member.split("/");
    assert.ok(member.startsWith("package/") && !parts.includes("..") &&
      !parts.some((p) => p === ".git" || p === "node_modules" || p === ".env" || p.startsWith(".env.")), `Unsafe member: ${member}`);
  }
  const details = (await command("tar", ["-tvzf", archive], cwd)).trim().split("\n");
  assert.ok(details.every((line) => /^[d-]/.test(line)), "Archive must contain only regular files/directories");
  await fs.mkdir(directory);
  await command("tar", ["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", directory], cwd);
}
export async function fetchBytes(url, request = fetch) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, registry, "Only the public npm registry is permitted");
  assert.ok(!parsed.username && !parsed.password, "Registry URLs must not contain credentials");
  const target = new URL(registry);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  const response = await request(target, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `Registry read failed: ${parsed.pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 2 * 1024 * 1024, "Unexpected SDK archive/metadata size");
  return bytes;
}
export async function reconstruct(output) {
  assert.ok(output && path.isAbsolute(output), "Provide a new absolute output directory");
  const npm = await fs.realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  const npmVersion = (await command(process.execPath, [npm, "--version"], here)).trim();
  assert.equal(npmVersion, "12.1.0", "Archive reproduction requires npm 12.1.0");
  await fs.mkdir(output); // Do not reuse a previous reconstruction as evidence.
  const artifacts = [];
  const provenance = [];
  for (const [index, item] of approved.entries()) {
    assert.equal(path.basename(item.archive), item.archive);
    const metadata = JSON.parse(await fetchBytes(`${registry}/${encodeURIComponent(item.name)}/${item.source.version}`));
    assert.equal(metadata.name, item.name);
    assert.equal(metadata.version, item.source.version);
    assert.equal(metadata.dist.integrity, item.source.integrity);
    const bytes = await fetchBytes(metadata.dist.tarball);
    assert.equal(digest(bytes), item.source.sha256, "Published source bytes changed");
    assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, item.source.integrity);
    const original = path.join(output, `source-${index}.tgz`);
    await fs.writeFile(original, bytes);
    const source = path.join(output, `source-${index}`);
    await unpack(original, source, output);
    const before = await hashes(source);
    const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.source.version);
    assert.equal(manifest.dependencies.zod, "4.1.8");
    assert.equal(manifest.dependencies.effect, item.effectAlias);
    manifest.version = item.version;
    manifest.dependencies.zod = item.zod;
    assert.equal(item.zod, "4.6.7");
    // Match the reviewed archive's ASCII JSON serialization exactly.
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    assert.equal(digest(serialized), item.manifestSha256);
    await fs.writeFile(path.join(source, "package.json"), serialized);
    const after = await hashes(source);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    assert.deepEqual(Object.keys(after).filter((name) => after[name] !== before[name]), ["package.json"]);
    const packed = JSON.parse(await command(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", output], source));
    const receipt = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    assert.equal(receipt.filename, item.archive);
    const archive = path.join(output, item.archive);
    const final = await fs.readFile(archive);
    assert.equal(digest(final), item.sha256, "Reconstructed archive differs from approval");
    assert.equal(`sha512-${digest(final, "sha512", "base64")}`, item.integrity);
    const repacked = path.join(output, `verified-${index}`);
    await unpack(archive, repacked, output);
    assert.deepEqual(await hashes(repacked), after, "Packing changed the member set or bytes");
    artifacts.push(Object.fromEntries(["name", "version", "archive", "sha256", "integrity"].map((key) => [key, item[key]])));
    provenance.push({ name: item.name, sourceVersion: item.source.version, sourceSha256: item.source.sha256, changedMembers: ["package.json"], unchangedMemberCount: Object.keys(before).length - 1 });
    console.log(`RECONSTRUCTED ${item.name}@${item.version} ${item.sha256}`);
  }
  const receipt = { kind: "zod-sdk-reconstruction", node: process.version, npm: npmVersion, artifacts, provenance, publication: false };
  await fs.writeFile(path.join(output, "reconstruction.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await reconstruct(process.argv[2]);
}
