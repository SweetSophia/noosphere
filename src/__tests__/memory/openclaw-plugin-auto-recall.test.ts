import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoRecallQuery,
  createNoosphereAutoRecallHook,
  MAX_QUERY_LENGTH,
  resolveAutoRecallConfig,
} from "../../../openclaw-noosphere-memory/src/auto-recall.js";
import { createNoosphereCorpusSupplement } from "../../../openclaw-noosphere-memory/src/corpus-supplement.js";
import {
  NoosphereClientError,
  NoosphereMemoryClient,
  type NoosphereGetRequest,
  type NoosphereGetResponse,
  type NoosphereSaveRequest,
  type NoosphereSaveResponse,
} from "../../../openclaw-noosphere-memory/src/client.js";
import type {
  NoosphereRecallRequest,
  NoosphereRecallResponse,
} from "../../../openclaw-noosphere-memory/src/client.js";
import { createNoosphereGetTool } from "../../../openclaw-noosphere-memory/src/tools/get.js";
import { createNoosphereSaveTool } from "../../../openclaw-noosphere-memory/src/tools/save.js";
import type { NoosphereClientContext } from "../../../openclaw-noosphere-memory/src/shared-init.js";

function makeContext(
  overrides: Partial<NoosphereClientContext["config"]> = {},
) {
  const calls: NoosphereRecallRequest[] = [];
  const response: NoosphereRecallResponse = {
    results: [],
    totalBeforeCap: 1,
    mode: "auto",
    tokenBudgetUsed: 12,
    providerMeta: [],
    promptInjectionText:
      "<recall>\n  <item>Remember the Omnissiah.</item>\n</recall>",
  };

  const context = {
    config: {
      baseUrl: "http://noosphere.local",
      apiKey: "noo_test",
      timeoutMs: 5000,
      ...overrides,
    },
    client: {
      async recall(request: NoosphereRecallRequest) {
        calls.push(request);
        return response;
      },
    },
  } as unknown as NoosphereClientContext;

  return { context, calls };
}

describe("resolveAutoRecallConfig", () => {
  it("is disabled by default to avoid duplicate memory injection", () => {
    const config = resolveAutoRecallConfig({});

    assert.equal(config.autoRecall, false);
    assert.deepEqual(config.autoProviders, ["noosphere"]);
  });

  it("normalizes boolean-ish values and allowlist arrays", () => {
    const truthy = resolveAutoRecallConfig({
      autoRecall: "true",
      includeRecentTurns: "1",
      enabledAgents: ["  cylena  ", "", "seriania"],
      allowedChatTypes: ["  telegram  ", "", "discord"],
    });

    assert.equal(truthy.autoRecall, true);
    assert.equal(truthy.includeRecentTurns, true);
    assert.deepEqual(truthy.enabledAgents, ["cylena", "seriania"]);
    assert.deepEqual(truthy.allowedChatTypes, ["telegram", "discord"]);

    const falsy = resolveAutoRecallConfig({
      autoRecall: "false",
      includeRecentTurns: "0",
    });

    assert.equal(falsy.autoRecall, false);
    assert.equal(falsy.includeRecentTurns, false);
  });

  it("normalizes recallInjectionPosition with prepend as fallback", () => {
    assert.equal(
      resolveAutoRecallConfig({ recallInjectionPosition: "system-prepend" })
        .recallInjectionPosition,
      "system-prepend",
    );
    assert.equal(
      resolveAutoRecallConfig({ recallInjectionPosition: "append" })
        .recallInjectionPosition,
      "prepend",
    );
    assert.equal(
      resolveAutoRecallConfig({ recallInjectionPosition: "unexpected" })
        .recallInjectionPosition,
      "prepend",
    );
  });
});

describe("OpenClaw Noosphere plugin auto-recall", () => {
  it("injects promptInjectionText from Noosphere auto recall when enabled", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook(
      { prompt: "what do we know about Noosphere?", messages: [] },
      { agentId: "cylena" },
    );

    assert.equal(
      result?.prependContext?.includes("<noosphere_auto_recall>"),
      true,
    );
    assert.equal(
      result?.prependContext?.includes("<hindsight_memories>"),
      false,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "auto");
    assert.deepEqual(calls[0].providers, ["noosphere"]);
    assert.equal(calls[0].resultCap, 5);
    assert.equal(calls[0].tokenBudget, 1200);
  });

  it("returns nothing when recall is empty", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(
          request: NoosphereRecallRequest,
        ): Promise<NoosphereRecallResponse> {
          calls.push(request);
          return {
            results: [],
            totalBeforeCap: 0,
            mode: "auto",
            providerMeta: [],
            promptInjectionText: "   ",
          };
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook(
      { prompt: "No matching durable memory", messages: [] },
      {},
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
  });

  it("fails open and logs a warning on recall errors", async () => {
    const warnings: string[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          throw new Error("network down");
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context, {
      warn: (message) => warnings.push(message),
    });

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /auto-recall skipped/);
  });

  it("honors enabledAgents and allowedChatTypes gates", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook(
      {
        autoRecall: true,
        enabledAgents: ["cylena"],
        allowedChatTypes: ["telegram"],
      },
      context,
    );

    assert.equal(
      await hook(
        { prompt: "Noosphere memory", messages: [] },
        { agentId: "other", messageProvider: "telegram" },
      ),
      undefined,
    );
    assert.equal(
      await hook(
        { prompt: "Noosphere memory", messages: [] },
        { agentId: "cylena", messageProvider: "discord" },
      ),
      undefined,
    );

    const result = await hook(
      { prompt: "Noosphere memory", messages: [] },
      { agentId: "cylena", messageProvider: "telegram" },
    );

    assert.equal(
      result?.prependContext?.includes("<noosphere_auto_recall>"),
      true,
    );
    assert.equal(calls.length, 1);
  });

  it("builds a bounded query from recent user turns plus current prompt", () => {
    const query = buildAutoRecallQuery(
      {
        prompt: "current question",
        messages: [
          { role: "user", content: "older user turn" },
          { role: "assistant", content: "assistant text ignored" },
          {
            role: "user",
            content: [{ type: "text", text: "recent user turn" }],
          },
        ],
      },
      resolveAutoRecallConfig({ autoRecall: true, recentTurnLimit: 1 }),
    );

    assert.equal(query, "recent user turn\n\ncurrent question");
  });

  it("supports configured injection positions", async () => {
    const { context } = makeContext();
    const hook = createNoosphereAutoRecallHook(
      { autoRecall: true, recallInjectionPosition: "system-prepend" },
      context,
    );

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result?.prependContext, undefined);
    assert.equal(
      result?.prependSystemContext?.includes("<noosphere_auto_recall>"),
      true,
    );
  });

  it("returns nothing when promptInjectionText is missing", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(
          request: NoosphereRecallRequest,
        ): Promise<NoosphereRecallResponse> {
          calls.push(request);
          return {
            results: [],
            totalBeforeCap: 0,
            mode: "auto",
            providerMeta: [],
          } as NoosphereRecallResponse;
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
  });

  it("skips injection when Noosphere does not return auto-mode prompt text", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(
          request: NoosphereRecallRequest,
        ): Promise<NoosphereRecallResponse> {
          calls.push(request);
          return {
            results: [],
            totalBeforeCap: 1,
            mode: "inspection",
            tokenBudgetUsed: 12,
            providerMeta: [],
            promptInjectionText: "<recall>inspection text</recall>",
          };
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
  });

  it("uses autoRecallTimeoutMs instead of the shared HTTP timeout", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const timeouts: Array<number | undefined> = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(
          request: NoosphereRecallRequest,
          options?: { timeoutMs?: number },
        ): Promise<NoosphereRecallResponse> {
          calls.push(request);
          timeouts.push(options?.timeoutMs);
          return {
            results: [],
            totalBeforeCap: 1,
            mode: "auto",
            tokenBudgetUsed: 12,
            providerMeta: [],
            promptInjectionText: "<recall>timeout text</recall>",
          };
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook(
      { autoRecall: true, autoRecallTimeoutMs: 1234 },
      context,
    );

    await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(calls.length, 1);
    assert.deepEqual(timeouts, [1234]);
  });

  it("skips recall when the assembled query is shorter than minQueryLength", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook(
      { autoRecall: true, minQueryLength: 1000 },
      context,
    );

    const result = await hook(
      { prompt: "short", messages: [{ role: "user", content: "tiny" }] },
      {},
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  it("truncates overlong auto-recall queries from the start to preserve the current prompt", async () => {
    const { context, calls } = makeContext();
    const currentPrompt = `${"x".repeat(MAX_QUERY_LENGTH + 100)} current question`;
    const hook = createNoosphereAutoRecallHook(
      { autoRecall: true, recentTurnLimit: 3 },
      context,
    );

    await hook(
      {
        prompt: currentPrompt,
        messages: [
          {
            role: "user",
            content: "older user turn that should be dropped first",
          },
          { role: "user", content: "recent user turn" },
        ],
      },
      {},
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].query.length, MAX_QUERY_LENGTH);
    assert.equal(calls[0].query.includes("older user turn"), false);
    assert.equal(calls[0].query.includes("current question"), true);
  });

  it("ignores missing-role messages and deduplicates recent user turns", () => {
    const query = buildAutoRecallQuery(
      {
        prompt: "current question",
        messages: [
          { content: "roleless content ignored" },
          { role: "user", content: "repeat" },
          { role: "user", content: "repeat" },
          { role: "user", content: "unique" },
        ],
      },
      resolveAutoRecallConfig({ autoRecall: true, recentTurnLimit: 4 }),
    );

    assert.equal(query, "repeat\n\nunique\n\ncurrent question");
  });
});

describe("OpenClaw Noosphere corpus supplement", () => {
  function makeCorpusContext() {
    const recallCalls: NoosphereRecallRequest[] = [];
    const getCalls: NoosphereGetRequest[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(request: NoosphereRecallRequest) {
          recallCalls.push(request);
          return {
            results: [
              {
                id: "article-1",
                provider: "noosphere",
                sourceType: "noosphere_article",
                canonicalRef: "noosphere:article:article-1",
                title: "Deployment Notes",
                content: "Line one.\nLine two.\nLine three.",
                summary: "Use the deployment workflow.",
                relevanceScore: 0.75,
                updatedAt: "2026-04-30T12:00:00.000Z",
              },
              { malformed: true },
            ],
            totalBeforeCap: 2,
            mode: "inspection",
            providerMeta: [],
          } as NoosphereRecallResponse;
        },
        async get(request: NoosphereGetRequest) {
          getCalls.push(request);
          return {
            result: {
              id: "article-1",
              provider: "noosphere",
              sourceType: "noosphere_article",
              canonicalRef: "noosphere:article:article-1",
              title: "Deployment Notes",
              content: "Line one.\nLine two.\nLine three.",
              updatedAt: "2026-04-30T12:00:00.000Z",
            },
            providerMeta: [
              { providerId: "noosphere", enabled: true, found: true },
            ],
          } as NoosphereGetResponse;
        },
      },
    } as unknown as NoosphereClientContext;

    return { context, recallCalls, getCalls };
  }

  it("adapts Noosphere recall results into memory corpus search results", async () => {
    const { context, recallCalls } = makeCorpusContext();
    const supplement = createNoosphereCorpusSupplement(context);

    const results = await supplement.search({
      query: " deployment workflow ",
      maxResults: 25,
    });

    assert.deepEqual(recallCalls, [
      {
        query: "deployment workflow",
        mode: "inspection",
        resultCap: 10,
        providers: ["noosphere"],
      },
    ]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      corpus: "noosphere",
      path: "noosphere:article:article-1",
      title: "Deployment Notes",
      kind: "noosphere_article",
      score: 0.75,
      snippet: "Use the deployment workflow.",
      id: "noosphere:article:article-1",
      citation: "noosphere:article:article-1",
      source: "noosphere",
      provenanceLabel: "Noosphere",
      sourceType: "noosphere_article",
      sourcePath: "noosphere:article:article-1",
      updatedAt: "2026-04-30T12:00:00.000Z",
    });
  });

  it("adapts corpus get lookups through canonical refs and line ranges", async () => {
    const { context, getCalls } = makeCorpusContext();
    const supplement = createNoosphereCorpusSupplement(context);

    const result = await supplement.get({
      lookup: " noosphere:article:article-1 ",
      fromLine: 2,
      lineCount: 1,
    });

    assert.deepEqual(getCalls, [
      { canonicalRef: "noosphere:article:article-1" },
    ]);
    assert.deepEqual(result, {
      corpus: "noosphere",
      path: "noosphere:article:article-1",
      title: "Deployment Notes",
      kind: "noosphere_article",
      content: "Line two.",
      fromLine: 2,
      lineCount: 1,
      id: "noosphere:article:article-1",
      provenanceLabel: "Noosphere",
      sourceType: "noosphere_article",
      sourcePath: "noosphere:article:article-1",
      updatedAt: "2026-04-30T12:00:00.000Z",
    });
  });

  it("bounds corpus supplement search queries", async () => {
    const { context, recallCalls } = makeCorpusContext();
    const supplement = createNoosphereCorpusSupplement(context);

    await supplement.search({ query: ` ${"x".repeat(1_100)} ` });

    assert.equal(recallCalls.length, 1);
    assert.equal(recallCalls[0].query.length, 1_000);
  });

  it("returns null for blank or empty-range corpus get inputs", async () => {
    const { context, recallCalls, getCalls } = makeCorpusContext();
    const supplement = createNoosphereCorpusSupplement(context);

    assert.deepEqual(await supplement.search({ query: "   " }), []);
    assert.equal(await supplement.get({ lookup: "   " }), null);
    assert.equal(
      await supplement.get({
        lookup: "noosphere:article:article-1",
        fromLine: 100,
      }),
      null,
    );
    assert.equal(recallCalls.length, 0);
    assert.equal(getCalls.length, 1);
  });

  it("validates corpus get results and canonical refs", async () => {
    const getCalls: NoosphereGetRequest[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          throw new Error("recall should not be called");
        },
        async get(request: NoosphereGetRequest): Promise<NoosphereGetResponse> {
          getCalls.push(request);
          return {
            result: {
              id: "article-1",
              provider: "noosphere",
              sourceType: "noosphere_article",
            } as unknown as NoosphereGetResponse["result"],
            providerMeta: [],
          };
        },
      },
    } as unknown as NoosphereClientContext;
    const supplement = createNoosphereCorpusSupplement(context);

    assert.equal(await supplement.get({ lookup: "article-1" }), null);
    assert.equal(await supplement.get({ lookup: "noosphere:article:" }), null);
    assert.deepEqual(getCalls, [{ provider: "noosphere", id: "article-1" }]);
  });

  it("bounds corpus get line counts", async () => {
    const getCalls: NoosphereGetRequest[] = [];
    const longContent = Array.from({ length: 600 }, (_, index) => `Line ${index + 1}`).join("\n");
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          throw new Error("recall should not be called");
        },
        async get(request: NoosphereGetRequest): Promise<NoosphereGetResponse> {
          getCalls.push(request);
          return {
            result: {
              id: "article-1",
              provider: "noosphere",
              sourceType: "noosphere_article",
              canonicalRef: "noosphere:article:article-1",
              content: longContent,
            },
            providerMeta: [],
          };
        },
      },
    } as unknown as NoosphereClientContext;
    const supplement = createNoosphereCorpusSupplement(context);

    const result = await supplement.get({
      lookup: "article-1",
      lineCount: 2_147_483_647,
    });

    assert.equal(result?.lineCount, 500);
    assert.equal(getCalls.length, 1);
  });

  it("normalizes snippets and relevance scores in corpus supplement search results", async () => {
    const longContent = `   This   is   text \n\n with  irregular   whitespace ${"and more text ".repeat(40)}`;
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          return {
            results: [
              {
                id: "missing-summary",
                provider: "noosphere",
                sourceType: "noosphere_article",
                content: longContent,
                relevanceScore: undefined,
              },
              {
                id: "high-score",
                provider: "noosphere",
                sourceType: "noosphere_article",
                summary: "   Short    summary   text   ",
                content: "Body not used when summary exists",
                relevanceScore: 10,
              },
              {
                id: "negative-score",
                provider: "noosphere",
                sourceType: "noosphere_article",
                content: "Negative score",
                relevanceScore: -5,
              },
              {
                id: "nan-score",
                provider: "noosphere",
                sourceType: "noosphere_article",
                content: "NaN score",
                relevanceScore: NaN,
              },
            ],
            totalBeforeCap: 4,
            mode: "inspection",
            providerMeta: [],
          };
        },
        async get(): Promise<NoosphereGetResponse> {
          throw new Error("get should not be called");
        },
      },
    } as unknown as NoosphereClientContext;
    const supplement = createNoosphereCorpusSupplement(context);

    const results = await supplement.search({ query: "deployment" });

    assert.equal(results.length, 4);
    assert.equal(results[0].snippet.length, 240);
    assert.equal(/\s{2,}/.test(results[0].snippet), false);
    assert.equal(results[1].snippet, "Short summary text");
    for (const result of results) {
      assert.equal(Number.isFinite(result.score), true);
      assert.equal(result.score >= 0 && result.score <= 1, true);
    }
  });

  it("fails open and warns when corpus supplement HTTP calls fail", async () => {
    const warnings: string[] = [];
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          throw new NoosphereClientError("network down");
        },
        async get(): Promise<NoosphereGetResponse> {
          throw new NoosphereClientError("network down");
        },
      },
    } as unknown as NoosphereClientContext;
    const supplement = createNoosphereCorpusSupplement(context, {
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(await supplement.search({ query: "deployment" }), []);
    assert.equal(await supplement.get({ lookup: "article-1" }), null);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /search skipped: network down/);
    assert.match(warnings[1], /get skipped: network down/);
  });
});

describe("OpenClaw Noosphere client", () => {
  it("rejects oversized response bodies before JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("{\"ok\":true}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "1000001",
        },
      });

    try {
      const client = new NoosphereMemoryClient({
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      });

      await assert.rejects(
        () => client.status(),
        /Noosphere response body is too large/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenClaw Noosphere get tool", () => {
  function makeGetContext() {
    const calls: NoosphereGetRequest[] = [];
    const response: NoosphereGetResponse = {
      result: {
        id: "article-1",
        provider: "noosphere",
        sourceType: "noosphere_article",
        canonicalRef: "noosphere:article:article-1",
        title: "Deployment Notes",
        content: "Use the deployment workflow.",
      },
      providerMeta: [{ providerId: "noosphere", enabled: true, found: true }],
    };

    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async get(request: NoosphereGetRequest) {
          calls.push(request);
          return response;
        },
      },
    } as unknown as NoosphereClientContext;

    return { context, calls, response };
  }

  it("normalizes provider/id get requests", async () => {
    const { context, calls } = makeGetContext();
    const tool = createNoosphereGetTool({}, context);

    const result = await tool.execute("tool-1", {
      provider: " noosphere ",
      id: " article-1 ",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ provider: "noosphere", id: "article-1" }]);
  });

  it("normalizes canonicalRef get requests", async () => {
    const { context, calls } = makeGetContext();
    const tool = createNoosphereGetTool({}, context);

    const result = await tool.execute("tool-1", {
      canonicalRef: " noosphere:article:article-1 ",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ canonicalRef: "noosphere:article:article-1" }]);
  });

  it("rejects mixed or wrong-typed get params before calling the client", async () => {
    const { context, calls } = makeGetContext();
    const tool = createNoosphereGetTool({}, context);

    const mixed = await tool.execute("tool-1", {
      provider: "noosphere",
      id: "article-1",
      canonicalRef: "noosphere:article:article-1",
    });
    const wrongTyped = await tool.execute("tool-2", {
      provider: "noosphere",
      id: 123,
    });

    assert.equal(mixed.isError, true);
    assert.equal(wrongTyped.isError, true);
    assert.equal(calls.length, 0);
    assert.match(String(mixed.content[0]?.text), /Use either canonicalRef/);
    assert.match(
      String(wrongTyped.content[0]?.text),
      /id must be a non-empty string/,
    );
  });

  it("formats get client errors as tool errors", async () => {
    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async get(): Promise<NoosphereGetResponse> {
          throw new NoosphereClientError(
            "Noosphere request failed with HTTP 401",
            401,
            { error: "Unauthorized" },
          );
        },
      },
    } as unknown as NoosphereClientContext;
    const tool = createNoosphereGetTool({}, context);

    const result = await tool.execute("tool-1", {
      provider: "noosphere",
      id: "article-1",
    });

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /HTTP 401/);
    assert.doesNotMatch(String(result.content[0]?.text), /noo_test/);
    assert.doesNotMatch(String(result.content[0]?.text), /noosphere\.local/);
  });
});

describe("OpenClaw Noosphere save tool", () => {
  function makeSaveContext() {
    const calls: NoosphereSaveRequest[] = [];
    const response: NoosphereSaveResponse = {
      success: true,
      candidate: {
        id: "article-1",
        title: "Save Candidate",
        slug: "save-candidate",
        topicId: "topic-1",
        status: "draft",
        url: "/wiki/memory/save-candidate",
      },
      strippedBlocks: [],
    };

    const context = {
      config: {
        baseUrl: "http://noosphere.local",
        apiKey: "noo_test",
        timeoutMs: 5000,
      },
      client: {
        async save(request: NoosphereSaveRequest) {
          calls.push(request);
          return response;
        },
      },
    } as unknown as NoosphereClientContext;

    return { context, calls };
  }

  it("normalizes save candidate requests", async () => {
    const { context, calls } = makeSaveContext();
    const tool = createNoosphereSaveTool({}, context);

    const result = await tool.execute("tool-1", {
      title: " Save Candidate ",
      content: " Durable content worth saving for future agents. ",
      topicId: " topic-1 ",
      tags: [" memory ", "bridge"],
      confidence: "low",
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        title: "Save Candidate",
        content: "Durable content worth saving for future agents.",
        topicId: "topic-1",
        excerpt: undefined,
        tags: ["memory", "bridge"],
        source: undefined,
        authorName: undefined,
        confidence: "low",
      },
    ]);
  });

  it("rejects malformed save params before calling the client", async () => {
    const { context, calls } = makeSaveContext();
    const tool = createNoosphereSaveTool({}, context);

    const missing = await tool.execute("tool-1", {
      title: "Save Candidate",
      content: "Durable content worth saving for future agents.",
    });
    const badTags = await tool.execute("tool-2", {
      title: "Save Candidate",
      content: "Durable content worth saving for future agents.",
      topicId: "topic-1",
      tags: "memory",
    });

    assert.equal(missing.isError, true);
    assert.equal(badTags.isError, true);
    assert.equal(calls.length, 0);
    assert.match(String(missing.content[0]?.text), /topicId is required/);
    assert.match(String(badTags.content[0]?.text), /tags must be an array/);
  });
});
