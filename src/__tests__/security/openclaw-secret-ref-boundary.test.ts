import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configModuleUrl = pathToFileURL(
  resolve(repoRoot, "openclaw-noosphere-memory", "src", "config.ts"),
).href;

test("OpenClaw SecretRefs are never resolved by reading the root config", async () => {
  const { resolveNoosphereMemoryConfig } = await import(configModuleUrl);
  const dir = mkdtempSync(join(tmpdir(), "noosphere-secret-ref-boundary-"));
  const secretFile = join(dir, "provider.json");
  writeFileSync(secretFile, JSON.stringify({ apiKey: "sentinel-file-value" }));

  try {
    assert.throws(
      () => resolveNoosphereMemoryConfig(
        {
          apiKey: {
            source: "file",
            provider: "local-file",
            id: "/apiKey",
          },
        },
        { NOOSPHERE_API_KEY: "environment-fallback-value" },
        {
          secrets: {
            providers: {
              "local-file": {
                source: "file",
                path: secretFile,
                mode: "json",
              },
            },
          },
        },
      ),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.equal(error.name, "NoosphereConfigError");
        assert.match(error.message, /must be resolved by OpenClaw/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("per-agent resolution rejects unresolved default SecretRefs before fallback", async () => {
  const { resolveApiKeyForAgent } = await import(configModuleUrl);
  const dir = mkdtempSync(join(tmpdir(), "noosphere-agent-secret-ref-boundary-"));
  const secretFile = join(dir, "provider.json");
  writeFileSync(secretFile, JSON.stringify({ apiKey: "agent-sentinel-file-value" }));

  try {
    assert.throws(
      () => resolveApiKeyForAgent(
        {
          apiKey: {
            source: "file",
            provider: "agent-file",
            id: "/apiKey",
          },
        },
        { NOOSPHERE_API_KEY: "agent-environment-fallback-value" },
        {
          secrets: {
            providers: {
              "agent-file": {
                source: "file",
                path: secretFile,
                mode: "json",
              },
            },
          },
        },
        "unconfigured-agent",
      ),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        assert.equal(error.name, "NoosphereConfigError");
        assert.match(error.message, /must be resolved by OpenClaw/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SecretRef markers cannot be bypassed by an embedded value", async () => {
  const { resolveNoosphereMemoryConfig } = await import(configModuleUrl);

  assert.throws(
    () => resolveNoosphereMemoryConfig(
      {
        apiKey: {
          source: "file",
          provider: "unresolved-file",
          id: "/apiKey",
          value: "embedded-unresolved-value",
        },
      },
      { NOOSPHERE_API_KEY: "environment-fallback-value" },
    ),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      assert.equal(error.name, "NoosphereConfigError");
      assert.match(error.message, /must be resolved by OpenClaw/);
      return true;
    },
  );
});

test("OpenClaw runtime credentials do not consult the source config", async () => {
  const { resolveNoosphereMemoryConfig } = await import(configModuleUrl);
  const sourceConfig = new Proxy({}, {
    get() {
      throw new Error("source config must not be inspected at runtime");
    },
  });

  const config = resolveNoosphereMemoryConfig(
    { apiKey: "runtime-resolved-value" },
    {},
    sourceConfig,
  );

  assert.equal(config.apiKey, "runtime-resolved-value");
});
