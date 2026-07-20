import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  HybridCorrectnessError,
  HybridLexicalFallbackError,
  readHybridRetrievalConfig,
  runHybridRetrieval,
  type HybridProfileSnapshot,
  type HybridRetrievalDependencies,
  type HybridRetrievalRequest,
} from "@/lib/memory/hybrid-retrieval";
import {
  canonicalizeHybridQueryDocument,
  validateHybridQueryEmbedding,
} from "@/lib/memory/hybrid-retrieval-runtime";

const profileId = "0198fe17-f4dd-7ee3-93e4-acde00000001";
const encodedKey = randomBytes(32).toString("base64");
const retainedEncodedKey = randomBytes(32).toString("base64");

function enabledEnvironment(): Record<string, string | undefined> {
  return {
    NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true",
    NOOSPHERE_HYBRID_QUERY_PROFILE_ID: profileId,
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "v1",
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS: JSON.stringify({ v1: encodedKey }),
  };
}

function profile(overrides: Partial<HybridProfileSnapshot> = {}): HybridProfileSnapshot {
  return {
    profileId,
    providerProtocol: "openai-compatible",
    locality: "local",
    modelIdentifier: "fixture-model",
    modelRevision: "fixture-r1",
    dimensions: 3,
    distanceMetric: "cosine",
    normalizationPolicy: "none",
    documentSchemaVersion: "noosphere-article-v1",
    documentNormalization: "NFKC;CRLF_CR_TO_LF;FINAL_LF;UTF8_CODEPOINT_PREFIX",
    maxInputBytes: 32768,
    endpointIdentitySha256: "11".repeat(32),
    profileState: "serving",
    cacheEpoch: "42",
    eligibleCount: 10,
    readyCount: 10,
    coverage: 1,
    remoteEgress: false,
    restrictedRemoteEgress: false,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<HybridRetrievalDependencies<string>> = {},
): HybridRetrievalDependencies<string> {
  return {
    loadProfile: async () => profile(),
    readCache: async () => null,
    hydrateCached: async () => ({ cacheValid: false, epoch: "42", candidates: [], rows: [] }),
    embedQuery: async () => "[1,0,0]",
    searchMiss: async () => ({
      cacheValid: true,
      epoch: "42",
      candidates: [{ id: "article-1", rawRrfScore: 1 / 61, lexicalRank: 1 }],
      rows: ["article-1"],
    }),
    writeCache: async () => undefined,
    ...overrides,
  };
}

const request = {
  query: "  Remember café photos  ",
  limit: 10,
  offset: 0,
  filters: { topicSlug: "engineering" },
  allowedScopes: ["team:a"],
};

test("Phase C is exactly false by default and rejects ambiguous flag values", () => {
  assert.deepEqual(readHybridRetrievalConfig({}), { enabled: false });
  assert.deepEqual(readHybridRetrievalConfig({ NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false" }), {
    enabled: false,
  });
  assert.throws(
    () => readHybridRetrievalConfig({ NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "1" }),
    HybridCorrectnessError,
  );
});

test("enabled retrieval requires an exact profile and authenticated cache keyring", () => {
  assert.throws(
    () => readHybridRetrievalConfig({ NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true" }),
    HybridCorrectnessError,
  );
  const config = readHybridRetrievalConfig(enabledEnvironment());
  assert.equal(config.enabled, true);
  if (config.enabled) {
    assert.equal(config.profileId, profileId);
    assert.equal(config.cacheKeyring.activeVersion, "v1");
  }
  const encodedEnvironment = enabledEnvironment();
  encodedEnvironment.NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64 = Buffer.from(
    encodedEnvironment.NOOSPHERE_HYBRID_CACHE_HMAC_KEYS!,
    "utf8",
  ).toString("base64");
  delete encodedEnvironment.NOOSPHERE_HYBRID_CACHE_HMAC_KEYS;
  assert.equal(readHybridRetrievalConfig(encodedEnvironment).enabled, true);
  assert.throws(
    () => readHybridRetrievalConfig({
      ...enabledEnvironment(),
      NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: "e30=",
    }),
    HybridCorrectnessError,
  );
});

test("insufficient vector coverage is a typed lexical fallback before provider I/O", async () => {
  let providerCalls = 0;
  const config = readHybridRetrievalConfig(enabledEnvironment());
  await assert.rejects(
    runHybridRetrieval(request, config, dependencies({
      loadProfile: async () => profile({ coverage: 0.94 }),
      embedQuery: async () => {
        providerCalls++;
        return "[1,0,0]";
      },
    })),
    (error) =>
      error instanceof HybridLexicalFallbackError &&
      error.code === "insufficient_vector_coverage",
  );
  assert.equal(providerCalls, 0);
});

test("a non-serving profile is a correctness failure before coverage fallback", async () => {
  let providerCalls = 0;
  await assert.rejects(
    runHybridRetrieval(
      request,
      readHybridRetrievalConfig(enabledEnvironment()),
      dependencies({
        loadProfile: async () => profile({ profileState: "preparing", coverage: 0.1 }),
        embedQuery: async () => {
          providerCalls++;
          return "[1,0,0]";
        },
      }),
    ),
    (error) =>
      error instanceof HybridCorrectnessError &&
      error.code === "query_profile_not_serving",
  );
  assert.equal(providerCalls, 0);
});

test("rotation reads a retained-key cache identity before paying for a new embedding", async () => {
  const config = readHybridRetrievalConfig({
    ...enabledEnvironment(),
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "v2",
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS: JSON.stringify({
      v1: retainedEncodedKey,
      v2: encodedKey,
    }),
  });
  const attemptedVersions: string[] = [];
  let providerCalls = 0;

  const result = await runHybridRetrieval(request, config, dependencies({
    readCache: async (identity) => {
      attemptedVersions.push(identity.keyVersion);
      return identity.keyVersion === "v1"
        ? { epoch: "42", candidates: [] }
        : null;
    },
    hydrateCached: async ({ identity }) => {
      assert.equal(identity.keyVersion, "v1");
      return { cacheValid: true, epoch: "42", candidates: [], rows: [] };
    },
    embedQuery: async () => {
      providerCalls++;
      return "[1,0,0]";
    },
  }));

  assert.deepEqual(result, []);
  assert.deepEqual(attemptedVersions, ["v2", "v1"]);
  assert.equal(providerCalls, 0);
});

test("a valid authenticated empty cache hit is authoritative and skips the provider", async () => {
  let providerCalls = 0;
  let missCalls = 0;
  const config = readHybridRetrievalConfig(enabledEnvironment());
  const result = await runHybridRetrieval(request, config, dependencies({
    readCache: async () => ({ epoch: "42", candidates: [] }),
    hydrateCached: async () => ({ cacheValid: true, epoch: "42", candidates: [], rows: [] }),
    embedQuery: async () => {
      providerCalls++;
      return "[1,0,0]";
    },
    searchMiss: async () => {
      missCalls++;
      throw new Error("miss path must not run");
    },
  }));

  assert.deepEqual(result, []);
  assert.equal(providerCalls, 0);
  assert.equal(missCalls, 0);
});

test("an invalid cache hint is discarded, then one provider/miss pass repopulates it", async () => {
  let providerCalls = 0;
  let missCalls = 0;
  let writes = 0;
  const config = readHybridRetrievalConfig(enabledEnvironment());
  const result = await runHybridRetrieval(request, config, dependencies({
    readCache: async () => ({
      epoch: "42",
      candidates: [{ id: "stale", rawRrfScore: 1 / 61, vectorRank: 1 }],
    }),
    hydrateCached: async () => ({ cacheValid: false, epoch: "42", candidates: [], rows: [] }),
    embedQuery: async () => {
      providerCalls++;
      return "[1,0,0]";
    },
    searchMiss: async () => {
      missCalls++;
      return {
        cacheValid: true,
        epoch: "43",
        candidates: [{ id: "current", rawRrfScore: 1 / 61, vectorRank: 1 }],
        rows: ["current"],
      };
    },
    writeCache: async (identity, resultToCache) => {
      writes++;
      assert.equal(identity.epoch, "43");
      assert.equal(resultToCache.epoch, "43");
    },
  }));

  assert.deepEqual(result, ["current"]);
  assert.equal(providerCalls, 1);
  assert.equal(missCalls, 1);
  assert.equal(writes, 1);
});

test("only typed transient provider failures permit lexical fallback", async () => {
  const config = readHybridRetrievalConfig(enabledEnvironment());
  await assert.rejects(
    runHybridRetrieval(request, config, dependencies({
      embedQuery: async () => {
        throw new HybridLexicalFallbackError("provider_http_503");
      },
    })),
    HybridLexicalFallbackError,
  );
  await assert.rejects(
    runHybridRetrieval(request, config, dependencies({
      embedQuery: async () => {
        throw new HybridCorrectnessError("provider_vector_invalid");
      },
    })),
    HybridCorrectnessError,
  );
});

test("cosine query embeddings reject zero norm even without L2 normalization", () => {
  assert.throws(
    () => validateHybridQueryEmbedding([0, 0, 0], profile()),
    (error) =>
      error instanceof HybridCorrectnessError &&
      error.code === "provider_vector_zero_norm",
  );
  assert.doesNotThrow(() =>
    validateHybridQueryEmbedding(
      [0, 0, 0],
      profile({ distanceMetric: "l2", normalizationPolicy: "none" }),
    ),
  );
});

test("provider bytes use the same normalized query identity as the cache", () => {
  assert.deepEqual(
    canonicalizeHybridQueryDocument("  Cafe\u0301\r\nPhotos  ", 64),
    Buffer.from("Café\nPhotos", "utf8"),
  );
  assert.deepEqual(
    canonicalizeHybridQueryDocument("é🙂tail", 6),
    Buffer.from("é🙂", "utf8"),
    "UTF-8 truncation must stop on a code-point boundary",
  );
});

test("orchestration canonicalizes query and filters before cache, provider, and SQL", async () => {
  const observed: {
    hydrated?: HybridRetrievalRequest;
    providerQuery?: string;
    missed?: HybridRetrievalRequest;
  } = {};
  const rawRequest = {
    ...request,
    query: "  Cafe\u0301\r\nPhotos  ",
    filters: {
      topicSlug: " engineering ",
      tagSlug: " architecture ",
      status: " published ",
      confidence: " high ",
    },
  };

  await runHybridRetrieval(
    rawRequest,
    readHybridRetrievalConfig(enabledEnvironment()),
    dependencies({
      readCache: async () => ({ epoch: "42", candidates: [] }),
      hydrateCached: async ({ request: hydrated }) => {
        observed.hydrated = hydrated;
        return { cacheValid: false, epoch: "42", candidates: [], rows: [] };
      },
      embedQuery: async ({ query }) => {
        observed.providerQuery = query;
        return "[1,0,0]";
      },
      searchMiss: async ({ request: missed }) => {
        observed.missed = missed;
        return { cacheValid: true, epoch: "42", candidates: [], rows: [] };
      },
    }),
  );

  const expectedFilters = {
    topicSlug: "engineering",
    tagSlug: "architecture",
    status: "published",
    confidence: "high",
  };
  assert.equal(observed.providerQuery, "Café\nPhotos");
  assert.equal(observed.hydrated?.query, "Café\nPhotos");
  assert.equal(observed.missed?.query, "Café\nPhotos");
  assert.deepEqual(observed.hydrated?.filters, expectedFilters);
  assert.deepEqual(observed.missed?.filters, expectedFilters);
});

test("normalization rejects a query that becomes empty before any profile or cache access", async () => {
  let profileCalls = 0;
  await assert.rejects(
    runHybridRetrieval(
      { ...request, query: " \r\n " },
      readHybridRetrievalConfig(enabledEnvironment()),
      dependencies({
        loadProfile: async () => {
          profileCalls++;
          return profile();
        },
      }),
    ),
    (error) => error instanceof HybridCorrectnessError && error.code === "query_empty",
  );
  assert.equal(profileCalls, 0);
});
