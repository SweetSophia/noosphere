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
