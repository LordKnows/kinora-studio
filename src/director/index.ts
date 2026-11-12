/* The director layer (packages/director) inside the Studio MCP: the same
   judgement helpers — style presets, treatment check, rhythm lint, cue map,
   subtitles, batch plan, extended-timeline check — without the filesystem.
   Styles come from the generated catalog; the two node-only tools of the
   package (assemble_local with ffmpeg, synthesize_narration with edge-tts)
   stay local and are not exposed here. */

import { StyleSchema, type Style } from "@director/styles/schema";

import { STYLE_LIBRARY_RAW } from "./generated";

export { compileLook, applyStyle } from "@director/compile/look";
export { validateTreatment, treatmentToMarkdown, TreatmentSchema, type Treatment } from "@director/treatment";
export { lintShotlist } from "@director/lint/shotlist";
export { lintCraft, shotFragility, fragileInText, screenDirection, type Fragility } from "@director/lint/craft";
export { checkConstraint, promptConstraints, lintConstraints, type ConstraintVerdict } from "@director/lint/constraints";
export { checkCueMap, cutOnBeats, hitTimes, type CueMap } from "@director/sound/cuemap";
export { checkTimeline, toStudioTimeline, type ExtTimeline } from "@director/timeline/extended";
export { checkLines, placeLines, toSrt, spellNumbersForSpeech, type Line } from "@director/narration/srt";
export { planBatch, type BatchShot } from "@director/batch";
export { styleToMarkdown } from "@director/styles/markdown";
export { DIRECTOR_DOC, TECHNIQUE_DOC, STYLES_INDEX_DOC } from "./generated";
export type { Style };

export { forkGuide, forkStyle, diffStyle, checkFork, changesToMarkdown, GROUP_ADVICE, type ChangeGroup, type StyleChange } from "@director/styles/fork";
export { StyleSchema };

export interface LoadedStyle {
  style: Style;
  /** "mine": a style a user made (src/studio/styles.ts); it carries who and from what. */
  origin: "library" | "mine";
  by?: string;
  basedOn?: string;
}

let cache: LoadedStyle[] | undefined;

/** The style library, validated once per isolate. */
export function loadStyles(): LoadedStyle[] {
  if (cache) return cache;
  const out: LoadedStyle[] = [];
  for (const raw of STYLE_LIBRARY_RAW) {
    const parsed = StyleSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`style library: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    out.push({ style: parsed.data, origin: "library" });
  }
  cache = out.sort((a, b) => a.style.slug.localeCompare(b.style.slug));
  return cache;
}

/** Find by slug, English or Chinese name. `pool` defaults to the library; pass
    the pool with the users' own styles (styles.allStyles) to find those too. */
export function findStyle(query: string, pool: LoadedStyle[] = loadStyles()): LoadedStyle | undefined {
  const q = query.trim().toLowerCase();
  const all = pool;
  return (
    all.find((s) => s.style.slug === q) ??
    all.find((s) => s.style.en.toLowerCase() === q || s.style.cn === query.trim()) ??
    all.find((s) => s.style.en.toLowerCase().includes(q) || s.style.cn.includes(query.trim()))
  );
}

/** Rank styles for a topic by matching uses, line and native-move fits. */
export function suggestStyles(topic: string, n = 3, pool: LoadedStyle[] = loadStyles()): { style: Style; score: number; why: string }[] {
  const words = topic.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length > 2);
  const scored = pool.map(({ style }) => {
    const hay = [...style.uses, style.line, style.line_cn, ...style.nativeMoves.flatMap((m) => m.fits), ...style.variation.structures].join(" ").toLowerCase();
    let score = 0;
    const hits: string[] = [];
    for (const w of words) if (hay.includes(w)) { score++; hits.push(w); }
    return { style, score, why: hits.length ? `matches ${hits.join(", ")}` : "no direct match" };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}
