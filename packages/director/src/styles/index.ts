import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StyleSchema, type Style } from "./schema.js";

/** Library root: `<package>/styles`. User styles: `$DIRECTOR_MY_STYLES` or `~/.openhiggsfield/my-styles`. */
export function libraryDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/styles/index.js → ../../styles ; src/styles/index.ts → ../../styles
  return join(here, "..", "..", "styles");
}

export function myStylesDir(): string {
  const env = process.env.DIRECTOR_MY_STYLES;
  if (env) return env;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".openhiggsfield", "my-styles");
}

export interface LoadedStyle {
  style: Style;
  dir: string;
  origin: "library" | "mine";
}

function loadDir(dir: string, origin: "library" | "mine"): LoadedStyle[] {
  if (!existsSync(dir)) return [];
  const out: LoadedStyle[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith("_")) continue;
    const file = join(dir, name.name, "style.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const parsed = StyleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    out.push({ style: parsed.data, dir: join(dir, name.name), origin });
  }
  return out.sort((a, b) => a.style.slug.localeCompare(b.style.slug));
}

/** User styles first, then the library; a user style shadows a library slug. */
export function loadStyles(): LoadedStyle[] {
  const mine = loadDir(myStylesDir(), "mine");
  const seen = new Set(mine.map((s) => s.style.slug));
  const lib = loadDir(libraryDir(), "library").filter((s) => !seen.has(s.style.slug));
  return [...mine, ...lib];
}

export function findStyle(query: string): LoadedStyle | undefined {
  const q = query.trim().toLowerCase();
  const all = loadStyles();
  return (
    all.find((s) => s.style.slug === q) ??
    all.find((s) => s.style.en.toLowerCase() === q || s.style.cn === query.trim()) ??
    all.find((s) => s.style.en.toLowerCase().includes(q) || s.style.cn.includes(query.trim()))
  );
}

/** Rank styles for a topic by matching `uses`, `line` and native-move fits. Crude but useful for suggestions. */
export function suggestStyles(topic: string, n = 3): { style: Style; score: number; why: string }[] {
  const words = topic.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length > 2);
  const scored = loadStyles().map(({ style }) => {
    const hay = [
      ...style.uses, style.line, style.line_cn,
      ...style.nativeMoves.flatMap((m) => m.fits),
      ...style.variation.structures,
    ].join(" ").toLowerCase();
    let score = 0;
    const hits: string[] = [];
    for (const w of words) if (hay.includes(w)) { score++; hits.push(w); }
    return { style, score, why: hits.length ? `matches ${hits.join(", ")}` : "no direct match" };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

export { StyleSchema, type Style } from "./schema.js";
