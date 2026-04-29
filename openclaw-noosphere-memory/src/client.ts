import { ResolvedNoosphereMemoryConfig } from "./config.js";

export interface NoosphereStatusResponse {
  ok: boolean;
  timestamp: string;
  providers: unknown[];
  settings: Record<string, unknown>;
}

export interface NoosphereRecallRequest {
  query: string;
  mode?: "auto" | "inspection";
  resultCap?: number;
  tokenBudget?: number;
  scope?: string;
  providers?: string[];
}

export interface NoosphereRecallResponse {
  results: unknown[];
  totalBeforeCap: number;
  mode: "auto" | "inspection";
  tokenBudgetUsed?: number;
  promptInjectionText?: string;
  providerMeta: unknown[];
  dedupStats?: unknown;
  conflicts?: unknown[];
  conflictStats?: unknown;
}

export class NoosphereClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "NoosphereClientError";
  }
}

export class NoosphereMemoryClient {
  constructor(private readonly config: ResolvedNoosphereMemoryConfig) {}

  async status(): Promise<NoosphereStatusResponse> {
    return this.request<NoosphereStatusResponse>("/api/memory/status", { method: "GET" });
  }

  async recall(request: NoosphereRecallRequest): Promise<NoosphereRecallResponse> {
    return this.request<NoosphereRecallResponse>("/api/memory/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.config.apiKey) {
      throw new NoosphereClientError("Noosphere API key is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          accept: "application/json",
          ...init.headers,
        },
      });

      const payload = await parseResponseBody(response);
      if (!response.ok) {
        throw new NoosphereClientError(
          extractError(payload) ?? `Noosphere request failed with HTTP ${response.status}`,
          response.status,
          payload,
        );
      }

      if (payload === null) {
        throw new NoosphereClientError("Noosphere returned an empty response body", response.status);
      }

      return payload as T;
    } catch (error) {
      if (error instanceof NoosphereClientError) throw error;
      if (isAbortError(error)) {
        throw new NoosphereClientError(`Noosphere request timed out after ${this.config.timeoutMs}ms`);
      }
      throw new NoosphereClientError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (!response.ok) return { rawBody: text };
    throw new NoosphereClientError("Noosphere returned a non-JSON response", response.status, { rawBody: text });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return { rawBody: text };
    throw new NoosphereClientError("Noosphere returned invalid JSON", response.status);
  }
}

function extractError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  if ("error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }

  if ("rawBody" in payload) {
    const rawBody = (payload as { rawBody?: unknown }).rawBody;
    if (typeof rawBody === "string" && rawBody.trim()) return rawBody.trim();
  }

  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /abort/i.test(error.message);
}
