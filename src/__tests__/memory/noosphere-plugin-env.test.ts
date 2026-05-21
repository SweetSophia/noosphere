import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("Noosphere plugin environment isolation", () => {
  it("prefers Opencode-specific variables before generic Noosphere fallbacks", async () => {
    const { resolveConfig: resolveOpencodeConfig } = await import(
      new URL("../../../opencode-noosphere-memory/dist/config.js", import.meta.url).href
    );

    const config = resolveOpencodeConfig(undefined, {
      OPENCODE_NOOSPHERE_BASE_URL: "https://opencode.example.test",
      NOOSPHERE_BASE_URL: "https://generic.example.test",
      OPENCODE_NOOSPHERE_API_KEY: "noo_opencode",
      NOOSPHERE_API_KEY: "noo_generic",
      OPENCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID: "  topic-opencode  ",
      NOOSPHERE_AUTO_SAVE_TOPIC_ID: "topic-generic",
    } as NodeJS.ProcessEnv);

    assert.equal(config.baseUrl, "https://opencode.example.test");
    assert.equal(config.apiKey, "noo_opencode");
    assert.equal(config.autoSaveTopicId, "topic-opencode");
  });

  it("prefers Kilo-specific variables before generic Noosphere fallbacks", async () => {
    const { resolveConfig: resolveKiloConfig } = await import(
      new URL("../../../kilocode-noosphere-memory/dist/config.js", import.meta.url).href
    );

    const config = resolveKiloConfig(undefined, {
      KILOCODE_NOOSPHERE_BASE_URL: "https://kilo.example.test",
      NOOSPHERE_BASE_URL: "https://generic.example.test",
      KILOCODE_NOOSPHERE_API_KEY: "noo_kilo",
      NOOSPHERE_API_KEY: "noo_generic",
      KILOCODE_NOOSPHERE_AUTO_SAVE_TOPIC_ID: "  topic-kilo  ",
      NOOSPHERE_AUTO_SAVE_TOPIC_ID: "topic-generic",
    } as NodeJS.ProcessEnv);

    assert.equal(config.baseUrl, "https://kilo.example.test");
    assert.equal(config.apiKey, "noo_kilo");
    assert.equal(config.autoSaveTopicId, "topic-kilo");
  });
});
