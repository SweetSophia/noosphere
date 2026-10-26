import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const adapter = Object.keys(manifest.dependencies).find((name) => name.endsWith("-noosphere-memory"));
assert.ok(adapter, "This fixture must run in an installed adapter consumer");
const pluginName = adapter.includes("kilocode") ? "@kilocode/plugin" : "@opencode-ai/plugin";
const pluginRequire = createRequire(import.meta.resolve(pluginName));
const effectRequire = createRequire(pluginRequire.resolve("effect"));
const { parse } = await import(pathToFileURL(effectRequire.resolve("toml")).href);
const { Effect, FileSystem, Path, Schema } = await import(pathToFileURL(pluginRequire.resolve("effect")).href);
const { Primitive } = await import(pathToFileURL(pluginRequire.resolve("effect/unstable/cli")).href);

test("safe integer endpoints retain Number types and exact values", () => {
  const result = parse("minimum = -9007199254740991\nmaximum = 9007199254740991\nordinary = 42");
  assert.equal(result.minimum, Number.MIN_SAFE_INTEGER);
  assert.equal(result.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(result.ordinary, 42);
  for (const value of Object.values(result)) assert.equal(typeof value, "number");
});

test("unsafe integers fail explicitly instead of silently rounding or changing to BigInt", () => {
  for (const value of ["9007199254740992", "-9007199254740992", "9223372036854775807"]) {
    assert.throws(() => parse(`value = ${value}`), /cannot be represented losslessly/);
  }
  assert.throws(() => parse("value = 9223372036854775808"), /outside the 64-bit signed integer range/);
});

test("Effect surfaces the unsafe-integer parse failure without a bigint opt-in", async () => {
  const filesystem = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    stat: () => Effect.succeed({ type: "File" }),
    readFileString: () => Effect.succeed("value = 9007199254740992"),
  });
  const operation = Primitive.fileParse({ format: "toml" }).parse("/fixture/config.toml").pipe(
    Effect.provideService(FileSystem.FileSystem, filesystem),
    Effect.provideService(Path.Path, { isAbsolute: () => true }),
  );
  await assert.rejects(Effect.runPromise(operation), /cannot be represented losslessly/);
});

test("prototype-shaped keys remain own data in null-prototype tables", () => {
  const result = parse('"__proto__" = { noosphereFixtureMarker = true }\n"constructor" = "configuration"\n"hasOwnProperty" = "data"');
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.__proto__), null);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result.__proto__.noosphereFixtureMarker, true);
  assert.equal(result.constructor, "configuration");
  assert.equal(result.hasOwnProperty, "data");
  assert.equal(Object.prototype.noosphereFixtureMarker, undefined);
});

test("nested arrays of tables remain consumable by the Effect schema boundary", async () => {
  const result = parse('[[servers]]\nname = "first"\n[servers.options]\nenabled = true\n[[servers]]\nname = "second"\n[servers.options]\nenabled = false');
  const schema = Schema.Struct({ servers: Schema.Array(Schema.Struct({ name: Schema.String, options: Schema.Struct({ enabled: Schema.Boolean }) })) });
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(schema)(result));
  assert.deepEqual(decoded.servers.map((server) => [server.name, server.options.enabled]), [["first", true], ["second", false]]);
});
