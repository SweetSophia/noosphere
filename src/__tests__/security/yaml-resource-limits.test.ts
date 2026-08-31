import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";

function buildMergeChain(levels: number): string {
  const lines = ["m0: &m0 { k0: 0 }"];

  for (let index = 1; index < levels; index += 1) {
    lines.push(
      `m${index}: &m${index}`,
      `  <<: *m${index - 1}`,
      `  k${index}: ${index}`,
    );
  }

  return lines.join("\n");
}

test("js-yaml bounds total work for chained merge keys", () => {
  assert.throws(
    () => yaml.load(buildMergeChain(160)),
    (error: unknown) => {
      assert.ok(error instanceof yaml.YAMLException);
      assert.match(error.message, /merge keys exceeded maxTotalMergeKeys/);
      return true;
    },
  );
});
