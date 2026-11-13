import type { MetadataRoute } from "next";

import { BRAND, BRAND_COLORS, BRAND_ICONS } from "@/brand";

/* The installed app (Add to Home Screen / Install). It opens on the
   projects, in the Studio's own grey, with the three-card K that
   scripts/build-brand-assets.mjs draws from src/brand.ts. */

const ICONS: MetadataRoute.Manifest["icons"] = [
  ...BRAND_ICONS.map((icon) => ({ src: icon.src, type: icon.type, sizes: icon.size, purpose: "any" as const })),
  /* the mark inside the safe circle, for launchers that crop to a shape */
  { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
];

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: `${BRAND.name} ${BRAND.zh}`,
    short_name: "Kinora",
    description: `${BRAND.descriptor}. ${BRAND.tagline}`,
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: BRAND_COLORS.card,
    theme_color: BRAND_COLORS.card,
    categories: ["entertainment", "productivity", "photo"],
    icons: ICONS,
  };
}
