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

test("memory recall validation rejects non-string provider elements", () => {
  assert.deepEqual(
    validateMemoryRecallRequest({ query: "memory", providers: ["noosphere", 123 as unknown] }),
    { ok: false, status: 400, error: "providers must be an array of provider ID strings" },
  );
});

test("memory recall validation rejects empty providers array", () => {
  assert.deepEqual(
    validateMemoryRecallRequest({ query: "memory", providers: [] }),
    { ok: false, status: 400, error: "providers must contain at least one non-empty provider ID" },
  );
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
      settings: { enabledProviders: ["broken"] },
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

test("memory recall settings summaryFirst flows to budget", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "test", mode: "auto", tokenBudget: 200 },
    {
      settings: { summaryFirst: false },
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "1",
              provider: "noosphere",
              content: "full content here",
              summary: "short summary",
            }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results[0]?.content, "full content here");
});

test("memory recall settings recallVerbosity flows to budget", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "test", mode: "auto", tokenBudget: 200 },
    {
      settings: { recallVerbosity: "detailed" },
      providers: [
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "1",
              provider: "noosphere",
              content: "full content here",
              summary: "short summary",
            }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results[0]?.content, "full content here");
});

test("memory recall settings providerPriorityWeights flows to orchestrator", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "test", mode: "inspection" },
    {
      settings: {
        enabledProviders: ["low-priority", "high-priority"],
        providerPriorityWeights: {
          "low-priority": 0.5,
          "high-priority": 2.0,
        },
      },
      providers: [
        {
          provider: mockProvider("low-priority", [
            mockResult({
              id: "low",
              provider: "low-priority",
              content: "low content",
              relevanceScore: 0.9,
            }),
          ]),
        },
        {
          provider: mockProvider("high-priority", [
            mockResult({
              id: "high",
              provider: "high-priority",
              content: "high content",
              relevanceScore: 0.5,
            }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results[0]?.providerId, "high-priority");
});

test("memory recall enabledProviders filters default providers", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", mode: "inspection" },
    {
      settings: { enabledProviders: ["alpha"] },
      providers: [
        {
          provider: mockProvider("alpha", [
            mockResult({ id: "a1", provider: "alpha", content: "Alpha" }),
          ]),
        },
        {
          provider: mockProvider("beta", [
            mockResult({ id: "b1", provider: "beta", content: "Beta" }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0]?.providerId, "alpha");
});

test("memory recall auto mode omits conflicts to keep response small", async () => {
  // Regression test: auto-mode responses used to include conflict pairs with
  // full article content, pushing responses past the plugin's 1 MB limit.
  const response = await executeMemoryRecallRequest(
    { query: "meeting", mode: "auto", resultCap: 5, tokenBudget: 200 },
    {
      providers: [
        {
          provider: mockProvider("hindsight", [
            mockResult({
              id: "mem-a",
              provider: "hindsight",
              content: "Meeting at 3pm",
              relevanceScore: 0.8,
            }),
          ]),
        },
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "mem-b",
              provider: "noosphere",
              content: "Meeting at 5pm",
              relevanceScore: 0.5,
            }),
          ]),
        },
      ],
      settings: {
        enabledProviders: ["hindsight", "noosphere"],
      },
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  // Auto mode must NOT include conflicts or conflictStats — they can account
  // for >98% of payload on broad queries and push responses past the 1 MB
  // plugin limit. The plugin only consumes promptInjectionText in auto mode.
  assert.equal(response.body.conflicts, undefined, "conflicts must be omitted in auto mode");
  assert.equal(response.body.conflictStats, undefined, "conflictStats must be omitted in auto mode");
});

test("memory recall inspection mode still includes conflicts", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "meeting", mode: "inspection", resultCap: 5 },
    {
      providers: [
        {
          provider: mockProvider("hindsight", [
            mockResult({
              id: "mem-a",
              provider: "hindsight",
              content: "Meeting at 3pm",
              relevanceScore: 0.8,
            }),
          ]),
        },
        {
          provider: mockProvider("noosphere", [
            mockResult({
              id: "mem-b",
              provider: "noosphere",
              content: "Meeting at 5pm",
              relevanceScore: 0.5,
            }),
          ]),
        },
      ],
      settings: {
        enabledProviders: ["hindsight", "noosphere"],
      },
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  // Inspection mode MUST still include conflicts — tools like noosphere_recall
  // use inspection mode and need conflict data.
  assert.ok(response.body.conflicts !== undefined, "conflicts present in inspection mode");
  assert.ok(response.body.conflictStats !== undefined, "conflictStats present in inspection mode");
});

test("memory recall explicit providers bypass enabledProviders filter", async () => {
  const response = await executeMemoryRecallRequest(
    { query: "memory", mode: "inspection", providers: ["beta"] },
    {
      settings: { enabledProviders: ["alpha"] },
      providers: [
        {
          provider: mockProvider("alpha", [
            mockResult({ id: "a1", provider: "alpha", content: "Alpha" }),
          ]),
        },
        {
          provider: mockProvider("beta", [
            mockResult({ id: "b1", provider: "beta", content: "Beta" }),
          ]),
        },
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("results" in response.body);
  if (!("results" in response.body)) return;
  assert.equal(response.body.results.length, 1);
  assert.equal(response.body.results[0]?.providerId, "beta");
});
