import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for Docker
  output: "standalone",

  // Image upload handling
  images: {
    // Allow local uploads for wiki images
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        port: "4400",
        pathname: "/uploads/**",
      },
    ],
  },
};

export default nextConfig;
