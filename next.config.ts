import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Development HMR access from the approved local-network test device only.
  allowedDevOrigins: ["172.20.10.2"],
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
