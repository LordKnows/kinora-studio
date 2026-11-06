import type { StudioTimeline, StudioClip, Warning } from "../types.js";
import type { LocalTransition } from "../catalog.js";

/**
 * The extended timeline: everything the Studio's `save_timeline` takes, plus
 * what its assembler cannot do yet (J/L cuts, fades, titles, a narration track,
 * ducking). `toStudioTimeline` strips it to the Studio shape so the project
 * stays valid; `assemble()` renders the full thing locally with ffmpeg from the
 * exported take files.
 */
export interface ExtClip extends Omit<StudioClip, "transition"> {
  /** Local file of the take (downloaded from the asset URL) for local assembly. */
  file?: string;
  transition?: LocalTransition;
  transitionS?: number;
  /** J-cut: this clip's audio starts this many seconds before its picture. */
  audioLeadS?: number;
  /** L-cut: this clip's audio continues this many seconds after its picture. */
  audioTrailS?: number;
  /** Gain on the clip's own audio in dB. */
  gainDb?: number;
  /** Mute the model's own audio (use narration / music only). */
  muteOwnAudio?: boolean;
  /** Hold the last frame this many seconds (a freeze). */
  freezeS?: number;
  /** YUV matrix the take was written with. Untagged H3 takes are BT.601 data
      (PyAV's default RGB → YUV); the assembler converts to BT.709 and tags it. */
  sourceMatrix?: "bt601" | "bt709";
}

export interface TitleCard {
  text: string;
  /** Absolute start second on the assembled timeline. */
  t: number;
  durationS: number;
  /** Full-frame card (intertitle) or overlay on the picture. */
  kind: "card" | "overlay" | "caption";
  font?: string;
  fontSize?: number;
  color?: string;
  background?: string;
  /** x/y as ffmpeg expressions, e.g. "(w-text_w)/2". */
  x?: string;
  y?: string;
}

export interface NarrationLine {
  file: string;
  t: number;
  gainDb?: number;
}

export interface ExtTimeline {
  fps?: number;
  width?: number;
  height?: number;
  clips: ExtClip[];
  titles?: TitleCard[];
  narration?: NarrationLine[];
  music?: { file?: string; assetId?: string; gainDb?: number; fadeInS?: number; fadeOutS?: number; startS?: number };
  /** Duck music under narration and dialogue by this many dB. */
  duckDb?: number;
  mix?: { dialogueDb?: number; musicDb?: number; sfxDb?: number };
  fadeInS?: number;
  fadeOutS?: number;
  /** Silences: the whole bus out. */
  silences?: { t: number; durationS: number }[];
  /** Burn an SRT file. */
  subtitles?: { file: string; style?: string };
  /** Target loudness (LUFS) for the two-pass loudnorm. */
  lufs?: number;
}

/** Strip to what `save_timeline` accepts. */
export function toStudioTimeline(t: ExtTimeline): { timeline: StudioTimeline; dropped: Warning[] } {
  const dropped: Warning[] = [];
  const clips: StudioClip[] = t.clips.map((c, i) => {
    const tr: "cut" | "dissolve" = c.transition === "dissolve" ? "dissolve" : "cut";
    if (c.transition && c.transition !== "cut" && c.transition !== "dissolve") dropped.push({ code: "studio.transition", severity: "info", shot: i, message: `transition ${c.transition} kept for the local assembler; the Studio gets a cut` });
    if (c.audioLeadS || c.audioTrailS) dropped.push({ code: "studio.jl", severity: "info", shot: i, message: "J/L cut only in the local assembler" });
    const clip: StudioClip = { shotId: c.shotId, takeId: c.takeId, inS: c.inS ?? 0, outS: c.outS, repeat: c.repeat ?? 1, transition: tr, ...(c.speed && c.speed !== 1 ? { speed: c.speed } : {}), ...(c.muteOwnAudio ? { muteOwnAudio: true } : {}) };
    if (tr === "dissolve") clip.transitionS = Math.min(1, Math.max(0.2, c.transitionS ?? 0.5));
    return clip;
  });
  if (t.titles?.length) dropped.push({ code: "studio.titles", severity: "info", message: `${t.titles.length} title(s) only in the local assembler` });
  if (t.narration?.length) dropped.push({ code: "studio.narration", severity: "info", message: "narration track only in the local assembler" });
  const timeline: StudioTimeline = { clips, mix: t.mix ?? { dialogueDb: 0, musicDb: -12, sfxDb: -3 } };
  if (t.music?.assetId) timeline.music = t.music.assetId;
  return { timeline, dropped };
}

/** Absolute start times of each clip on the assembled picture track (repeats and dissolve overlaps included). */
export function clipStarts(t: ExtTimeline): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  let cursor = 0;
  t.clips.forEach((c, i) => {
    const len = (((c.outS - (c.inS ?? 0)) / (c.speed ?? 1)) * (c.repeat ?? 1)) + (c.freezeS ?? 0);
    const overlap = i > 0 && c.transition && c.transition !== "cut" ? Math.min(1, Math.max(0.2, c.transitionS ?? 0.5)) : 0;
    const start = cursor - overlap;
    out.push({ start, length: len });
    cursor = start + len;
  });
  return out;
}

export function totalSeconds(t: ExtTimeline): number {
  const s = clipStarts(t);
  if (!s.length) return 0;
  const last = s[s.length - 1];
  return last.start + last.length;
}

export function checkTimeline(t: ExtTimeline): Warning[] {
  const W: Warning[] = [];
  t.clips.forEach((c, i) => {
    if (c.outS <= (c.inS ?? 0)) W.push({ code: "clip.range", severity: "error", shot: i, message: `outS ${c.outS} ≤ inS ${c.inS ?? 0}` });
    if (c.outS > 15.2) W.push({ code: "clip.long", severity: "error", shot: i, message: `outS ${c.outS} exceeds a take's length` });
    if (c.speed !== undefined && (c.speed < 0.5 || c.speed > 2)) W.push({ code: "clip.speed", severity: "error", shot: i, message: `speed ${c.speed} is outside 0.5–2` });
    else if (c.speed !== undefined && (c.speed < 0.8 || c.speed > 1.25)) W.push({ code: "clip.speed.visible", severity: "info", shot: i, message: `speed ${c.speed}: beyond 0.8–1.25 the retime shows` });
    if ((c.audioLeadS ?? 0) > 2 || (c.audioTrailS ?? 0) > 2) W.push({ code: "clip.jl", severity: "warn", shot: i, message: "J/L cuts over 2 s read as a mistake" });
    if (i === 0 && c.audioLeadS) W.push({ code: "clip.jl.first", severity: "warn", shot: 0, message: "the first clip cannot lead its audio" });
    if (c.transition === "dissolve" && i === 0) W.push({ code: "clip.dissolve.first", severity: "warn", shot: 0, message: "a dissolve on the first clip is a fade; use fadeInS" });
  });
  const total = totalSeconds(t);
  for (const tc of t.titles ?? []) {
    if (tc.t + tc.durationS > total + 0.01 && tc.kind !== "card") W.push({ code: "title.outside", severity: "warn", message: `title "${tc.text}" runs past the picture` });
    if (tc.durationS < (tc.kind === "card" ? 3 : 1.8)) W.push({ code: "title.short", severity: "warn", message: `title "${tc.text}" held ${tc.durationS}s; cards need ≥ 3 s (4 s for a main title), overlays ≥ 1.8 s` });
  }
  const jl = t.clips.filter((c) => c.audioLeadS || c.audioTrailS).length;
  if (t.clips.length >= 6 && jl < 2) W.push({ code: "timeline.jl", severity: "info", message: "fewer than two J/L cuts; use sound as a transition at least twice" });
  if (t.clips.length >= 6 && (t.silences?.length ?? 0) < 2) W.push({ code: "timeline.silence", severity: "info", message: "fewer than two silences on the timeline" });
  return W;
}
