import { NextRequest } from "next/server";

export const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;

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
  maxBytes: number = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<string> {
  // Missing/empty header → Number(null)===0; the streaming cap below is the
  // authoritative bound, so the absent-header path falls through safely.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (totalBytes + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    totalBytes += value.byteLength;
    chunks.push(value);
  }

  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

export const MAX_JSON_DEPTH = 20;

export class JsonDepthExceededError extends Error {
  constructor() {
    super("JSON nesting depth exceeds limit");
    this.name = "JsonDepthExceededError";
  }
}

export function getJsonBodyError(error: unknown): {
  message: string;
  status: 400 | 413;
} {
  // Match by `name` rather than `instanceof` so the 413 mapping survives
  // module-duplication or realm boundaries that break instanceof identity.
  if (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "RequestBodyTooLargeError" ||
      (error as { name?: string }).name === "JsonDepthExceededError")
  ) {
    return { message: (error as Error).message, status: 413 };
  }

  return { message: "Invalid JSON body", status: 400 };
}

function assertJsonDepth(raw: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const character of raw) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) {
        throw new JsonDepthExceededError();
      }
    } else if (character === "}" || character === "]") {
      // Malformed closing delimiters must not offset later nesting and weaken
      // the guard. JSON.parse will still report the malformed payload.
      depth = Math.max(0, depth - 1);
    }
  }
}

/**
 * Parse JSON with a nesting-depth guard to prevent CPU exhaustion
 * from deeply nested payloads (e.g. 30KB of brackets).
 */
export function safeJsonParse(raw: string): unknown {
  assertJsonDepth(raw);
  return JSON.parse(raw);
}

/**
 * Convenience wrapper: read a bounded request body and parse it as JSON.
 * Throws RequestBodyTooLargeError (413) or JsonDepthExceededError (413) on failure.
 */
export async function readBoundedJson(
  request: NextRequest,
  maxBytes: number = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  const rawBody = await readBoundedJsonBody(request, maxBytes);
  return safeJsonParse(rawBody);
}

export async function readBoundedJsonObject<T extends object = Record<string, unknown>>(
  request: NextRequest,
  maxBytes: number = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<T> {
  const body = await readBoundedJson(request, maxBytes);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SyntaxError("JSON body must be an object");
  }
  return body as T;
}
