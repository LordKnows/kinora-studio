/* The product's name and mark, in one place. Plain data with no imports, so
   client components, server modules and scripts/build-brand-assets.mjs (which
   Node loads as TypeScript) all read the same thing. docs/brand.md says why
   it looks like this.

   Stave: the set of lines music is written on. The Studio's first page lays a
   film out the same way, a stave for time, the script, the board, the takes,
   the sound and the cut, read top to bottom at any moment. 镜谱: a score of
   shots. */

export const BRAND = {
  name: "Stave",
  zh: "镜谱",
  /** What it is, after the name: "Stave — AI film studio". */
  descriptor: "AI film studio",
  descriptorZh: "AI 电影工作室",
  tagline: "The whole film on one score: every shot, take and cut in its place.",
  taglineZh: "把整部片子写成一页总谱：每个镜头、每条镜次、每一刀都在它的位置上。",
} as const;

/** The three colours of the interface; the red means only "here", "rolling" and "the next step". */
export const BRAND_COLORS = {
  ink: "#121212",
  card: "#E6E6E4",
  tally: "#FF4B1F",
} as const;

/* The mark on a 32-unit field: three staves cut into shots of different
   lengths, and the red line that marks where the film is now. Strokes are two
   units on odd centres with even ends, so the lines fall on whole pixels at 16
   and 32 px. */
export const MARK = {
  viewBox: "0 0 32 32",
  staves: "M6 9H12M14 9H26M6 15H18M20 15H26M6 21H10M12 21H22M24 21H26",
  here: "M19 4V26",
  stroke: 2,
  /** Corner radius of the plate the app icons sit on. */
  plateRadius: 7,
} as const;

/** The mark as SVG markup: on its ink plate (`plate`), or bare in ink on a light ground. */
export function markSvg({ size = 32, plate = true, rounded = true, title = BRAND.name }: { size?: number; plate?: boolean; rounded?: boolean; title?: string } = {}): string {
  const line = plate ? BRAND_COLORS.card : BRAND_COLORS.ink;
  const ground = plate ? `<rect width="32" height="32"${rounded ? ` rx="${MARK.plateRadius}"` : ""} fill="${BRAND_COLORS.ink}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="${size}" height="${size}"><title>${title}</title>${ground}<g shape-rendering="crispEdges" fill="none" stroke-width="${MARK.stroke}"><path d="${MARK.staves}" stroke="${line}"/><path d="${MARK.here}" stroke="${BRAND_COLORS.tally}"/></g></svg>`;
}
