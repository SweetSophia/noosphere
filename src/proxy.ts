import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

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
