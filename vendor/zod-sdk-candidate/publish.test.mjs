import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run, guard, digest, atomicJSON, validateTargets } from "./publish.mjs";
import { requiredChecks } from "./ci-receipt.mjs";

const source = JSON.parse(await readFile(new URL("artifacts.json", import.meta.url), "utf8"));
const sha = "a".repeat(40);
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "SweetSophia/noosphere", GITHUB_ACTOR: "SweetSophia",
  GITHUB_TRIGGERING_ACTOR: "SweetSophia", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: sha, EXPECTED_REVIEWED_SHA: sha, GITHUB_RUN_ATTEMPT: "1" };
async function fixture(t, transform = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sdk-publication-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = structuredClone(source), manifests = [], bytes = [];
  for (const [i, a] of artifacts.entries()) {
    const manifest = { name: a.name, version: a.version, dependencies: { zod: a.zod, effect: a.effectAlias } };
    transform(manifest, i);
    manifests.push(manifest);
    const build = path.join(directory, String(i));
    await mkdir(path.join(build, "package"), { recursive: true });
    const text = JSON.stringify(manifest);
    await writeFile(path.join(build, "package/package.json"), text);
    execFileSync("tar", ["-czf", path.join(directory, a.archive), "-C", build, "package/package.json"]);
    const tar = await readFile(path.join(directory, a.archive));
    bytes.push(tar);
    a.sha256 = digest(tar, "sha256", "hex");
    a.integrity = `sha512-${digest(tar, "sha512", "base64")}`;
    a.manifestSha256 = digest(text, "sha256", "hex");
  }
  const qualification = { kind: "zod-sdk-local-qualification", completed: true, artifacts, sourceCommit: sha,
    node: "v22.23.4", npm: "12.1.0", distribution: "private-file-sdk-archives-NOT-public-registry-only-qualification",
    checks: requiredChecks.map((name, i) => i === 0 ? { name, passed: true } : { name, passed: true,
      exitCode: name === "wrong-sdk-revision-rejected" ? 1 : 0, expectedFailure: name === "wrong-sdk-revision-rejected" }),
    consumers: ["opencode-noosphere-memory", "kilocode-noosphere-memory"].map((adapter, i) => ({
      adapter, runtimeCases: 12, strictTypes: true, zod: "4.6.7", toml: "5.0.1", sdk: artifacts[i].version, privateFileSdkEdge: true })) };
  await atomicJSON(path.join(directory, "qualification.json"), qualification);
  let clock = 0;
  const calls = [], publicModes = ["missing", "missing"];
  const request = async (url) => {
    url = String(url);
    const i = url.includes("/tar/") ? Number(url.split("/").at(-1)) : artifacts.findIndex((a) => url.includes(encodeURIComponent(a.name)));
    assert.ok(i >= 0 && i < 2, `Unexpected mock URL ${url}`);
    calls.push({ read: url });
    const mode = publicModes[i];
    if (url.includes("/tar/")) return new Response(mode === "tar404" ? null : mode === "bytes-mismatch" ? Buffer.from("wrong") : bytes[i], { status: mode === "tar404" ? 404 : 200 });
    if (mode === "missing") return new Response(null, { status: 404 });
    const meta = { ...manifests[i], dist: { integrity: artifacts[i].integrity, tarball: `https://registry.npmjs.org/tar/${i}` } };
    if (mode === "integrity-mismatch") meta.dist.integrity = "sha512-wrong";
    if (mode === "dependency-mismatch") meta.dependencies = { ...meta.dependencies, zod: "4.3.0" };
    if (mode === "identity-mismatch") meta.name = "other";
    if (mode === "unsafe-url") meta.dist.tarball = "https://example.invalid/secret";
    if (mode === "credential-url") {
      const url = new URL(meta.dist.tarball); url.username = "fixture"; url.password = "fixture";
      meta.dist.tarball = url.href;
    }
    if (mode === "fragment-url") meta.dist.tarball += "#fixture";
    return Response.json(meta);
  };
  const npm = async (args) => {
    calls.push({ npm: args });
    if (args[0] === "--version") return "12.1.0";
    if (args[0] === "whoami") return "sweetsophia";
    const i = artifacts.findIndex((a) => args[1] === path.join(directory, a.archive));
    assert.ok(i >= 0, "Only approved tarball paths may be published");
    const journal = JSON.parse(await readFile(path.join(directory, "submitted.json"), "utf8"));
    assert.equal(journal.submissions.find((s) => s.target === i)?.state, "attempted", "Journal precedes submission");
    publicModes[i] = "visible";
    return "";
  };
  const options = { artifacts, env: { ...env }, npm, request, now: () => clock, sleep: async () => { clock += 10 * 60_000; } };
  return { directory, artifacts, manifests, qualification, publicModes, options, calls,
    publishes: () => calls.filter((c) => c.npm?.[0] === "publish"),
    saveQualification: () => atomicJSON(path.join(directory, "qualification.json"), qualification),
    journal: (submissions) => atomicJSON(path.join(directory, "submitted.json"), { kind: "zod-sdk-submission-journal", commit: sha, targets: artifacts, submissions }),
  };
}

test("unchanged committed approval records satisfy the target contract", () => {
  validateTargets(source);
});
test("check approves synthetic bytes with zero npm/network calls", async (t) => {
  const f = await fixture(t);
  assert.equal((await run(f.directory, "--check", f.options)).completed, true);
  assert.deepEqual(f.calls, []);
});
for (const kind of ["sha256", "integrity", "manifestSha256", "version", "name", "archive", "effectAlias", "zod", "extra"]) {
  test(`reject unapproved local ${kind}`, async (t) => {
    const f = await fixture(t);
    if (kind === "extra") f.artifacts.push(structuredClone(f.artifacts[0]));
    else f.artifacts[0][kind] = kind === "sha256" || kind === "manifestSha256" ? "0".repeat(64) : "invalid";
    await assert.rejects(run(f.directory, "--publish", f.options));
    assert.equal(f.publishes().length, 0);
    assert.deepEqual(f.calls, []);
  });
}
for (const key of ["name", "version", "zod", "effect"]) {
  test(`reject approved tar with wrong manifest ${key}`, async (t) => {
    const f = await fixture(t, (m, i) => { if (!i) { if (["zod", "effect"].includes(key)) m.dependencies[key] = "wrong"; else m[key] = "wrong"; } });
    await assert.rejects(run(f.directory, "--check", f.options));
    assert.deepEqual(f.calls, []);
  });
}
for (const kind of ["missing", "kind", "completed", "artifacts", "failed-check", "empty-checks", "missing-source-commit", "wrong-source-commit", "omitted-gate"]) {
  test(`reject ${kind} qualification before npm`, async (t) => {
    const f = await fixture(t);
    if (kind === "missing") await rm(path.join(f.directory, "qualification.json"));
    else {
      if (kind === "kind") f.qualification.kind = "other";
      if (kind === "completed") f.qualification.completed = false;
      if (kind === "artifacts") f.qualification.artifacts = f.artifacts.slice(0, 1);
      if (kind === "failed-check") f.qualification.checks[0].passed = false;
      if (kind === "empty-checks") f.qualification.checks = [];
      if (kind === "missing-source-commit") delete f.qualification.sourceCommit;
      if (kind === "wrong-source-commit") f.qualification.sourceCommit = "b".repeat(40);
      if (kind === "omitted-gate") f.qualification.checks.pop();
      await f.saveQualification();
    }
    await assert.rejects(run(f.directory, "--publish", f.options));
    assert.deepEqual(f.calls, []);
  });
}
test("guards exact workflow identity and reviewed SHA", () => {
  guard(env);
  for (const key of Object.keys(env)) assert.throws(() => guard({ ...env, [key]: "wrong" }), key);
  assert.throws(() => guard({ ...env, GITHUB_SHA: "short", EXPECTED_REVIEWED_SHA: "short" }));
  const missingTrigger = { ...env }; delete missingTrigger.GITHUB_TRIGGERING_ACTOR;
  assert.throws(() => guard(missingTrigger));
});
test("reject wrong publishing npm version before identity or registry access", async (t) => {
  const f = await fixture(t), normal = f.options.npm;
  f.options.npm = async (args) => args[0] === "--version" ? "11.0.0" : normal(args);
  await assert.rejects(run(f.directory, "--publish", f.options), /npm version/);
  assert.deepEqual(f.calls, []);
});
test("reject wrong npm identity without registry reads or publish", async (t) => {
  const f = await fixture(t);
  f.options.npm = async (args) => args[0] === "--version" ? "12.1.0" : "not-approved";
  await assert.rejects(run(f.directory, "--publish", f.options), /npm identity/);
  assert.deepEqual(f.calls, []);
});
for (const mode of ["integrity-mismatch", "bytes-mismatch", "dependency-mismatch", "identity-mismatch", "unsafe-url", "credential-url", "fragment-url"]) {
  test(`preflight second target ${mode} blocks ALL submissions`, async (t) => {
    const f = await fixture(t); f.publicModes[1] = mode;
    const reason = mode === "unsafe-url" ? /Unexpected tarball origin/
      : ["credential-url", "fragment-url"].includes(mode) ? /Invalid tarball URL/ : undefined;
    await assert.rejects(run(f.directory, "--publish", f.options), reason);
    assert.equal(f.publishes().length, 0);
    await assert.rejects(readFile(path.join(f.directory, "submitted.json")), { code: "ENOENT" });
  });
}
test("publish journals attempted then accepted, exact flags, public readback and replay", async (t) => {
  const f = await fixture(t);
  assert.equal((await run(f.directory, "--publish", f.options)).completed, true);
  assert.equal(f.publishes().length, 2);
  for (const c of f.publishes()) assert.deepEqual(c.npm.slice(2), ["--access=public", "--ignore-scripts", "--tag=noosphere-zod-candidate", "--provenance=false", "--registry=https://registry.npmjs.org", "--loglevel=error"]);
  const journal = JSON.parse(await readFile(path.join(f.directory, "submitted.json"), "utf8"));
  assert.deepEqual(journal.submissions.map((s) => s.state), ["accepted", "accepted"]);
  await run(f.directory, "--publish", f.options);
  assert.equal(f.publishes().length, 2);
});
for (const state of ["attempted", "accepted", "unknown"]) {
  test(`recovered ${state} never resubmits on metadata 404`, async (t) => {
    const f = await fixture(t); await f.journal([{ target: 0, state }, { target: 1, state }]);
    await assert.rejects(run(f.directory, "--publish", f.options), /visibility deadline/);
    assert.equal(f.publishes().length, 0);
    const receipt = JSON.parse(await readFile(path.join(f.directory, "publication.json"), "utf8"));
    assert.equal(receipt.completed, false);
    assert.deepEqual(receipt.pending.map((p) => p.state), ["metadata-404", "metadata-404"]);
  });
}
test("unknown submission is durable and is verify-only on subsequent invocation", async (t) => {
  const f = await fixture(t); f.publicModes[1] = "visible";
  const normal = f.options.npm;
  f.options.npm = async (args) => { if (args[0] === "publish") { f.calls.push({ npm: args }); throw new Error("secret must not be serialized"); } return normal(args); };
  await assert.rejects(run(f.directory, "--publish", f.options), /visibility deadline/);
  const journal = JSON.parse(await readFile(path.join(f.directory, "submitted.json"), "utf8"));
  assert.equal(journal.submissions[0].state, "unknown");
  assert.ok(!JSON.stringify(journal).includes("secret"));
  await assert.rejects(run(f.directory, "--publish", f.options), /visibility deadline/);
  assert.equal(f.publishes().length, 1);
});
test("recovery rerun cannot replay an older journal after an unknown submission", async (t) => {
  const f = await fixture(t);
  const older = [{ target: 0, state: "accepted" }];
  await f.journal(older);
  const normal = f.options.npm;
  f.options.npm = async (args) => {
    if (args[0] === "publish") {
      f.calls.push({ npm: args });
      throw new Error("simulated unknown upload outcome");
    }
    return normal(args);
  };
  await assert.rejects(run(f.directory, "--publish", f.options), /visibility deadline/);
  const latest = JSON.parse(await readFile(path.join(f.directory, "submitted.json"), "utf8"));
  assert.equal(latest.submissions.find((s) => s.target === 1)?.state, "unknown");
  assert.equal(f.publishes().length, 1);

  // A failed-job rerun restores the original inputs, not the latest recovery journal.
  await f.journal(older);
  f.options.env.GITHUB_RUN_ATTEMPT = "2";
  const before = f.calls.length;
  let failure;
  try { await run(f.directory, "--publish", f.options); }
  catch (error) { failure = error; }
  assert.equal(f.publishes().length, 1, "rerunning recovery must not submit an unknown target again");
  assert.match(failure?.message || "", /Publication reruns are forbidden/);
  assert.deepEqual(f.calls.slice(before), [], "rerun rejection precedes npm and registry access");
});
test("publication reruns fail before npm or registry access; read-only verification stays available", async (t) => {
  const f = await fixture(t); f.options.env.GITHUB_RUN_ATTEMPT = "2";
  await assert.rejects(run(f.directory, "--publish", f.options), /Publication reruns are forbidden/);
  assert.deepEqual(f.calls, []);
  f.publicModes.fill("visible");
  await assert.rejects(run(f.directory, "--publish", f.options), /Publication reruns are forbidden/);
  assert.deepEqual(f.calls, []);
  assert.equal((await run(f.directory, "--verify", f.options)).completed, true);
  assert.equal(f.calls.filter((c) => c.npm).length, 0);
});
test("a new recovery dispatch can submit only the remaining unattempted target", async (t) => {
  const f = await fixture(t); f.publicModes[0] = "visible";
  await f.journal([{ target: 0, state: "accepted" }]);
  assert.equal((await run(f.directory, "--publish", f.options)).completed, true);
  assert.equal(f.publishes().length, 1);
  assert.equal(f.publishes()[0].npm[1], path.join(f.directory, f.artifacts[1].archive));
});
test("verify has no npm calls, records partial verification and distinguishes tarball 404", async (t) => {
  const f = await fixture(t); f.publicModes[0] = "visible"; f.publicModes[1] = "tar404";
  await assert.rejects(run(f.directory, "--verify", f.options), /visibility deadline/);
  assert.equal(f.calls.filter((c) => c.npm).length, 0);
  const receipt = JSON.parse(await readFile(path.join(f.directory, "publication.json"), "utf8"));
  assert.deepEqual(receipt.artifacts, [f.artifacts[0]]);
  assert.equal(receipt.pending[0].state, "tarball-404");
});
test("existing tarball 404 prevents submission of other target", async (t) => {
  const f = await fixture(t); f.publicModes[1] = "tar404";
  await assert.rejects(run(f.directory, "--publish", f.options), /visibility deadline/);
  assert.equal(f.publishes().length, 0);
});
test("local byte drift during preflight is rejected before journal or upload", async (t) => {
  const f = await fixture(t), normal = f.options.npm;
  f.options.npm = async (args) => {
    if (args[0] === "whoami") await writeFile(path.join(f.directory, f.artifacts[1].archive), "changed");
    return normal(args);
  };
  await assert.rejects(run(f.directory, "--publish", f.options), /SHA256/);
  assert.equal(f.publishes().length, 0);
  await assert.rejects(readFile(path.join(f.directory, "submitted.json")), { code: "ENOENT" });
});
test("malformed or wrong-commit recovered journal cannot publish", async (t) => {
  const f = await fixture(t); await f.journal([{ target: 0, state: "unknown" }]);
  const file = path.join(f.directory, "submitted.json"), journal = JSON.parse(await readFile(file, "utf8"));
  journal.commit = "b".repeat(40); await atomicJSON(file, journal);
  await assert.rejects(run(f.directory, "--publish", f.options), /Journal reviewed SHA mismatch/);
  assert.equal(f.publishes().length, 0);
});

test("workflow guard is mandatory for the run entrypoint", async (t) => {
  const f = await fixture(t); f.options.env.GITHUB_ACTOR = "other";
  await assert.rejects(run(f.directory, "--publish", f.options));
  assert.deepEqual(f.calls, []);
});
test("verify succeeds with public bytes without npm or workflow identity", async (t) => {
  const f = await fixture(t); f.publicModes.fill("visible"); f.options.env = {};
  assert.equal((await run(f.directory, "--verify", f.options)).completed, true);
  assert.equal(f.calls.filter((c) => c.npm).length, 0);
});
test("metadata and tarball propagation can recover without resubmission", async (t) => {
  const f = await fixture(t); f.publicModes[1] = "tar404";
  await f.journal([{ target: 0, state: "accepted" }, { target: 1, state: "unknown" }]);
  const sleep = f.options.sleep;
  f.options.sleep = async () => { await sleep(); f.publicModes.fill("visible"); };
  assert.equal((await run(f.directory, "--publish", f.options)).completed, true);
  assert.equal(f.publishes().length, 0);
});
test("existing publication lock blocks a competing invocation", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.directory, ".publish-lock"));
  await assert.rejects(run(f.directory, "--publish", f.options));
  assert.equal(f.publishes().length, 0);
});
