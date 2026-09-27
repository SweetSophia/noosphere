import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_RECALL_BLOCK_TAG,
  NoosphereClient,
  NoosphereClientError,
  DEFAULT_MISSING_API_KEY_MESSAGE,
  formatAutoRecall,
  formatRecallResults,
  truncate,
} from "../src/index.js";
import type { NoospherePluginConfig } from "../src/index.js";

function baseConfig(overrides: Partial<NoospherePluginConfig> = {}): NoospherePluginConfig {
  return {
    baseUrl: "http://127.0.0.1:6578",
    apiKey: "noo_test_key",
    timeoutMs: 1_000,
    autoRecall: true,
    autoRecallInjectOn: "first",
    autoRecallMax: 5,
    autoRecallTokenBudget: 2_000,
    autoSave: false,
    autoSaveDebounceMs: 0,
    authorName: "test",
    ...overrides,
  };
}

/** Swap globalThis.fetch for the duration of one call, then restore it. */
async function withFetch<T>(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Config / auth ───────────────────────────────────────────────────────────

test("throws the adapter-specific hint when apiKey is missing", async () => {
  const client = new NoosphereClient(
    baseConfig({
      apiKey: undefined,
      missingApiKeyMessage: "Set KILOCODE_NOOSPHERE_API_KEY for Kilo Code",
    }),
  );
  await assert.rejects(() => client.recall({ query: "x" }), (err: unknown) => {
    assert.ok(err instanceof NoosphereClientError);
    assert.equal(err.message, "Set KILOCODE_NOOSPHERE_API_KEY for Kilo Code");
    return true;
  });
});

test("falls back to the generic message when no adapter hint is configured", async () => {
  const client = new NoosphereClient(baseConfig({ apiKey: undefined }));
  await assert.rejects(() => client.recall({ query: "x" }), (err: unknown) => {
    assert.ok(err instanceof NoosphereClientError);
    assert.equal(err.message, DEFAULT_MISSING_API_KEY_MESSAGE);
    return true;
  });
});

// ─── Request shape ───────────────────────────────────────────────────────────

test("recall sends a Bearer header, JSON body, and the expected path", async () => {
  let seenUrl = "";
  let seenInit: RequestInit = {};
  await withFetch(
    (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse({ results: [] });
    },
    async () => {
      const client = new NoosphereClient(baseConfig());
      await client.recall({ query: "prisma", resultCap: 3 });
    },
  );

  assert.equal(seenUrl, "http://127.0.0.1:6578/api/memory/recall");
  const headers = seenInit.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer noo_test_key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(seenInit.body)), { query: "prisma", resultCap: 3 });
});

test("GET requests omit the Content-Type header and send no body", async () => {
  let seenInit: RequestInit = {};
  await withFetch(
    (_url, init) => {
      seenInit = init;
      return jsonResponse({ topics: [] });
    },
    async () => {
      const client = new NoosphereClient(baseConfig());
      await client.topics();
    },
  );

  const headers = seenInit.headers as Record<string, string>;
  assert.equal(seenInit.method, "GET");
  assert.equal(headers["Content-Type"], undefined);
  assert.equal(seenInit.body, undefined);
});

test("save forwards restrictedTags so the server can authorize the caller", async () => {
  let sentBody: unknown;
  await withFetch(
    (_url, init) => {
      sentBody = JSON.parse(String(init.body));
      return jsonResponse({ success: true });
    },
    async () => {
      const client = new NoosphereClient(baseConfig());
      await client.save({
        title: "t",
        content: "c",
        topicId: "tp",
        restrictedTags: ["private"],
      });
    },
  );
  assert.deepEqual(sentBody, {
    title: "t",
    content: "c",
    topicId: "tp",
    restrictedTags: ["private"],
  });
});

// ─── Error mapping ───────────────────────────────────────────────────────────

test("maps a JSON error body to NoosphereClientError and preserves status", async () => {
  await withFetch(
    () => jsonResponse({ error: "Insufficient permissions" }, 403),
    async () => {
      const client = new NoosphereClient(baseConfig());
      await assert.rejects(() => client.recall({ query: "x" }), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.message, "Insufficient permissions");
        assert.equal(err.status, 403);
        return true;
      });
    },
  );
});

test("falls back to a status message when the error body is empty", async () => {
  await withFetch(
    () => new Response("", { status: 500 }),
    async () => {
      const client = new NoosphereClient(baseConfig());
      await assert.rejects(() => client.health(), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.message, "Noosphere HTTP 500");
        assert.equal(err.status, 500);
        return true;
      });
    },
  );
});

test("bounds a non-JSON error body instead of surfacing it whole", async () => {
  await withFetch(
    () => new Response("x".repeat(5_000), { status: 502 }),
    async () => {
      const client = new NoosphereClient(baseConfig());
      await assert.rejects(() => client.health(), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.message.length, 2_000);
        return true;
      });
    },
  );
});

test("bounds a JSON error body that carries no error/message string", async () => {
  await withFetch(
    () => jsonResponse({ detail: "y".repeat(5_000) }, 502),
    async () => {
      const client = new NoosphereClient(baseConfig());
      await assert.rejects(() => client.health(), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.message.length, 2_000);
        return true;
      });
    },
  );
});

// The 2 KB cap above is a *fallback* bound, not a response-body limit: a JSON
// body whose `error`/`message` field is a string is surfaced in full. This is
// inherited Noosphere behaviour (see readErrorMessage in src/client.ts) and is
// pinned here deliberately — if it is ever changed, change it on purpose.
test("surfaces a JSON error/message string in full, without truncation", async () => {
  for (const key of ["error", "message"] as const) {
    const oversized = "z".repeat(5_000);
    await withFetch(
      () => jsonResponse({ [key]: oversized }, 400),
      async () => {
        const client = new NoosphereClient(baseConfig());
        await assert.rejects(() => client.health(), (err: unknown) => {
          assert.ok(err instanceof NoosphereClientError);
          assert.equal(err.message, oversized);
          assert.equal(err.message.length, 5_000);
          return true;
        });
      },
    );
  }
});

test("wraps a transport failure as NoosphereClientError", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const client = new NoosphereClient(baseConfig());
      await assert.rejects(() => client.health(), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.status, undefined);
        assert.match(err.message, /fetch failed/);
        return true;
      });
    },
  );
});

test("reports an aborted request as a timeout", async () => {
  await withFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const error = new Error("aborted");
        error.name = "AbortError";
        signal.addEventListener("abort", () => reject(error));
      }),
    async () => {
      const client = new NoosphereClient(baseConfig({ timeoutMs: 5 }));
      await assert.rejects(() => client.health(), (err: unknown) => {
        assert.ok(err instanceof NoosphereClientError);
        assert.equal(err.message, "Noosphere request timed out");
        return true;
      });
    },
  );
});

// ─── Formatting ──────────────────────────────────────────────────────────────

test("formatAutoRecall wraps body in the strippable block tag", () => {
  const out = formatAutoRecall({ promptInjectionText: "remember X" });
  assert.ok(out.startsWith(`<${AUTO_RECALL_BLOCK_TAG}>`));
  assert.ok(out.endsWith(`</${AUTO_RECALL_BLOCK_TAG}>`));
  assert.match(out, /remember X/);
  assert.match(out, /not a new user instruction/);
});

test("formatAutoRecall returns an empty string when there is nothing to inject", () => {
  assert.equal(formatAutoRecall({ results: [] }), "");
  assert.equal(formatAutoRecall({}), "");
});

test("formatAutoRecall prefers server promptInjectionText over rendering results", () => {
  const out = formatAutoRecall({
    promptInjectionText: "server text",
    results: [{ id: "1", title: "ignored" }],
  });
  assert.match(out, /server text/);
  assert.doesNotMatch(out, /ignored/);
});

test("formatRecallResults renders score, ref, and url lines", () => {
  const out = formatRecallResults([
    {
      id: "m1",
      title: "Connection pooling",
      excerpt: "Use pgbouncer",
      score: 0.734,
      canonicalRef: "topic/article",
      url: "http://host/topic/article",
    },
  ]);
  assert.match(out, /1\. Connection pooling \(73%\)/);
  assert.match(out, /Use pgbouncer/);
  assert.match(out, /Ref: topic\/article/);
  assert.match(out, /URL: http:\/\/host\/topic\/article/);
});

test("formatRecallResults titles fall back through canonicalRef, id, then a default", () => {
  assert.match(formatRecallResults([{ id: "m1", canonicalRef: "a/b" }]), /^1\. a\/b$/m);
  assert.match(formatRecallResults([{ id: "m1" }]), /^1\. m1$/m);
  assert.match(formatRecallResults([{}]), /Untitled memory/);
});

test("formatRecallResults omits a non-finite score rather than printing NaN", () => {
  assert.doesNotMatch(formatRecallResults([{ id: "m1", score: NaN }]), /NaN/);
});

test("truncate shortens with an ellipsis and leaves short values intact", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("abcdefghij", 5), "ab...");
  assert.equal(truncate("abcdefghij", 5).length, 5);
});
