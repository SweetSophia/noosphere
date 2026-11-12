import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const workflow = fs.readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
for (const job of ["publish_helper", "publish_openclaw", "publish_opencode", "publish_kilocode", "publish_mcp"]) {
  test(`${job} publishes a packed artifact through exact-integrity readback`, () => {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0];
    assert.ok(block);
    const code = block.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.match(code, /npm pack --json|pack-adapter\.mjs/);
    if (/npm pack --json/.test(code)) {
      assert.match(code, /npm pack --json --ignore-scripts/, "already-built artifacts must not contaminate JSON with lifecycle stdout");
    }
    assert.match(code, /LOCAL_INTEGRITY: \$\{\{ steps.pack.outputs.integrity \}\}/);
    assert.match(code, /TARBALL: \$\{\{ steps.pack.outputs.filename \}\}/);
    assert.match(code, /bash "\$GITHUB_WORKSPACE\/scripts\/publish-npm-artifact.sh" \\\n\s+"\$TARBALL" "\$\{package\}@\$\{version\}" "\$LOCAL_INTEGRITY"/);
    assert.doesNotMatch(code, /npm publish/);
  });
}

test("pack receipts stay parseable despite a stdout-writing prepack hook", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noosphere-pack-receipt-"));
  try {
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      name: "noosphere-pack-receipt-fixture", version: "0.0.0",
      scripts: { prepack: "node -e \"console.log('lifecycle-stdout-sentinel')\"" },
    }));
    const job = workflow.split("\n  publish_openclaw:\n")[1]?.split(/\n  [a-z_]+:\n/)[0];
    const command = job.match(/npm pack --json[^>\n]*/)?.[0]?.trim();
    assert.ok(command);
    const contaminated = execFileSync("bash", ["-c", command.replace(" --ignore-scripts", "")], { cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_foreground_scripts: "true" } });
    assert.ok(contaminated.includes("lifecycle-stdout-sentinel"));
    assert.throws(() => JSON.parse(contaminated), SyntaxError, "negative control must reproduce lifecycle stdout corrupting the receipt");
    const output = execFileSync("bash", ["-c", command], { cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_foreground_scripts: "true" } });
    const receipt = JSON.parse(output);
    assert.match((Array.isArray(receipt) ? receipt[0] : Object.values(receipt)[0]).integrity, /^sha512-/);
    assert.ok(!output.includes("lifecycle-stdout-sentinel"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const job of ["publish_helper", "publish_openclaw", "publish_mcp"]) {
  test(`${job} parses both array and keyed-object npm receipts`, () => {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noosphere-receipt-shape-"));
    try {
      const record = { filename: "fixture.tgz", integrity: "sha512-fixture" };
      for (const shape of [[record], { "fixture.tgz": record }]) {
        const file = path.join(directory, "receipt.json");
        fs.writeFileSync(file, JSON.stringify(shape));
        for (const key of ["filename", "integrity"]) {
          const expression = block.match(new RegExp(`${key}=\\$\\(node -e '([^']+)'`))?.[1];
          assert.ok(expression, `${job} ${key} parser exists`);
          assert.equal(execFileSync(process.execPath, ["-e", expression, file], { encoding: "utf8" }), record[key]);
        }
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test("the release workflow runs the complete publication contract in package-check", () => {
  const block = workflow.split("\n  package-check:\n")[1]?.split(/\n  [a-z_]+:\n/)[0];
  assert.match(block, /run: npm run npm-publish:check/);
});

// Exercise the actual tag-time policy against each drift, not a second copy of
// its predicate. Symlink unchanged inputs; only the policy and workflow are local.
test("tag-time policy rejects bypassing any of the five publishers", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noosphere-publication-policy-"));
  try {
    for (const name of fs.readdirSync(root)) {
      if (!["scripts", ".github"].includes(name)) fs.symlinkSync(path.join(root, name), path.join(directory, name));
    }
    fs.mkdirSync(path.join(directory, "scripts"));
    for (const name of fs.readdirSync(path.join(root, "scripts"))) {
      if (name !== "check-package-policies.mjs") fs.symlinkSync(path.join(root, "scripts", name), path.join(directory, "scripts", name));
    }
    fs.copyFileSync(path.join(root, "scripts/check-package-policies.mjs"), path.join(directory, "scripts/check-package-policies.mjs"));
    fs.mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
    for (const name of fs.readdirSync(path.join(root, ".github/workflows"))) {
      if (name !== "npm-publish.yml") fs.symlinkSync(path.join(root, ".github/workflows", name), path.join(directory, ".github/workflows", name));
    }
    const workflowPath = path.join(directory, ".github/workflows/npm-publish.yml");
    const policyPath = path.join(directory, "scripts/check-package-policies.mjs");
    fs.writeFileSync(workflowPath, workflow);
    execFileSync(process.execPath, [policyPath], { stdio: "pipe" });
    for (const job of ["publish_helper", "publish_openclaw", "publish_opencode", "publish_kilocode", "publish_mcp"]) {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      const endOffset = workflow.slice(start + 1).search(/\n  [a-z_]+:\n/);
      const end = endOffset < 0 ? workflow.length : start + 1 + endOffset;
      const block = workflow.slice(start, end).replace('bash "$GITHUB_WORKSPACE/scripts/publish-npm-artifact.sh"', 'npm publish');
      fs.writeFileSync(workflowPath, workflow.slice(0, start) + block + workflow.slice(end));
      assert.throws(() => execFileSync(process.execPath, [policyPath], { stdio: "pipe" }), `${job} must not bypass shared publisher`);
    }
    fs.writeFileSync(workflowPath, workflow + "\n  bypass:\n    steps:\n      - run: npm publish fixture.tgz\n");
    assert.throws(() => execFileSync(process.execPath, [policyPath], { stdio: "pipe" }), "a newly added job must not publish directly");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
