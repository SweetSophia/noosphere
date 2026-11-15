import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeServiceBlock } from "./compose-service-block.mjs";

// These regressions pin the block-extraction contract the policy check in
// check-postgres-image-policy.mjs depends on: the extracted block must cover
// exactly one service, so a cap assertion on that block cannot be satisfied
// by a different service's content.

test("the block ends at an inline-style next service header", () => {
  // A reformat that inlines the next service's mapping must still terminate
  // the block; if it does not, the block widens into the next service and a
  // cap found there satisfies the worker assertion vacuously.
  const compose = [
    "services:",
    "  hybrid-worker:",
    "    logging:",
    "      driver: json-file",
    "  db: {image: postgres:16, logging: {driver: json-file}}",
    "    cap: max-size 10m",
  ].join("\n");
  const block = composeServiceBlock(compose, "hybrid-worker");
  assert.ok(!block.includes("postgres:16"), `block leaked into the db service: ${block}`);
  assert.ok(!block.includes("max-size 10m"), `block leaked into the db service: ${block}`);
  assert.ok(block.includes("driver: json-file"));
});

test("the block ends at a commented next service header", () => {
  const compose = [
    "services:",
    "  hybrid-worker:",
    "    logging:",
    "      driver: json-file",
    "  app:  # application service",
    "    cap: max-size 10m",
  ].join("\n");
  const block = composeServiceBlock(compose, "hybrid-worker");
  assert.ok(!block.includes("application service"), `block leaked into the app service: ${block}`);
  assert.ok(!block.includes("max-size 10m"), `block leaked into the app service: ${block}`);
});

test("a missing service is reported as null, not as an empty block", () => {
  // A renamed or dropped service must be distinguishable from a present
  // service whose cap is missing: the first returns null, the second a
  // non-empty block without the cap.
  const compose = ["services:", "  db:", "    image: postgres:16"].join("\n");
  assert.equal(composeServiceBlock(compose, "hybrid-worker"), null);
});

test("the block runs to the end of the file when no next header follows", () => {
  const compose = ["services:", "  hybrid-worker:", '    max-file: "3"'].join("\n");
  assert.equal(composeServiceBlock(compose, "hybrid-worker"), '    max-file: "3"');
});

test("the service key is matched exactly, not as a shared prefix", () => {
  const compose = [
    "services:",
    "  hybrid-worker-extra:",
    "    cap: max-size 10m",
    "  hybrid-worker:",
    "    driver: json-file",
  ].join("\n");
  const block = composeServiceBlock(compose, "hybrid-worker");
  assert.ok(!block.includes("max-size 10m"), `block selected the wrong service: ${block}`);
  assert.ok(block.includes("driver: json-file"));
});

test("both repository compose templates expose a capped worker block", () => {
  for (const path of ["../docker-compose.yml", "../docker-compose.noosphere.yml"]) {
    const block = composeServiceBlock(
      readFileSync(new URL(path, import.meta.url), "utf8"),
      "hybrid-worker",
    );
    assert.ok(block, `${path} has no hybrid-worker service block`);
    assert.ok(block.includes("logging:"), `${path} worker block lacks logging:`);
    assert.ok(block.includes("driver: json-file"), `${path} worker block lacks the driver`);
    assert.ok(block.includes('max-size: "10m"'), `${path} worker block lacks max-size`);
    assert.ok(block.includes('max-file: "3"'), `${path} worker block lacks max-file`);
  }
});
