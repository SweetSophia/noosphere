import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fsNode from "node:fs";
const consumerRequire=createRequire(import.meta.url);
const adapterUrl=fileURLToPath(import.meta.resolve("@sweetsophia/opencode-noosphere-memory"));
const pluginUrl=fileURLToPath(import.meta.resolve("@opencode-ai/plugin"));
const pluginRequire=createRequire(pluginUrl);
const effectUrl=pluginRequire.resolve("effect");
const effectRequire=createRequire(effectUrl);
const { Effect, FileSystem, Path, Schema } = await import(pathToFileURL(effectUrl).href);
const { Primitive } = await import(pathToFileURL(pluginRequire.resolve("effect/unstable/cli")).href);
const Toml = await import(pathToFileURL(effectRequire.resolve("toml")).href);
const { NoosphereClient } = await import(new URL("./client.js",pathToFileURL(adapterUrl)).href);

import { NoosphereOpencodePlugin } from "@sweetsophia/opencode-noosphere-memory";

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
    const hooks = await NoosphereOpencodePlugin({ client: { app: { log: async () => {} } } }, { apiKey: "fixture-only", authorName: "Fixture Author" });
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
 // This fixture serves two dependency graphs: the frozen publication candidate and
 // the active candidate. Each is checked against the alias its own adapter manifest
 // declares, so neither graph's versions are hardcoded into the other.
 let dir=path.dirname(adapterUrl);
 let adapter;
 for (let depth=0; depth<4; depth+=1) {
   const candidate=path.join(dir,"package.json");
   if (fsNode.existsSync(candidate)) {
     const parsed=JSON.parse(fsNode.readFileSync(candidate));
     if (parsed.name==="@sweetsophia/opencode-noosphere-memory") { adapter=parsed; break; }
   }
   dir=path.dirname(dir);
 }
 assert.ok(adapter, "Adapter manifest not found");
 const declaredPlugin=adapter.dependencies["@opencode-ai/plugin"];
 assert.match(declaredPlugin,/^npm:@sweetsophia\/noosphere-opencode-plugin@/);
 const declaredVersion=declaredPlugin.slice(declaredPlugin.lastIndexOf("@")+1);
 assert.equal(consumer.overrides,undefined);
 assert.equal(parent.name, "@sweetsophia/noosphere-opencode-plugin");
 assert.equal(parent.version, declaredVersion);
 // The installed zod must be exactly the version the fork declares. No range
 // semantics are approximated here: a ranged or absent declaration fails closed
 // with its own diagnostic instead of blessing a version this fixture cannot prove.
 const declaredZod=parent.dependencies.zod;
 assert.equal(typeof declaredZod, "string", "the fork must declare zod");
 assert.equal(pluginRequire("zod/package.json").version, declaredZod, "the installed zod must be exactly the version the fork declares");
 assert.match(parent.dependencies.effect,/^npm:@sweetsophia\/noosphere-effect@/);
 assert.equal(effect.version, parent.dependencies.effect.slice(parent.dependencies.effect.lastIndexOf("@")+1));
 assert.equal(effect.dependencies.toml,"5.0.1");
 assert.ok(effectUrl.includes(path.dirname(new URL(import.meta.url).pathname)));
 assert.equal(effectRequire("toml/package.json").version,"5.0.1");
});

test("public entrypoint preserves the declared host export shape", async () => {
 const p=await import("@sweetsophia/opencode-noosphere-memory");
 assert.equal(typeof p.server,"function");
 assert.equal(typeof p["NoosphereOpencodePlugin"],"function");
 assert.equal(p.default,p.server);
});
