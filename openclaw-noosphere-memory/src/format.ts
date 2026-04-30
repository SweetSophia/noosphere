import { NoosphereClientError } from "./client.js";
import type { ResolvedNoosphereMemoryConfig } from "./config.js";

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

export function jsonResult(payload: unknown): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function errorResult(error: unknown, config?: ResolvedNoosphereMemoryConfig): ToolTextResult {
  const payload = formatError(error, config);
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError: true,
  };
}

export function formatError(error: unknown, config?: ResolvedNoosphereMemoryConfig): Record<string, unknown> {
  void config;

  if (error instanceof NoosphereClientError) {
    return {
      ok: false,
      error: error.message,
      status: error.status,
    };
  }

  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
