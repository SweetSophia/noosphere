// Verifies local-archive CI evidence only, never public-registry qualification.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reconstruction = "exact approved archive reconstruction";
const negative = "wrong-sdk-revision-rejected";
const adapters = ["opencode-noosphere-memory", "kilocode-noosphere-memory"];
export const requiredChecks = [reconstruction, ...["ci", "test", "types", "build"].map((gate) => `client-${gate}`),
  ...adapters.flatMap((adapter) => ["fixture-lock", "ci", "test", "types", "build", "audit", "pack",
    "consumer-install", "consumer-reinstall", "consumer-tree", "consumer-audit", "consumer-runtime", "consumer-types"]
    .map((gate) => `${adapter}-${gate}`)), negative];

// Throws on invalid evidence; does not mutate inputs, perform I/O, or execute SDK code.
export function validateCiReceipt(q, artifacts, expectedSha, expectedNodeMajor) {
  assert.equal(typeof expectedSha, "string", "Expected reviewed SHA required");
  assert.match(expectedSha, /^[a-fA-F0-9]{40}$/, "Expected full reviewed SHA required");
  assert.ok([22, 24].includes(expectedNodeMajor), "Expected Node major must be 22 or 24");
  assert.ok(q && typeof q === "object", "Qualification required");
  assert.equal(q.sourceCommit, expectedSha, "Qualification source commit differs");
  assert.equal(q.kind, "zod-sdk-local-qualification");
  assert.equal(q.completed, true);
  assert.ok(Array.isArray(artifacts) && artifacts.length === 2, "Two approved artifacts required");
  assert.deepEqual(q.artifacts, artifacts, "Qualification artifacts differ");
  assert.equal(typeof q.node, "string", "Node version required");
  assert.match(q.node, new RegExp(`^v${expectedNodeMajor}\\.[0-9]+\\.[0-9]+$`), "Qualification Node version differs");
  assert.equal(q.npm, "12.1.0", "Qualification npm version differs");
  assert.equal(q.distribution, "private-file-sdk-archives-NOT-public-registry-only-qualification", "Private-file classification required");

  assert.ok(Array.isArray(q.checks), "Qualification checks required");
  const seen = new Set();
  for (const check of q.checks) {
    assert.ok(check && typeof check.name === "string" && check.name.length > 0, "Named check required");
    assert.ok(!seen.has(check.name), "Duplicate check");
    seen.add(check.name);
    assert.equal(check.passed, true, "Qualification check failed");
    if (check.name === reconstruction) {
      assert.equal(Object.hasOwn(check, "exitCode"), false, "Reconstruction does not have an exit code");
      assert.ok(!Object.hasOwn(check, "expectedFailure") || check.expectedFailure === false, "Reconstruction cannot be an expected failure");
    } else {
      assert.equal(check.exitCode, check.name === negative ? 1 : 0, "Qualification exit code differs");
      assert.equal(check.expectedFailure, check.name === negative, "Expected-failure classification differs");
    }
  }
  assert.ok(requiredChecks.every((name) => seen.has(name)), "Mandatory qualification check missing");

  assert.ok(Array.isArray(q.consumers) && q.consumers.length === 2, "Exactly two consumers required");
  const consumers = new Map();
  for (const consumer of q.consumers) {
    assert.ok(consumer && adapters.includes(consumer.adapter), "Unexpected consumer");
    assert.ok(!consumers.has(consumer.adapter), "Duplicate consumer");
    consumers.set(consumer.adapter, consumer);
  }
  adapters.forEach((adapter, index) => {
    assert.deepEqual(consumers.get(adapter), { adapter, runtimeCases: 12, strictTypes: true, zod: "4.6.7",
      toml: "5.0.1", sdk: artifacts[index].version, privateFileSdkEdge: true }, "Consumer evidence differs");
  });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 5);
    assert.ok(path.isAbsolute(process.argv[2] || ""));
    assert.ok(["22", "24"].includes(process.argv[4]));
    const artifacts = JSON.parse(await readFile(new URL("artifacts.json", import.meta.url), "utf8"));
    const q = JSON.parse(await readFile(process.argv[2], "utf8"));
    validateCiReceipt(q, artifacts, process.argv[3], Number(process.argv[4]));
    console.log("SDK CI receipt verified (private-file qualification only).");
  } catch {
    // Never echo untrusted receipt fields, paths, arguments, or exception text.
    console.error("SDK CI receipt verification failed.");
    process.exitCode = 1;
  }
}
