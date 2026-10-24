import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fsNode from "node:fs";
const consumerRequire=createRequire(import.meta.url);
const adapterUrl=fileURLToPath(import.meta.resolve("@sweetsophia/kilocode-noosphere-memory"));
const pluginUrl=fileURLToPath(import.meta.resolve("@kilocode/plugin"));
const pluginRequire=createRequire(pluginUrl);
const effectUrl=pluginRequire.resolve("effect");
const effectRequire=createRequire(effectUrl);
const { Effect, FileSystem, Path, Schema } = await import(pathToFileURL(effectUrl).href);
const { Primitive } = await import(pathToFileURL(pluginRequire.resolve("effect/unstable/cli")).href);
const Toml = await import(pathToFileURL(effectRequire.resolve("toml")).href);
const { NoosphereClient } = await import(new URL("./client.js",pathToFileURL(adapterUrl)).href);

import { NoosphereKiloPlugin } from "@sweetsophia/kilocode-noosphere-memory";

const document = 'title = "ordinary configuration"\nenabled = true\nports = [6578, 6579]\n[server]\nhost = "127.0.0.1"\n';
// TOML 5 intentionally returns null-prototype tables; do not assume Object.prototype.
const expected = Object.assign(Object.create(null), { title: "ordinary configuration", enabled: true, ports: [6578, 6579], server: Object.assign(Object.create(null), { host: "127.0.0.1" }) });

test("Effect resolves the qualified TOML version", () => {
  assert.equal(effectRequire("toml/package.json").version, "5.0.1");
});

test("TOML namespace parse retains ordinary scalar, array and table behavior", () => {
  const value = Toml.parse(document);
  assert.deepEqual(value, expected);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.server), null);
});

test("Effect fileParse consumes TOML through its real parser boundary", async () => {
  const fs = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    stat: () => Effect.succeed({ type: "File" }),
    readFileString: () => Effect.succeed(document),
  });
  const parsed = await Effect.runPromise(Primitive.fileParse({ format: "toml" }).parse("/fixture/config.toml").pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, { isAbsolute: () => true }),
  ));
  assert.deepEqual(parsed, expected);
  const schema = Schema.Struct({ title: Schema.String, enabled: Schema.Boolean, ports: Schema.Array(Schema.Number), server: Schema.Struct({ host: Schema.String }) });
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(schema)(parsed));
  assert.equal(decoded.server.host, "127.0.0.1");
});

test("ordinary malformed TOML still reports a parsing error", () => {
  assert.throws(() => Toml.parse("value = ["));
});

test("adapter initialization and draft-save tool remain compatible", async () => {
  const original = NoosphereClient.prototype.save;
  const calls = [];
  NoosphereClient.prototype.save = async (request) => { calls.push(request); return { saved: true }; };
  try {
    const hooks = await NoosphereKiloPlugin({ client: { app: { log: async () => {} } } }, { apiKey: "fixture-only", authorName: "Fixture Author" });
    assert.equal(typeof hooks["chat.message"], "function");
    assert.equal(typeof hooks.event, "function");
    assert.deepEqual(hooks.tool.noosphere_save.args.restrictedTags.parse(["team:private"]), ["team:private"]);
    const result = JSON.parse(await hooks.tool.noosphere_save.execute({ title: "Fixture", content: "Ordinary draft compatibility", topicId: "fixture-topic", restrictedTags: ["team:private"] }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].restrictedTags, ["team:private"]);
  } finally { NoosphereClient.prototype.save = original; }
});

test("installed aliases use declared fork edges without overrides or builder references", () => {
 const path = consumerRequire("node:path");
 const parent=JSON.parse(fsNode.readFileSync(path.join(path.dirname(pluginUrl),"../package.json")));
 const effect=effectRequire("effect/package.json");
 const consumer=JSON.parse(fsNode.readFileSync(new URL("./package.json",import.meta.url)));
 assert.equal(consumer.overrides,undefined);
 assert.equal(parent.name, "@sweetsophia/noosphere-kilocode-plugin");
 assert.equal(parent.version, "7.3.1-noosphere.5");
 assert.equal(parent.dependencies.zod, "4.6.7");
 assert.equal(pluginRequire("zod/package.json").version, "4.6.7");
 assert.equal(parent.dependencies.effect, "npm:@sweetsophia/noosphere-effect@4.0.0-beta.57-noosphere.4");
 assert.match(parent.dependencies.effect,/^npm:@sweetsophia\/noosphere-effect@/);
 assert.ok(effect.version.endsWith("-noosphere.4"));
 assert.equal(effect.dependencies.toml,"5.0.1");
 assert.ok(effectUrl.includes(path.dirname(new URL(import.meta.url).pathname)));
 assert.equal(effectRequire("toml/package.json").version,"5.0.1");
});
test("public entrypoint preserves the declared host export shape", async () => {
 const p=await import("@sweetsophia/kilocode-noosphere-memory");
 assert.equal(typeof p.server,"function");
 assert.equal(typeof p["NoosphereKiloPlugin"],"function");
 assert.equal(p.default.server,p.server);assert.equal(typeof p.default.id,"string");
});
