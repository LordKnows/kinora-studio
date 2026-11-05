import { z } from "zod";
import type { Warning } from "./types.js";

/**
 * The treatment: written before the shotlist, after the brief. Mirrors the
 * DIRECTOR.md §4 discipline: three candidate structures, a chosen one, logline
 * and arc, benchmark learn / don't learn, hook, ending, signature shot, native move.
 */
export const TreatmentSchema = z.object({
  title: z.string().min(1),
  style: z.string().min(1).describe("style slug"),
  totalSeconds: z.number().int().min(5).max(3600),
  logline: z.string().min(10).max(300),
  arc: z.object({
    setup: z.string().min(5),
    turn: z.string().min(5),
    ending: z.string().min(5),
  }),
  candidates: z.array(z.object({
    name: z.string().min(1),
    shape: z.string().min(10),
    why: z.string().optional(),
  })).min(3).max(5),
  chosen: z.string().min(1).describe("name of the chosen candidate"),
  whyChosen: z.string().min(10),
  benchmark: z.array(z.object({
    work: z.string().min(1),
    learn: z.string().min(5),
    dontLearn: z.string().min(5),
  })).min(1).max(3),
  hook: z.object({
    description: z.string().min(5),
    atSecond: z.number().min(0).max(10),
  }),
  endingEcho: z.string().min(5).describe("how the ending answers the opening"),
  signatureShot: z.string().min(5),
  nativeMove: z.string().min(1).describe("name of the style's native move used at the emotional peak"),
  sequences: z.array(z.object({
    name: z.string().min(1),
    seconds: z.number().positive(),
    purpose: z.string().min(3),
    pace: z.enum(["still", "slow", "steady", "brisk", "frantic"]),
  })).min(3).max(8),
  soundDesign: z.array(z.object({
    sequence: z.string(),
    ambience: z.string(),
    foley: z.string(),
    music: z.string(),
  })).min(1),
  silences: z.array(z.object({ atSecond: z.number().min(0), why: z.string() })).default([]),
  audioBridges: z.array(z.object({ atSecond: z.number().min(0), kind: z.enum(["j_cut", "l_cut"]), what: z.string() })).default([]),
  narrationLanguage: z.string().default("en"),
});
export type Treatment = z.infer<typeof TreatmentSchema>;

export interface TreatmentCheck {
  ok: boolean;
  warnings: Warning[];
}

export function validateTreatment(input: unknown, styleNativeMoves?: string[]): TreatmentCheck {
  const parsed = TreatmentSchema.safeParse(input);
  const warnings: Warning[] = [];
  if (!parsed.success) {
    for (const i of parsed.error.issues) warnings.push({ code: "treatment.schema", severity: "error", message: `${i.path.join(".")}: ${i.message}` });
    return { ok: false, warnings };
  }
  const t = parsed.data;
  if (!t.candidates.some((c) => c.name === t.chosen)) warnings.push({ code: "treatment.chosen", severity: "error", message: `chosen "${t.chosen}" is not one of the candidates` });
  const shapes = t.candidates.map((c) => c.shape.toLowerCase());
  if (new Set(shapes).size < shapes.length) warnings.push({ code: "treatment.duplicate", severity: "warn", message: "two candidate structures are identical; the first idea is usually the cliché" });
  if (t.hook.atSecond > 3) warnings.push({ code: "treatment.hook", severity: "warn", message: `hook lands at ${t.hook.atSecond}s; aim for the first 3 seconds` });
  const seqTotal = t.sequences.reduce((a, s) => a + s.seconds, 0);
  if (Math.abs(seqTotal - t.totalSeconds) > Math.max(2, t.totalSeconds * 0.05)) warnings.push({ code: "treatment.sequences", severity: "error", message: `sequences add up to ${seqTotal}s, target is ${t.totalSeconds}s` });
  const paces = new Set(t.sequences.map((s) => s.pace));
  if (paces.size < 2) warnings.push({ code: "treatment.pace", severity: "warn", message: "every sequence has the same pace; a film at one even speed has failed" });
  if (!t.sequences.some((s) => s.pace === "still" || s.pace === "slow")) warnings.push({ code: "treatment.breath", severity: "warn", message: "no slow or still sequence: give the audience one breath" });
  if (t.totalSeconds >= 30 && t.silences.length < 2) warnings.push({ code: "treatment.silence", severity: "warn", message: "fewer than two real silences before the turn or the peak" });
  if (t.totalSeconds >= 30 && t.audioBridges.length < 2) warnings.push({ code: "treatment.bridges", severity: "warn", message: "fewer than two J-cuts or L-cuts; use sound as a transition at least twice" });
  const seqNames = new Set(t.sequences.map((s) => s.name));
  for (const row of t.soundDesign) if (!seqNames.has(row.sequence)) warnings.push({ code: "treatment.sound", severity: "warn", message: `sound design row for unknown sequence "${row.sequence}"` });
  for (const s of t.sequences) if (!t.soundDesign.some((r) => r.sequence === s.name)) warnings.push({ code: "treatment.sound", severity: "warn", message: `sequence "${s.name}" has no sound design row` });
  if (styleNativeMoves && !styleNativeMoves.some((m) => m.toLowerCase() === t.nativeMove.toLowerCase())) warnings.push({ code: "treatment.nativeMove", severity: "warn", message: `native move "${t.nativeMove}" is not in the style's menu (${styleNativeMoves.join("; ")})` });
  if (/piano and strings/i.test(t.soundDesign.map((r) => r.music).join(" "))) warnings.push({ code: "treatment.generic", severity: "info", message: "generic 'piano and strings'; score in the style's instruments" });
  return { ok: !warnings.some((w) => w.severity === "error"), warnings };
}

/** The treatment as TREATMENT.md, ready for `save_script` or the project folder. */
export function treatmentToMarkdown(t: Treatment): string {
  const L: string[] = [];
  L.push(`# ${t.title}`, "", `Style: \`${t.style}\` · ${t.totalSeconds} s · narration: ${t.narrationLanguage}`, "");
  L.push("## Logline and arc", "", t.logline, "", `- Setup: ${t.arc.setup}`, `- Turn: ${t.arc.turn}`, `- Ending: ${t.arc.ending}`, `- Ending echoes the opening: ${t.endingEcho}`, "");
  L.push("## Candidate structures", "");
  for (const c of t.candidates) L.push(`- **${c.name}${c.name === t.chosen ? " (chosen)" : ""}.** ${c.shape}${c.why ? ` ${c.why}` : ""}`);
  L.push("", `Chosen: **${t.chosen}**. ${t.whyChosen}`, "");
  L.push("## Benchmark", "");
  for (const b of t.benchmark) L.push(`- ${b.work}: learn ${b.learn}; don't take ${b.dontLearn}.`);
  L.push("", "## Hook, signature, native move", "", `- Hook at ${t.hook.atSecond}s: ${t.hook.description}`, `- Signature shot: ${t.signatureShot}`, `- Native move at the peak: ${t.nativeMove}`, "");
  L.push("## Sequences", "", "| Sequence | Seconds | Pace | Purpose |", "|---|---|---|---|");
  for (const s of t.sequences) L.push(`| ${s.name} | ${s.seconds} | ${s.pace} | ${s.purpose} |`);
  L.push("", "## Sound design", "", "| Sequence | Ambience | Foley | Music |", "|---|---|---|---|");
  for (const r of t.soundDesign) L.push(`| ${r.sequence} | ${r.ambience} | ${r.foley} | ${r.music} |`);
  if (t.silences.length) { L.push("", "Silences:"); for (const s of t.silences) L.push(`- ${s.atSecond}s: ${s.why}`); }
  if (t.audioBridges.length) { L.push("", "Audio bridges:"); for (const b of t.audioBridges) L.push(`- ${b.atSecond}s ${b.kind}: ${b.what}`); }
  L.push("");
  return L.join("\n");
}
