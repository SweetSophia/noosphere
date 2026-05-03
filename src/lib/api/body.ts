import { NextRequest } from "next/server";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function readBoundedJsonBody(
  request: NextRequest,
  maxBytes: number = 64 * 1024,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

const MAX_JSON_DEPTH = 20;

export class JsonDepthExceededError extends Error {
  constructor() {
    super("JSON nesting depth exceeds limit");
    this.name = "JsonDepthExceededError";
  }
}

/**
 * Parse JSON with a nesting-depth guard to prevent CPU exhaustion
 * from deeply nested payloads (e.g. 30KB of brackets).
 */
export function safeJsonParse(raw: string): unknown {
  let depth = 0;
  return JSON.parse(raw, (_key, value: unknown) => {
    if (depth++ > MAX_JSON_DEPTH) {
      throw new JsonDepthExceededError();
    }
    return value;
  });
}
