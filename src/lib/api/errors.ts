import { NextResponse } from "next/server";

let requestIdSeq = 0;

function nextRequestId(): string {
  requestIdSeq = (requestIdSeq + 1) % 0xffff;
  const time = Date.now().toString(36);
  const seq = requestIdSeq.toString(36).padStart(3, "0");
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `${time}-${seq}-${rand}`;
}

/**
 * Standardized JSON error response with an optional requestId for tracing.
 */
export function apiError(
  message: string,
  status: number,
  requestId?: string
): NextResponse {
  const id = requestId ?? nextRequestId();
  return NextResponse.json({ error: message, requestId: id }, { status });
}

/**
 * Attach a requestId to the current response headers for tracing.
 */
export function withRequestId(response: NextResponse): NextResponse {
  response.headers.set("x-request-id", nextRequestId());
  return response;
}

/**
 * Keep an entire API handler inside one fail-closed response boundary. Error
 * messages are deliberately omitted from both the response and the log so a
 * database or provider exception cannot disclose request data or credentials.
 */
export async function withApiErrorBoundary(
  context: string,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    // Never inspect arbitrary exception properties here. Error.name/message
    // are writable (and may be hostile getters), so even "classification"
    // must remain a fixed, non-secret-bearing value.
    const errorKind = error === null ? "null" : typeof error;
    console.error(`[${context}] unexpected route failure`, { errorKind });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
