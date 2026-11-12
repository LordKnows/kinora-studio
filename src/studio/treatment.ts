import * as director from "@/director";

import * as repo from "./repo";
import * as styles from "./styles";
import type { TimelineInput } from "./schemas";
import type { Scene } from "./types";

/* The treatment: why the film is shaped the way it is (logline, arc, three
   candidate structures and the one chosen, the benchmark, the hook, the
   sequences and their paces, the sound design, where it goes silent). It is
   kept beside the script version it was written for, so the lint, the story
   review, the export and the Story page can all hold the film to it. */

export type TreatmentWarning = { code: string; message: string; severity: "error" | "warn" | "info" };

export type StoredTreatment = {
  /** The script version it was saved with. */
  scriptVersion: number;
  treatment: director.Treatment;
  warnings: TreatmentWarning[];
  style?: string;
  savedAt: number;
};

/** Check a treatment and, when it holds together, keep it as the project's current one. */
export async function saveTreatment(projectId: string, scriptVersion: number, raw: unknown, style?: string): Promise<{ kept: boolean; ok: boolean; warnings: TreatmentWarning[] }> {
  const s = style ? await styles.resolveStyle(style) : undefined;
  const result = director.validateTreatment(raw, s?.style.nativeMoves.map((m) => m.name));
  const warnings = result.warnings as TreatmentWarning[];
  if (!result.ok) return { kept: false, ok: false, warnings };
  for (const old of (await repo.listNotes(projectId, "treatment")).filter((n) => n.status === "current")) await repo.updateNote(old.id, { status: "superseded" });
  const parsed = director.TreatmentSchema.parse(raw);
  await repo.insertNote(projectId, "treatment", "current", { scriptVersion, treatment: parsed, warnings, ...(s ? { style: s.style.slug } : {}) });
  return { kept: true, ok: true, warnings };
}

export async function currentTreatment(projectId: string): Promise<StoredTreatment | undefined> {
  const notes = (await repo.listNotes(projectId, "treatment")).filter((n) => n.status === "current");
  const note = notes[notes.length - 1];
  if (!note) return undefined;
  const parsed = director.TreatmentSchema.safeParse(note.body.treatment);
  if (!parsed.success) return undefined;
  return {
    scriptVersion: Number(note.body.scriptVersion ?? 0), treatment: parsed.data,
    warnings: Array.isArray(note.body.warnings) ? (note.body.warnings as TreatmentWarning[]) : [],
    ...(typeof note.body.style === "string" ? { style: note.body.style } : {}), savedAt: note.createdAt,
  };
}

const NO_TREATMENT = "no treatment with this script: send one with save_script (logline, arc, three candidate structures and the chosen one, benchmark, hook, signature shot, sequences with their paces, the sound design, silences and sound bridges). validate_treatment checks it first.";

/** What the lint says about the treatment: missing, written for an older script, or carrying its own warnings. */
export function treatmentLint(stored: StoredTreatment | undefined, latestScriptVersion: number | undefined): TreatmentWarning[] {
  if (latestScriptVersion === undefined) return [];
  if (!stored) return [{ code: "treatment.missing", severity: "warn", message: NO_TREATMENT }];
  const out: TreatmentWarning[] = [];
  if (stored.scriptVersion < latestScriptVersion) out.push({ code: "treatment.stale", severity: "info", message: `the treatment was written for script v${stored.scriptVersion}; the script is at v${latestScriptVersion}. Send it again with save_script if the shape changed` });
  for (const w of stored.warnings) if (w.severity !== "info") out.push(w);
  return out;
}

export function missingTreatmentWarning(): TreatmentWarning {
  return { code: "treatment.missing", severity: "warn", message: NO_TREATMENT };
}

const NONE = /^(n\/?a|none|no|silence|silent|无|没有)?[\s.。]*$/i;

/**
 * Hold the timeline to the sound that was planned: the scenes' rows of the
 * sound design table and the treatment's silences and sound bridges. A plan
 * that never reached the timeline is the commonest way a film ends up with
 * wall-to-wall room tone.
 */
export function soundPlanFindings(scenes: Scene[], timeline: TimelineInput, stored: StoredTreatment | undefined): string[] {
  if (timeline.clips.length === 0) return [];
  const out: string[] = [];
  const scored = scenes.filter((s) => s.sound?.music && !NONE.test(s.sound.music));
  if (scored.length && !timeline.music) {
    out.push(`the sound design gives ${scored.length} scene(s) a score (${scored.slice(0, 3).map((s) => `${s.slug}: ${s.sound!.music}`).join("; ")}) and the timeline has no music: set a music asset on the timeline, or change the plan`);
  }
  const quiet = scenes.filter((s) => s.sound?.silence?.trim());
  const plannedSilences = Math.max(quiet.length, stored?.treatment.silences.length ?? 0);
  const silences = timeline.silences?.length ?? 0;
  if (plannedSilences > silences) {
    const where = stored?.treatment.silences.length ? stored.treatment.silences.map((x) => `${x.atSecond} s (${x.why})`).join("; ") : quiet.map((s) => `${s.slug}: ${s.sound!.silence}`).join("; ");
    out.push(`${plannedSilences} silence(s) were planned (${where}) and the timeline has ${silences}: add them to the timeline's silences`);
  }
  const plannedBridges = stored?.treatment.audioBridges.length ?? 0;
  const bridges = timeline.clips.filter((c) => c.audioLeadS || c.audioTrailS).length;
  if (plannedBridges > bridges) {
    out.push(`${plannedBridges} sound bridge(s) were planned (${stored!.treatment.audioBridges.map((b) => `${b.atSecond} s ${b.kind === "j_cut" ? "J-cut" : "L-cut"}: ${b.what}`).join("; ")}) and ${bridges} clip(s) lead or trail their sound: set audioLeadS / audioTrailS`);
  }
  return out;
}
