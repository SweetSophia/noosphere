/**
 * HindsightProvider — Unit Tests
 *
 * Run with: npx tsx src/__tests__/memory/hindsight-provider.test.ts
 *
 * Tests cover:
 * 1. Constructor validation (baseUrl, apiKey, bankId, fetch impl)
 * 2. Descriptor correctness (id, sourceType, capabilities, config)
 * 3. URL normalization (trailing slash strip, HTTPS enforcement)
 * 4. search() — happy path, limit, empty results
 * 5. search() — options passthrough (budget, types, maxTokens, queryTimestamp, tags)
 * 6. search() — HTTP error handling with parsed error messages
 * 7. search() — JSON parse failure handling
 * 8. getById() — always returns null (not supported)
 * 9. Factory createHindsightProvider()
 * 10. Default config options (defaultBudget, defaultTypes, defaultMaxTokens)
 */

import {
  HindsightProvider,
  createHindsightProvider,
  type HindsightProviderSettings,
} from "@/lib/memory/hindsight";
import type { MemoryProviderConfig } from "@/lib/memory/provider";

// ─── Test runner ───────────────────────────────────────────────────────────

let testCounter = 0;
let passCount = 0;
let failCount = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  testCounter++;
  const label = `[${testCounter}] ${name}`;
  const p = Promise.resolve()
    .then(() => fn())
    .then(() => {
      passCount++;
      console.log(`  ✓ ${label}`);
    })
    .catch((err: unknown) => {
      failCount++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label}\n    ${message}`);
    });
  pending.push(p);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    return aArr.every((v, i) => deepEqual(v, bArr[i]));
  }
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k))) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

function assertMatch(actual: string, regex: RegExp, label: string): void {
  if (!regex.test(actual)) {
    throw new Error(
      `${label}: value "${actual}" did not match regex ${regex}`,
    );
  }
}

function assertIncludes(actual: string, substring: string, label: string): void {
  if (!actual.includes(substring)) {
    throw new Error(
      `${label}: "${actual}" does not include "${substring}"`,
    );
  }
}

// ─── Mock fetch factory ─────────────────────────────────────────────────────

type MockFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

interface MockFetch {
  fetch: typeof fetch;
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }>;
}

function createMockFetch(responses: MockFetchResponse[]): MockFetch {
  let callIndex = 0;
  const calls: MockFetch["calls"] = [];

  const mock: MockFetch = {
    calls,
    fetch: async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = responses[callIndex++] ?? {
        ok: false,
        status: 500,
        statusText: "No more mock responses",
        json: async () => ({}),
        text: async () => "{}",
      };
      calls.push({
        url: String(url),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === "string" ? init.body : "",
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        json: response.json,
        text: response.text,
      } as Response;
    },
  };

  return mock;
}

// ─── Shared mock response factories ────────────────────────────────────────

function mockRecallResponse(
  results: Array<{
    id: string;
    text: string;
    type?: string;
    context?: string | null;
    tags?: string[] | null;
    entities?: string[] | null;
    occurred_start?: string | null;
    occurred_end?: string | null;
    mentioned_at?: string | null;
    document_id?: string | null;
    chunk_id?: string | null;
    source_fact_ids?: string[] | null;
    proof_count?: number | null;
    metadata?: Record<string, string> | null;
  }> = [],
) {
  return {
    results: results.map((r) => ({
      id: r.id,
      text: r.text,
      type: r.type ?? "world",
      context: r.context ?? null,
      tags: r.tags ?? null,
      entities: r.entities ?? null,
      occurred_start: r.occurred_start ?? null,
      occurred_end: r.occurred_end ?? null,
      mentioned_at: r.mentioned_at ?? null,
      document_id: r.document_id ?? null,
      chunk_id: r.chunk_id ?? null,
      source_fact_ids: r.source_fact_ids ?? null,
      proof_count: r.proof_count ?? null,
      metadata: r.metadata ?? null,
    })),
  };
}

// ─── Constructor validation ─────────────────────────────────────────────────

test("throws when baseUrl is missing", () => {
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "",
      apiKey: "test-key",
      bankId: "test-bank",
    } as HindsightProviderSettings);
  } catch (err: unknown) {
    threw = err instanceof Error && err.message.includes("baseUrl");
  }
  if (!threw) throw new Error("Should have thrown for missing baseUrl");
});

test("throws when apiKey is missing", () => {
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "https://api.example.com",
      apiKey: "",
      bankId: "test-bank",
    } as HindsightProviderSettings);
  } catch (err: unknown) {
    threw = err instanceof Error && err.message.includes("apiKey");
  }
  if (!threw) throw new Error("Should have thrown for missing apiKey");
});

test("throws when bankId is missing", () => {
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      bankId: "",
    } as HindsightProviderSettings);
  } catch (err: unknown) {
    threw = err instanceof Error && err.message.includes("bankId");
  }
  if (!threw) throw new Error("Should have thrown for missing bankId");
});

test("throws when fetch is not a function", () => {
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      bankId: "test-bank",
      fetch: "not a function" as unknown as typeof fetch,
    } as HindsightProviderSettings);
  } catch (err: unknown) {
    threw = err instanceof Error && err.message.includes("fetch");
  }
  if (!threw) throw new Error("Should have thrown for non-function fetch");
});

test("throws when baseUrl is not HTTPS (without allowInsecureBaseUrl)", () => {
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "http://api.example.com",
      apiKey: "test-key",
      bankId: "test-bank",
    } as HindsightProviderSettings);
  } catch (err: unknown) {
    threw = err instanceof Error && err.message.includes("HTTPS");
  }
  if (!threw) throw new Error("Should have thrown for non-HTTPS baseUrl");
});

test("allows HTTP baseUrl when allowInsecureBaseUrl is true", () => {
  // Should not throw
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "http://insecure.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
    allowInsecureBaseUrl: true,
  });
  assertEqual(provider.descriptor.id, "hindsight", "id should be set");
});

test("strips trailing slashes from baseUrl", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com///",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });
  // Access private field via any — only for test inspection
  const baseUrl = (provider as unknown as { baseUrl: string }).baseUrl;
  assertEqual(baseUrl, "https://api.example.com", "trailing slashes stripped");
});

// ─── Descriptor ────────────────────────────────────────────────────────────

test("descriptor has correct id", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });
  assertEqual(provider.descriptor.id, "hindsight", "id");
});

test("descriptor has correct sourceType", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });
  assertEqual(provider.descriptor.sourceType, "hindsight", "sourceType");
});

test("descriptor has correct capabilities", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });
  assertEqual(provider.descriptor.capabilities.search, true, "search");
  assertEqual(provider.descriptor.capabilities.getById, false, "getById");
  assertEqual(provider.descriptor.capabilities.score, false, "score");
  assertEqual(provider.descriptor.capabilities.autoRecall, true, "autoRecall");
});

test("descriptor metadata contains bankId", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "my-bank-123",
    fetch: mockFetch.fetch,
  });
  assertEqual(
    (provider.descriptor.metadata as Record<string, unknown>)?.bankId,
    "my-bank-123",
    "bankId in metadata",
  );
});

test("descriptor defaultConfig can be overridden", () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
    providerConfig: {
      priorityWeight: 2.5,
      allowAutoRecall: false,
    },
  });
  assertEqual(provider.descriptor.defaultConfig.priorityWeight, 2.5, "weight");
  assertEqual(
    provider.descriptor.defaultConfig.allowAutoRecall,
    false,
    "autoRecall override",
  );
});

// ─── search() happy path ────────────────────────────────────────────────────

test("search returns results from Hindsight API", async () => {
  const recallResponse = mockRecallResponse([
    {
      id: "mem-abc",
      text: "Sophie prefers dark mode",
      type: "experience",
      context: "user preference",
      tags: ["sophie", "ui"],
    },
    {
      id: "mem-def",
      text: "Project uses PostgreSQL",
      type: "world",
      context: null,
    },
  ]);

  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => recallResponse,
      text: async () => JSON.stringify(recallResponse),
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("dark mode");

  assertEqual(results.length, 2, "result count");
  assertEqual(results[0].id, "mem-abc", "first id");
  assertEqual(results[0].provider, "hindsight", "provider");
  assertEqual(results[0].sourceType, "hindsight", "sourceType");
  assertEqual(results[0].content, "Sophie prefers dark mode", "content");
  assertEqual(results[0].title, "experience: user preference", "title");
  assertEqual(results[0].curationLevel, "ephemeral", "curationLevel");
  assertEqual(results[0].canonicalRef, "hindsight:test-bank:mem-abc", "canonicalRef");
  assertEqual(results[0].tags, ["sophie", "ui"], "tags");
  assertEqual(
    (results[0].metadata as Record<string, unknown>)?.hindsightType,
    "experience",
    "hindsightType in metadata",
  );
  assertEqual(
    (results[0].metadata as Record<string, unknown>)?.context,
    "user preference",
    "context in metadata",
  );
});

test("search uses POST to correct endpoint", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => '{"results":[]}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "secret-key",
    bankId: "my-bank",
    fetch: mockFetch.fetch,
  });

  await provider.search("test query");

  const calls = mockFetch.calls;
  assertEqual(calls.length, 1, "one call");
  assertEqual(calls[0].method, "POST", "POST method");
  assertIncludes(
    calls[0].url,
    "/v1/my-bank/memories/recall",
    "recall endpoint URL",
  );
  assertEqual(calls[0].headers["Authorization"], "Bearer secret-key", "auth header");
  assertEqual(calls[0].headers["Content-Type"], "application/json", "content-type");
});

test("search sends correct body to API", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => '{"results":[]}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    defaultBudget: "high",
    defaultTypes: ["world", "experience"],
    defaultMaxTokens: 2048,
    fetch: mockFetch.fetch,
  });

  await provider.search("my query");

  const calls = mockFetch.calls;
  const body = JSON.parse(calls[0].body);
  assertEqual(body.query, "my query", "query field");
  assertEqual(body.budget, "high", "budget");
  assertEqual(body.types, ["world", "experience"], "types");
  assertEqual(body.max_tokens, 2048, "max_tokens");
});

test("search respects limit option", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => mockRecallResponse([
        { id: "mem-1", text: "First" },
        { id: "mem-2", text: "Second" },
        { id: "mem-3", text: "Third" },
      ]),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test", { limit: 2 });
  assertEqual(results.length, 2, "limited to 2");
  assertEqual(results[0].id, "mem-1", "first id");
  assertEqual(results[1].id, "mem-2", "second id");
});

test("search falls back to config.maxResults when limit is not set", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => mockRecallResponse([
        { id: "mem-1", text: "First" },
        { id: "mem-2", text: "Second" },
        { id: "mem-3", text: "Third" },
      ]),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  // No explicit limit — should cap at config.maxResults (2)
  const results = await provider.search("test", {
    config: { maxResults: 2 } as Partial<MemoryProviderConfig>,
  });
  assertEqual(results.length, 2, "capped to config.maxResults");
});

test("search returns empty array when no results", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => '{"results":[]}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("nonexistent");
  assertEqual(results.length, 0, "empty results");
});

test("search respects metadata options (budget, types, maxTokens, tags)", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => '{"results":[]}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  await provider.search("test query", {
    metadata: {
      budget: "low",
      types: ["observation"],
      maxTokens: 512,
      queryTimestamp: "2026-04-27T10:00:00Z",
      tags: ["urgent", " Sophie"],
      tagsMatch: "all",
    } as Record<string, unknown>,
  });

  const calls = mockFetch.calls;
  const body = JSON.parse(calls[0].body);
  assertEqual(body.budget, "low", "budget override");
  assertEqual(body.types, ["observation"], "types override");
  assertEqual(body.max_tokens, 512, "max_tokens override");
  assertEqual(body.query_timestamp, "2026-04-27T10:00:00Z", "query_timestamp");
  assertEqual(body.tags, ["urgent", " Sophie"], "tags");
  assertEqual(body.tags_match, "all", "tags_match");
});

test("search skips undefined/null body fields", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => '{"results":[]}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  await provider.search("test");

  const calls = mockFetch.calls;
  const body = JSON.parse(calls[0].body);
  assertEqual(body.query_timestamp, undefined, "query_timestamp not sent");
  assertEqual(body.tags, undefined, "tags not sent");
  assertEqual(body.max_tokens, undefined, "max_tokens not sent");
});

test("search derives title from type when no context", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => mockRecallResponse([
        { id: "mem-1", text: "Some fact", type: "world", context: null },
      ]),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test");
  assertEqual(results[0].title, "world", "title from type alone");
});

test("search derives createdAt/updatedAt from occurred_start/occurred_end", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [{
          id: "mem-1",
          text: "Summary",
          type: "experience",
          occurred_start: "2026-01-01T00:00:00Z",
          occurred_end: "2026-03-15T12:30:00Z",
        }],
      }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test");
  assertEqual(results[0].createdAt, "2026-01-01T00:00:00Z", "createdAt from occurred_start");
  assertEqual(results[0].updatedAt, "2026-03-15T12:30:00Z", "updatedAt from occurred_end");
});

test("search includes sourceFacts metadata when present", async () => {
  const fact1 = { id: "fact-1", text: "Source fact text", type: "world" };
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [{
          id: "mem-1",
          text: "Summary",
          type: "experience",
          source_fact_ids: ["fact-1"],
        }],
        source_facts: { "fact-1": fact1 },
      }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test");
  const meta = results[0].metadata as Record<string, unknown>;
  assertEqual(
    (meta?.sourceFacts as unknown[])?.[0],
    fact1,
    "sourceFacts populated",
  );
  assertEqual(meta?.sourceFactsTruncated, false, "not truncated");
});

test("search truncates sourceFacts at MAX_METADATA_SOURCE_FACTS (5)", async () => {
  const facts = Array.from({ length: 8 }, (_, i) => ({
    id: `fact-${i}`,
    text: `Fact ${i}`,
    type: "world",
  }));
  const factIds = facts.map((f) => f.id);
  const sourceFacts = Object.fromEntries(facts.map((f) => [f.id, f]));

  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [{ id: "mem-1", text: "Summary", source_fact_ids: factIds }], source_facts: sourceFacts }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test");
  const meta = results[0].metadata as Record<string, unknown>;
  assertEqual((meta?.sourceFacts as unknown[]).length, 5, "capped to 5 facts");
  assertEqual(meta?.sourceFactsTruncated, true, "truncated flag set");
});

test("search populates missingSourceFactIds for dangling references", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [{
          id: "mem-1",
          text: "Summary",
          source_fact_ids: ["fact-1", "fact-missing", "fact-2"],
        }],
        source_facts: {
          "fact-1": { id: "fact-1", text: "Fact 1", type: "world" },
          "fact-2": { id: "fact-2", text: "Fact 2", type: "world" },
        },
      }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const results = await provider.search("test");
  const meta = results[0].metadata as Record<string, unknown>;
  assertEqual(
    meta?.missingSourceFactIds,
    ["fact-missing"],
    "dangling fact IDs collected",
  );
});

// ─── Error handling ────────────────────────────────────────────────────────

test("search throws on non-ok response with status text", async () => {
  const mockFetch = createMockFetch([
    {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ message: "Bank not found" }),
      text: async () => '{"message":"Bank not found"}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "bad-bank",
    fetch: mockFetch.fetch,
  });

  let threw = false;
  try {
    await provider.search("test");
  } catch (err: unknown) {
    threw = true;
    assertMatch(
      (err as Error).message,
      /503/,
      "status code in error",
    );
    assertMatch(
      (err as Error).message,
      /Bank not found/,
      "parsed message in error",
    );
  }
  assert(threw, "should have thrown");
});

test("search throws on non-ok response without body", async () => {
  const mockFetch = createMockFetch([
    {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => { throw new Error("not json"); },
      text: async () => { throw new Error("read failed"); },
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  let threw = false;
  try {
    await provider.search("test");
  } catch (err: unknown) {
    threw = true;
    assertMatch(
      (err as Error).message,
      /500/,
      "status code in error",
    );
  }
  assert(threw, "should have thrown");
});

test("search throws on malformed JSON response", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => { throw new Error("parse error"); },
      text: async () => "not valid json{{{",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  let threw = false;
  try {
    await provider.search("test");
  } catch (err: unknown) {
    threw = true;
    assertMatch(
      (err as Error).message,
      /parse/i,
      "parse error message",
    );
  }
  assert(threw, "should have thrown");
});

test("search error body is truncated at 1000 chars", async () => {
  const longBody = '{"message":"' + "x".repeat(2000) + '"}';
  const mockFetch = createMockFetch([
    {
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "x".repeat(2000) }),
      text: async () => longBody,
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  let threw = false;
  try {
    await provider.search("test");
  } catch (err: unknown) {
    threw = true;
    const msg = (err as Error).message;
    assert(msg.length < longBody.length, "truncated vs original");
    assertIncludes(msg, "x".repeat(1000) + "...", "truncation marker");
  }
  assert(threw, "should have thrown");
});

test("search error parses error.error.message field", async () => {
  const mockFetch = createMockFetch([
    {
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ error: { message: "Invalid query syntax" } }),
      text: async () => '{"error":{"message":"Invalid query syntax"}}',
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  let threw = false;
  try {
    await provider.search("test");
  } catch (err: unknown) {
    threw = true;
    assertMatch(
      (err as Error).message,
      /Invalid query syntax/,
      "nested error message",
    );
  }
  assert(threw, "should have thrown");
});

// ─── getById ───────────────────────────────────────────────────────────────

test("getById always returns null (not supported)", async () => {
  const mockFetch = createMockFetch([]);
  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  const result = await provider.getById("mem-abc");
  assertEqual(result, null, "always null");
});

// ─── Factory ───────────────────────────────────────────────────────────────

test("createHindsightProvider returns a HindsightProvider instance", () => {
  const mockFetch = createMockFetch([]);
  const provider = createHindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });
  assertEqual(provider.descriptor.id, "hindsight", "is hindsight provider");
});

test("default budget is mid when not specified", () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    fetch: mockFetch.fetch,
  });

  // Access private field via any
  const defaultBudget = (provider as unknown as { defaultBudget: string }).defaultBudget;
  assertEqual(defaultBudget, "mid", "default budget");
});

test("custom default budget is used", async () => {
  const mockFetch = createMockFetch([
    {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
      text: async () => "{}",
    },
  ]);

  const provider = new HindsightProvider({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    bankId: "test-bank",
    defaultBudget: "high",
    fetch: mockFetch.fetch,
  });

  await provider.search("test");

  const calls = mockFetch.calls;
  const body = JSON.parse(calls[0].body);
  assertEqual(body.budget, "high", "custom budget");
});

test("uses global fetch when fetch not provided", () => {
  // In Node 18+ globalThis.fetch is available, so this should not throw.
  // This test verifies the constructor gracefully accepts missing fetch param
  // and uses globalThis.fetch as the default.
  if (typeof globalThis.fetch !== "function") {
    // Skip in environments without global fetch
    return;
  }
  let threw = false;
  try {
    new HindsightProvider({
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      bankId: "test-bank",
    });
  } catch {
    threw = true;
  }
  assert(!threw, "constructor should not throw when globalThis.fetch is available");
});

// ─── Run ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  HindsightProvider Tests\n");

  await Promise.all(pending);

  console.log(
    `\n  ${passCount} passed, ${failCount} failed, ${testCounter} total\n`,
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
