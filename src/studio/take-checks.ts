import { onscreenLines } from "./compiler";
import type { ShotInput, TakeFault } from "./schemas";
import type { Take } from "./types";

/*
 * What was measured on a finished take, read against what the shot asked for.
 *
 * The director sees four stills of a take and hears nothing; the user is the
 * only one who watches it. The worker measures three things on the file that
 * need no model (workers/h3-runpod/handler.py measure_take): how much the
 * picture changes over time, the level of the sound over time, and how far
 * the first and last frames are from the pictures the take was given. Here
 * they are held against the shot's beats, its timed lines and its frames.
 *
 * Every finding is a lead, never a verdict: "the movement of beat 1 is over
 * in its first second" says where to look, and the take is still the user's
 * to watch. The thresholds below are first guesses, not measured on H3 takes:
 * most compare a take with itself (one part against the rest), which holds
 * across styles; the few absolute floors are marked.
 */

export type TakeChecks = {
  version: number;
  /** Mean absolute change between consecutive small grey frames, at `fps`; 0 is a still. */
  motion?: { fps: number; values: number[] };
  /** RMS level of the take's own sound in dBFS, `hz` values a second; null: no audio stream. */
  audio?: { hz: number; db: number[] } | null;
  /** How far the take's first / last frame is from the picture given for it, 0 to 1. */
  first_frame_diff?: number;
  last_frame_diff?: number;
  failed?: string[];
};

export type TakeFinding = {
  code: string;
  message: string;
  /** The fault tag this finding suggests, for the user to confirm on the Board. */
  suggests?: TakeFault;
  /** Where in the take, in seconds. */
  at?: [number, number];
};

/** Numbers a comparison of takes can use (the A/B report). */
export type TakeMeasures = {
  /** Share of all the take's movement that falls in its first 30 %. Even movement gives 0.3. */
  earlyShare?: number;
  beats: number;
  /** Beats that show little movement next to the rest of the take. */
  idleBeats: number;
  timedLines: number;
  /** Timed on-screen lines with nothing audible in their window. */
  quietLines: number;
  startDiff?: number;
  endDiff?: number;
  findings: number;
};

/* Absolute floors (guesses): below this mean change the picture is a still; this level is digital silence. */
const STILL = 0.0006;
const SILENCE_DB = -55;
/* A frame "is" the picture it was given when it is this close (codec loss and scaling leave about 0.01). */
const SAME_FRAME = 0.04;

export function takeChecks(take: Take): TakeChecks | undefined {
  const c = take.input?.studio_checks as TakeChecks | undefined;
  return c && typeof c === "object" && typeof c.version === "number" ? c : undefined;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Findings and measures of one take against its shot. Empty when the take carries no measurements. */
export function readTake(take: Take, spec: ShotInput): { findings: TakeFinding[]; measures: TakeMeasures } {
  const checks = takeChecks(take);
  const findings: TakeFinding[] = [];
  const timed = onscreenLines(spec).filter((l) => l.startS !== undefined && l.endS !== undefined && l.endS > l.startS);
  const measures: TakeMeasures = { beats: spec.beats.length, idleBeats: 0, timedLines: timed.length, quietLines: 0, findings: 0 };
  if (!checks) return { findings, measures };

  const m = checks.motion;
  if (m?.values.length && m.fps > 0) {
    const v = m.values;
    const length = v.length / m.fps;
    /* the shot is written in spec seconds; the take runs the frame grid's length */
    const scale = length / spec.durationS;
    const slice = (from: number, to: number) => v.slice(Math.max(0, Math.floor(from * scale * m.fps)), Math.min(v.length, Math.ceil(to * scale * m.fps)));
    const overall = mean(v);
    const total = sum(v);
    const cuts = spec.beats.filter((b) => b.cut && b.from > 0).map((b) => b.from * scale);
    measures.earlyShare = total > 0 ? Math.round((sum(v.slice(0, Math.ceil(v.length * 0.3))) / total) * 100) / 100 : undefined;

    if (overall < STILL) {
      findings.push({ code: "motion.still", message: `the picture hardly changes over the whole take (mean change ${overall.toFixed(4)}): it may be a still`, at: [0, r1(length)] });
    } else {
      for (const [k, b] of spec.beats.entries()) {
        const w = slice(b.from, b.to);
        const span = b.to - b.from;
        if (w.length < 4 || span < 1.5) continue;
        const energy = sum(w);
        const head = sum(w.slice(0, Math.ceil(w.length * 0.3)));
        const at: [number, number] = [r1(b.from * scale), r1(b.to * scale)];
        if (spec.beats.length > 1 && mean(w) < overall * 0.2) {
          measures.idleBeats++;
          findings.push({ code: "motion.idle_beat", suggests: "action_timing", at, message: `beat ${k + 1} (${b.from}–${b.to} s) shows little movement next to the rest of the take: its action may have happened earlier, or not at all` });
        } else if (energy > 0 && head / energy >= 0.75 && mean(w) >= STILL) {
          findings.push({ code: "motion.early", suggests: "action_timing", at, message: `${pct(head / energy)} of the movement in beat ${k + 1} (${b.from}–${b.to} s) falls in its first ${r1(span * 0.3)} s and the picture then holds: the action may be over early` });
        }
      }
      /* an abrupt change the shot did not ask for, away from the ends and from its own cuts */
      const med = median(v);
      const edge = Math.ceil(0.4 * m.fps);
      v.forEach((x, i) => {
        const t = (i + 0.5) / m.fps;
        if (i < 2 || i >= v.length - edge) return;
        if (x > Math.max(0.12, med * 8) && !cuts.some((c) => Math.abs(c - t) <= 0.5)) findings.push({ code: "motion.jump", at: [r1(t), r1(t)], message: `an abrupt change in the picture at ${r1(t)} s that the shot did not ask for: a cut, a flash or a pop` });
      });
      for (const c of cuts) {
        const near = v.filter((_x, i) => Math.abs((i + 0.5) / m.fps - c) <= 0.6);
        if (near.length && Math.max(...near) < Math.max(0.05, med * 4)) findings.push({ code: "motion.no_cut", suggests: "action_wrong", at: [r1(c), r1(c)], message: `the hard cut the shot asks for at ${r1(c)} s does not show in the picture` });
      }
      const tail = v.slice(-edge);
      if (tail.length && Math.max(...tail) > Math.max(0.05, med * 5) && !cuts.some((c) => length - c <= 0.6)) {
        findings.push({ code: "motion.tail", suggests: "tail_snap", at: [r1(length - 0.4), r1(length)], message: `the picture jumps in its last 0.4 s: a snap onto the end frame? Trim the tail (tailTrimS) or check the end frame` });
      }
      if (v.length > 2 && Math.max(v[0]!, v[1]!) > Math.max(0.05, med * 5)) {
        findings.push({ code: "motion.head", suggests: "first_frame_pop", at: [0, 0.3], message: "the picture jumps in its first frames: the edit drops two frames at the head of a frame-driven take; check whether that is enough" });
      }
    }
  }

  const a = checks.audio;
  if (a?.db.length && a.hz > 0) {
    const length = a.db.length / a.hz;
    const scale = length / spec.durationS;
    const peak = Math.max(...a.db);
    if (peak < SILENCE_DB) {
      findings.push({ code: "sound.silent", suggests: "audio_bad", message: `the take has no audible sound (peak ${Math.round(peak)} dBFS)`, at: [0, r1(length)] });
    } else {
      for (const l of timed) {
        const w = a.db.slice(Math.floor(l.startS! * scale * a.hz), Math.ceil(l.endS! * scale * a.hz));
        if (w.length && Math.max(...w) < Math.max(SILENCE_DB, peak - 35)) {
          measures.quietLines++;
          const quote = l.text.length > 16 ? `${l.text.slice(0, 16)}…` : l.text;
          findings.push({ code: "sound.line_quiet", suggests: "audio_bad", at: [r1(l.startS! * scale), r1(l.endS! * scale)], message: `nothing audible between ${l.startS} and ${l.endS} s, where "${quote}" should be spoken: the line may come late, or not at all. The level cannot tell speech from other sound: listen` });
        }
      }
    }
  } else if (checks.audio === null) {
    findings.push({ code: "sound.none", suggests: "audio_bad", message: "the take has no audio stream" });
  }

  if (checks.first_frame_diff !== undefined) {
    measures.startDiff = checks.first_frame_diff;
    if (checks.first_frame_diff > SAME_FRAME) findings.push({ code: "frame.start", suggests: "first_frame_pop", at: [0, 0], message: `the take's first frame is not the picture it was given (difference ${checks.first_frame_diff.toFixed(3)}; the same picture measures about 0.01)` });
  }
  if (checks.last_frame_diff !== undefined) {
    measures.endDiff = checks.last_frame_diff;
    /* the take's own first frame says what "the same picture" measures on this pipeline */
    const same = Math.max(SAME_FRAME, (checks.first_frame_diff ?? 0.012) * 3);
    if (checks.last_frame_diff > same) findings.push({ code: "frame.end", message: `the take does not land on its end frame (difference ${checks.last_frame_diff.toFixed(3)}${checks.first_frame_diff !== undefined ? `, against ${checks.first_frame_diff.toFixed(3)} at the first frame` : ""}): the action may not have reached it in the time` });
  }
  measures.findings = findings.length;
  return { findings, measures };
}

/** The fault tags the measurements suggest, for the Board's one-click tagging. */
export function suggestedFaults(findings: TakeFinding[]): TakeFault[] {
  return [...new Set(findings.map((f) => f.suggests).filter((f): f is TakeFault => !!f))];
}

/** One line for a review's basis: what was measured, so an agent can say what it did and did not check. */
export function measuredBasis(take: Take): string {
  const c = takeChecks(take);
  if (!c) return "no measurements on this take";
  const has = [c.motion?.values.length ? "motion over time" : "", c.audio?.db.length ? "sound level over time" : "", c.first_frame_diff !== undefined ? "first frame against its picture" : "", c.last_frame_diff !== undefined ? "last frame against its picture" : ""].filter(Boolean);
  return has.length ? `measured on the file: ${has.join(", ")}` : "no measurements on this take";
}

/** A short line per finding for the Board; `{at}` is where in the take. The full sentence is the finding's message. */
export const FINDING_LABELS: Record<string, string> = {
  "motion.still": "The picture hardly changes: a still?",
  "motion.early": "The action may be over early ({at})",
  "motion.idle_beat": "A beat with little movement ({at})",
  "motion.jump": "An abrupt change nobody asked for ({at})",
  "motion.no_cut": "The cut the shot asks for does not show ({at})",
  "motion.tail": "The picture jumps in its last frames",
  "motion.head": "The picture jumps in its first frames",
  "sound.silent": "No audible sound",
  "sound.none": "No audio stream",
  "sound.line_quiet": "Nothing audible where a line should be ({at})",
  "frame.start": "The first frame is not the picture it was given",
  "frame.end": "The take does not land on its end frame",
};

export function findingAt(f: TakeFinding): string {
  if (!f.at) return "";
  return f.at[0] === f.at[1] ? `${f.at[0]} s` : `${f.at[0]}–${f.at[1]} s`;
}
