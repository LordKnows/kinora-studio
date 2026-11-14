import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* better-sqlite3 is a native module used only on Node (dev / self-host);
     Workers use D1 through src/cloudflare.ts. */
  serverExternalPackages: ["better-sqlite3"],
  /* The project pages before the Reel / Story / Design / Board / Cut bar kept
     their own addresses; links to them (in decisions, in chats with the
     director, in bookmarks) land on the page that holds them now. The query
     (?view=lined, ?show=review, ?shot=…) is passed through, and the browser
     keeps a #fragment across a redirect. Answered before rendering, as a 307. */
  async redirects() {
    return MOVED_PAGES.map(([from, to]) => ({ source: `/p/:id/${from}`, destination: `/p/:id${to}`, permanent: false }));
  },
};

/** The project pages that moved: old slug, new address under /p/:id. */
export const MOVED_PAGES: Array<[string, string]> = [
  ["look", "/design"],
  ["script", "/story"],
  ["elements", "/design?tab=elements"],
  ["pictures", "/design?tab=pictures"],
  ["timeline", "/cut"],
  ["finals", "/cut"],
  ["director", "?panel=director"],
  ["settings", "?panel=settings"],
];

export default nextConfig;

/* Lets `next dev` reach Cloudflare bindings (D1, R2) through wrangler when
   STUDIO_DB=d1; a no-op otherwise. */
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.STUDIO_DB === "d1") void initOpenNextCloudflareForDev();
