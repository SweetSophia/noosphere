import assert from "node:assert/strict";
import test from "node:test";

import {
  executeMemoryGetRequest,
  validateMemoryGetRequest,
} from "@/lib/memory/api/get";
import type { MemoryProvider } from "@/lib/memory/provider";
import type { MemoryResult } from "@/lib/memory/types";

function mockResult(
  overrides: Partial<MemoryResult> & { id: string; provider: string },
): MemoryResult {
  return {
    sourceType: overrides.provider as MemoryResult["sourceType"],
    content: `Content for ${overrides.id}`,
    canonicalRef: `${overrides.provider}:article:${overrides.id}`,
    ...overrides,
  };
}

function mockProvider(
  id: string,
  result: MemoryResult | null = null,
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
    search: () => Promise.resolve([]),
    getById: () => Promise.resolve(result),
    score: () => ({}),
    ...overrides,
  } as MemoryProvider;
}

test("memory get validation accepts provider and id", () => {
  assert.deepEqual(
    validateMemoryGetRequest({ provider: " noosphere ", id: " article-1 " }),
    {
      ok: true,
      request: { provider: "noosphere", id: "article-1" },
    },
  );
});

test("memory get validation parses canonical refs", () => {
  assert.deepEqual(
    validateMemoryGetRequest({ canonicalRef: "noosphere:article:article-1" }),
    {
      ok: true,
      request: {
        provider: "noosphere",
        id: "article-1",
        canonicalRef: "noosphere:article:article-1",
      },
    },
  );
});

test("memory get validation trims canonical ref segments", () => {
  assert.deepEqual(
    validateMemoryGetRequest({ canonicalRef: " noosphere : article : abc " }),
    {
      ok: true,
      request: {
        provider: "noosphere",
        id: "abc",
        canonicalRef: "noosphere:article:abc",
      },
    },
  );
});

test("memory get validation preserves colons in canonical ref ids", () => {
  assert.deepEqual(
    validateMemoryGetRequest({ canonicalRef: "noosphere:article:a:b:c" }),
    {
      ok: true,
      request: {
        provider: "noosphere",
        id: "a:b:c",
        canonicalRef: "noosphere:article:a:b:c",
      },
    },
  );
});

test("memory get validation rejects malformed inputs", () => {
  assert.deepEqual(validateMemoryGetRequest({}), {
    ok: false,
    status: 400,
    error: "provider is required",
  });
  assert.deepEqual(validateMemoryGetRequest({ provider: "noosphere" }), {
    ok: false,
    status: 400,
    error: "id is required",
  });
  assert.deepEqual(validateMemoryGetRequest({ canonicalRef: "not-a-ref" }), {
    ok: false,
    status: 400,
    error: "canonicalRef must look like provider:type:id",
  });
  assert.deepEqual(
    validateMemoryGetRequest({
      provider: "noosphere",
      id: "1",
      canonicalRef: "noosphere:article:1",
    }),
    {
      ok: false,
      status: 400,
      error: "Use either canonicalRef or provider + id, not both",
    },
  );
  assert.deepEqual(
    validateMemoryGetRequest({ canonicalRef: "noosphere:note:article-1" }),
    {
      ok: false,
      status: 400,
      error: "Unsupported canonicalRef type for noosphere: note",
    },
  );
  assert.deepEqual(
    validateMemoryGetRequest({ provider: "Noosphere", id: "article-1" }),
    {
      ok: false,
      status: 400,
      error:
        "provider must contain only lowercase letters, numbers, and hyphens",
    },
  );
  assert.deepEqual(
    validateMemoryGetRequest({ provider: "n".repeat(65), id: "article-1" }),
    {
      ok: false,
      status: 400,
      error: "provider is too long",
    },
  );
});

test("memory get returns normalized provider result", async () => {
  const result = mockResult({
    id: "article-1",
    provider: "noosphere",
    title: "Deployment Notes",
    content: "Use the documented deployment workflow.",
  });
  const response = await executeMemoryGetRequest(
    { provider: "noosphere", id: "article-1" },
    { providers: [mockProvider("noosphere", result)] },
  );

  assert.equal(response.status, 200);
  assert.ok("result" in response.body);
  if (!("result" in response.body)) return;
  assert.equal(response.body.result?.id, "article-1");
  assert.equal(response.body.result?.provider, "noosphere");
  assert.deepEqual(
    response.body.providerMeta.map((meta) => meta.providerId),
    ["noosphere"],
  );
  assert.equal(response.body.providerMeta[0]?.found, true);
  assertProviderDuration(response.body.providerMeta[0]);
});

test("memory get returns null for missing results", async () => {
  const response = await executeMemoryGetRequest(
    { provider: "noosphere", id: "missing" },
    { providers: [mockProvider("noosphere", null)] },
  );

  assert.equal(response.status, 200);
  assert.ok("result" in response.body);
  if (!("result" in response.body)) return;
  assert.equal(response.body.result, null);
  assert.equal(response.body.providerMeta[0]?.found, false);
  assertProviderDuration(response.body.providerMeta[0]);
});

test("memory get reports disabled providers distinctly", async () => {
  const response = await executeMemoryGetRequest(
    { provider: "noosphere", id: "article-1" },
    {
      providerOptions: { config: { enabled: false } },
      providers: [
        mockProvider("noosphere", null, {
          getById: () => Promise.reject(new Error("should not be called")),
        }),
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("result" in response.body);
  if (!("result" in response.body)) return;
  assert.equal(response.body.result, null);
  assert.equal(response.body.providerMeta[0]?.enabled, false);
  assert.equal(response.body.providerMeta[0]?.found, false);
  assert.equal(response.body.providerMeta[0]?.error, undefined);
  assertProviderDuration(response.body.providerMeta[0]);
});

test("memory get reports unsupported getById capability", async () => {
  const response = await executeMemoryGetRequest(
    { provider: "noosphere", id: "article-1" },
    {
      providers: [
        mockProvider("noosphere", null, {
          descriptor: {
            ...mockProvider("noosphere").descriptor,
            capabilities: {
              ...mockProvider("noosphere").descriptor.capabilities,
              getById: false,
            },
          },
          getById: () => Promise.reject(new Error("should not be called")),
        }),
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("result" in response.body);
  if (!("result" in response.body)) return;
  assert.equal(response.body.result, null);
  assert.equal(response.body.providerMeta[0]?.enabled, true);
  assert.equal(response.body.providerMeta[0]?.found, false);
  assert.equal(
    response.body.providerMeta[0]?.error,
    "Provider does not support getById",
  );
  assertProviderDuration(response.body.providerMeta[0]);
});

test("memory get rejects unknown providers", async () => {
  const response = await executeMemoryGetRequest(
    { provider: "missing", id: "article-1" },
    { providers: [mockProvider("noosphere")] },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Unknown provider ID: missing" });
});

test("memory get preserves provider errors as metadata", async () => {
  const response = await executeMemoryGetRequest(
    { provider: "broken", id: "article-1" },
    {
      providers: [
        mockProvider("broken", null, {
          getById: () => Promise.reject(new Error("provider unavailable")),
        }),
      ],
    },
  );

  assert.equal(response.status, 200);
  assert.ok("result" in response.body);
  if (!("result" in response.body)) return;
  assert.equal(response.body.result, null);
  assert.equal(response.body.providerMeta[0]?.error, "provider unavailable");
  assertProviderDuration(response.body.providerMeta[0]);
});

function assertProviderDuration(meta: { durationMs?: number } | undefined) {
  assert.equal(typeof meta?.durationMs, "number");
  assert.ok((meta?.durationMs ?? -1) >= 0);
}
