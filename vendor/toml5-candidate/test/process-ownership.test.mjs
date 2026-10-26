import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runWithBudget } from "../resource-budget.mjs";

const moduleUrl = new URL("../resource-budget.mjs", import.meta.url).href;
const budget = { reserve: 100, statfs: () => ({ bavail: 1000, bsize: 1 }) };
async function live(pid) {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function waitForFile(file) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  throw new Error("Tiny writer fixture did not become ready");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "toml-writer-owner-"));
  const pidFile = path.join(root, "writers.json");
  t.after(async () => {
    try {
      const record = JSON.parse(await fs.readFile(pidFile, "utf8"));
      if (Number.isInteger(record.leader) && record.leader > 1 && record.leader !== process.pid) {
        try { process.kill(-record.leader, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, pidFile };
}

for (const exitCode of [0, 7]) {
  test(`an exiting parent (${exitCode}) cannot leave an ignored-stdio writer`, async (t) => {
    const { root, pidFile } = await fixture(t);
    const script = `const fs=require('node:fs');const {spawn}=require('node:child_process');
const descendant=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({leader:process.pid,descendant:descendant.pid}));
console.log('original-output');process.exit(${exitCode});`;
    if (exitCode) {
      await assert.rejects(runWithBudget(process.execPath, ["-e", script], { cwd: root, timeout: 2000 }, budget), error => error.code === exitCode && /original-output/.test(error.stdout));
    } else {
      const result = await runWithBudget(process.execPath, ["-e", script], { cwd: root, timeout: 2000 }, budget);
      assert.match(result.stdout, /original-output/);
    }
    const writers = await waitForFile(pidFile);
    assert.equal(await live(writers.descendant), false, "orphan writer survived the completed command");
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} stops owned writers before cleanup and install-lock release`, async (t) => {
    const { root, pidFile } = await fixture(t);
    const lock = path.join(root, "install.lock");
    const marker = path.join(root, "cleanup.json");
    const writer = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({leader:process.pid,descendant:process.pid}));setTimeout(()=>{},30000);`;
    const ownerSource = `import * as budget from ${JSON.stringify(moduleUrl)};
import * as fs from 'node:fs/promises';
const restore=budget.installSignalHandlers?.() || (()=>{});
const release=await budget.acquireQualificationLock(${JSON.stringify(lock)});
try {
 await budget.runWithBudget(process.execPath,['-e',${JSON.stringify(writer)}],{cwd:${JSON.stringify(root)},timeout:30000},{reserve:100,statfs:()=>({bavail:1000,bsize:1})});
} finally {
 await budget.stopOwnedWriters?.();
 await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({cleaned:true}));
 await release();
 restore();
}`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerSource], { stdio: ["ignore", "pipe", "pipe"] });
    owner.stdout.resume(); owner.stderr.resume();
    t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); });
    const closed = once(owner, "close");
    const writers = await waitForFile(pidFile);
    owner.kill(signal);
    const [code] = await closed;
    assert.notEqual(code, 0, "interruption must not become a success");
    assert.equal(await live(writers.descendant), false, "owner interruption abandoned its writer");
    assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), { cleaned: true });
    await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
  });
}


test("unknown writer quiescence retains owner and lock with an explicit intervention diagnostic", { timeout: 8000 }, async (t) => {
  const { root } = await fixture(t);
  const fault = path.join(root, "unknown-quiescence");
  const marker = path.join(root, "failure.json");
  const lock = path.join(root, "install.lock");
  await fs.writeFile(fault, "fixture");
  const original = await fs.readFile(new URL("../resource-budget.mjs", import.meta.url), "utf8");
  const needle = "async function stopGroup(pid) {";
  assert.equal(original.split(needle).length, 2);
  const copy = path.join(root, "resource-budget.mjs");
  // Fault only the copied helper. The tiny child has exited; simulate inability
  // to prove that state, without creating an unkillable or real writing process.
  await fs.writeFile(copy, original.replace(needle, `${needle}\n  if (await fs.access(${JSON.stringify(fault)}).then(() => true, () => false)) throw new Error("fixture quiescence unknown");`));
  const script = `import * as budget from ${JSON.stringify(pathToFileURL(copy).href)};
import * as fs from 'node:fs/promises';
const restore=budget.installSignalHandlers();
const release=await budget.acquireQualificationLock(${JSON.stringify(lock)});
process.once('SIGTERM',async()=>{await budget.stopOwnedWriters();await release();restore();});
try { await budget.runWithBudget(process.execPath,['-e','console.log("tiny child")'],{cwd:${JSON.stringify(root)},timeout:2000},{reserve:100,pollMs:20,statfs:()=>({bavail:1000,bsize:1})}); }
catch(error){process.exitCode=1;await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({message:error.message}));}`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  owner.stdout.resume(); let diagnostic = ""; owner.stderr.on("data", bytes => { diagnostic += bytes; });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); });
  const closed = once(owner, "close");
  const failure = await waitForFile(marker);
  assert.match(failure.message, /quiescence unknown/);
  await delay(100);
  assert.equal(owner.exitCode, null, "owner exited while quiescence was unknown");
  assert.equal(owner.signalCode, null);
  await fs.lstat(lock);
  assert.match(diagnostic, /retaining ownership and lock\/output for supervisor intervention/);
  await fs.rm(fault); // Simulated supervisor confirms that quiescence can be checked.
  owner.kill("SIGTERM");
  const [code] = await closed;
  assert.notEqual(code, 0, "supervised failure became success");
  await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
});
