import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack scoped to this repo even when parent directories contain lockfiles.
  turbopack: {
    root: process.cwd(),
  },

  // Standalone output for Docker
  output: "standalone",

  // Image upload handling
  images: {
    // Allow local uploads for wiki images on both legacy dev and official OpenClaw ports.
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        port: "4400",
        pathname: "/uploads/**",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "4400",
        pathname: "/uploads/**",
      },
      {
        protocol: "http",
        hostname: "localhost",
        port: "6578",
        pathname: "/uploads/**",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "6578",
        pathname: "/uploads/**",
      },
    ],
  },

  // Security headers including Content Security Policy
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    const localHttpOrigins = [
      "http://localhost:4400",
      "http://127.0.0.1:4400",
      "http://localhost:6578",
      "http://127.0.0.1:6578",
    ];
    const localWsOrigins = [
      "ws://localhost:4400",
      "ws://127.0.0.1:4400",
      "ws://localhost:6578",
      "ws://127.0.0.1:6578",
    ];

    const scriptSrc = ["script-src", "'self'", "'unsafe-inline'"];
    const imgSrc = ["img-src", "'self'", "data:", "blob:"];
    const connectSrc = ["connect-src", "'self'"];

    if (!isProd) {
      scriptSrc.push("'unsafe-eval'");
      imgSrc.push(...localHttpOrigins);
      connectSrc.push(...localWsOrigins);
    }

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "upgrade-insecure-requests",
              scriptSrc.join(" "),
              "style-src 'self' 'unsafe-inline'",
              imgSrc.join(" "),
              "font-src 'self'",
              connectSrc.join(" "),
              "media-src 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
