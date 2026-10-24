// Resource safety for disposable Linux CI qualification, not production storage.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statfsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const GiB = 1024 ** 3;
export const reserveBytes = 10 * GiB;
export const peakBytes = 2 * GiB;
const ownedGroups = new Map();
let cancellation;
let signalOwners = 0;
let handlersInstalled = false;

export function throwIfCancelled() { if (cancellation) throw cancellation; }
function killGroup(pid) {
  if (!pid) return false;
  try { process.kill(-pid, "SIGKILL"); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function groupHasWriters(group) {
  // A zombie may retain a group ID until init reaps it, but cannot write data.
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = await fs.readFile(`/proc/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (Number(fields[2]) === group && !["Z", "X"].includes(fields[0])) return true;
    } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
  }
  return false;
}
async function stopGroup(pid) {
  if (!killGroup(pid)) return;
  const deadline = Date.now() + 2000;
  while (await groupHasWriters(pid)) {
    if (Date.now() >= deadline) throw new Error(`Writer group ${pid} did not stop; keep its lock and output for intervention`);
    killGroup(pid);
    await delay(10);
  }
}
export async function stopOwnedWriters() {
  for (const record of ownedGroups.values()) record.stop(cancellation || new Error("Qualification owner is closing"));
  for (const pid of [...ownedGroups.keys()]) {
    await stopGroup(pid);
    ownedGroups.get(pid)?.finish();
    ownedGroups.delete(pid);
  }
  removeUnusedSignalHandlers();
}
function interrupt(signal) {
  cancellation ||= Object.assign(new Error(`Qualification interrupted by ${signal}`), { signal });
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  for (const record of ownedGroups.values()) record.stop(cancellation);
}
const signalHandlers = { SIGINT: () => interrupt("SIGINT"), SIGTERM: () => interrupt("SIGTERM") };
function emergencyExit() {
  // Last synchronous backstop for process.exit/uncaught failure; SIGKILL is uncatchable.
  for (const pid of ownedGroups.keys()) { try { killGroup(pid); } catch { /* Already terminating. */ } }
}
function removeUnusedSignalHandlers() {
  if (signalOwners === 0 && ownedGroups.size === 0 && handlersInstalled) {
    for (const [signal, handler] of Object.entries(signalHandlers)) process.off(signal, handler);
    process.off("exit", emergencyExit);
    handlersInstalled = false;
  }
}
export function installSignalHandlers() {
  signalOwners++;
  if (!handlersInstalled) {
    for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);
    process.on("exit", emergencyExit);
    handlersInstalled = true;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    signalOwners--;
    removeUnusedSignalHandlers();
  };
}

export function checkDiskBudget(directory, { reserve = reserveBytes, peak = peakBytes, statfs = statfsSync } = {}) {
  const stats = statfs(directory);
  const free = Number(stats.bavail) * Number(stats.bsize);
  assert.ok(Number.isFinite(free) && free >= reserve + peak,
    `Disk budget exhausted: ${free} bytes available; ${reserve + peak} required (reserve ${reserve}, stage peak ${peak})`);
  return free;
}

export async function runWithBudget(binary, args, options, budget = {}) {
  // Group ownership/quiescence below relies on Linux /proc, rather than pretending
  // that killing one Windows child or merely observing its exit stops descendants.
  assert.equal(process.platform, "linux", "Qualification process ownership requires Linux");
  throwIfCancelled();
  checkDiskBudget(options.cwd, { ...budget, peak: 0 });
  const restoreSignals = installSignalHandlers();
  try {
    return await new Promise((resolve, reject) => {
      // execFile does not forward `detached`; spawn creates a real process group.
      const child = spawn(binary, args, { cwd: options.cwd, env: options.env, detached: true, windowsHide: true });
      const output = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
      let failure;
      function stop(error) {
        failure ||= error;
        try { killGroup(child.pid); }
        catch (killError) { failure = killError; }
      }
      for (const stream of ["stdout", "stderr"]) {
        child[stream].on("data", (bytes) => {
          if (failure) return;
          sizes[stream] += bytes.length;
          if (sizes[stream] > maxBuffer) stop(new Error(`${stream} exceeded maxBuffer`));
          else output[stream].push(bytes);
        });
      }
      const monitor = setInterval(() => {
        try { checkDiskBudget(options.cwd, { ...budget, peak: 0 }); }
        catch (error) { stop(error); }
      }, budget.pollMs || 1000);
      monitor.unref();
      const deadline = options.timeout ? setTimeout(() => stop(new Error(`Command timed out after ${options.timeout}ms`)), options.timeout) : undefined;
      deadline?.unref();
      const finish = () => { clearInterval(monitor); clearTimeout(deadline); };
      if (child.pid) ownedGroups.set(child.pid, { stop, finish });
      // Do not wait for inherited pipes to close before stopping background writers.
      child.once("exit", () => {
        try { killGroup(child.pid); }
        catch (error) { failure ||= error; }
      });
      child.once("error", (error) => { failure ||= error; });
      child.once("close", async (code, signal) => {
        try {
          // Parent exit (including zero) is not proof that its writers stopped.
          await stopGroup(child.pid);
          ownedGroups.delete(child.pid);
          finish();
          throwIfCancelled();
          checkDiskBudget(options.cwd, { ...budget, peak: 0 });
        } catch (error) {
          failure ||= error;
          if (ownedGroups.has(child.pid)) monitor.ref(); // Keep ownership if quiescence failed.
        }
        const text = { stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") };
        if (failure || code !== 0) reject(Object.assign(failure || new Error(`Command exited ${code} (${signal || "no signal"})`), text, { code, signal: cancellation?.signal || signal }));
        else resolve(text);
      });
    });
  } finally { restoreSignals(); }
}

// Linux's shared /tmp keeps per-runtime TMPDIR/HOME overrides from bypassing it.
export async function acquireQualificationLock(location = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `noosphere-toml-qualification-${process.getuid?.() ?? "user"}.lock`)) {
  try { await fs.mkdir(location, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another qualification owns the install lock; run runtimes serially. Inspect any stale lock before removal.", { cause: error });
    throw error;
  }
  try { await fs.writeFile(path.join(location, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); }
  catch (error) { await fs.rm(location, { recursive: true }); throw error; }
  const identity = await fs.lstat(location);
  return async () => {
    const current = await fs.lstat(location);
    assert.equal(current.ino, identity.ino, "Qualification lock changed; do not remove another owner's lock");
    await fs.rm(location, { recursive: true });
  };
}

export async function cleanupGenerated(output) {
  // Only walk our newly-created output; never follow links back to source/live data.
  const names = new Set(["node_modules", ".npm-cache"]);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (names.has(entry.name) || entry.name.startsWith(".pack-adapter-")) {
        await fs.rm(location, { recursive: true, force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(location);
    }
  }
  await visit(output);
}
