import type { MetadataRoute } from "next";

import { SITE_URL } from "@/site";

/* The Studio is a private workspace: projects, the library, the machine
   and Connect sit behind sign-in, and robots.ts keeps crawlers out of
   them. The one address worth listing is the front door. */

const PUBLIC_PATHS = ["/"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({
    url: new URL(path, `${SITE_URL}/`).toString(),
    changeFrequency: "monthly",
    priority: 1,
  }));
}
