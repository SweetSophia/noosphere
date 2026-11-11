import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
for (const job of ["publish_helper", "publish_openclaw", "publish_opencode", "publish_kilocode", "publish_mcp"]) {
  test(`${job} publishes a packed artifact through exact-integrity readback`, () => {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_]+:\n/)[0];
    assert.ok(block);
    const code = block.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.match(code, /npm pack --json|pack-adapter\.mjs/);
    assert.match(code, /LOCAL_INTEGRITY: \$\{\{ steps.pack.outputs.integrity \}\}/);
    assert.match(code, /TARBALL: \$\{\{ steps.pack.outputs.filename \}\}/);
    assert.match(code, /bash "\$GITHUB_WORKSPACE\/scripts\/publish-npm-artifact.sh" \\\n\s+"\$TARBALL" "\$\{package\}@\$\{version\}" "\$LOCAL_INTEGRITY"/);
    assert.doesNotMatch(code, /npm publish/);
  });
}
