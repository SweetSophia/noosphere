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
    } as unknown as NodeJS.ProcessEnv);

    assert.equal(config.baseUrl, "https://opencode.example.test");
    assert.equal(config.apiKey, "noo_opencode");
    assert.equal(config.autoSaveTopicId, "topic-opencode");
  });

  it("reports the Opencode-specific API key name when the client is unconfigured", async () => {
    const { NoosphereClient } = await import(
      new URL("../../../opencode-noosphere-memory/dist/client.js", import.meta.url).href
    );
    const { resolveConfig } = await import(
      new URL("../../../opencode-noosphere-memory/dist/config.js", import.meta.url).href
    );

    const client = new NoosphereClient(resolveConfig(undefined, {} as unknown as NodeJS.ProcessEnv));

    await assert.rejects(() => client.status(), (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /OPENCODE_NOOSPHERE_API_KEY/);
      assert.match(message, /NOOSPHERE_API_KEY/);
      return true;
    });
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
    } as unknown as NodeJS.ProcessEnv);

    assert.equal(config.baseUrl, "https://kilo.example.test");
    assert.equal(config.apiKey, "noo_kilo");
    assert.equal(config.autoSaveTopicId, "topic-kilo");
  });

  it("reports the Kilo-specific API key name when the client is unconfigured", async () => {
    const { NoosphereClient } = await import(
      new URL("../../../kilocode-noosphere-memory/dist/client.js", import.meta.url).href
    );
    const { resolveConfig } = await import(
      new URL("../../../kilocode-noosphere-memory/dist/config.js", import.meta.url).href
    );

    const client = new NoosphereClient(resolveConfig(undefined, {} as unknown as NodeJS.ProcessEnv));

    await assert.rejects(() => client.status(), (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /KILOCODE_NOOSPHERE_API_KEY/);
      assert.match(message, /NOOSPHERE_API_KEY/);
      return true;
    });
  });

  it("reports the OpenClaw-specific API key name when the client is unconfigured", async () => {
    const { NoosphereMemoryClient } = await import(
      new URL("../../../openclaw-noosphere-memory/dist/client.js", import.meta.url).href
    );
    const { resolveNoosphereMemoryConfig } = await import(
      new URL("../../../openclaw-noosphere-memory/dist/config.js", import.meta.url).href
    );

    const client = new NoosphereMemoryClient(
      resolveNoosphereMemoryConfig({}, {} as unknown as NodeJS.ProcessEnv),
    );

    await assert.rejects(() => client.status(), (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /OPENCLAW_NOOSPHERE_API_KEY/);
      assert.match(message, /NOOSPHERE_API_KEY/);
      return true;
    });
  });
});
