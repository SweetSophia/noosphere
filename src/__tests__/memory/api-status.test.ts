import assert from "node:assert/strict";
import test from "node:test";

import { getMemoryStatusSnapshot } from "@/lib/memory/api/providers";

test("memory status exposes safe provider metadata", () => {
  const snapshot = getMemoryStatusSnapshot({
    now: new Date("2026-04-29T08:00:00.000Z"),
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.timestamp, "2026-04-29T08:00:00.000Z");
  assert.equal(snapshot.providers.length, 1);

  const [provider] = snapshot.providers;
  assert.equal(provider.id, "noosphere");
  assert.equal(provider.sourceType, "noosphere");
  assert.equal(provider.enabled, true);
  assert.equal(provider.allowAutoRecall, true);
  assert.equal(provider.capabilities.search, true);
  assert.equal(provider.capabilities.getById, true);
  assert.equal(provider.capabilities.autoRecall, true);
});

test("memory status includes normalized public recall settings", () => {
  const snapshot = getMemoryStatusSnapshot({
    settings: {
      maxInjectedMemories: 3.8,
      maxInjectedTokens: -1,
      conflictThreshold: 5,
    },
  });

  assert.equal(snapshot.settings.maxInjectedMemories, 3);
  assert.equal(snapshot.settings.maxInjectedTokens, 2000);
  assert.equal(snapshot.settings.conflictThreshold, 1);
  assert.equal(snapshot.settings.autoRecallEnabled, true);
  assert.equal(snapshot.settings.conflictStrategy, "surface");
});

test("memory status does not expose secret-like fields", () => {
  const serialized = JSON.stringify(getMemoryStatusSnapshot()).toLowerCase();

  assert.equal(serialized.includes("apikey"), false);
  assert.equal(serialized.includes("api_key"), false);
  assert.equal(serialized.includes("apikey"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("password"), false);
});
