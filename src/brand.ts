/* The product's name and mark, in one place. Plain data with no imports, so
   client components, server modules and scripts/build-brand-assets.mjs (which
   Node loads as TypeScript) all read the same thing. docs/brand.md says why
   it looks like this.

   The Kinora (Lumière, 1896) was a home viewer: a reel of 640 curved photo
   cards on a brass core, turned by a crank, and a small metal stop that held
   each card flat in front of the lens for an instant. That instant is a frame.
   影匣: a box of moving pictures. */

export const BRAND = {
  /** The name in text: titles, the manifest, the MCP server's instructions. */
  name: "Kinora Studio",
  /** The wordmark: the word in bold with the i's dot as the red card, the suffix in regular. */
  word: "kinora",
  suffix: "Studio",
  zh: "影匣",
  /** What it is, after the name: "Kinora Studio — AI film studio". */
  descriptor: "AI film studio",
  descriptorZh: "AI 电影工作室",
  tagline: "Every shot a reel; the red card is the frame in front of the lens now.",
  taglineZh: "每个镜头是一卷片轮；红色的那张，是此刻停在镜头前的那一帧。",
} as const;

/** The colours. The red means only "now": the card at the stop, a take rolling, the next step. */
export const BRAND_COLORS = {
  ink: "#121212",
  card: "#E6E6E4",
  paper: "#F7F7F5",
  tally: "#FF4B1F",
  /** On dark grounds: the light (never pure white) and the plate one step above the ground, with its edge. */
  night: "#EDEDEA",
  nightPlate: "#1F1F1E",
  nightEdge: "#3A3A38",
} as const;

/** The mark as files a client fetches (scripts/build-brand-assets.mjs writes them). The web app manifest and
    the MCP server both list these; the PNGs come first because every MCP client must read PNG and SVG is optional. */
export const BRAND_ICONS = [
  { src: "/icon-192.png", type: "image/png", size: "192x192" },
  { src: "/icon-512.png", type: "image/png", size: "512x512" },
  { src: "/icon.svg", type: "image/svg+xml", size: "any" },
] as const;

/** The frames inside src/app/favicon.ico, in pixels: what an origin answers when asked for /favicon.ico. */
export const FAVICON_SIZES = [16, 32, 48] as const;

/* The mark on a 64-unit field: three rounded cards make a K. The upright one
   is the spindle, the lower one leans on it, and the red one is the card
   flicking past the stop. */
export const MARK = {
  viewBox: "0 0 64 64",
  /** The cards alone, cropped to them: the mark without its plate, beside the wordmark on a dark ground. */
  bareViewBox: "11 8 43 48",
  plateRadius: 14,
  cardRadius: 3.5,
  cards: [
    { x: 13, y: 10, w: 11, h: 44, rotate: "", red: false },
    { x: 27, y: 5, w: 11, h: 27, rotate: "36 27 32", red: true },
    { x: 27, y: 32, w: 11, h: 25, rotate: "-36 27 32", red: false },
  ],
} as const;

export type MarkGround = "ink" | "paper" | "night" | "none";

const cardsSvg = (fg: string, cls = false) =>
  MARK.cards
    .map((c) => `<rect${cls ? ` class="${c.red ? "red" : "card"}"` : ""} x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${MARK.cardRadius}" fill="${c.red ? BRAND_COLORS.tally : fg}"${c.rotate ? ` transform="rotate(${c.rotate})"` : ""}/>`)
    .join("");

/** The mark as SVG markup. `ink`: on its ink plate (the app icon); `paper`: ink cards on a light plate; `night`: on the raised dark plate; `none`: the cards alone. */
export function markSvg({ size = 64, ground = "ink", title = BRAND.name, rounded = true }: { size?: number; ground?: MarkGround; title?: string; rounded?: boolean } = {}): string {
  const rx = rounded ? ` rx="${MARK.plateRadius}"` : "";
  if (ground === "none") {
    const [, , w, h] = MARK.bareViewBox.split(" ").map(Number);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.bareViewBox}" width="${((size * w!) / h!).toFixed(1)}" height="${size}"><title>${title}</title>${cardsSvg(BRAND_COLORS.ink)}</svg>`;
  }
  const plate =
    ground === "night"
      ? `<rect x=".5" y=".5" width="63" height="63"${rx} fill="${BRAND_COLORS.nightPlate}" stroke="${BRAND_COLORS.nightEdge}"/>`
      : `<rect width="64" height="64"${rx} fill="${ground === "paper" ? BRAND_COLORS.paper : BRAND_COLORS.ink}"/>`;
  const fg = ground === "ink" ? BRAND_COLORS.card : ground === "night" ? BRAND_COLORS.night : BRAND_COLORS.ink;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="${size}" height="${size}"><title>${title}</title>${plate}${cardsSvg(fg)}</svg>`;
}

/** The favicon: the ink plate, and in a dark browser the raised dark plate with its edge, so it does not sink into the tab. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="32" height="32"><title>${BRAND.name}</title><style>.plate{fill:${BRAND_COLORS.ink}}.card{fill:${BRAND_COLORS.card}}@media (prefers-color-scheme: dark){.plate{fill:${BRAND_COLORS.nightPlate};stroke:#4A4A47;stroke-width:2}.card{fill:${BRAND_COLORS.night}}}</style><rect class="plate" x="1" y="1" width="62" height="62" rx="${MARK.plateRadius}"/>${cardsSvg(BRAND_COLORS.card, true)}</svg>`;
}
