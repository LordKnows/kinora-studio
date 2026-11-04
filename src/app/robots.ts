import type { MetadataRoute } from "next";

import { SITE_URL } from "@/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      /* API, MCP and OAuth endpoints are not pages. */
      disallow: ["/api/", "/mcp", "/oauth/", "/p/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
