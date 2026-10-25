import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateCiReceipt } from "./ci-receipt.mjs";

const artifacts = JSON.parse(readFileSync(new URL("artifacts.json", import.meta.url), "utf8"));
const sha = "0123456789abcdef0123456789abcdef01234567";
// Snapshot of a successful local receipt; no CI, SDK, npm, or registry is run.
const successfulLocalReceipt = {
  "kind": "zod-sdk-local-qualification",
  "completed": true,
  "node": "v22.23.4",
  "npm": "12.1.0",
  "artifacts": [
    {
      "name": "@sweetsophia/noosphere-opencode-plugin",
      "version": "1.15.5-noosphere.4",
      "sha256": "a7087e63560d06df0735fa8474fcf2364b50b377fb30016eb8467066cc56a8d4",
      "integrity": "sha512-sf4voi3QyESYxVGyTFDPGeaBUB1xXshiNOYFykx7yxCSnb7JbwGiP9MLQ+7dR+XttegWu+mVSxRqVVxETmw8Ng==",
      "archive": "sweetsophia-noosphere-opencode-plugin-1.15.5-noosphere.4.tgz",
      "source": {
        "version": "1.15.5-noosphere.3",
        "sha256": "b3be7a902c22bf2e0fb0c19ac519fcbb6d1af1c4c446db0d30da7039695bce07",
        "integrity": "sha512-XNZUygmM+sN23WI9FHVkoMQQmnsnyjUMRttcAt+fvIs4K2nq9mBELc8bfNMLieLFbQEKQWeFzaM2hOYNN5cHpw=="
      },
      "effectAlias": "npm:@sweetsophia/noosphere-effect@4.0.0-beta.65-noosphere.3",
      "zod": "4.6.7",
      "manifestSha256": "c5e8447942aff8bace5d7f49dad9895b48f080888a04e758629347fc203f3f61"
    },
    {
      "name": "@sweetsophia/noosphere-kilocode-plugin",
      "version": "7.3.1-noosphere.5",
      "sha256": "3900af1ca93dffb9ca0593d8040878bd8bea60b40127edef94c5ffc064dcbbbb",
      "integrity": "sha512-fmdIIbMS3DN+hGXi7j47xFCruwA8EpnFcm8Zwib2n2o7/2r9CuxEmW7/4yqVjuwTIGDp726OboQ1vatO2ZMaOg==",
      "archive": "sweetsophia-noosphere-kilocode-plugin-7.3.1-noosphere.5.tgz",
      "source": {
        "version": "7.3.1-noosphere.4",
        "sha256": "030dca359fc9698cb71e6a11c1f8d644d4486a7c1c05c8e930e77980ea8ce239",
        "integrity": "sha512-Qcwu0jnFWcuvwgkko4s1cBH9axmi+sM8RWfzO+mZJ2RuRXuXA1SVmNgSC/JqQ88veuaq+Ubsc2omz55uMEN50g=="
      },
      "effectAlias": "npm:@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4",
      "zod": "4.6.7",
      "manifestSha256": "bce0953074c12ffb4e260f07c0591ee612261aa9eaf2f75024f36b2bc8b5ec83"
    }
  ],
  "checks": [
    {
      "name": "exact approved archive reconstruction",
      "passed": true
    },
    {
      "name": "client-ci",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "001-client-ci.log"
    },
    {
      "name": "client-test",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "002-client-test.log"
    },
    {
      "name": "client-types",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "003-client-types.log"
    },
    {
      "name": "client-build",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "004-client-build.log"
    },
    {
      "name": "opencode-noosphere-memory-fixture-lock",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "005-opencode-noosphere-memory-fixture-lock.log"
    },
    {
      "name": "opencode-noosphere-memory-ci",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "006-opencode-noosphere-memory-ci.log"
    },
    {
      "name": "opencode-noosphere-memory-test",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "007-opencode-noosphere-memory-test.log"
    },
    {
      "name": "opencode-noosphere-memory-types",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "008-opencode-noosphere-memory-types.log"
    },
    {
      "name": "opencode-noosphere-memory-build",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "009-opencode-noosphere-memory-build.log"
    },
    {
      "name": "opencode-noosphere-memory-audit",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "010-opencode-noosphere-memory-audit.log"
    },
    {
      "name": "opencode-noosphere-memory-pack",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "011-opencode-noosphere-memory-pack.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-install",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "012-opencode-noosphere-memory-consumer-install.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-reinstall",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "013-opencode-noosphere-memory-consumer-reinstall.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-tree",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "014-opencode-noosphere-memory-consumer-tree.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-audit",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "015-opencode-noosphere-memory-consumer-audit.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-runtime",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "016-opencode-noosphere-memory-consumer-runtime.log"
    },
    {
      "name": "opencode-noosphere-memory-consumer-types",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "017-opencode-noosphere-memory-consumer-types.log"
    },
    {
      "name": "wrong-sdk-revision-rejected",
      "passed": true,
      "exitCode": 1,
      "expectedFailure": true,
      "log": "018-wrong-sdk-revision-rejected.log"
    },
    {
      "name": "kilocode-noosphere-memory-fixture-lock",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "019-kilocode-noosphere-memory-fixture-lock.log"
    },
    {
      "name": "kilocode-noosphere-memory-ci",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "020-kilocode-noosphere-memory-ci.log"
    },
    {
      "name": "kilocode-noosphere-memory-test",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "021-kilocode-noosphere-memory-test.log"
    },
    {
      "name": "kilocode-noosphere-memory-types",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "022-kilocode-noosphere-memory-types.log"
    },
    {
      "name": "kilocode-noosphere-memory-build",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "023-kilocode-noosphere-memory-build.log"
    },
    {
      "name": "kilocode-noosphere-memory-audit",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "024-kilocode-noosphere-memory-audit.log"
    },
    {
      "name": "kilocode-noosphere-memory-pack",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "025-kilocode-noosphere-memory-pack.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-install",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "026-kilocode-noosphere-memory-consumer-install.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-reinstall",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "027-kilocode-noosphere-memory-consumer-reinstall.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-tree",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "028-kilocode-noosphere-memory-consumer-tree.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-audit",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "029-kilocode-noosphere-memory-consumer-audit.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-runtime",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "030-kilocode-noosphere-memory-consumer-runtime.log"
    },
    {
      "name": "kilocode-noosphere-memory-consumer-types",
      "passed": true,
      "exitCode": 0,
      "expectedFailure": false,
      "log": "031-kilocode-noosphere-memory-consumer-types.log"
    }
  ],
  "consumers": [
    {
      "adapter": "opencode-noosphere-memory",
      "runtimeCases": 12,
      "strictTypes": true,
      "zod": "4.6.7",
      "toml": "5.0.1",
      "sdk": "1.15.5-noosphere.4",
      "privateFileSdkEdge": true
    },
    {
      "adapter": "kilocode-noosphere-memory",
      "runtimeCases": 12,
      "strictTypes": true,
      "zod": "4.6.7",
      "toml": "5.0.1",
      "sdk": "7.3.1-noosphere.5",
      "privateFileSdkEdge": true
    }
  ],
  "distribution": "private-file-sdk-archives-NOT-public-registry-only-qualification"
};
const fixture = () => ({ ...structuredClone(successfulLocalReceipt), sourceCommit: sha });
const validate = (q = fixture(), expectedSha = sha, major = 22, approved = artifacts) =>
  validateCiReceipt(q, approved, expectedSha, major);
const gate = (q, name) => q.checks.find((check) => check.name === name);

for (const major of [22, 24]) test(`accepts complete Node ${major} proof without mutating inputs`, () => {
  const q = fixture(); q.node = `v${major}.23.4`;
  const before = structuredClone(q), approvedBefore = structuredClone(artifacts);
  assert.equal(validate(q, sha, major), true);
  assert.deepEqual(q, before); assert.deepEqual(artifacts, approvedBefore);
});

test("gate/consumer order and log timestamps are not evidence requirements", () => {
  const q = fixture(); q.checks.reverse(); q.consumers.reverse();
  for (const check of q.checks) { delete check.log; check.timestamp = "not immutable evidence"; }
  assert.equal(validate(q), true);
});

test("accepts a full uppercase SHA with exact source binding", () => {
  const q = fixture(); q.sourceCommit = sha.toUpperCase();
  assert.equal(validate(q, q.sourceCommit), true);
});

for (const bad of [undefined, null, "", "a".repeat(39), "g".repeat(40), "a".repeat(41), "a".repeat(40) + "\n", 22])
  test(`rejects invalid expected SHA ${String(bad)}`, () => assert.throws(() => validateCiReceipt(fixture(), artifacts, bad, 22)));
for (const bad of [undefined, "", "a".repeat(40), 123])
  test(`rejects wrong/missing source SHA ${String(bad)}`, () => {
    const q = fixture(); if (bad === undefined) delete q.sourceCommit; else q.sourceCommit = bad;
    assert.throws(() => validate(q));
  });
for (const major of [undefined, "22", 20, 26, 0])
  test(`rejects unsupported expected Node major ${String(major)}`, () =>
    assert.throws(() => validateCiReceipt(fixture(), artifacts, sha, major)));
for (const bad of [undefined, "22.23.4", "v24.1.0", "v222.1.0", "v22.", "v22.1.0\n", 22])
  test(`rejects wrong/missing Node runtime ${String(bad)}`, () => {
    const q = fixture(); q.node = bad; assert.throws(() => validate(q));
  });
for (const [name, mutate] of [
  ["missing receipt", () => null],
  ["wrong kind", (q) => { q.kind = "zod-sdk-publication"; }],
  ["incomplete", (q) => { q.completed = false; }],
  ["truthy completed", (q) => { q.completed = "true"; }],
  ["missing npm", (q) => { delete q.npm; }],
  ["wrong npm", (q) => { q.npm = "12.1.1"; }],
  ["missing artifacts", (q) => { delete q.artifacts; }],
  ["missing artifact", (q) => { q.artifacts.pop(); }],
  ["reordered artifacts", (q) => { q.artifacts.reverse(); }],
  ["changed nested source", (q) => { q.artifacts[0].source.sha256 = "0".repeat(64); }],
  ["missing full approved record", (q) => { delete q.artifacts[0].manifestSha256; }],
  ["extra artifact field", (q) => { q.artifacts[0].unapproved = true; }],
  ["changed artifact version", (q) => { q.artifacts[0].version = "wrong"; }],
  ["changed artifact integrity", (q) => { q.artifacts[1].integrity = "wrong"; }],
  ["changed artifact alias", (q) => { q.artifacts[0].effectAlias = "wrong"; }],
  ["checks missing", (q) => { delete q.checks; }],
  ["checks empty", (q) => { q.checks = []; }],
  ["checks non-array", (q) => { q.checks = {}; }],
  ["null check", (q) => { q.checks.push(null); }],
  ["unnamed check", (q) => { delete q.checks[1].name; }],
  ["duplicate check", (q) => { q.checks.push(structuredClone(q.checks[0])); }],
  ["truthy passed check", (q) => { q.checks[1].passed = "true"; }],
  ["missing passed check", (q) => { delete q.checks[1].passed; }],
  ["empty check name", (q) => { q.checks[1].name = ""; }],
  ["failed additional check", (q) => { q.checks.push({ name: "extra", passed: false, exitCode: 0, expectedFailure: false }); }],
  ["nonzero additional check", (q) => { q.checks.push({ name: "extra", passed: true, exitCode: 2, expectedFailure: false }); }],
  ["negative control zero", (q) => { gate(q, "wrong-sdk-revision-rejected").exitCode = 0; }],
  ["negative control other failure", (q) => { gate(q, "wrong-sdk-revision-rejected").exitCode = 2; }],
  ["negative control missing flag", (q) => { delete gate(q, "wrong-sdk-revision-rejected").expectedFailure; }],
  ["negative control false flag", (q) => { gate(q, "wrong-sdk-revision-rejected").expectedFailure = false; }],
  ["reconstruction exit code", (q) => { q.checks[0].exitCode = 0; }],
  ["reconstruction negative classification", (q) => { q.checks[0].expectedFailure = true; }],
  ["consumers missing", (q) => { delete q.consumers; }],
  ["consumer missing", (q) => { q.consumers.pop(); }],
  ["consumer extra", (q) => { q.consumers.push(structuredClone(q.consumers[0])); }],
  ["consumer duplicate", (q) => { q.consumers[1] = structuredClone(q.consumers[0]); }],
  ["unexpected consumer", (q) => { q.consumers[0].adapter = "unknown"; }],
  ["null consumer", (q) => { q.consumers[0] = null; }],
  ["public distribution", (q) => { q.distribution = "public-registry-only-qualification"; }],
  ["missing distribution", (q) => { delete q.distribution; }],
]) test(`rejects ${name}`, () => {
  let q = fixture(); const replacement = mutate(q); if (replacement === null) q = null;
  assert.throws(() => validate(q));
});

// Every recorded gate is independently mandatory and must report actual success.
for (const check of successfulLocalReceipt.checks) {
  test(`rejects omitted gate: ${check.name}`, () => {
    const q = fixture(); q.checks = q.checks.filter((c) => c.name !== check.name);
    assert.throws(() => validate(q));
  });
  test(`rejects failed gate: ${check.name}`, () => {
    const q = fixture(); gate(q, check.name).passed = false; assert.throws(() => validate(q));
  });
  if (check.exitCode === 0) for (const [field, value] of [["exitCode", 1], ["exitCode", "0"], ["exitCode", undefined], ["expectedFailure", true], ["expectedFailure", undefined]])
    test(`rejects ${check.name} ${field}=${String(value)}`, () => {
      const q = fixture(); gate(q, check.name)[field] = value; assert.throws(() => validate(q));
    });
}
for (const index of [0, 1]) for (const [field, value] of [["sdk", "wrong"], ["zod", "4.6.6"], ["toml", "4.0.0"],
  ["runtimeCases", 11], ["runtimeCases", "12"], ["strictTypes", false], ["privateFileSdkEdge", false]]) {
  test(`rejects consumer ${index} wrong ${field}`, () => {
    const q = fixture(); q.consumers[index][field] = value; assert.throws(() => validate(q));
  });
  test(`rejects consumer ${index} missing ${field}`, () => {
    const q = fixture(); delete q.consumers[index][field]; assert.throws(() => validate(q));
  });
}

test("CLI fails closed without echoing credential-like arguments", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("ci-receipt.mjs", import.meta.url)), "credential-like-argument"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, "SDK CI receipt verification failed.\n");
});
