import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { minimatchOverrideFailures } from "./minimatch-override-policy.mjs";
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url)));

test("a changed parent range or resolved pin requires deliberate requalification", () => {
  assert.deepEqual(minimatchOverrideFailures(manifest, lock), []);
  const changed = structuredClone(lock);
  changed.packages["node_modules/@typescript-eslint/typescript-estree"].dependencies.minimatch = "^11.0.0";
  assert.match(minimatchOverrideFailures(manifest, changed).join(" "), /declared minimatch range changed/);
  const missing = structuredClone(lock);
  delete missing.packages["node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"];
  assert.match(minimatchOverrideFailures(manifest, missing).join(" "), /qualified patched minimatch/);
  const wrong = structuredClone(manifest);
  wrong.overrides["@typescript-eslint/typescript-estree"].minimatch = "10.2.5";
  assert.match(minimatchOverrideFailures(wrong, lock).join(" "), /pin changed/);
});

const nested = "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch";
for (const [entry, version] of [[nested, "10.2.2"], ["node_modules/@scope/pkg/node_modules/minimatch", "10.0.1"], ["node_modules/new-consumer/node_modules/minimatch", "9.0.5"], ["node_modules/minimatch", "7.0.0"]]) {
  test(`rejects unqualified resolution ${entry}@${version} with actionable diagnostics`, () => {
    const changed = structuredClone(lock);
    changed.packages[entry] = { version };
    const errors = minimatchOverrideFailures(manifest, changed).join(" ");
    assert.ok(errors.includes(entry), errors);
    assert.ok(errors.includes(version), errors);
  });
}
test("rejects an unparseable minimatch resolution", () => {
  const changed = structuredClone(lock);
  changed.packages["node_modules/minimatch"].version = "not-a-version";
  assert.match(minimatchOverrideFailures(manifest, changed).join(" "), /node_modules\/minimatch.*not-a-version/);
});

test("null lock metadata produces a policy diagnostic, not a TypeError", () => {
  const changed = structuredClone(lock);
  changed.packages["node_modules/minimatch"] = null;
  assert.match(minimatchOverrideFailures(manifest, changed).join(" "), /node_modules\/minimatch.*undefined/);
});
test("type declarations are not minimatch runtime copies", () => {
  const changed = structuredClone(lock);
  changed.packages["node_modules/@types/minimatch"] = { version: "6.0.0" };
  assert.deepEqual(minimatchOverrideFailures(manifest, changed), []);
});
