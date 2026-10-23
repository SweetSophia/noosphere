// Local SDK archive compatibility only: never claim public-registry distribution.
import assert from "node:assert/strict";
import { execFile as callback, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { approved, reconstruct } from "./reconstruct.mjs";
const execFile = promisify(callback);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const output = process.argv[2];
assert.equal(process.argv.length, 3, "Provide exactly one new absolute output directory");
assert.ok(path.isAbsolute(output || ""));
assert.ok([22, 24].includes(Number(process.versions.node.split(".")[0])), "Qualify on Node 22 or 24");
const reconstruction = await reconstruct(output);
const npm = await fs.realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const checks = [{ name: "exact approved archive reconstruction", passed: true }];
const qualification = { kind: "zod-sdk-local-qualification", completed: false, node: process.version,
  sourceCommit: process.env.GITHUB_SHA || null,
  npm: reconstruction.npm, artifacts: approved, checks, consumers: [],
  distribution: "private-file-sdk-archives-NOT-public-registry-only-qualification" };
const env = { ...process.env };
for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[key];
let sequence = 0;
async function run(binary, args, cwd, name, expectedFailure = false) {
  const log = path.join(output, `${String(++sequence).padStart(3, "0")}-${name}.log`);
  let result, failure;
  try { result = await execFile(binary, args, { cwd, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { failure = error; result = error; }
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  await fs.writeFile(log, text);
  const code = failure ? failure.code : 0;
  const passed = expectedFailure ? typeof code === "number" && code !== 0 && /^# fail 1$/m.test(text) && /^# skipped 0$/m.test(text) : !failure;
  checks.push({ name, passed, exitCode: code, expectedFailure, log: path.basename(log) });
  assert.ok(passed, `${name} failed; see ${log}`);
  console.log(`PASS ${name}`);
  return text;
}
const npmRun = (args, cwd, name) => run(process.execPath, [npm, ...args], cwd, name);
const install = ["--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"];
const safeCopy = { recursive: true, filter: (p) => !p.split(path.sep).some((part) => part === "node_modules" || part === ".git" || part === ".env" || part.startsWith(".env.")) };
try {
  await fs.copyFile(path.join(repo, "tsconfig.json"), path.join(output, "tsconfig.json"));
  const client = path.join(output, "noosphere-client");
  await fs.cp(path.join(repo, "noosphere-client"), client, safeCopy);
  for (const [name, args] of [["ci", ["ci", ...install]], ["test", ["test"]], ["types", ["run", "typecheck"]], ["build", ["run", "build"]]])
    await npmRun(args, client, `client-${name}`);
  for (const [index, adapter] of ["opencode-noosphere-memory", "kilocode-noosphere-memory"].entries()) {
    const artifact = approved[index];
    const plugin = index === 0 ? "@opencode-ai/plugin" : "@kilocode/plugin";
    const builder = path.join(output, adapter);
    await fs.cp(path.join(repo, adapter), builder, safeCopy);
    const manifest = JSON.parse(await fs.readFile(path.join(builder, "package.json"), "utf8"));
    assert.equal(manifest.dependencies["@sweetsophia/noosphere-client"], "file:../noosphere-client");
    // This private fixture edge is deliberately not a portable published graph.
    manifest.dependencies[plugin] = `file:${path.join(output, artifact.archive)}`;
    await fs.writeFile(path.join(builder, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await npmRun(["install", "--package-lock-only", ...install], builder, `${adapter}-fixture-lock`);
    for (const [name, args] of [["ci", ["ci", ...install]], ["test", ["test"]], ["types", ["run", "typecheck"]], ["build", ["run", "build"]], ["audit", ["audit", "--audit-level=low", "--registry=https://registry.npmjs.org"]]])
      await npmRun(args, builder, `${adapter}-${name}`);
    const archiveDirectory = path.join(output, `packed-${index}`);
    const receipt = JSON.parse(await run(process.execPath, [path.join(repo, "vendor/toml5-candidate/pack-adapter.mjs"), builder, archiveDirectory], output, `${adapter}-pack`));
    const consumer = path.join(output, `consumer-${index}`);
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies: { [manifest.name]: `file:${receipt.archive}` }, devDependencies: { typescript: "5.9.3", "@types/node": "22.19.7" } }, null, 2)}\n`);
    await fs.cp(path.join(repo, "vendor/toml5-candidate/consumer-fixtures", adapter), consumer, { recursive: true });
    await fs.copyFile(path.join(repo, "vendor/toml5-candidate/consumer-fixtures/toml-boundaries.test.mjs"), path.join(consumer, "toml-boundaries.test.mjs"));
    const fixture = path.join(consumer, "consumer.test.mjs");
    let text = await fs.readFile(fixture, "utf8");
    const old = ` assert.ok(parent.version.endsWith("-noosphere.${index === 0 ? 3 : 4}"));`;
    assert.equal(text.split(old).length, 2, "SDK fixture oracle drift");
    const exact = ` assert.equal(parent.version, ${JSON.stringify(artifact.version)});`;
    text = text.replace(old, [
      ` assert.equal(parent.name, ${JSON.stringify(artifact.name)});`, exact,
      ' assert.equal(parent.dependencies.zod, "4.6.7");',
      ' assert.equal(pluginRequire("zod/package.json").version, "4.6.7");',
      ` assert.equal(parent.dependencies.effect, ${JSON.stringify(artifact.effectAlias)});`,
    ].join("\n")).replace("installed aliases use declared fork edges without overrides or builder references", "local SDK retains exact identity and unchanged Effect/TOML edges without overrides");
    await fs.writeFile(fixture, text);
    await npmRun(["install", ...install], consumer, `${adapter}-consumer-install`);
    await npmRun(["ci", ...install], consumer, `${adapter}-consumer-reinstall`);
    await npmRun(["ls", "--all"], consumer, `${adapter}-consumer-tree`);
    await npmRun(["audit", "--audit-level=low", "--registry=https://registry.npmjs.org"], consumer, `${adapter}-consumer-audit`);
    const lock = JSON.parse(await fs.readFile(path.join(consumer, "package-lock.json"), "utf8"));
    for (const [name, version] of [["zod", "4.6.7"], ["toml", "5.0.1"]]) {
      const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith(`node_modules/${name}`));
      assert.ok(entries.length > 0);
      assert.ok(entries.every(([, value]) => value.version === version), `Unexpected installed ${name}`);
    }
    const runtime = await run(process.execPath, ["--test", "--test-reporter=tap", "consumer.test.mjs", "toml-boundaries.test.mjs"], consumer, `${adapter}-consumer-runtime`);
    assert.match(runtime, /^# pass 12$/m); assert.match(runtime, /^# fail 0$/m); assert.match(runtime, /^# skipped 0$/m);
    await run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--skipLibCheck", "false", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"], consumer, `${adapter}-consumer-types`);
    if (index === 0) {
      await fs.writeFile(path.join(consumer, "wrong-sdk.test.mjs"), text.replace(exact, ' assert.equal(parent.version, "1.15.5-noosphere.3");'));
      await run(process.execPath, ["--test", "--test-reporter=tap", "wrong-sdk.test.mjs"], consumer, "wrong-sdk-revision-rejected", true);
    }
    qualification.consumers.push({ adapter, runtimeCases: 12, strictTypes: true, zod: "4.6.7", toml: "5.0.1", sdk: artifact.version, privateFileSdkEdge: true });
  }
  qualification.completed = true;
} finally {
  await fs.writeFile(path.join(output, "qualification.json"), `${JSON.stringify(qualification, null, 2)}\n`);
}
console.log(`Qualified local SDK prototypes on ${process.version}; PUBLIC distribution remains separately gated.`);
