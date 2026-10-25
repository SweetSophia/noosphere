import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchBytes } from "./reconstruct.mjs";

async function serve(t, listener) {
  const server = createServer(listener);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("SDK downloader preserves bytes and fixed authority/path/query without following redirects", async () => {
  const bytes = await fetchBytes("https://registry.npmjs.org/@scope%2fpackage?fixture=true", async (url, options) => {
    assert.equal(url.origin, "https://registry.npmjs.org");
    assert.equal(url.pathname, "/@scope%2fpackage"); assert.equal(url.search, "?fixture=true");
    assert.equal(options.redirect, "error");
    return new Response("fixture");
  });
  assert.equal(bytes.toString(), "fixture");
});
test("SDK downloader rejects foreign origins and credentials before fetching", async () => {
  let calls = 0;
  for (const url of ["http://registry.npmjs.org/fixture", "https://attacker.invalid/fixture", "https://fixture-user@registry.npmjs.org/fixture"]) {
    await assert.rejects(fetchBytes(url, async () => { calls++; }));
  }
  assert.equal(calls, 0);
});
test("SDK downloader rejects an actual HTTP redirect without requesting its target", async (t) => {
  let destinationHits = 0;
  const destination = await serve(t, (_req, res) => { destinationHits++; res.end("must not be read"); });
  const origin = await serve(t, (_req, res) => { res.writeHead(302, { location: destination + "/private" }); res.end(); });
  await assert.rejects(fetchBytes("https://registry.npmjs.org/redirect", (url, options) => fetch(origin + url.pathname, options)));
  assert.equal(destinationHits, 0);
});
test("SDK downloader retains HTTP-status and size admission checks", async () => {
  await assert.rejects(fetchBytes("https://registry.npmjs.org/fixture", async () => new Response("missing", { status: 404 })), /Registry read failed/);
  await assert.rejects(fetchBytes("https://registry.npmjs.org/fixture", async () => new Response(new Uint8Array(2 * 1024 * 1024))), /Unexpected SDK archive/);
});
test("qualification evidence can be overwritten on a read-only rerun, while publication reruns remain forbidden", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/toml-candidate.yml", import.meta.url), "utf8");
  const qualifier = workflow.split("  zod-sdk-qualification:")[1].split("  publish-zod-sdks:")[0];
  assert.match(qualifier, /name: zod-sdk-qualified-node-\$\{\{ matrix\.node \}\}\n\s+overwrite: true/);
  const publisher = workflow.split("  publish-zod-sdks:")[1];
  assert.match(publisher, /github\.run_attempt == 1/);
  assert.match(publisher, /name: zod-sdk-qualified-node-22/);
  assert.match(publisher, /name: zod-sdk-qualified-node-24/);
  assert.doesNotMatch(publisher, /overwrite: true/);
});
