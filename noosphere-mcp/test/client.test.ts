import assert from "node:assert/strict";
import test from "node:test";

import {
  NoosphereClient,
  NoosphereClientError,
  type NoosphereClientConfig,
} from "../src/client.js";

const config: NoosphereClientConfig = {
  baseUrl: "http://127.0.0.1:6578",
  apiKey: "synthetic-test-key",
  timeoutMs: 5_000,
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("search_articles maps filters and pagination onto the articles endpoint", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = new NoosphereClient(config, async (input, init) => {
    observedUrl = String(input);
    observedInit = init;
    return jsonResponse({ articles: [], pagination: { page: 2, limit: 25, total: 0, pages: 0 } });
  });

  await client.searchArticles({
    query: "durable memory",
    topic: "engineering",
    tag: "codex",
    status: "published",
    confidence: "high",
    page: 2,
    limit: 25,
  });

  const url = new URL(observedUrl);
  assert.equal(url.pathname, "/api/articles");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    q: "durable memory",
    topic: "engineering",
    tag: "codex",
    status: "published",
    confidence: "high",
    page: "2",
    limit: "25",
  });
  assert.equal(observedInit?.method, "GET");
  assert.equal(observedInit?.redirect, "error");
  assert.equal(new Headers(observedInit?.headers).get("authorization"), "Bearer synthetic-test-key");
});

test("get_article uses the canonical memory endpoint rather than unsupported GET-by-id", async () => {
  let observedUrl = "";
  let observedBody = "";
  const client = new NoosphereClient(config, async (input, init) => {
    observedUrl = String(input);
    observedBody = String(init?.body);
    return jsonResponse({ result: { id: "article-1", title: "One" }, providerMeta: [] });
  });

  await client.getArticle({ articleId: "article-1" });

  assert.equal(new URL(observedUrl).pathname, "/api/memory/get");
  assert.deepEqual(JSON.parse(observedBody), { provider: "noosphere", id: "article-1" });
});

test("write and recall methods preserve the documented request bodies", async () => {
  const requests: Array<{ pathname: string; body: unknown }> = [];
  const client = new NoosphereClient(config, async (input, init) => {
    requests.push({ pathname: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return jsonResponse({ ok: true });
  });

  await client.saveMemory({
    title: "Draft",
    content: "Durable content",
    topicId: "topic-1",
    tags: ["codex"],
    confidence: "high",
    restrictedTags: ["work"],
  });
  await client.recallMemory({ query: "durable", resultCap: 4, tokenBudget: 1200, scope: "work" });
  await client.createArticle({
    title: "Curated",
    slug: "curated",
    content: "Published content",
    topicId: "topic-1",
    status: "reviewed",
    tags: ["codex"],
  });

  assert.deepEqual(requests, [
    {
      pathname: "/api/memory/save",
      body: {
        title: "Draft",
        content: "Durable content",
        topicId: "topic-1",
        tags: ["codex"],
        confidence: "high",
        restrictedTags: ["work"],
      },
    },
    {
      pathname: "/api/memory/recall",
      body: { query: "durable", resultCap: 4, tokenBudget: 1200, scope: "work" },
    },
    {
      pathname: "/api/articles",
      body: {
        title: "Curated",
        slug: "curated",
        content: "Published content",
        topicId: "topic-1",
        status: "reviewed",
        tags: ["codex"],
      },
    },
  ]);
});

test("missing credentials fail before fetch", async () => {
  let called = false;
  const client = new NoosphereClient({ ...config, apiKey: undefined }, async () => {
    called = true;
    return jsonResponse({});
  });

  await assert.rejects(() => client.searchArticles({}), /CODEX_NOOSPHERE_API_KEY/);
  assert.equal(called, false);
});

test("all requests reject redirects and bound response bodies", async () => {
  const redirectClient = new NoosphereClient(config, async (_input, init) => {
    assert.equal(init?.redirect, "error");
    throw new TypeError("fetch failed: redirect mode is set to error");
  });
  await assert.rejects(() => redirectClient.searchArticles({}), NoosphereClientError);

  let oversizedBodyCancelled = false;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      oversizedBodyCancelled = true;
    },
  });
  const oversizedClient = new NoosphereClient(config, async () =>
    new Response(oversizedBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "1000001",
      },
    }),
  );
  await assert.rejects(() => oversizedClient.searchArticles({}), /response body is too large/);
  assert.equal(oversizedBodyCancelled, true);
});

test("HTTP errors are bounded and do not expose the bearer credential", async () => {
  const client = new NoosphereClient(config, async () =>
    jsonResponse({ error: "denied", detail: "x".repeat(10_000) }, { status: 403 }),
  );

  await assert.rejects(
    () => client.searchArticles({}),
    (error: unknown) =>
      error instanceof NoosphereClientError &&
      error.status === 403 &&
      error.message === "denied" &&
      !JSON.stringify(error).includes("synthetic-test-key"),
  );
});
