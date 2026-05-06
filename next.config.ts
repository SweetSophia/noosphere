import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
