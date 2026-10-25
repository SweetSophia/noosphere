// Qualify the active adapters' packed artifacts using only public npm dependencies.
// Usage: node public-consumers.mjs /absolute/archive-directory /absolute/new/output [adapter-directory-name]
import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const [archives, output, selected] = process.argv.slice(2);
assert.ok(archives && output && path.isAbsolute(archives) && path.isAbsolute(output));
const adapters = ["opencode-noosphere-memory", "kilocode-noosphere-memory"];
assert.ok(selected === undefined || adapters.includes(selected), "Unknown adapter selection");
await fs.mkdir(output); // Never reuse an installation as qualification evidence.
const npm = await fs.realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const registry = "https://registry.npmjs.org";
const receipts = [];
let sequence = 0;
async function run(binary, args, cwd, label) {
  const log = path.join(output, `${String(++sequence).padStart(3, "0")}-${label}.log`);
  try {
    const result = await execFile(binary, args, { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    await fs.writeFile(log, result.stdout + result.stderr);
    console.log(`PASS ${label}`);
    return result.stdout;
  } catch (error) {
    await fs.writeFile(log, `${error.stdout || ""}${error.stderr || ""}\n${error.message}`);
    console.error(`${error.stdout || ""}${error.stderr || ""}`.slice(-20_000));
    throw new Error(`${label} failed; see ${log}`, { cause: error });
  }
}
for (const adapter of selected ? [selected] : adapters) {
  const source = JSON.parse(await fs.readFile(path.join(repo, adapter, "package.json"), "utf8"));
  const archive = path.join(archives, `${source.name.slice(1).replace("/", "-")}-${source.version}.tgz`);
  const packed = JSON.parse(await run("tar", ["-xOzf", archive, "package/package.json"], output, `${adapter}-manifest`));
  assert.equal(packed.name, source.name);
  assert.equal(packed.version, source.version);
  assert.equal(packed.overrides, undefined, "Dependency overrides cannot deliver this repair");
  assert.equal(packed.dependencies["@sweetsophia/noosphere-client"], JSON.parse(await fs.readFile(path.join(repo, "noosphere-client/package.json"), "utf8")).version);
  assert.deepEqual(packed.bundledDependencies, ["@sweetsophia/noosphere-client"]);
  const consumer = path.join(output, adapter);
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { [packed.name]: `file:${archive}` }, devDependencies: { typescript: "5.9.3", "@types/node": "22.19.7" } }, null, 2));
  await fs.cp(path.join(here, "consumer-fixtures", adapter), consumer, { recursive: true });
  await fs.copyFile(path.join(here, "consumer-fixtures/toml-boundaries.test.mjs"), path.join(consumer, "toml-boundaries.test.mjs"));
  const args = [`--registry=${registry}`, `--cache=${path.join(consumer, ".npm-cache")}`, "--ignore-scripts", "--no-audit", "--no-fund"];
  await run(process.execPath, [npm, "install", ...args], consumer, `${adapter}-install`);
  await run(process.execPath, [npm, "ci", ...args], consumer, `${adapter}-reinstall`);
  await run(process.execPath, [npm, "ls", "--all"], consumer, `${adapter}-tree`);
  await run(process.execPath, [npm, "audit", "--audit-level=low", `--registry=${registry}`], consumer, `${adapter}-audit`);
  const lock = JSON.parse(await fs.readFile(path.join(consumer, "package-lock.json"), "utf8"));
  const toml = Object.entries(lock.packages).filter(([name]) => name.endsWith("node_modules/toml"));
  assert.ok(toml.length > 0);
  for (const [, entry] of toml) assert.equal(entry.version, "5.0.1");
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name && entry.resolved && !entry.inBundle && name !== `node_modules/${packed.name}`) {
      assert.ok(entry.resolved.startsWith(`${registry}/`), `Non-public dependency: ${name} ${entry.resolved}`);
    }
  }
  await run(process.execPath, ["--test", "consumer.test.mjs", "toml-boundaries.test.mjs"], consumer, `${adapter}-runtime`);
  await run(process.execPath, [path.join(consumer, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "false", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"], consumer, `${adapter}-types`);
  receipts.push({ name: packed.name, version: packed.version, sha256: createHash("sha256").update(await fs.readFile(archive)).digest("hex"), toml: toml.map(([name, entry]) => ({ name, version: entry.version })) });
}
await fs.writeFile(path.join(output, "public-consumers.json"), `${JSON.stringify({ node: process.version, registry, artifacts: receipts }, null, 2)}\n`);
