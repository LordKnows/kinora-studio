import type { Shotlist, Warning } from "../types.js";
import { flatShots } from "../types.js";
import { effectiveSeconds } from "../catalog.js";

/**
 * The cue map: one tempo grid the picture locks to. Sections may change tempo.
 * `beatTime(bar, beat)` is the only way the assembler and lint turn music into seconds.
 */
export interface CueSection {
  id: string;
  /** Start second of the section. */
  t: number;
  bpm: number;
  /** Beats per bar (default 4). */
  beatsPerBar?: number;
  /** Texture, instrumentation, dynamics; free text for the composer. */
  texture?: string;
}

export interface Hit {
  id: string;
  /** Section id + bar (1-based) + beat (1-based, may be fractional). */
  section: string;
  bar: number;
  beat: number;
  what: string;
}

export interface CueMap {
  sections: CueSection[];
  hits: Hit[];
  /** Silences: whole bus out. */
  silences?: { t: number; durationS: number; why: string }[];
}

export function beatLengthS(bpm: number): number {
  return 60 / bpm;
}

/** Absolute time of a (section, bar, beat). */
export function beatTime(map: CueMap, section: string, bar: number, beat = 1): number {
  const s = map.sections.find((x) => x.id === section);
  if (!s) throw new Error(`unknown section ${section}`);
  const bpb = s.beatsPerBar ?? 4;
  return s.t + ((bar - 1) * bpb + (beat - 1)) * beatLengthS(s.bpm);
}

/** The section active at time t. */
export function sectionAt(map: CueMap, t: number): CueSection {
  const sorted = [...map.sections].sort((a, b) => a.t - b.t);
  let cur = sorted[0];
  for (const s of sorted) if (s.t <= t + 1e-9) cur = s;
  return cur;
}

/** Nearest grid time at the given subdivision (1 = beat, 2 = half beat, 4 = sixteenth; 0.25 = bar in 4/4). */
export function snapToGrid(map: CueMap, t: number, subdivision = 1): number {
  const s = sectionAt(map, t);
  const step = beatLengthS(s.bpm) / subdivision;
  const k = Math.round((t - s.t) / step);
  return s.t + k * step;
}

export function hitTimes(map: CueMap): { id: string; t: number; what: string }[] {
  return map.hits.map((h) => ({ id: h.id, t: beatTime(map, h.section, h.bar, h.beat), what: h.what })).sort((a, b) => a.t - b.t);
}

/**
 * Plan clip boundaries on the grid. Given the shots in order, produce the cut
 * times that keep each shot within its renderable length (effective seconds)
 * while landing every cut on a beat or bar. Returns per-shot `outS` to use on the timeline.
 */
export function cutOnBeats(map: CueMap, shots: { durationS: number }[], opts: { subdivision?: number; startS?: number; minS?: number } = {}): { startS: number; outS: number; cutAtS: number }[] {
  const sub = opts.subdivision ?? 1;
  const minS = opts.minS ?? 2;
  let t = opts.startS ?? 0;
  const out: { startS: number; outS: number; cutAtS: number }[] = [];
  for (const sh of shots) {
    const maxLen = effectiveSeconds(sh.durationS);
    let cut = snapToGrid(map, t + sh.durationS, sub);
    if (cut - t > maxLen) cut = snapToGrid(map, t + maxLen, sub);
    while (cut - t > maxLen + 1e-9) cut -= beatLengthS(sectionAt(map, cut).bpm) / sub;
    if (cut - t < minS) cut = snapToGrid(map, t + minS, sub);
    out.push({ startS: t, outS: +(cut - t).toFixed(3), cutAtS: +cut.toFixed(3) });
    t = cut;
  }
  return out;
}

/** Check that the hits the treatment names fall inside a shot that can carry them, and that silences exist. */
export function checkCueMap(map: CueMap, list?: Shotlist, totalSeconds?: number): Warning[] {
  const W: Warning[] = [];
  if (!map.sections.length) return [{ code: "cue.sections", severity: "error", message: "no sections" }];
  const sorted = [...map.sections].sort((a, b) => a.t - b.t);
  if (sorted[0].t !== 0) W.push({ code: "cue.start", severity: "warn", message: "first section does not start at 0" });
  for (const s of sorted) if (s.bpm < 30 || s.bpm > 240) W.push({ code: "cue.bpm", severity: "error", message: `section ${s.id}: bpm ${s.bpm}` });
  const bpms = new Set(sorted.map((s) => s.bpm));
  if (sorted.length >= 3 && bpms.size === 1 && !sorted.some((s) => s.texture)) W.push({ code: "cue.flat", severity: "info", message: "one tempo and no texture changes across all sections; vary density or tempo at the turn" });
  if (totalSeconds && totalSeconds >= 30 && (map.silences?.length ?? 0) < 2) W.push({ code: "cue.silence", severity: "warn", message: "fewer than two silences; put one before the turn and one before the peak" });
  for (const h of map.hits) {
    try { beatTime(map, h.section, h.bar, h.beat); } catch (e) { W.push({ code: "cue.hit", severity: "error", message: `${h.id}: ${(e as Error).message}` }); }
  }
  if (list) {
    const bounds: { start: number; end: number; shot: number }[] = [];
    let t = 0;
    for (const { shot, index } of flatShots(list)) { bounds.push({ start: t, end: t + shot.durationS, shot: index }); t += shot.durationS; }
    for (const h of hitTimes(map)) {
      const b = bounds.find((x) => h.t >= x.start && h.t < x.end);
      if (!b) W.push({ code: "cue.hit.outside", severity: "warn", message: `hit ${h.id} at ${h.t.toFixed(2)}s falls outside the shotlist (${t}s)` });
      else if (h.t - b.start < 0.5 || b.end - h.t < 0.5) W.push({ code: "cue.hit.edge", severity: "info", message: `hit ${h.id} at ${h.t.toFixed(2)}s sits within 0.5 s of a shot boundary (shot ${b.shot}); H3 timing at the seam is loose` });
    }
  }
  return W;
}
