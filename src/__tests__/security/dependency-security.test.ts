import assert from "node:assert/strict";
import test from "node:test";
// Intentionally exercise the exact locked transitive packages used by Next and
// PostCSS, rather than a separate test-only dependency resolution. This suite
// requires a full root npm ci, including optional dependencies. A missing package
// must fail the check; omitting optional dependencies is not this test contract.
import sharp from "sharp";
import { SourceMapConsumer } from "source-map-js";

const basicMap = {
  version: 3,
  sources: ["entry.ts"],
  names: [],
  mappings: "AAAA",
};

function indexedMap(line: number, map: object = basicMap) {
  return {
    version: 3,
    sections: [{ offset: { line, column: 0 }, map }],
  };
}

function consumeIndexedMap(map: ReturnType<typeof indexedMap>): SourceMapConsumer {
  // The runtime supports serialized indexed maps, but upstream types only cover
  // basic map objects. Keep this declaration mismatch at the test-only boundary.
  // @ts-expect-error -- source-map-js accepts serialized maps at runtime.
  return new SourceMapConsumer(JSON.stringify(map));
}

test("indexed source maps reject excessive section offsets before serialization", () => {
  // Constructor rejection proves the guard without allocating the amplified map.
  assert.throws(
    () => consumeIndexedMap(indexedMap(10_000_001)),
    /Section offset line must not exceed/,
  );
});

test("indexed source maps bound cumulative nested section offsets", () => {
  const map = indexedMap(6_000_000, indexedMap(6_000_000));
  assert.throws(
    () => consumeIndexedMap(map),
    /including offsets of nested sections/,
  );
});

test("ordinary indexed source maps still retain their mappings", () => {
  const consumer = consumeIndexedMap(indexedMap(2));
  const mappings: unknown[] = [];
  consumer.eachMapping((mapping) => mappings.push(mapping));
  assert.deepEqual(mappings, [{
    source: "entry.ts",
    generatedLine: 3,
    generatedColumn: 0,
    originalLine: 1,
    originalColumn: 0,
    name: null,
  }]);
});

test("patched image binaries still render SVG and encode WebP", async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">' +
    '<rect width="4" height="4" fill="blue"/></svg>',
  );
  const { data, info } = await sharp(svg, { limitInputPixels: 64 })
    .webp()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.format, "webp");
  assert.equal(info.width, 4);
  assert.equal(info.height, 4);
  assert.ok(data.length > 0);
});
