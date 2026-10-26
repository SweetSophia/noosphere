import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindLocalSdkFixture } from "./consumer-fixture.mjs";

const approved = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url)));
for (const [index, adapter] of ["opencode-noosphere-memory", "kilocode-noosphere-memory"].entries()) {
  const artifact = approved[index];
  const source = readFileSync(new URL(`../toml5-candidate/consumer-fixtures/${adapter}/consumer.test.mjs`, import.meta.url), "utf8");
  const edge = `file:/fixture/${artifact.archive}`;
  const bound = bindLocalSdkFixture(source, artifact, edge);
  const versionAssertion = ' assert.equal(parent.version, declaredVersion);';
  assert.ok(source.includes(versionAssertion));
  // Execute the actual generated binding plus the retained shared version check.
  const verify = new Function("assert", "declaredPlugin", "parent", "pluginRequire", bound.replacement + "\n" + versionAssertion);
  const parent = { name: artifact.name, version: artifact.version, dependencies: { zod: artifact.zod, effect: artifact.effectAlias } };
  const run = (sdk = parent, actualEdge = edge, zod = artifact.zod) => verify(assert, actualEdge, sdk, () => ({ version: zod }));

  test(`${adapter}: the exact private archive and SDK graph pass`, () => { run(); });
  test(`${adapter}: all shared assertions outside the two alias-declaration lines remain byte-identical`, () => {
    const original = source.match(/ assert\.match\(declaredPlugin,[^\n]*\n const declaredVersion=[^\n]*/)?.[0];
    assert.ok(original);
    assert.equal(bound.text.replace(bound.replacement, original), source);
    assert.equal(bound.text.split(bound.versionBinding).length, 2);
    assert.ok(bound.text.includes(versionAssertion));
  });
  for (const [name, change] of [
    ["wrong revision", sdk => { sdk.version = artifact.source.version; }],
    ["wrong package", sdk => { sdk.name = "@fixture/wrong"; }],
    ["wrong Effect edge", sdk => { sdk.dependencies.effect = "npm:@fixture/effect@0.0.0"; }],
    ["ranged Zod declaration", sdk => { sdk.dependencies.zod = "^4.6.7"; }],
  ]) {
    test(`${adapter}: ${name} fails the real oracle`, () => {
      const changed = structuredClone(parent); change(changed);
      assert.throws(() => run(changed), { code: "ERR_ASSERTION" });
    });
  }
  test(`${adapter}: wrong file edge, public alias, and stale installed Zod fail`, () => {
    assert.throws(() => run(parent, "file:/fixture/wrong.tgz"), { code: "ERR_ASSERTION" });
    assert.throws(() => run(parent, `npm:${artifact.name}@${artifact.version}`), { code: "ERR_ASSERTION" });
    assert.throws(() => run(parent, edge, "4.1.8"), { code: "ERR_ASSERTION" });
  });
  test(`${adapter}: the wrong-revision control fails at the retained version assertion`, () => {
    const wrong = new Function("assert", "declaredPlugin", "parent", "pluginRequire",
      bound.replacement.replace(bound.versionBinding, ` const declaredVersion=${JSON.stringify(artifact.source.version)};`) + "\n" + versionAssertion);
    assert.throws(() => wrong(assert, edge, parent, () => ({ version: artifact.zod })), { code: "ERR_ASSERTION" });
  });
  test(`${adapter}: missing or duplicated binding targets fail closed`, () => {
    assert.throws(() => bindLocalSdkFixture("no oracle", artifact, edge), /oracle drift/);
    assert.throws(() => bindLocalSdkFixture(source + source, artifact, edge), /oracle drift/);
    assert.throws(() => bindLocalSdkFixture(source, artifact, "npm:wrong"), /private archive edge/);
  });
}
