import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { rateLimit } from "@/lib/rate-limit";
import { readUploadedImage } from "@/lib/uploads";

function isAdminPath(path: string) {
  return path === "/wiki/admin" || path.startsWith("/wiki/admin/");
}

function addSecurityHeaders(response: NextResponse) {
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

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Rate-limit authentication endpoints
  if (path.startsWith("/api/auth") || path === "/wiki/login") {
    const result = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 10,
      keyPrefix: "auth",
    });
    if (!result.allowed) return addSecurityHeaders(result.response);
  }

  // Rate-limit write-heavy API endpoints. Keep this broad enough to cover
  // article edits plus admin/API write surfaces, while leaving reads unthrottled.
  const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const isWriteEndpoint =
    path === "/api/articles" ||
    path.startsWith("/api/articles/") ||
    path === "/api/ingest" ||
    path === "/api/answer" ||
    path === "/api/import" ||
    path === "/api/uploads/image" ||
    path === "/api/lint" ||
    path === "/api/memory/save" ||
    path === "/api/memory/settings" ||
    path === "/api/sync/obsidian";

  if (isWriteMethod && isWriteEndpoint) {
    const result = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 30,
      keyPrefix: "api-write",
    });
    if (!result.allowed) return addSecurityHeaders(result.response);
  }

  if (isAdminPath(path)) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    if (!token) {
      const loginUrl = new URL("/wiki/login", request.url);
      loginUrl.searchParams.set("callbackUrl", `${path}${request.nextUrl.search}`);
      return addSecurityHeaders(NextResponse.redirect(loginUrl));
    }

    if (token.role !== "ADMIN") {
      return addSecurityHeaders(NextResponse.redirect(new URL("/wiki", request.url)));
    }
  }

  // Intercept SVG uploads to force download (prevents SVG-script XSS)
  // Even with DOMPurify sanitization at upload time, serving SVGs as attachments
  // is defense-in-depth against browser mutation XSS and parser differentials.
  if (path.startsWith("/uploads/images/") && path.endsWith(".svg")) {
    try {
      const filename = path.split("/").pop()!;
      const imageData = await readUploadedImage([filename]);
      const headers = new Headers();
      headers.set("Content-Type", "image/svg+xml");
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
      headers.set("Content-Security-Policy", "sandbox");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      return new NextResponse(imageData.bytes, { status: 200, headers });
    } catch {
      // File not found or path traversal attempt — fall through to static handler
    }
  }

  return addSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    "/api/:path*",
    "/wiki/login",
    "/wiki/:path*", // cover article pages, browse, search, admin
    "/uploads/:path*",
  ],
};
