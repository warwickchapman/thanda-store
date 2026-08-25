import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF.js dynamically loads its worker module at runtime. Keeping it outside
  // the route bundle preserves that module relationship in `next start`.
  serverExternalPackages: ['pdfjs-dist'],
};

export default nextConfig;
