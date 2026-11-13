import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import fs from "node:fs";
import { qualifiedMinimatchVersion } from "./minimatch-override-policy.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));

// Test-only resolution through the actual consumer: a separate root minimatch
// dependency could hide a vulnerable nested copy and would prove nothing.
const require = createRequire(import.meta.url);
const consumerRequire = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const minimatch = consumerRequire("minimatch");

test("TypeScript-ESLint resolves the patched minimatch, not an unrelated root copy", () => {
  assert.equal(consumerRequire("minimatch/package.json").version,
    manifest.overrides["@typescript-eslint/typescript-estree"].minimatch,
    "consumer resolution must match the qualified manifest override");
  assert.equal(manifest.overrides["@typescript-eslint/typescript-estree"].minimatch, qualifiedMinimatchVersion);
});

test("patched matcher preserves ordinary lint project inclusion and exclusion", () => {
  for (const [file, pattern, options, expected] of [
    ["src/lib/example.ts", "src/**/*.ts", {}, true],
    ["src/lib/example.js", "src/**/*.ts", {}, false],
    ["src/.generated/example.ts", "src/**/*.ts", { dot: true }, true],
    ["SRC/example.ts", "src/**/*.ts", { nocase: true }, true],
    ["packages/wiki/tsconfig.json", "**/tsconfig.json", {}, true],
  ]) {
    assert.equal(minimatch.minimatch(file, pattern, options), expected);
    assert.equal(new minimatch.Minimatch(pattern, options).match(file), expected);
  }
  assert.deepEqual(minimatch.match(["a.ts", "b.js"], "*.ts"), ["a.ts"]);
});
