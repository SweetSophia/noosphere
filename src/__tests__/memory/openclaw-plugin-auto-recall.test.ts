import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoRecallQuery,
  createNoosphereAutoRecallHook,
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

describe("OpenClaw Noosphere plugin auto-recall", () => {
  it("is disabled by default to avoid duplicate memory injection", () => {
    const config = resolveAutoRecallConfig({});

    assert.equal(config.autoRecall, false);
    assert.deepEqual(config.autoProviders, ["noosphere"]);
  });

  it("injects promptInjectionText from Noosphere auto recall when enabled", async () => {
    const { context, calls } = makeContext();
    const hook = createNoosphereAutoRecallHook({ autoRecall: true }, context);

    const result = await hook({ prompt: "what do we know about Noosphere?", messages: [] }, { agentId: "cylena" });

    assert.equal(result?.prependContext?.includes("<recall>"), true);
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

    assert.equal(result?.prependContext?.includes("<recall>"), true);
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
});
