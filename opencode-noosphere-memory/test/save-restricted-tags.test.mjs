import assert from "node:assert/strict";
import test from "node:test";
import { NoosphereOpencodePlugin } from "../dist/index.js";
import { NoosphereClient } from "../dist/client.js";

test("noosphere_save exposes bounded restrictedTags and forwards them", async () => {
  const originalSave = NoosphereClient.prototype.save;
  const calls = [];
  NoosphereClient.prototype.save = async function (request) {
    calls.push(request);
    return { saved: true };
  };
  try {
    const plugin = await NoosphereOpencodePlugin(
      { client: { app: { log: async () => {} } } },
      { apiKey: "test-only", authorName: "Test Author" },
    );
    const save = plugin.tool.noosphere_save;
    const scopes = ["team:private"];
    assert.deepEqual(save.args.restrictedTags.parse(scopes), scopes);
    assert.equal(save.args.restrictedTags.safeParse(["x".repeat(65)]).success, false);
    assert.equal(save.args.restrictedTags.safeParse(Array(17).fill("x")).success, false);
    const result = JSON.parse(await save.execute({
      title: "Draft", content: "Durable fact", topicId: "test-topic", restrictedTags: scopes,
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      title: "Draft", content: "Durable fact", topicId: "test-topic",
      restrictedTags: scopes, authorName: "Test Author",
    }]);
  } finally {
    NoosphereClient.prototype.save = originalSave;
  }
});
