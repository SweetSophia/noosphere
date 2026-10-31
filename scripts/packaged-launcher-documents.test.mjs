import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = resolve(root, "scripts/check-postgres-image-policy.mjs");
const option = "--packaged-launcher-documents-root";
function check(args, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, policy, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

for (const args of [[option], [option, "--verify-remote"], [option, ""]]) {
  test(`rejects missing document-root value: ${JSON.stringify(args)}`, () => {
    const result = check(args);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /requires a directory argument/);
    assert.doesNotMatch(result.output, /TypeError|ERR_INVALID_ARG_TYPE|\n\s+at /);
  });
}

test("missing fixture documents are policy failures, not uncaught exceptions", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "noosphere-documents-"));
  try {
    const result = check([option, fixture]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Failed to read README\.md/);
    assert.match(result.output, /Failed to read docs\/INSTALLATION\.md/);
    assert.doesNotMatch(result.output, /\n\s+at /);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("fixture override is scoped to packaged-launcher assertions", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "noosphere-documents-"));
  try {
    mkdirSync(resolve(fixture, "docs"));
    // Only the packaged blocks are supplied; all other assertions deliberately
    // continue reading repository documents, rather than falling back silently.
    for (const path of ["README.md", "docs/INSTALLATION.md"]) {
      const text = readFileSync(resolve(root, path), "utf8");
      const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
        .filter((match) => match[1].includes("/releases/download/v"));
      assert.ok(blocks.length > 0);
      writeFileSync(resolve(fixture, path), blocks.map((match) => match[0]).join("\n"));
    }
    const result = check([option, fixture]);
    assert.equal(result.status, 0, result.output);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const status of [404, 200]) {
  test(`published asset HTTP ${status} has an actionable, distinct diagnostic`, () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "noosphere-documents-fetch-"));
    try {
      const mock = resolve(fixture, "fetch.mjs");
      // Stub the network only; the real policy CLI still parses and checks docs.
      writeFileSync(mock, `globalThis.fetch = async () => new Response("fixture bytes", { status: ${status} });`);
      const result = check(["--verify-remote"], ["--import", mock]);
      assert.equal(result.status, 1, result.output);
      if (status === 404) {
        assert.match(result.output, /README\.md and docs\/INSTALLATION\.md.*not published or unavailable.*keep.*last published release/);
        assert.doesNotMatch(result.output, /published release launcher.*digest mismatch/);
      } else {
        assert.match(result.output, /README\.md and docs\/INSTALLATION\.md.*published.*digest mismatch/);
        assert.doesNotMatch(result.output, /not published or unavailable/);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
