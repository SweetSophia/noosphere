import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, "..");
const repo = path.resolve(vendor, "../..");
const adapters = ["opencode-noosphere-memory", "kilocode-noosphere-memory"];

async function fixture(t, extraEnv = {}, captureFailure = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "toml-ci-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "repo");
  const harness = path.join(source, "vendor/toml5-candidate");
  await mkdir(harness, { recursive: true });
  const lock = path.join(root, "qualification.lock");
  // Isolate fixture ownership without adding a production lock-override switch.
  const runner = await readFile(path.join(vendor, "qualify-active.mjs"), "utf8");
  assert.equal(runner.split("await acquireQualificationLock()").length, 2);
  await writeFile(path.join(harness, "qualify-active.mjs"), runner.replace("await acquireQualificationLock()", `await acquireQualificationLock(${JSON.stringify(lock)})`));
  const resources = await readFile(path.join(vendor, "resource-budget.mjs"), "utf8");
  const cleanupEntry = "export async function cleanupGenerated(output) {";
  assert.equal(resources.split(cleanupEntry).length, 2);
  // Fault only the copied cleanup helper; exercise the actual runner finalizer.
  const releaseEntry = "    const current = await fs.lstat(location);";
  assert.equal(resources.split(releaseEntry).length, 2);
  await writeFile(path.join(harness, "resource-budget.mjs"), resources.replace(cleanupEntry,
    `${cleanupEntry}\n  if (process.env.CI_FAIL_CLEANUP) throw new Error("injected cleanup failure");`).replace(releaseEntry,
    `    if (process.env.CI_FAIL_RELEASE) throw new Error("injected lock release failure");\n${releaseEntry}`));
  for (const name of ["noosphere-client", ...adapters]) {
    const dir = path.join(source, name);
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.15.1" }));
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name, lockfileVersion: 3 }));
    await writeFile(path.join(dir, "dist/index.js"), "export const fixture = true;\n");
    await writeFile(path.join(dir, ".env"), "DO_NOT_COPY=fixture\n");
  }
  const trace = path.join(root, "trace.jsonl");
  const npm = path.join(root, "fake-npm.cjs");
  await writeFile(npm, `const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
fs.mkdirSync('node_modules',{recursive:true});
fs.writeFileSync('node_modules/disposable-fixture','remove after use');
fs.mkdirSync('.npm-cache',{recursive:true});
fs.writeFileSync('.npm-cache/disposable-fixture','remove after use');
const linkedClientInstall=path.join(process.cwd(),'..','noosphere-client','node_modules','disposable-fixture');
const linkedClientInstallAvailable=fs.existsSync(linkedClientInstall);
fs.appendFileSync(process.env.CI_TRACE, JSON.stringify({kind:'npm',args,cwd:process.cwd(),node:process.execPath,linkedClientInstallAvailable})+'\\n');
if(args[0]==='ls' && !linkedClientInstallAvailable && path.basename(process.cwd()).startsWith('opencode-noosphere-memory')) process.exit(25);
if(args[0]==='audit' && process.cwd().endsWith(process.env.CI_FAIL_AUDIT||'__never__')) process.exit(23);
`);
  for (const file of ["pack-adapter.mjs", "public-consumers.mjs"]) {
    await writeFile(path.join(harness, file), `import * as fs from 'node:fs/promises';
await fs.appendFile(process.env.CI_TRACE,JSON.stringify({kind:${JSON.stringify(file)},args:process.argv.slice(2),node:process.execPath})+'\\n');
if(${JSON.stringify(file)}==='public-consumers.mjs' && process.env.CI_FAIL_PUBLIC) process.exit(24);
`);
  }
  const output = path.join(root, "output");
  const failure = path.join(root, "failure.json");
  const runnerPath = path.join(harness, "qualify-active.mjs");
  // Import the actual copied runner so a test can inspect errors/cause objects,
  // not merely a stage log or Node's depth-limited printed diagnostic.
  const capture = `import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
const describe = e => e && typeof e === 'object' ? {
  name: e.name, message: e.message, code: e.code,
  cause: e.cause === undefined ? undefined : describe(e.cause),
  errors: Array.isArray(e.errors) ? e.errors.map(describe) : undefined,
} : { value: String(e) };
try { await import(pathToFileURL(process.argv[1]).href); }
catch (error) {
  await writeFile(${JSON.stringify(failure)}, JSON.stringify(describe(error)));
  console.error(error);
  process.exitCode ||= 1;
}`;
  const args = captureFailure ? ["--input-type=module", "-e", capture, runnerPath, output] : [runnerPath, output];
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, npm_execpath: npm, CI_TRACE: trace, ...extraEnv }, encoding: "utf8", timeout: 20_000,
  });
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  return { root, source, output, lock, failure, result, events };
}

test("installed-consumers verifies frozen provenance and then the active graph, without bypasses", async () => {
  const workflow = await readFile(path.join(repo, ".github/workflows/toml-candidate.yml"), "utf8");
  const installed = workflow.split("  installed-consumers:")[1].split("  application-typecheck:")[0];
  assert.match(installed, /qualify\.mjs[^\n]*--reconstruct-only/);
  assert.match(installed, /qualify-active\.mjs/);
  assert.match(installed, /node --test vendor\/toml5-candidate\/test\/ci-qualification\.test\.mjs/);
  assert.doesNotMatch(installed, /continue-on-error|\|\| true|--omit=dev|--audit-level=(?:high|critical)/);
  const historical = await readFile(path.join(vendor, "qualify.mjs"), "utf8");
  assert.match(historical, /--reconstruct-only/);
  assert.match(historical, /release-artifacts\.json/);
  assert.match(historical, /historical-archives-only-not-consumer-qualification/);
  assert.match(historical, /"audit", "--audit-level=low"/); // Historical default still audits.
  const publication = workflow.split("  publish-dependencies:")[1];
  assert.match(publication, /github\.sha == inputs\.expected_sha/);
  assert.match(publication, /qualify\.mjs "\$RUNNER_TEMP\/toml-publication"\n/);
  assert.doesNotMatch(publication, /--reconstruct-only/);
});

test("active qualification uses current snapshots, runs every gate, and leaves the source untouched", async (t) => {
  const { source, output, lock, result, events } = await fixture(t);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(lock, "owner.json")), { code: "ENOENT" });
  for (const name of ["noosphere-client", ...adapters]) {
    const checks = events.filter(e => e.kind === "npm" && e.cwd.endsWith(name));
    for (const command of ["ci", "audit", "ls"]) assert.ok(checks.some(e => e.args[0] === command), name + command);
    for (const command of ["test", "typecheck", "build"]) assert.ok(checks.some(e => e.args.join(" ") === "run " + command), name + command);
    assert.ok(checks.find(e => e.args[0] === "ci").args.includes("--ignore-scripts"));
    assert.ok(checks.find(e => e.args[0] === "audit").args.includes("--audit-level=low"));
    assert.ok(checks.every(e => e.cwd.startsWith(output)));
    assert.equal(JSON.parse(await readFile(path.join(source, name, "package.json"))).version, "1.15.1");
    await assert.rejects(readFile(path.join(output, "source", name, ".env")), { code: "ENOENT" });
  }
  const adapterTree = events.find(e => e.kind === "npm" && e.args[0] === "ls" && e.cwd.endsWith(adapters[0]));
  assert.equal(adapterTree?.linkedClientInstallAvailable, true, "adapter tree gate must resolve the linked client's installed dev dependency graph");
  assert.equal(events.filter(e => e.kind === "pack-adapter.mjs").length, 2);
  assert.equal(events.filter(e => e.kind === "public-consumers.mjs").length, 1);
  assert.ok(events.every(e => e.node === process.execPath));
  const receipt = JSON.parse(await readFile(path.join(output, "qualification.json")));
  assert.equal(receipt.distribution, "active-public-registry-only-not-publication");
  for (const name of ["noosphere-client", ...adapters]) {
    for (const dir of ["node_modules", ".npm-cache"]) {
      await assert.rejects(readFile(path.join(output, "source", name, dir, "disposable-fixture")), { code: "ENOENT" });
    }
  }
});

test("an audit failure prevents packing, consumer qualification and a success receipt", async (t) => {
  const { output, lock, result, events } = await fixture(t, { CI_FAIL_AUDIT: adapters[0] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /audit failed/);
  await assert.rejects(readFile(path.join(lock, "owner.json")), { code: "ENOENT" });
  for (const name of ["noosphere-client", ...adapters]) {
    await assert.rejects(readFile(path.join(output, "source", name, "node_modules/disposable-fixture")), { code: "ENOENT" });
  }
  assert.equal(events.filter(e => e.kind !== "npm").length, 0);
  await assert.rejects(readFile(path.join(output, "qualification.json")), { code: "ENOENT" });
});

test("a consumer failure propagates and never writes a success receipt", async (t) => {
  const { output, lock, result } = await fixture(t, { CI_FAIL_PUBLIC: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public-consumers failed/);
  await assert.rejects(readFile(path.join(lock, "owner.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(output, "qualification.json")), { code: "ENOENT" });
});

for (const finalizationStage of ["cleanup", "release"]) {
  for (const auditFailure of [false, true]) {
    test(`${finalizationStage} rejection preserves causes and ownership (audit failure: ${auditFailure})`, async (t) => {
      const { output, lock, failure, result } = await fixture(t, {
        [finalizationStage === "cleanup" ? "CI_FAIL_CLEANUP" : "CI_FAIL_RELEASE"]: "1",
        ...(auditFailure ? { CI_FAIL_AUDIT: adapters[0] } : {}),
      }, true);
      assert.notEqual(result.status, 0);
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      assert.equal(owner.pid, result.pid, "retain this qualifier's lock, not another owner's");
      assert.match(result.stderr, finalizationStage === "cleanup" ? /install lock retained/ : /install lock release failed/);
      assert.ok(result.stderr.includes(output), "retain the exact failed output for operator recovery");
      const error = JSON.parse(await readFile(failure, "utf8"));
      const finalizationMessage = finalizationStage === "cleanup" ? "injected cleanup failure" : "injected lock release failure";
      if (auditFailure) {
        assert.equal(error.cause.name, "AggregateError");
        assert.equal(error.cause.errors.length, 2);
        assert.match(error.cause.errors[0].message, /opencode-noosphere-memory-audit failed/);
        assert.equal(error.cause.errors[0].cause.code, 23, "preserve the original qualification exit status");
        assert.equal(error.cause.errors[1].message, finalizationMessage);
      } else {
        assert.equal(error.cause.message, finalizationMessage, "a sole finalization failure needs no invented qualification cause");
      }
      const cache = path.join(output, "source/noosphere-client/.npm-cache/disposable-fixture");
      if (finalizationStage === "cleanup") assert.equal(await readFile(cache, "utf8"), "remove after use");
      else await assert.rejects(readFile(cache), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(output, "qualification.json")), { code: "ENOENT" });
    });
  }
}

test("unknown historical modes fail before writing or fetching any artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toml-ci-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const result = spawnSync(process.execPath, [path.join(vendor, "qualify.mjs"), output, "--ignore-audit"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown qualification mode/);
  await assert.rejects(readFile(path.join(output, "reconstruction.json")), { code: "ENOENT" });
});

test("the new active runner refuses an existing output directory", async (t) => {
  const { source, output, lock } = await fixture(t);
  const result = spawnSync(process.execPath, [path.join(source, "vendor/toml5-candidate/qualify-active.mjs"), output], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  await assert.rejects(readFile(path.join(lock, "owner.json")), { code: "ENOENT" });
});
