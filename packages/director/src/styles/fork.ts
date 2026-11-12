import type { Style } from "./schema.js";
import { lintConstraints } from "../lint/constraints.js";
import type { Warning } from "../types.js";

/**
 * A style of the user's own: a library style changed, or one written from a
 * blank page on a library style's technique. The convention (after
 * lemo-opuscar's "make a style your own") sorts a style's sections into three
 * groups, so the user knows what each change costs before it is made.
 */
export type ChangeGroup = "safe" | "character" | "essence";

export const GROUP_ADVICE: Record<ChangeGroup, string> = {
  safe: "Safe to change: the style stays itself.",
  character: "Changes its character: possible, but say what the style loses with it.",
  essence: "Cannot change: with a different essence this is a different style, not a version of the base. Start from a blank page and keep the base only as the technique.",
};

interface Section {
  section: string;
  group: ChangeGroup;
  read: (s: Style) => unknown;
  /** What this section decides, in a line the user can read. */
  about: string;
}

const SECTIONS: Section[] = [
  { section: "§1 essence", group: "essence", about: "what makes a frame read as this style, and what it is not", read: (s) => ({ essence: s.essence, not: s.not }) },
  { section: "§2 materials", group: "character", about: "the medium and how it is rendered", read: (s) => s.materials },
  { section: "§3 colour logic", group: "character", about: "the rules of colour: how many hues, what the accent is for", read: (s) => s.colour.rules },
  { section: "§3 palette", group: "safe", about: "the palette inside those rules", read: (s) => ({ example: s.colour.examplePalette, look: s.engine.look.palette }) },
  { section: "§4 type", group: "safe", about: "typefaces, where titles and captions sit", read: (s) => s.type },
  { section: "§5 motion", group: "safe", about: "tempo, stepping, how much moves, shot lengths", read: (s) => ({ motion: s.motion, durations: s.engine.durations }) },
  { section: "§6 camera grammar", group: "character", about: "the camera moves the style uses, its framing and transitions", read: (s) => s.camera },
  { section: "§7 sound palette", group: "safe", about: "instruments, foley, ambience, silence, voice", read: (s) => s.sound },
  { section: "§8 native moves", group: "safe", about: "the moments only this medium can do (swap at most one: they are the signature)", read: (s) => s.nativeMoves },
  { section: "§9 pitfalls", group: "safe", about: "what the model gets wrong in this style, and the fix", read: (s) => s.pitfalls },
  { section: "§10 engine", group: "character", about: "what reaches the model on every shot: genre, camera, lens, lighting, the constraints (statements of what the picture shows), cinematography defaults, LoRAs, the beat suffix", read: (s) => ({ ...s.engine, look: { ...s.engine.look, palette: undefined }, durations: undefined }) },
  { section: "§11 variation space", group: "safe", about: "the structures, openings and endings the style suggests", read: (s) => s.variation },
];

export interface StyleChange {
  section: string;
  group: ChangeGroup;
  was: string;
  now: string;
  /** The user's reason, when the director recorded one. */
  why?: string;
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 400 ? text.slice(0, 397) + "…" : text;
}

/** The three groups for one style, with what each section holds now. */
export function forkGuide(base: Style): { group: ChangeGroup; advice: string; sections: { section: string; about: string; now: string }[] }[] {
  return (["safe", "character", "essence"] as const).map((group) => ({
    group,
    advice: GROUP_ADVICE[group],
    sections: SECTIONS.filter((x) => x.group === group).map((x) => ({ section: x.section, about: x.about, now: brief(x.read(base)) })),
  }));
}

/** A copy of the base under a new name, ready to be changed. */
export function forkStyle(base: Style, id: { slug: string; en: string; cn: string; line?: string; line_cn?: string }): Style {
  return {
    ...structuredClone(base),
    slug: id.slug, en: id.en, cn: id.cn,
    line: id.line ?? base.line, line_cn: id.line_cn ?? base.line_cn,
    lineage: `Based on ${base.en} (${base.slug}).`,
  };
}

/** Which sections differ from the base, each with its group. */
export function diffStyle(base: Style, next: Style, why: Record<string, string> = {}): StyleChange[] {
  const out: StyleChange[] = [];
  for (const x of SECTIONS) {
    const was = JSON.stringify(x.read(base));
    const now = JSON.stringify(x.read(next));
    if (was === now) continue;
    out.push({ section: x.section, group: x.group, was: brief(x.read(base)), now: brief(x.read(next)), ...(why[x.section] ? { why: why[x.section] } : {}) });
  }
  return out;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** What to tell the user before a style of their own is kept. */
export function checkFork(base: Style | undefined, next: Style, taken: { library: string[]; others: string[] }): { changes: StyleChange[]; warnings: Warning[] } {
  const W: Warning[] = [];
  if (!SLUG.test(next.slug)) W.push({ code: "style.slug", severity: "error", message: `slug "${next.slug}" must be lowercase letters, digits and hyphens, 2 to 49 characters` });
  if (taken.library.includes(next.slug)) W.push({ code: "style.slug.library", severity: "error", message: `"${next.slug}" is a library style; a style of your own needs its own slug` });
  if (taken.others.includes(next.slug)) W.push({ code: "style.slug.taken", severity: "error", message: `"${next.slug}" is someone else's style; choose another slug` });
  /* H3 has no negative prompt: a constraint is a statement of what the picture shows.
     The sixteen presets are held to that; so is a style of the user's own. */
  for (const w of lintConstraints(next.engine.negative)) {
    W.push({ ...w, code: w.code.replace("look.constraints", "style.constraints"), message: w.message.replace(/^Look constraints/, "The style's constraints (engine.negative)") });
  }
  if (!base) return { changes: [], warnings: W };

  const changes = diffStyle(base, next);
  if (!changes.length) W.push({ code: "style.same", severity: "warn", message: `nothing differs from ${base.slug}; a film can use the library style as it is` });
  if (changes.some((c) => c.group === "essence")) {
    W.push({ code: "style.essence", severity: "warn", message: `§1 differs from ${base.slug}: this is a different style, not a version of it. Tell the user, and keep it only if that is what they want (${base.slug} is then only the technique base)` });
  }
  const character = changes.filter((c) => c.group === "character");
  if (character.length) W.push({ code: "style.character", severity: "info", message: `changes the style's character: ${character.map((c) => c.section).join(", ")}. Say what it loses with each` });
  /* §10 follows from the others (a new palette changes the Look), so it is not counted as a decision of its own. */
  const decisions = changes.filter((c) => c.section !== "§10 engine");
  if (decisions.length > 5) W.push({ code: "style.many", severity: "warn", message: `${decisions.length} sections changed at once; more than five in one round are hard to judge. Split it into rounds` });
  const before = new Set(base.nativeMoves.map((m) => m.name));
  const after = new Set(next.nativeMoves.map((m) => m.name));
  const gone = [...before].filter((n) => !after.has(n));
  if (gone.length > 1) W.push({ code: "style.signature", severity: "warn", message: `${gone.length} native moves removed (${gone.join(", ")}); they are what makes the style recognisable, swap at most one` });
  /* Changes that travel together. */
  const touched = new Set(changes.map((c) => c.section));
  if (touched.has("§5 motion") && !touched.has("§7 sound palette")) W.push({ code: "style.travel.sound", severity: "info", message: "motion changed and sound did not: faster motion wants denser sound, slower motion sparser" });
  if (touched.has("§2 materials") && !touched.has("§9 pitfalls")) W.push({ code: "style.travel.pitfalls", severity: "info", message: "a new material brings its own pitfalls; add them to §9" });
  if ((touched.has("§3 palette") || touched.has("§3 colour logic")) && JSON.stringify(base.engine.look.palette) === JSON.stringify(next.engine.look.palette)) {
    W.push({ code: "style.travel.look", severity: "warn", message: "the colours changed but engine.look.palette did not: the model reads the Look, so the change would not reach a shot" });
  }
  return { changes, warnings: W };
}

/** CHANGES.md: one row per decision, as the user approved it. */
export function changesToMarkdown(base: Style, next: Style, changes: StyleChange[]): string {
  const L = [`# ${next.en} · ${next.cn}: what changed from ${base.en}`, "", "| Section | Group | Was | Now | Why |", "|---|---|---|---|---|"];
  const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const c of changes) L.push(`| ${c.section} | ${c.group} | ${cell(c.was)} | ${cell(c.now)} | ${cell(c.why ?? "")} |`);
  L.push("");
  return L.join("\n");
}
