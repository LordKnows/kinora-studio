import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* better-sqlite3 is a native module used only on Node (dev / self-host);
     Workers use D1 through src/cloudflare.ts. */
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;

/* Lets `next dev` reach Cloudflare bindings (D1, R2) through wrangler when
   STUDIO_DB=d1; a no-op otherwise. */
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.STUDIO_DB === "d1") void initOpenNextCloudflareForDev();
