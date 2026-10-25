import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { approvedKatexRanges, katexOverrideFailures } from "./katex-override-policy.mjs";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
test("the deliberately forced, qualified KaTeX graph passes", () => { assert.deepEqual(katexOverrideFailures(manifest, lock), []); });
for (const parent of Object.keys(approvedKatexRanges)) {
  test(`${parent}: changed declared range requires re-qualification even if it admits the forced version`, () => {
    const changed = structuredClone(lock); changed.packages[`node_modules/${parent}`].dependencies.katex = "^0.18.2";
    assert.ok(katexOverrideFailures(manifest, changed).some(error => error.includes(parent) && error.includes("re-qualify")));
  });
}
test("a new direct pin, removed override or stale nested copy fails closed", () => {
  const changed = structuredClone(manifest); changed.dependencies.katex = "^0.18.2"; delete changed.overrides.mermaid;
  const stale = structuredClone(lock); stale.packages["node_modules/mermaid/node_modules/katex"] = { version: "0.16.47" };
  const errors = katexOverrideFailures(changed, stale);
  assert.ok(errors.some(error => error.includes("exact qualified pin")));
  assert.ok(errors.some(error => error.includes("mermaid") && error.includes("override")));
  assert.ok(errors.some(error => error.includes("node_modules/mermaid/node_modules/katex")));
});
test("a missing root resolution is not a vacuous pass", () => {
  const changed = structuredClone(lock); delete changed.packages["node_modules/katex"];
  assert.ok(katexOverrideFailures(manifest, changed).some(error => error.includes("missing")));
});
