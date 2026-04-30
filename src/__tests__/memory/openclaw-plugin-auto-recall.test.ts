import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoRecallQuery,
  createNoosphereAutoRecallHook,
  MAX_QUERY_LENGTH,
  resolveAutoRecallConfig,
} from "../../../openclaw-noosphere-memory/src/auto-recall.js";
import type { NoosphereRecallRequest, NoosphereRecallResponse } from "../../../openclaw-noosphere-memory/src/client.js";
import type { NoosphereClientContext } from "../../../openclaw-noosphere-memory/src/shared-init.js";

function makeContext(overrides: Partial<NoosphereClientContext["config"]> = {}) {
  const calls: NoosphereRecallRequest[] = [];
  const response: NoosphereRecallResponse = {
    results: [],
    totalBeforeCap: 1,
    mode: "auto",
    tokenBudgetUsed: 12,
    providerMeta: [],
    promptInjectionText: "<recall>\n  <item>Remember the Omnissiah.</item>\n</recall>",
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

    const falsy = resolveAutoRecallConfig({ autoRecall: "false", includeRecentTurns: "0" });

    assert.equal(falsy.autoRecall, false);
    assert.equal(falsy.includeRecentTurns, false);
  });

  it("normalizes recallInjectionPosition with prepend as fallback", () => {
    assert.equal(resolveAutoRecallConfig({ recallInjectionPosition: "system-prepend" }).recallInjectionPosition, "system-prepend");
    assert.equal(resolveAutoRecallConfig({ recallInjectionPosition: "append" }).recallInjectionPosition, "prepend");
    assert.equal(resolveAutoRecallConfig({ recallInjectionPosition: "unexpected" }).recallInjectionPosition, "prepend");
  });
});

describe("OpenClaw Noosphere plugin auto-recall", () => {
  it("injects promptInjectionText from Noosphere auto recall when enabled", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook({ prompt: "what do we know about Noosphere?", messages: [] }, { agentId: "cylena" });

    assert.equal(result?.prependContext?.includes("<noosphere_auto_recall>"), true);
    assert.equal(result?.prependContext?.includes("<hindsight_memories>"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "auto");
    assert.deepEqual(calls[0].providers, ["noosphere"]);
    assert.equal(calls[0].resultCap, 5);
    assert.equal(calls[0].tokenBudget, 1200);
  });

  it("returns nothing when recall is empty", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const context = {
      config: { baseUrl: "http://noosphere.local", apiKey: "noo_test", timeoutMs: 5000 },
      client: {
        async recall(request: NoosphereRecallRequest): Promise<NoosphereRecallResponse> {
          calls.push(request);
          return { results: [], totalBeforeCap: 0, mode: "auto", providerMeta: [], promptInjectionText: "   " };
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook({ prompt: "No matching durable memory", messages: [] }, {});

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
  });

  it("fails open and logs a warning on recall errors", async () => {
    const warnings: string[] = [];
    const context = {
      config: { baseUrl: "http://noosphere.local", apiKey: "noo_test", timeoutMs: 5000 },
      client: {
        async recall(): Promise<NoosphereRecallResponse> {
          throw new Error("network down");
        },
      },
    } as unknown as NoosphereClientContext;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context, { warn: (message) => warnings.push(message) });

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /auto-recall skipped/);
  });

  it("honors enabledAgents and allowedChatTypes gates", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook(
      { autoRecall: true, enabledAgents: ["cylena"], allowedChatTypes: ["telegram"] },
      context,
    );

    assert.equal(await hook({ prompt: "Noosphere memory", messages: [] }, { agentId: "other", messageProvider: "telegram" }), undefined);
    assert.equal(await hook({ prompt: "Noosphere memory", messages: [] }, { agentId: "cylena", messageProvider: "discord" }), undefined);

    const result = await hook({ prompt: "Noosphere memory", messages: [] }, { agentId: "cylena", messageProvider: "telegram" });

    assert.equal(result?.prependContext?.includes("<noosphere_auto_recall>"), true);
    assert.equal(calls.length, 1);
  });

  it("builds a bounded query from recent user turns plus current prompt", () => {
    const query = buildAutoRecallQuery(
      {
        prompt: "current question",
        messages: [
          { role: "user", content: "older user turn" },
          { role: "assistant", content: "assistant text ignored" },
          { role: "user", content: [{ type: "text", text: "recent user turn" }] },
        ],
      },
      resolveAutoRecallConfig({ autoRecall: true, recentTurnLimit: 1 }),
    );

    assert.equal(query, "recent user turn\n\ncurrent question");
  });

  it("supports configured injection positions", async () => {
    const { context } = makeContext();
    const hook = createNoosphereAutoRecallHook({ autoRecall: true, recallInjectionPosition: "system-prepend" }, context);

    const result = await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(result?.prependContext, undefined);
    assert.equal(result?.prependSystemContext?.includes("<noosphere_auto_recall>"), true);
  });

  it("returns nothing when promptInjectionText is missing", async () => {
    const calls: NoosphereRecallRequest[] = [];
    const context = {
      config: { baseUrl: "http://noosphere.local", apiKey: "noo_test", timeoutMs: 5000 },
      client: {
        async recall(request: NoosphereRecallRequest): Promise<NoosphereRecallResponse> {
          calls.push(request);
          return { results: [], totalBeforeCap: 0, mode: "auto", providerMeta: [] } as NoosphereRecallResponse;
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
      config: { baseUrl: "http://noosphere.local", apiKey: "noo_test", timeoutMs: 5000 },
      client: {
        async recall(request: NoosphereRecallRequest): Promise<NoosphereRecallResponse> {
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
      config: { baseUrl: "http://noosphere.local", apiKey: "noo_test", timeoutMs: 5000 },
      client: {
        async recall(request: NoosphereRecallRequest, options?: { timeoutMs?: number }): Promise<NoosphereRecallResponse> {
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
    const hook = createNoosphereAutoRecallHook({ autoRecall: true, autoRecallTimeoutMs: 1234 }, context);

    await hook({ prompt: "Noosphere bridge", messages: [] }, {});

    assert.equal(calls.length, 1);
    assert.deepEqual(timeouts, [1234]);
  });

  it("skips recall when the assembled query is shorter than minQueryLength", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook({ autoRecall: true, minQueryLength: 1000 }, context);

    const result = await hook({ prompt: "short", messages: [{ role: "user", content: "tiny" }] }, {});

    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  it("truncates overlong auto-recall queries from the start to preserve the current prompt", async () => {
    const { context, calls } = makeContext();
    const currentPrompt = `${"x".repeat(MAX_QUERY_LENGTH + 100)} current question`;
    const hook = createNoosphereAutoRecallHook({ autoRecall: true, recentTurnLimit: 3 }, context);

    await hook(
      {
        prompt: currentPrompt,
        messages: [
          { role: "user", content: "older user turn that should be dropped first" },
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
