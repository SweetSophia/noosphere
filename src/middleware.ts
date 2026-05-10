import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Rate-limit authentication endpoints
  if (path.startsWith("/api/auth") || path === "/wiki/login") {
    const result = rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 10,
      keyPrefix: "auth",
    });
    if (!result.allowed) return result.response;
  }

  // Rate-limit write-heavy API endpoints
  if (
    path === "/api/articles" ||
    path === "/api/ingest" ||
    path === "/api/answer" ||
    path === "/api/import" ||
    path === "/api/uploads/image"
  ) {
    const result = rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 30,
      keyPrefix: "api-write",
    });
    if (!result.allowed) return result.response;
  }

  // Add security headers to all responses
  const response = NextResponse.next();

  // NOTE: Using 'unsafe-inline' for scripts is pragmatic for Next.js hydration.
  // A production-hardened setup should use nonce-based CSP instead:
  // generate a random nonce per request, add it to script-src, and pass it
  // through NextScript / inline script tags. That requires a custom _document.tsx.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Next.js needs inline scripts for hydration
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/wiki/login",
    "/wiki/:path*", // cover article pages, browse, search, admin
    "/uploads/:path*",
  ],
};
