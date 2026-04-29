import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMemoryRecallRequest,
  validateMemoryRecallRequest,
} from "@/lib/memory/api/recall";
import type { MemoryProvider } from "@/lib/memory/provider";
import type { MemoryResult } from "@/lib/memory/types";

function mockProvider(
  id: string,
  results: MemoryResult[] = [],
  overrides: Partial<MemoryProvider> = {},
): MemoryProvider {
  return {
    descriptor: {
      id,
      displayName: id,
      sourceType: id as MemoryResult["sourceType"],
      defaultConfig: {
        enabled: true,
        priorityWeight: 1,
        allowAutoRecall: true,
      },
      capabilities: {
        search: true,
        getById: true,
        score: true,
        autoRecall: true,
      },
    },
    search: () => Promise.resolve(results),
    getById: () => Promise.resolve(null),
    score: () => ({}),
    ...overrides,
  } as MemoryProvider;
}

function mockResult(
  overrides: Partial<MemoryResult> & { id: string; provider: string },
): MemoryResult {
  return {
    sourceType: overrides.provider as MemoryResult["sourceType"],
    content: `Content for ${overrides.id}`,
    relevanceScore: 0.8,
    confidenceScore: 0.8,
    ...overrides,
  };
}

test("memory recall validation rejects missing or empty query", () => {
  assert.deepEqual(validateMemoryRecallRequest({}), {
    ok: false,
    status: 400,
    error: "query is required",
  });
  assert.deepEqual(validateMemoryRecallRequest({ query: "   " }), {
    ok: false,
    status: 400,
    error: "query is required",
  });
});

test("memory recall validation normalizes caps and defaults", () => {
  const result = validateMemoryRecallRequest({
    query: "  serianis memory  ",
    resultCap: 999,
    tokenBudget: 99999,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.query, "serianis memory");
  assert.equal(result.request.mode, "inspection");
  assert.equal(result.request.resultCap, 10);
  assert.equal(result.request.tokenBudget, 2000);
});

test("memory recall inspection mode returns results without prompt text", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "deployment", mode: "inspection", resultCap: 5 },
    {
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "article-1",
              provider: "noosphere",
              title: "Deployment Notes",
              content: "Use the documented deployment workflow.",
            }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.mode, "inspection");
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0]?.providerId, "noosphere");
  assert.equal(response.body.promptInjectionText, undefined);
});

test("memory recall auto mode returns bounded prompt text", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "serianis", mode: "auto", resultCap: 1, tokenBudget: 50 },
    {
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "article-1",
              provider: "noosphere",
              title: "Serianis",
              content: "Serianis deployment memory.",
              tokenEstimate: 20,
            }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("promptInjectionText" in response.body);
  if (!("promptInjectionText" in response.body)) return;
  assert.equal(response.body.mode, "auto");
  assert.equal(response.body.results.length, 1);
  assert.ok((response.body.tokenBudgetUsed ?? 0) > 0);
  assert.ok((response.body.tokenBudgetUsed ?? 0) <= 50);
  assert.match(response.body.promptInjectionText ?? "", /^<recall query="serianis">/);
  assert.match(response.body.promptInjectionText ?? "", /<memory source="noosphere"/);
});


test("memory recall auto mode defaults to noosphere provider only", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", mode: "auto" },
    {
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({ id: "n1", provider: "noosphere", content: "Noosphere" }),
          ]),
        },
        {
          provider: mockProvider("hindsight", [
            mockResult({ id: "h1", provider: "hindsight", content: "Hindsight" }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0]?.providerId, "noosphere");
  assert.deepEqual(response.body.providerMeta.map((meta) => meta.providerId), ["noosphere"]);
});

test("memory recall filters providers at route layer", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", providers: ["secondary"] },
    {
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({ id: "n1", provider: "noosphere", content: "Noosphere" }),
          ]),
        },
        {
          provider: mockProvider("secondary", [
            mockResult({ id: "s1", provider: "secondary", content: "Secondary" }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0]?.providerId, "secondary");
  assert.deepEqual(response.body.providerMeta.map((meta) => meta.providerId), ["secondary"]);
});

test("memory recall rejects unknown provider filters", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", providers: ["missing"] },
    { providers: [{ provider: mockProvider("noosphere") }] },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Unknown provider ID: missing" });
});

test("memory recall preserves provider errors as metadata", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", mode: "inspection" },
    {
      providers: [
        {
          provider: mockProvider("broken", [], {
            search: () => Promise.reject(new Error("provider unavailable")),
          }),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 0);
  assert.equal(response.body.providerMeta[0]?.providerId, "broken");
  assert.equal(response.body.providerMeta[0]?.error, "provider unavailable");
});

test("memory recall timeout fails open with provider metadata", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "slow", mode: "auto" },
    {
      timeoutMs: 1,
      providers: [
        {
          provider: mockProvider("noosphere", [], {
            search: () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
          }),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 0);
  assert.equal(response.body.mode, "auto");
  assert.equal(response.body.promptInjectionText, "");
  assert.equal(response.body.providerMeta[0]?.error, "Memory recall timed out");
});
