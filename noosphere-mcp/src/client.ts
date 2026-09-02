const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const stringifyJson = JSON.stringify;
const createObject = Object.create;
const setPrototypeOf = Object.setPrototypeOf;
const isArray = Array.isArray;
const ArrayConstructor = Array;

export interface NoosphereClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface SearchArticlesInput {
  query?: string;
  topic?: string;
  tag?: string;
  status?: "draft" | "reviewed" | "published";
  confidence?: "low" | "medium" | "high";
  page?: number;
  limit?: number;
}

export type GetArticleInput =
  | { articleId: string; canonicalRef?: never }
  | { canonicalRef: string; articleId?: never };

export interface SaveMemoryInput {
  title: string;
  content: string;
  topicId: string;
  excerpt?: string;
  tags?: string[];
  source?: string;
  authorName?: string;
  confidence?: "low" | "medium" | "high";
  restrictedTags?: string[];
}

export interface RecallMemoryInput {
  query: string;
  resultCap?: number;
  tokenBudget?: number;
  scope?: string;
  providers?: string[];
}

export interface CreateArticleInput {
  title: string;
  slug: string;
  content: string;
  topicId: string;
  excerpt?: string;
  tags?: string[];
  authorName?: string;
  confidence?: "low" | "medium" | "high";
  status?: "draft" | "reviewed" | "published";
  relatedArticleIds?: string[];
  restrictedTags?: string[];
}

export type NoosphereResponse = Record<string, unknown>;
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class NoosphereClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NoosphereClientError";
  }
}

export class NoosphereClient {
  constructor(
    private readonly config: NoosphereClientConfig,
    private readonly fetchFn: FetchLike = globalThis.fetch,
  ) {}

  async searchArticles(input: SearchArticlesInput): Promise<NoosphereResponse> {
    const url = new URL(`${this.config.baseUrl}/api/articles`);
    appendQuery(url, "q", input.query);
    appendQuery(url, "topic", input.topic);
    appendQuery(url, "tag", input.tag);
    appendQuery(url, "status", input.status);
    appendQuery(url, "confidence", input.confidence);
    appendQuery(url, "page", input.page);
    appendQuery(url, "limit", input.limit);
    return this.request(url.toString(), { method: "GET" });
  }

  async getArticle(input: GetArticleInput): Promise<NoosphereResponse> {
    const body = "canonicalRef" in input
      ? { canonicalRef: input.canonicalRef }
      : { provider: "noosphere", id: input.articleId };
    return this.postJson("/api/memory/get", body);
  }

  async saveMemory(input: SaveMemoryInput): Promise<NoosphereResponse> {
    return this.postJson("/api/memory/save", input);
  }

  async recallMemory(input: RecallMemoryInput): Promise<NoosphereResponse> {
    // Inspection mode includes conflict evidence that can exceed the bounded MCP response size.
    // Build an allowlisted body so caller-owned serialization hooks cannot override that mode.
    const body = createObject(null) as Record<string, unknown>;
    const query = input.query;
    const resultCap = input.resultCap;
    const tokenBudget = input.tokenBudget;
    const scope = input.scope;
    const providers = copyRecallProviders(input.providers);
    body.query = query;
    body.resultCap = resultCap;
    body.tokenBudget = tokenBudget;
    body.scope = scope;
    body.providers = providers;
    body.mode = "auto";

    return this.postJson("/api/memory/recall", body);
  }

  async createArticle(input: CreateArticleInput): Promise<NoosphereResponse> {
    return this.postJson("/api/articles", input);
  }

  private async postJson(path: string, body: unknown): Promise<NoosphereResponse> {
    return this.request(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stringifyJson(body),
    });
  }

  private async request(url: string, init: RequestInit): Promise<NoosphereResponse> {
    if (!this.config.apiKey) {
      throw new NoosphereClientError(
        "Noosphere API key is not configured. Set CODEX_NOOSPHERE_API_KEY or NOOSPHERE_API_KEY before using Noosphere tools.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.config.apiKey}`);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      const payload = await parseResponseBody(response);
      if (!response.ok) {
        throw new NoosphereClientError(
          `Noosphere request failed with HTTP ${response.status}.`,
          response.status,
        );
      }
      if (!isRecord(payload)) {
        throw new NoosphereClientError(
          "Noosphere returned an empty or non-object JSON response.",
          response.status,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof NoosphereClientError) throw error;
      if (isAbortError(error)) {
        throw new NoosphereClientError(
          `Noosphere request timed out after ${this.config.timeoutMs}ms.`,
        );
      }
      throw new NoosphereClientError("Noosphere request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function copyRecallProviders(providers: string[] | undefined): string[] | undefined {
  if (providers === undefined) return undefined;
  if (!isArray(providers)) {
    throw new NoosphereClientError("Recall providers must be an array of strings.");
  }

  const length = providers.length;
  const copy = new ArrayConstructor<string>(length);
  for (let index = 0; index < length; index += 1) {
    const provider = providers[index];
    if (typeof provider !== "string") {
      throw new NoosphereClientError("Recall providers must be an array of strings.");
    }
    copy[index] = provider;
  }
  setPrototypeOf(copy, null);
  return copy;
}

function appendQuery(
  url: URL,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === "") return;
  url.searchParams.set(name, String(value));
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response);
  if (!text) return null;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) return { error: text };
    throw new NoosphereClientError(
      "Noosphere returned a non-JSON response.",
      response.status,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return { error: text };
    throw new NoosphereClientError(
      "Noosphere returned invalid JSON.",
      response.status,
    );
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_RESPONSE_BODY_BYTES) {
      await cancelResponseBody(response);
      throw new NoosphereClientError(
        "Noosphere response body is too large.",
        response.status,
      );
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BODY_BYTES) {
      throw new NoosphereClientError(
        "Noosphere response body is too large.",
        response.status,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response error even if cancellation itself fails.
        }
        throw new NoosphereClientError(
          "Noosphere response body is too large.",
          response.status,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed cancellation must not replace the body-size rejection.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
