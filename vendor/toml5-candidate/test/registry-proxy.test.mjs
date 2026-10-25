import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../qualify.mjs", import.meta.url), "utf8");
// Exercise the actual proxy core without reconstructing archives/installing consumers.
const start = source.indexOf("    const upstreamUrl = new URL(");
const ending = "    response.end(Buffer.from(await upstream.arrayBuffer()));";
const end = source.indexOf(ending, start);
assert.ok(start >= 0 && end > start, "cannot locate the production proxy core");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const proxy = new AsyncFunction("request", "response", "fetch", "registry", source.slice(start, end + ending.length));
const registry = "https://registry.npmjs.org";
const response = () => ({ status: undefined, body: undefined, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; return this; } });

async function serve(t, listener) {
  const server = createServer(listener);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("registry proxy preserves ordinary public responses", async (t) => {
  const origin = await serve(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"fixture":true}'); });
  const result = response();
  await proxy({ url: "/fixture" }, result, (url, options) => {
    assert.equal(url.origin, registry);
    return fetch(origin + url.pathname, options);
  }, registry);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), '{"fixture":true}');
});

test("registry proxy fails closed on an upstream redirect and never fetches its destination", async (t) => {
  let destinationHits = 0;
  const destination = await serve(t, (_req, res) => { destinationHits++; res.end("must not be fetched"); });
  const origin = await serve(t, (_req, res) => { res.writeHead(302, { location: destination + "/private" }); res.end(); });
  const result = response();
  await assert.rejects(proxy({ url: "/redirect" }, result, (url, options) => {
    assert.equal(url.origin, registry);
    return fetch(origin + url.pathname, options);
  }, registry));
  assert.equal(destinationHits, 0);
  assert.equal(result.body, undefined, "redirect body was forwarded");
});

test("an absolute-form request cannot change the registry origin", async () => {
  let calls = 0;
  const result = response();
  await proxy({ url: "http://attacker.invalid/private" }, result, async () => { calls++; }, registry);
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});

test("historical reconstruction returns naturally without starting the consumer server", async () => {
  const marker = 'if (mode === "--reconstruct-only") {';
  const start = source.lastIndexOf(marker);
  const end = source.indexOf("} else {", start);
  assert.ok(start >= 0 && end > start, "historical mode is not isolated from the server branch");
  const body = source.slice(start + marker.length, end);
  const execute = new AsyncFunction("fs", "path", "here", "output", "receipts", "assert", "process", body);
  let written;
  await execute({ readFile: async () => "[]", writeFile: async (name, data) => { written = { name, data }; } },
    { join: (...parts) => parts.join("/") }, "fixture", "output", [], assert,
    { version: process.version, exit() { throw new Error("forced exit would truncate piped evidence"); } });
  assert.equal(written.name, "output/reconstruction.json");
  assert.equal(JSON.parse(written.data).distribution, "historical-archives-only-not-consumer-qualification");
});
