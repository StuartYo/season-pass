import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // HiGHS ships a WebAssembly file next to its JS; keep it as a plain Node dependency so the file is found at runtime.
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: { "/api/mcp": ["./node_modules/highs/build/**"], "/api/agent": ["./node_modules/highs/build/**"] },
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
};

export default nextConfig;
