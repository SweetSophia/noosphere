import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createNoosphereMcpServer,
  type NoosphereApi,
} from "../src/server.js";

function createFakeApi(): NoosphereApi & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    async searchArticles(input) {
      calls.push(["searchArticles", input]);
      return { articles: [{ id: "article-1", title: "Codex" }], pagination: { page: 1 } };
    },
    async getArticle(input) {
      calls.push(["getArticle", input]);
      return { result: { id: "article-1", title: "Codex" }, providerMeta: [] };
    },
    async saveMemory(input) {
      calls.push(["saveMemory", input]);
      return { success: true, candidate: { id: "draft-1", status: "draft" } };
    },
    async recallMemory(input) {
      calls.push(["recallMemory", input]);
      return { results: [], totalBeforeCap: 0, mode: "inspection", providerMeta: [] };
    },
    async createArticle(input) {
      calls.push(["createArticle", input]);
      return { id: "article-2", title: input.title, slug: input.slug };
    },
  };
}

async function connect(api: NoosphereApi) {
  const server = createNoosphereMcpServer(api, "9.9.9-test");
  const client = new Client({ name: "noosphere-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("advertises exactly issue #260's five tools with truthful annotations", async (t) => {
  const api = createFakeApi();
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["search_articles", "get_article", "save_memory", "recall_memory", "create_article"],
  );
  assert.match(
    listed.tools.find((tool) => tool.name === "recall_memory")?.description ?? "",
    /bounded automatic mode/i,
  );

  const annotations = Object.fromEntries(
    listed.tools.map((tool) => [tool.name, tool.annotations]),
  );
  assert.deepEqual(annotations.search_articles, {
    title: "Search Noosphere articles",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(annotations.get_article?.readOnlyHint, true);
  assert.equal(annotations.recall_memory?.readOnlyHint, true);
  assert.equal(annotations.save_memory?.readOnlyHint, false);
  assert.equal(annotations.save_memory?.destructiveHint, false);
  assert.equal(annotations.create_article?.readOnlyHint, false);
  assert.equal(annotations.create_article?.destructiveHint, false);
});

test("routes validated MCP arguments to the Noosphere API", async (t) => {
  const api = createFakeApi();
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "search_articles",
    arguments: { query: "codex", limit: 10 },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    articles: [{ id: "article-1", title: "Codex" }],
    pagination: { page: 1 },
  });
  assert.deepEqual(api.calls, [["searchArticles", { query: "codex", limit: 10 }]]);

  const recall = await client.callTool({
    name: "recall_memory",
    arguments: { query: "codex", tokenBudget: 1 },
  });
  assert.equal(recall.isError, undefined);
  assert.deepEqual(api.calls, [
    ["searchArticles", { query: "codex", limit: 10 }],
    ["recallMemory", { query: "codex", tokenBudget: 1 }],
  ]);
});

test("rejects invalid arguments before any write call", async (t) => {
  const api = createFakeApi();
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "save_memory",
    arguments: { title: "missing content and topic" },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(api.calls, []);
});

test("rejects REST-invalid boundary values before any API call", async (t) => {
  const api = createFakeApi();
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const cases = [
    {
      name: "get_article",
      arguments: { canonicalRef: "not-a-canonical-reference" },
    },
    {
      name: "search_articles",
      arguments: { query: "   " },
    },
    {
      name: "search_articles",
      arguments: { query: "q".repeat(257) },
    },
    {
      name: "get_article",
      arguments: { canonicalRef: "noosphere:article:".padEnd(513, "a") },
    },
    {
      name: "save_memory",
      arguments: {
        title: "t".repeat(161),
        content: "durable ".repeat(8),
        topicId: "topic-1",
      },
    },
    {
      name: "save_memory",
      arguments: {
        title: "short content",
        content: "x".repeat(39),
        topicId: "topic-1",
      },
    },
    {
      name: "recall_memory",
      arguments: { query: "codex", resultCap: 11 },
    },
    {
      name: "recall_memory",
      arguments: { query: "codex", providers: [] },
    },
    {
      name: "create_article",
      arguments: {
        title: "t".repeat(201),
        slug: "codex",
        content: "content",
        topicId: "topic-1",
      },
    },
    {
      name: "create_article",
      arguments: {
        title: "Unicode bytes",
        slug: "unicode-bytes",
        content: "é".repeat(600_000),
        topicId: "topic-1",
      },
    },
  ];

  for (const item of cases) {
    const result = await client.callTool(item);
    assert.equal(result.isError, true, `${item.name} should reject before REST`);
  }
  assert.deepEqual(api.calls, []);
});

test("renders successful tool text without indentation amplification", async (t) => {
  const api = createFakeApi();
  let nested: Record<string, unknown> = { leaf: true };
  for (let depth = 0; depth < 1_000; depth += 1) nested = { nested };
  api.searchArticles = async () => nested;
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "search_articles",
    arguments: {},
  });
  assert.ok(Array.isArray(result.content));
  const first = result.content[0];
  assert.ok(first && typeof first === "object" && "text" in first);
  const text = String(first.text);
  assert.equal(text, JSON.stringify(nested));
});

test("converts client failures to bounded MCP errors", async (t) => {
  const api = createFakeApi();
  api.recallMemory = async () => {
    throw new Error("upstream denied");
  };
  const { client, server } = await connect(api);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "recall_memory",
    arguments: { query: "codex" },
  });
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  const first = result.content[0];
  assert.ok(
    typeof first === "object" &&
      first !== null &&
      "type" in first &&
      first.type === "text" &&
      "text" in first &&
      typeof first.text === "string",
  );
  assert.match(first.text, /upstream denied/);
});
