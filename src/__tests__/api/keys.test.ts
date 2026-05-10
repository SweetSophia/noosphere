import assert from "node:assert/strict";
import test from "node:test";
import crypto from "crypto";
import { hashApiKey, generateApiKey } from "@/lib/api/keys";

test("generateApiKey returns a noo_ prefixed key", () => {
  const key = generateApiKey("test-agent");
  assert.ok(key.raw.startsWith("noo_"), "raw key should start with noo_");
  assert.equal(key.hash, hashApiKey(key.raw));
  assert.equal(key.prefix, key.raw.slice(0, 8));
  assert.equal(key.hash.length, 64); // SHA-256 hex
});

test("generateApiKey produces unique keys", () => {
  const a = generateApiKey("a");
  const b = generateApiKey("b");
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});

test("hashApiKey is deterministic", () => {
  const raw = "noo_test-key-123";
  const hash1 = hashApiKey(raw);
  const hash2 = hashApiKey(raw);
  assert.equal(hash1, hash2);
  assert.equal(hash1, crypto.createHash("sha256").update(raw).digest("hex"));
});
