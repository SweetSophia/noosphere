import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Primitive } from "effect/unstable/cli";
import * as Toml from "toml";
import { NoosphereOpencodePlugin } from "../dist/index.js";
import { NoosphereClient } from "../dist/client.js";

const document = 'title = "ordinary configuration"\nenabled = true\nports = [6578, 6579]\n[server]\nhost = "127.0.0.1"\n';
// TOML 5 intentionally returns null-prototype tables; do not assume Object.prototype.
const expected = Object.assign(Object.create(null), { title: "ordinary configuration", enabled: true, ports: [6578, 6579], server: Object.assign(Object.create(null), { host: "127.0.0.1" }) });

test("Effect resolves the qualified TOML version", () => {
  const require = createRequire(import.meta.url);
  const effectRequire = createRequire(require.resolve("effect"));
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
