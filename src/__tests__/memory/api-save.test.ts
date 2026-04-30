import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMemorySaveRequest,
  stripInjectedMemoryBlocks,
  validateMemorySaveRequest,
  type SanitizedMemorySaveInput,
} from "@/lib/memory/api/save";

const durableContent =
  "This is a durable operational note about the Noosphere bridge workflow. It explains why future agents should preserve draft review before publishing.";

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    title: "Noosphere bridge save candidate",
    content: durableContent,
    topicId: "topic-1",
    tags: [" Memory ", "memory", "bridge"],
    confidence: "medium",
    ...overrides,
  };
}

test("memory save validation accepts durable draft candidates", () => {
  const result = validateMemorySaveRequest(validRequest());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.status, "draft");
  assert.deepEqual(result.input.tags, ["Memory", "bridge"]);
  assert.equal(result.input.confidence, "medium");
});

test("memory save strips injected memory blocks before validation", () => {
  const result = validateMemorySaveRequest(
    validRequest({
      content: `<recall>old injected recall</recall>\n${durableContent}\n<hindsight_memories>do not save this</hindsight_memories>`,
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.content.includes("old injected recall"), false);
  assert.equal(result.input.content.includes("do not save this"), false);
  assert.deepEqual(
    new Set(result.input.strippedBlocks),
    new Set(["recall", "hindsight_memories"]),
  );
});

test("memory save strip helper handles noosphere auto recall blocks", () => {
  const stripped = stripInjectedMemoryBlocks(
    "keep this\n<noosphere_auto_recall><recall>nested</recall></noosphere_auto_recall>\nkeep that",
  );

  assert.equal(stripped.content.includes("nested"), false);
  assert.deepEqual(
    new Set(stripped.strippedBlocks),
    new Set(["recall", "noosphere_auto_recall"]),
  );
});

test("memory save strip helper handles nested same-type blocks", () => {
  const stripped = stripInjectedMemoryBlocks(
    "before <recall>outer <recall>inner</recall> content</recall> after",
  );

  assert.equal(stripped.content, "before \n after");
  assert.deepEqual(stripped.strippedBlocks, ["recall"]);
});

test("memory save rejects empty, transient, and noisy content", () => {
  assert.deepEqual(validateMemorySaveRequest(validRequest({ content: "ok" })), {
    ok: false,
    status: 400,
    error: "content is too short to save as durable memory",
  });

  assert.deepEqual(
    validateMemorySaveRequest(
      validRequest({
        content: "1234567890 1234567890 1234567890 1234567890 1234567890",
      }),
    ),
    {
      ok: false,
      status: 400,
      error: "content must contain meaningful prose",
    },
  );
});

test("memory save rejects likely secrets", () => {
  const result = validateMemorySaveRequest(
    validRequest({
      content: `${durableContent}\nToken: noo_abcdefghijklmnopqrstuvwxyz`,
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "content appears to contain a secret (Noosphere API key)",
  });
});

test("memory save rejects secrets in optional fields", () => {
  const result = validateMemorySaveRequest(
    validRequest({
      excerpt: "Token noo_abcdefghijklmnopqrstuvwxyz should not persist",
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "content appears to contain a secret (Noosphere API key)",
  });
});

test("memory save rejects malformed optional fields", () => {
  assert.deepEqual(
    validateMemorySaveRequest(validRequest({ tags: "memory" })),
    {
      ok: false,
      status: 400,
      error: "tags must be an array of strings",
    },
  );
  assert.deepEqual(
    validateMemorySaveRequest(validRequest({ confidence: "certain" })),
    {
      ok: false,
      status: 400,
      error: "confidence must be low/medium/high",
    },
  );
});

test("memory save executes through injected writer", async () => {
  const seen: SanitizedMemorySaveInput[] = [];
  const response = await executeMemorySaveRequest(validRequest(), {
    writer: {
      async saveCandidate(input) {
        seen.push(input);
        return {
          id: "article-1",
          title: input.title,
          slug: "noosphere-bridge-save-candidate",
          topicId: input.topicId,
          status: "draft",
          url: "/wiki/memory/noosphere-bridge-save-candidate",
        };
      },
    },
  });

  assert.equal(response.status, 201);
  assert.ok("success" in response.body);
  if (!("success" in response.body)) return;
  assert.equal(response.body.success, true);
  assert.equal(response.body.candidate.status, "draft");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "draft");
});
