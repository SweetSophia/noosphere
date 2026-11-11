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
    const output = execFileSync("bash", ["-c", command], { cwd: directory, encoding: "utf8", env: { ...process.env, npm_config_foreground_scripts: "true" } });
    const receipt = JSON.parse(output);
    assert.match((Array.isArray(receipt) ? receipt[0] : Object.values(receipt)[0]).integrity, /^sha512-/);
    assert.ok(!output.includes("lifecycle-stdout-sentinel"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
