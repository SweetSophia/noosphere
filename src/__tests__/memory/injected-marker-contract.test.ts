import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatAutoRecall } from "@sweetsophia/noosphere-client";
import {
  SERVER_MEMORY_SAVE_STRIP_MODE,
  stripInjectedMemoryBlocks,
} from "@sweetsophia/noosphere-injected-memory";

test("server strips the context tags declared by the Hermes client", () => {
  const formatting = readFileSync("hermes-noosphere-memory/plugins/memory/noosphere/formatting.py", "utf8");
  const tags = formatting.match(/_FENCE_TAG_RE = re\.compile\(r"[^"\n]*\(\?:([^)]*)\)/)?.[1].split("|");
  assert.deepEqual(tags, ["memory-context", "noosphere-context"]);
  for (const tag of tags) {
    for (const [opening, closing] of [[`<${tag}>`, `</${tag}>`], [`< ${tag} >`, `</ ${tag} >`]]) {
      const result = stripInjectedMemoryBlocks(
        `Before.\n${opening}recalled private context${closing}\nAfter.`,
        SERVER_MEMORY_SAVE_STRIP_MODE,
      );
      assert.deepEqual(result.strippedBlocks, [tag]);
      assert.ok(result.content.includes("Before."));
      assert.ok(result.content.includes("After."));
      assert.ok(!result.content.includes("recalled private context"));
    }
  }
});

test("server strips the block emitted by the OpenCode/Kilo shared formatter", () => {
  const injected = formatAutoRecall({ results: [], promptInjectionText: "private recall" });
  const result = stripInjectedMemoryBlocks(injected, SERVER_MEMORY_SAVE_STRIP_MODE);
  assert.equal(result.content.trim(), "");
  assert.deepEqual(result.strippedBlocks, ["noosphere_auto_recall"]);
});