import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCLAW_ARTICLE_CREATE_STRIP_MODE,
  SERVER_MEMORY_SAVE_STRIP_MODE,
  stripInjectedMemoryBlocks,
} from "@sweetsophia/noosphere-injected-memory";
import {
  stripInjectedMemoryBlocks as stripInjectedMemoryBlocksFromSource,
} from "../../../noosphere-injected-memory/src/index.js";

test("shared injected strip helper preserves OpenClaw package malformed-block behavior", () => {
  assert.deepEqual(
    stripInjectedMemoryBlocks(
      "before <recall>hidden</recall > after",
      OPENCLAW_ARTICLE_CREATE_STRIP_MODE,
    ),
    { content: "before \n after", strippedBlocks: ["recall"] },
  );

  assert.throws(
    () => stripInjectedMemoryBlocks("before <recall/> after", OPENCLAW_ARTICLE_CREATE_STRIP_MODE),
    /Unclosed memory block tag: <recall>/,
  );
  assert.throws(
    () => stripInjectedMemoryBlocks("before <recall>hidden", OPENCLAW_ARTICLE_CREATE_STRIP_MODE),
    /Unclosed memory block tag: <recall>/,
  );
});

test("shared injected strip helper preserves server-save malformed-block behavior", () => {
  assert.deepEqual(
    stripInjectedMemoryBlocks("before <recall/> after", SERVER_MEMORY_SAVE_STRIP_MODE),
    { content: "before \n", strippedBlocks: ["recall"] },
  );

  assert.deepEqual(
    stripInjectedMemoryBlocks("before <recall>hidden</recall > after", SERVER_MEMORY_SAVE_STRIP_MODE),
    { content: "before \n", strippedBlocks: ["recall"] },
  );
});

test("shared injected strip helper does not leak state between modes or calls", () => {
  const packageResult = stripInjectedMemoryBlocks(
    "one <recall>first</recall> two <recall>second</recall> three",
    OPENCLAW_ARTICLE_CREATE_STRIP_MODE,
  );
  const serverResult = stripInjectedMemoryBlocks(
    "alpha <hindsight_memories>hidden</hindsight_memories> omega",
    SERVER_MEMORY_SAVE_STRIP_MODE,
  );

  assert.deepEqual(packageResult, {
    content: "one \n two \n three",
    strippedBlocks: ["recall", "recall"],
  });
  assert.deepEqual(serverResult, {
    content: "alpha \n omega",
    strippedBlocks: ["hindsight_memories"],
  });
});

test("shared injected strip helper source and package entry points agree", () => {
  const content = "before <noosphere_auto_recall>hidden</noosphere_auto_recall> after";

  assert.deepEqual(
    stripInjectedMemoryBlocksFromSource(content, SERVER_MEMORY_SAVE_STRIP_MODE),
    stripInjectedMemoryBlocks(content, SERVER_MEMORY_SAVE_STRIP_MODE),
  );
});
