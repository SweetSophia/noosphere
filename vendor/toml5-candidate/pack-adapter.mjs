// Pack an already-built adapter without changing its source manifest or publishing.
// Usage: node pack-adapter.mjs /absolute/adapter/source /absolute/output/directory
import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const [sourceArgument, outputArgument] = process.argv.slice(2);
assert.ok(sourceArgument && path.isAbsolute(sourceArgument), "Provide an absolute adapter source directory");
assert.ok(outputArgument && path.isAbsolute(outputArgument), "Provide an absolute output directory");
const source = await fs.realpath(sourceArgument);
assert.ok(outputArgument !== source && !outputArgument.startsWith(`${source}${path.sep}`), "Output must be outside the adapter source directory");
await fs.mkdir(outputArgument, { recursive: true });
const output = await fs.realpath(outputArgument);
assert.ok(output !== source && !output.startsWith(`${source}${path.sep}`), "Output must be outside the adapter source directory");
const temporary = await fs.mkdtemp(path.join(output, ".pack-adapter-"));
const stage = path.join(temporary, "adapter");
const npm = await fs.realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const clientName = "@sweetsophia/noosphere-client";
const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
assert.ok([
  "@sweetsophia/opencode-noosphere-memory",
  "@sweetsophia/kilocode-noosphere-memory",
].includes(manifest.name), "Only the two TOML candidate adapters are supported");
assert.match(manifest.dependencies?.[clientName] ?? "", /^file:/, "Keep the source client dependency local");
assert.deepEqual(manifest.bundledDependencies, [clientName], "Unexpected bundled dependency set");
assert.ok(Array.isArray(manifest.files), "Adapter must declare its shipped files");

async function command(binary, args, cwd) {
  try {
    return (await execFile(binary, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`${binary} ${args.join(" ")} failed:\n${error.stderr || error.message}`, { cause: error });
  }
}
async function npmPack(directory, destination) {
  const result = JSON.parse(await command(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], directory));
  const receipt = Array.isArray(result) ? result[0] : Object.values(result)[0];
  assert.equal(typeof receipt?.filename, "string", "Unexpected npm pack result");
  assert.equal(path.basename(receipt.filename), receipt.filename, "Unexpected archive filename");
  return receipt;
}
const forbidden = (name) => name === "node_modules" || name === ".git" || name === ".env" || name.startsWith(".env.");
async function copyShipped(from, to) {
  if (forbidden(path.basename(from))) return;
  const stat = await fs.lstat(from);
  assert.ok(!stat.isSymbolicLink(), `Shipped adapter path must not be a symlink: ${from}`);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(from)) await copyShipped(path.join(from, name), path.join(to, name));
  } else {
    assert.ok(stat.isFile(), `Unsupported adapter file: ${from}`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}
await fs.mkdir(stage);
for (const entry of manifest.files) {
  assert.equal(typeof entry, "string");
  const relative = entry.replace(/^\.\//, "").replace(/\/$/, "");
  assert.ok(relative && relative !== "." && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes("..") && !/[?*\[\]{}!]/.test(relative), `Expected an explicit shipped path: ${entry}`);
  await copyShipped(path.join(source, relative), path.join(stage, relative));
}
// npm's standard root readme/license metadata, plus the repository's NOTICE.
for (const name of await fs.readdir(source)) {
  if (/^(?:readme|licen[cs]e|copying|notice|authors)(?:\..*)?$/i.test(name)) {
    await copyShipped(path.join(source, name), path.join(stage, name));
  }
}

const installedClient = await fs.realpath(path.join(source, "node_modules", clientName));
const clientManifest = JSON.parse(await fs.readFile(path.join(installedClient, "package.json"), "utf8"));
assert.equal(clientManifest.name, clientName);
assert.equal(typeof clientManifest.version, "string");
assert.match(clientManifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
// npm decides the client's publishable members; never recursively copy its tree.
const clientReceipt = await npmPack(installedClient, temporary);
const clientArchive = path.join(temporary, clientReceipt.filename);
const members = (await command("tar", ["-tzf", clientArchive], temporary)).trim().split("\n");
assert.ok(members.includes("package/package.json"));
for (const member of members) {
  const parts = member.split("/");
  assert.ok(member.startsWith("package/") && !parts.includes("..") && !parts.some(forbidden), `Unsafe or developer-only client member: ${member}`);
}
const details = await command("tar", ["-tvzf", clientArchive], temporary);
assert.ok(details.trim().split("\n").every((line) => /^[d-]/.test(line)), "Client archive must contain only directories and regular files");
const bundled = path.join(stage, "node_modules", clientName);
await fs.mkdir(bundled, { recursive: true });
await command("tar", ["-xzf", clientArchive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", bundled], temporary);
manifest.dependencies[clientName] = clientManifest.version;
await fs.writeFile(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const receipt = await npmPack(stage, temporary);
assert.ok(receipt.bundled?.includes(clientName), "Adapter archive must contain the private client");
const archive = path.join(output, receipt.filename);
await fs.copyFile(path.join(temporary, receipt.filename), archive, constants.COPYFILE_EXCL);
console.log(JSON.stringify({ ...receipt, archive, client: { name: clientName, version: clientManifest.version, integrity: clientReceipt.integrity } }, null, 2));
