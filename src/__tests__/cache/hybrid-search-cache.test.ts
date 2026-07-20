import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  HYBRID_CACHE_VALUE_DOMAIN,
  buildHybridCacheIdentity,
  createHybridCacheEnvelope,
  normalizeHybridQuery,
  parseHybridCacheEnvelope,
  parseHybridCacheKeyring,
  readHybridSearchCache,
  writeHybridSearchCache,
} from "@/lib/cache/hybrid-search-cache";
import { _redisTestHooks } from "@/lib/cache/redis";

const key1 = randomBytes(32).toString("base64");
const key2 = randomBytes(32).toString("base64");

class FakeRedisClient {
  status = "wait";
  readonly store = new Map<string, string>();

  async connect() {
    this.status = "ready";
  }

  disconnect() {
    this.status = "end";
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _ttl: number, value: string) {
    this.store.set(key, value);
    return "OK";
  }
}

function keyring() {
  return parseHybridCacheKeyring({
    activeVersion: "v2",
    encodedKeys: JSON.stringify({ v1: key1, v2: key2 }),
  });
}

function identity(overrides: Record<string, unknown> = {}) {
  return buildHybridCacheIdentity(
    {
      query: "  Remember café\r\nphotos  ",
      epoch: "42",
      profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
      documentSchema: "article-v1",
      topicSlug: "engineering",
      tagSlug: "memory",
      status: "reviewed",
      confidence: "high",
      allowedScopes: ["team:b", "team:a"],
      ...overrides,
    },
    keyring(),
  );
}

test("query normalization is deterministic without lowercasing semantic text", () => {
  assert.equal(normalizeHybridQuery("  Cafe\u0301\r\nPhotos  "), "Café\nPhotos");
});

test("cache identity never includes raw query text or raw scopes", () => {
  const built = identity();
  assert.match(built.cacheKey, /^recall:hybrid:v1:v2:[a-f0-9]{64}$/);
  assert.equal(built.queryHash.length, 64);
  assert.equal(built.scopeSetMac.length, 64);
  assert.doesNotMatch(JSON.stringify(built), /Remember|café|team:a|team:b/);
});

test("scope set identity is order-independent but membership-sensitive", () => {
  const first = identity({ allowedScopes: ["team:a", "team:b"] });
  const reordered = identity({ allowedScopes: ["team:b", "team:a", "team:a"] });
  const changed = identity({ allowedScopes: ["team:a"] });

  assert.equal(first.cacheKey, reordered.cacheKey);
  assert.notEqual(first.cacheKey, changed.cacheKey);
});

test("identity binds epoch, profile, document schema, filters, depth, and RRF parameters", () => {
  const baseline = identity();
  for (const override of [
    { epoch: "43" },
    { profileId: "0198fe17-f4dd-7ee3-93e4-acde00000002" },
    { documentSchema: "article-v2" },
    { status: "published" },
    { depth: 199 },
    { rrfK: 61 },
  ]) {
    assert.notEqual(identity(override).cacheKey, baseline.cacheKey);
  }
});

test("keyring rejects missing, weak, oversized, and inactive configurations", () => {
  assert.throws(() => parseHybridCacheKeyring({ activeVersion: "", encodedKeys: "{}" }));
  assert.throws(() =>
    parseHybridCacheKeyring({
      activeVersion: "v1",
      encodedKeys: JSON.stringify({ v1: Buffer.alloc(31).toString("base64") }),
    }),
  );
  assert.throws(() =>
    parseHybridCacheKeyring({
      activeVersion: "v4",
      encodedKeys: JSON.stringify({ v1: key1, v2: key2, v3: key1, v4: key2 }),
    }),
  );
  assert.throws(() =>
    parseHybridCacheKeyring({ activeVersion: "missing", encodedKeys: JSON.stringify({ v1: key1 }) }),
  );
});

test("complete authenticated empty and non-empty fused sets round-trip", () => {
  const built = identity();
  const populated = createHybridCacheEnvelope(
    built,
    {
      epoch: "42",
      candidates: [
        { id: "article-1", rawRrfScore: 0.03, lexicalRank: 1, vectorRank: 2 },
        { id: "article-2", rawRrfScore: 0.02, lexicalRank: 2 },
      ],
    },
    keyring(),
  );
  const empty = createHybridCacheEnvelope(built, { epoch: "42", candidates: [] }, keyring());

  assert.equal(HYBRID_CACHE_VALUE_DOMAIN, "noosphere-hybrid-cache-v1/value");
  assert.deepEqual(parseHybridCacheEnvelope(built, populated, keyring())?.candidates, [
    { id: "article-1", rawRrfScore: 0.03, lexicalRank: 1, vectorRank: 2 },
    { id: "article-2", rawRrfScore: 0.02, lexicalRank: 2 },
  ]);
  assert.deepEqual(parseHybridCacheEnvelope(built, empty, keyring())?.candidates, []);
});

test("tamper, truncation, incompleteness, epoch mismatch, and unknown key versions are misses", () => {
  const built = identity();
  const encoded = createHybridCacheEnvelope(
    built,
    {
      epoch: "42",
      candidates: [{ id: "article-1", rawRrfScore: 0.03, lexicalRank: 1 }],
    },
    keyring(),
  );
  const parsed = JSON.parse(encoded) as Record<string, unknown>;

  const cases = [
    encoded.slice(0, -1),
    JSON.stringify({ ...parsed, complete: false }),
    JSON.stringify({ ...parsed, epoch: "43" }),
    JSON.stringify({ ...parsed, keyVersion: "retired" }),
    JSON.stringify({ ...parsed, fusedSetSize: 2 }),
    JSON.stringify({ ...parsed, mac: `${String(parsed.mac).slice(0, -1)}0` }),
  ];
  for (const value of cases) {
    assert.equal(parseHybridCacheEnvelope(built, value, keyring()), null);
  }
});

test("rotation changes identity and retired/compromised keys become unusable", () => {
  const oldRing = parseHybridCacheKeyring({
    activeVersion: "v1",
    encodedKeys: JSON.stringify({ v1: key1, v2: key2 }),
  });
  const oldIdentity = buildHybridCacheIdentity(
    {
      query: "query",
      epoch: "42",
      profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
      documentSchema: "article-v1",
      allowedScopes: [],
    },
    oldRing,
  );
  const oldValue = createHybridCacheEnvelope(oldIdentity, { epoch: "42", candidates: [] }, oldRing);
  const rotated = keyring();
  const compromisedRemoved = parseHybridCacheKeyring({
    activeVersion: "v2",
    encodedKeys: JSON.stringify({ v2: key2 }),
  });

  assert.notEqual(oldIdentity.cacheKey, buildHybridCacheIdentity({
    query: "query",
    epoch: "42",
    profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    documentSchema: "article-v1",
    allowedScopes: [],
  }, rotated).cacheKey);
  assert.equal(parseHybridCacheEnvelope(oldIdentity, oldValue, compromisedRemoved), null);
});

test("Redis stores only the authenticated content-free envelope and treats tamper as a miss", async () => {
  const redis = new FakeRedisClient();
  _redisTestHooks.setClientForTesting(redis as never);
  try {
    const built = identity();
    const result = {
      epoch: "42",
      candidates: [{ id: "article-1", rawRrfScore: 0.03, lexicalRank: 1 }],
    };
    await writeHybridSearchCache(built, result, keyring());
    const raw = redis.store.get(built.cacheKey);
    assert.ok(raw);
    assert.doesNotMatch(raw!, /Remember|café|team:a|content|title|excerpt|embedding/);
    assert.deepEqual(await readHybridSearchCache(built, keyring()), result);

    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    redis.store.set(built.cacheKey, JSON.stringify({ ...parsed, fusedSetSize: 99 }));
    assert.equal(await readHybridSearchCache(built, keyring()), null);
  } finally {
    _redisTestHooks.reset();
  }
});
