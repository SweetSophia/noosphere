// Qualify current adapter manifests/locks, not the frozen historical proposals.
// Usage: node qualify-active.mjs /absolute/new/output-directory
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDiskBudget, runWithBudget, acquireQualificationLock, cleanupGenerated, installSignalHandlers, stopOwnedWriters, throwIfCancelled } from "./resource-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const [output, ...extra] = process.argv.slice(2);
assert.ok(output && path.isAbsolute(output) && extra.length === 0, "Provide one new absolute output directory");
assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Node 22 or newer required");
// Refuse work before allocating: preserve 10 GiB plus a 2 GiB stage budget.
checkDiskBudget(path.dirname(output));
const npm = await fs.realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const registry = "https://registry.npmjs.org";
// npm run invokes `node` by PATH, not necessarily process.execPath. Bind both.
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`, npm_execpath: npm, npm_config_registry: registry, npm_config_cache: path.join(output, ".npm-cache") };
const source = path.join(output, "source");
const archives = path.join(output, "archives");
const consumers = path.join(output, "consumers");
const adapters = ["opencode-noosphere-memory", "kilocode-noosphere-memory"];
const checks = [];

async function run(binary, args, cwd, label) {
  const log = path.join(output, `${String(checks.length + 1).padStart(3, "0")}-${label}.log`);
  try {
    const result = await runWithBudget(binary, args, { cwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    await fs.writeFile(log, result.stdout + result.stderr);
    checks.push({ label, exitCode: 0, log: path.basename(log) });
    console.log(`PASS ${label}`);
  } catch (error) {
    await fs.writeFile(log, `${error.stdout || ""}${error.stderr || ""}\n${error.message}`);
    throw new Error(`${label} failed; see ${log}`, { cause: error });
  }
}
async function distHashes(directory) {
  const result = {};
  async function visit(current, prefix = "") {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const name = prefix + item.name;
      const location = path.join(current, item.name);
      if (item.isDirectory()) await visit(location, `${name}/`);
      else {
        assert.ok(item.isFile(), `Unsupported dist member: ${name}`);
        result[name] = createHash("sha256").update(await fs.readFile(location)).digest("hex");
      }
    }
  }
  await visit(directory);
  return result;
}

const restoreSignals = installSignalHandlers();
let releaseInstallLock;
let created = false;
let qualificationFailure;
try {
  releaseInstallLock = await acquireQualificationLock();
  throwIfCancelled();
  await fs.mkdir(output); // Refuse reuse: cached installations are not fresh proof.
  created = true;
  await fs.mkdir(source);
  // Preserve sibling file: resolution, without copying credentials or installs.
  for (const name of ["noosphere-client", ...adapters]) {
    await fs.cp(path.join(repo, name), path.join(source, name), {
      recursive: true,
      filter: async (location) => {
        const base = path.basename(location);
        if (["node_modules", ".git", ".npmrc", ".npm-cache"].includes(base) || base === ".env" || base.startsWith(".env.")) return false;
        assert.ok(!(await fs.lstat(location)).isSymbolicLink(), `Source snapshot must not contain symlinks: ${base}`);
        return true;
      },
    });
  }
  for (const name of ["noosphere-client", ...adapters]) {
    const directory = path.join(source, name);
    const before = await Promise.all(["package.json", "package-lock.json"].map(file => fs.readFile(path.join(directory, file), "utf8")));
    const dist = await distHashes(path.join(directory, "dist"));
    for (const [stage, args] of [
      ["ci", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`]],
      ["tree", ["ls", "--all"]],
      ["test", ["run", "test"]],
      ["audit", ["audit", "--audit-level=low", `--registry=${registry}`]],
      ["typecheck", ["run", "typecheck"]],
      ["build", ["run", "build"]],
    ]) await run(process.execPath, [npm, ...args], directory, `${name}-${stage}`);
    assert.deepEqual(await distHashes(path.join(directory, "dist")), dist, `Built dist differs from current candidate: ${name}`);
    assert.deepEqual(await Promise.all(["package.json", "package-lock.json"].map(file => fs.readFile(path.join(directory, file), "utf8"))), before, `Qualification changed a manifest or lock: ${name}`);
    if (adapters.includes(name)) {
      await run(process.execPath, [path.join(here, "pack-adapter.mjs"), directory, archives], source, `${name}-pack`);
    }
    // On failure, the outer finalizer owns cleanup and preserves both errors;
    // a per-package finally must not replace the original qualification failure.
    await stopOwnedWriters();
    // npm ls --all follows the sibling client link and needs its development tree.
    if (name !== "noosphere-client") await fs.rm(path.join(directory, "node_modules"), { recursive: true, force: true });
  }
  await fs.rm(path.join(source, "noosphere-client", "node_modules"), { recursive: true, force: true });
  // Keep the same strict install/reinstall/tree/audit/runtime/type gates.
  await run(process.execPath, [path.join(here, "public-consumers.mjs"), archives, consumers], source, "public-consumers");
} catch (error) {
  // The wrapper also preserves a non-Error/falsy thrown value if one occurs.
  qualificationFailure = { error };
  throw error;
} finally {
  // Includes interruption: complete writer stop and owned-output cleanup before
  // even attempting lock release. Any rejected step skips all subsequent steps.
  let lockReleaseStarted = false;
  try {
    await stopOwnedWriters();
    if (created) await cleanupGenerated(output);
    if (releaseInstallLock) {
      lockReleaseStarted = true;
      await releaseInstallLock();
    }
  } catch (error) {
    const cause = qualificationFailure
      ? new AggregateError([qualificationFailure.error, error], "Qualification and finalization both failed")
      : error;
    const ownership = releaseInstallLock
      ? lockReleaseStarted ? "install lock release failed; inspect lock state." : "install lock retained."
      : "No install lock was acquired.";
    throw new Error(`Qualification finalization failed; ${ownership} Inspect owned writers and output before recovery: ${output}`, { cause });
  } finally { restoreSignals(); }
}
// Cleanup must succeed too; interruption must never become a success receipt.
throwIfCancelled();
await fs.writeFile(path.join(output, "qualification.json"), `${JSON.stringify({ node: process.version, registry, distribution: "active-public-registry-only-not-publication", checks, publicConsumerReceipt: "consumers/public-consumers.json", generatedInstallationsRetained: false, reserveGiB: 10, stagePeakBudgetGiB: 2 }, null, 2)}\n`);
