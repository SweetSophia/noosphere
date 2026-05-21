import type {
  MemoryRecallResponse,
  MemorySaveResponse,
  NoospherePluginConfig,
  TopicListResponse,
} from "./types.js";

const MAX_ERROR_BODY_LENGTH = 2_000;

export interface RecallRequest {
  query: string;
  mode?: "auto" | "inspection";
  resultCap?: number;
  tokenBudget?: number;
  providers?: string[];
  scope?: string;
}

export interface SaveRequest {
  title: string;
  content: string;
  topicId: string;
  excerpt?: string;
  tags?: string[];
  source?: string;
  authorName?: string;
  confidence?: "low" | "medium" | "high";
}

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
  constructor(private readonly config: NoospherePluginConfig) {}

  async status(): Promise<unknown> {
    return this.requestJson("GET", "/api/memory/status");
  }

  async health(): Promise<unknown> {
    return this.requestJson("GET", "/api/health");
  }

  async topics(): Promise<TopicListResponse> {
    return this.requestJson<TopicListResponse>("GET", "/api/topics");
  }

  async recall(request: RecallRequest): Promise<MemoryRecallResponse> {
    return this.requestJson<MemoryRecallResponse>("POST", "/api/memory/recall", request);
  }

  async save(request: SaveRequest): Promise<MemorySaveResponse> {
    return this.requestJson<MemorySaveResponse>("POST", "/api/memory/save", request);
  }

  private async requestJson<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.config.apiKey) {
      throw new NoosphereClientError(
        "Set OPENCODE_NOOSPHERE_API_KEY for Opencode Noosphere memory requests, or NOOSPHERE_API_KEY as a compatibility fallback",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (!response.ok) {
        throw new NoosphereClientError(
          await readErrorMessage(response),
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof NoosphereClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new NoosphereClientError("Noosphere request timed out");
      }
      throw new NoosphereClientError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `Noosphere HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const message = parsed.error || parsed.message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  } catch {
    // Fall through to bounded text.
  }
  return text.slice(0, MAX_ERROR_BODY_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
