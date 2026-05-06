import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack is the default in Next.js 16+
  turbopack: {
    resolveAlias: {
      // Prevents canvas errors when pdfjs-dist is loaded
      canvas: "./src/lib/emptyModule.ts",
    },
  },
};

export default nextConfig;
