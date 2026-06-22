import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMemorySaveRequest,
  MemorySaveError,
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
  assert.deepEqual(result.input.restrictedTags, []);
});

test("memory save defaults scoped key writes to caller scopes", () => {
  const result = validateMemorySaveRequest(validRequest(), {
    allowedScopes: ["cylena", "serianis"],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.restrictedTags, ["cylena", "serianis"]);
});

test("memory save rejects scopes outside caller scopes", () => {
  assert.deepEqual(
    validateMemorySaveRequest(
      validRequest({ restrictedTags: ["serianis", "other-agent"] }),
      { allowedScopes: ["serianis"] },
    ),
    {
      ok: false,
      status: 403,
      error: "Cannot assign scope(s) you don't have: other-agent",
    },
  );
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

test("memory save strip helper is stable across repeated calls", () => {
  const first = stripInjectedMemoryBlocks(
    "one <recall>first</recall> two <recall>second</recall> three",
  );
  const second = stripInjectedMemoryBlocks(
    "alpha <hindsight_memories>hidden</hindsight_memories> omega",
  );
  const third = stripInjectedMemoryBlocks(
    "start <recall>outer <recall>inner</recall></recall> finish",
  );

  assert.equal(first.content, "one \n two \n three");
  assert.deepEqual(first.strippedBlocks, ["recall", "recall"]);
  assert.equal(second.content, "alpha \n omega");
  assert.deepEqual(second.strippedBlocks, ["hindsight_memories"]);
  assert.equal(third.content, "start \n finish");
  assert.deepEqual(third.strippedBlocks, ["recall"]);
});

test("memory save strip helper handles interleaved injected tags", () => {
  const stripped = stripInjectedMemoryBlocks(
    "a <recall>one</recall> b <hindsight_memories>two</hindsight_memories> c <recall>three</recall> d <noosphere_auto_recall>four</noosphere_auto_recall> e",
  );

  assert.equal(stripped.content, "a \n b \n c \n d \n e");
  assert.deepEqual(stripped.strippedBlocks, [
    "recall",
    "recall",
    "hindsight_memories",
    "noosphere_auto_recall",
  ]);
});

test("memory save strip helper pins unclosed variant behavior", () => {
  assert.deepEqual(stripInjectedMemoryBlocks("before <recall/> after"), {
    content: "before \n",
    strippedBlocks: ["recall"],
  });

  assert.deepEqual(stripInjectedMemoryBlocks("before <recall>x</recall > after"), {
    content: "before \n",
    strippedBlocks: ["recall"],
  });
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

for (const content of [
  "I'll check this after the deployment review finishes.",
  "We'll handle this once the deployment review has finished.",
  "Remind me to check this tomorrow morning.",
]) {
  test(`memory save rejects transient-only content: ${content}`, () => {
    assert.deepEqual(validateMemorySaveRequest(validRequest({ content })), {
      ok: false,
      status: 400,
      error:
        "content looks transient and should not be saved as durable memory",
    });
  });
}

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

test("memory save rejects common credential formats", () => {
  for (const [content, name] of [
    [`${durableContent}\nAWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP`, "AWS access key"],
    [`${durableContent}\npassword: supersecretvalue12345`, "credential assignment"],
    [
      `${durableContent}\nBearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpayload.signaturesig`,
      "JWT token",
    ],
  ] as const) {
    const result = validateMemorySaveRequest(validRequest({ content }));

    assert.deepEqual(result, {
      ok: false,
      status: 400,
      error: `content appears to contain a secret (${name})`,
    });
  }
});

test("memory save rejects secrets in optional fields with field-aware errors", () => {
  const result = validateMemorySaveRequest(
    validRequest({
      excerpt: "Token noo_abcdefghijklmnopqrstuvwxyz should not persist",
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "excerpt appears to contain a secret (Noosphere API key)",
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
  assert.deepEqual(seen[0].restrictedTags, []);
});

test("memory save validates restrictedTags against the scope registry before writing", async () => {
  let writerCalled = false;

  const response = await executeMemorySaveRequest(
    validRequest({ restrictedTags: ["serianis", "unknown-scope"] }),
    {
      allowedScopes: ["*"],
      restrictedScopeLookup: async () => ["serianis"],
      writer: {
        async saveCandidate(input) {
          writerCalled = true;
          return {
            id: "article-1",
            title: input.title,
            slug: "noosphere-bridge-save-candidate",
            topicId: input.topicId,
            status: "draft",
          };
        },
      },
    },
  );

  assert.equal(writerCalled, false);
  assert.deepEqual(response, {
    status: 400,
    body: { error: "Unknown restricted tag(s): unknown-scope" },
  });
});

test("memory save writes after scoped defaults are confirmed in the scope registry", async () => {
  const seen: SanitizedMemorySaveInput[] = [];

  const response = await executeMemorySaveRequest(validRequest(), {
    allowedScopes: ["cylena", "serianis"],
    restrictedScopeLookup: async (tags) => tags,
    writer: {
      async saveCandidate(input) {
        seen.push(input);
        return {
          id: "article-1",
          title: input.title,
          slug: "noosphere-bridge-save-candidate",
          topicId: input.topicId,
          status: "draft",
        };
      },
    },
  });

  assert.equal(response.status, 201);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].restrictedTags, ["cylena", "serianis"]);
});

test("memory save propagates writer MemorySaveError", async () => {
  await assert.rejects(
    executeMemorySaveRequest(validRequest(), {
      writer: {
        async saveCandidate() {
          throw new MemorySaveError("Topic not found", 404);
        },
      },
    }),
    (error: unknown) =>
      error instanceof MemorySaveError &&
      error.message === "Topic not found" &&
      error.status === 404,
  );
});
