import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { checkDiskBudget, runWithBudget, acquireQualificationLock, cleanupGenerated } from "../resource-budget.mjs";

const stats = free => () => ({ bavail: free, bsize: 1 });

test("preflight includes the stage peak as well as the protected reserve", () => {
  assert.throws(() => checkDiskBudget("unused", { reserve: 100, peak: 50, statfs: stats(149) }), /Disk budget exhausted/);
  assert.equal(checkDiskBudget("unused", { reserve: 100, peak: 50, statfs: stats(150) }), 150);
  assert.throws(() => checkDiskBudget("unused", { statfs: () => { throw new Error("unreadable filesystem"); } }), /unreadable filesystem/);
});

test("low space prevents a child process from starting", async () => {
  await assert.rejects(runWithBudget(process.execPath, ["-e", "throw Error('must not start')"], { cwd: os.tmpdir() }, { reserve: 100, statfs: stats(99) }), /Disk budget exhausted/);
});

test("reserve breach stops a running disposable writer", async () => {
  let reads = 0;
  const began = Date.now();
  await assert.rejects(runWithBudget(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});setTimeout(()=>{},30000)"], { cwd: os.tmpdir() }, {
    reserve: 100, pollMs: 50, statfs: () => ({ bavail: ++reads < 4 ? 200 : 99, bsize: 1 }),
  }), /Disk budget exhausted/);
  assert.ok(Date.now() - began < 5000, "must stop promptly, not after the command timeout");
});

test("guarded execution captures output and preserves a nonzero failure", async () => {
  const budget = { reserve: 100, statfs: stats(1000) };
  const result = await runWithBudget(process.execPath, ["-e", "console.log('passed');console.error('diagnostic')"], { cwd: os.tmpdir(), timeout: 2000 }, budget);
  assert.match(result.stdout, /passed/);
  assert.match(result.stderr, /diagnostic/);
  await assert.rejects(runWithBudget(process.execPath, ["-e", "console.error('failed');process.exit(7)"], { cwd: os.tmpdir(), timeout: 2000 }, budget), error => error.code === 7 && /failed/.test(error.stderr));
});

test("guarded execution stops a timed-out command", async () => {
  await assert.rejects(runWithBudget(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { cwd: os.tmpdir(), timeout: 50 }, { reserve: 100, statfs: stats(1000) }), /timed out/);
});

test("one installation lock excludes a concurrent qualification and releases cleanly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toml-budget-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "install.lock");
  const release = await acquireQualificationLock(lock);
  await assert.rejects(acquireQualificationLock(lock), /run runtimes serially/);
  await release();
  await (await acquireQualificationLock(lock))();
});

test("cleanup removes disposable installs/caches/staging but keeps compact evidence and outside data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "toml-budget-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const outside = path.join(root, "outside");
  await mkdir(outside); await mkdir(output);
  await writeFile(path.join(outside, "live-data"), "keep");
  for (const name of ["node_modules", ".npm-cache", ".pack-adapter-fixture"]) {
    await mkdir(path.join(output, name));
    await writeFile(path.join(output, name, "generated"), "remove");
  }
  await symlink(outside, path.join(output, "outside-link"), "dir");
  await writeFile(path.join(output, "package-lock.json"), "keep lock");
  await writeFile(path.join(output, "receipt.json"), "keep proof");
  await cleanupGenerated(output);
  for (const name of ["node_modules", ".npm-cache", ".pack-adapter-fixture"]) await assert.rejects(readFile(path.join(output, name, "generated")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(outside, "live-data"), "utf8"), "keep");
  assert.equal(await readFile(path.join(output, "package-lock.json"), "utf8"), "keep lock");
  assert.equal(await readFile(path.join(output, "receipt.json"), "utf8"), "keep proof");
});
