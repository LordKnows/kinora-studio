import type { StudioTimeline, StudioClip, Warning } from "../types.js";
import type { LocalTransition } from "../catalog.js";

/**
 * The extended timeline, in the director's own words. The Studio's
 * `save_timeline` now takes nearly all of it (transitions, J/L cuts, freezes,
 * titles, narration by asset, silences, fades, a loudness target), and
 * `toStudioTimeline` translates. What stays local: a clip's own gain, a title's
 * free x/y and font, narration from a file that is not a Studio asset.
 * `assemble()` renders the same timeline with ffmpeg from take files on disk.
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
  /** A file on disk, for the local assembly. */
  file?: string;
  /** A Studio audio asset, for `save_timeline`. */
  assetId?: string;
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

const STUDIO_COLOR = /^[A-Za-z0-9#@.]{1,32}$/;

/** Translate to what `save_timeline` accepts, and say what could not go along. */
export function toStudioTimeline(t: ExtTimeline): { timeline: StudioTimeline; dropped: Warning[] } {
  const dropped: Warning[] = [];
  const clips: StudioClip[] = t.clips.map((c, i) => {
    /* The Studio has no flash of its own: a flash is a short fade through white. */
    const flash = c.transition === "flash_white";
    const tr: NonNullable<StudioClip["transition"]> = !c.transition ? "cut" : c.transition === "flash_white" ? "fade_white" : c.transition;
    const clip: StudioClip = { shotId: c.shotId, takeId: c.takeId, inS: c.inS ?? 0, outS: c.outS, repeat: c.repeat ?? 1, transition: tr, ...(c.speed && c.speed !== 1 ? { speed: c.speed } : {}), ...(c.muteOwnAudio ? { muteOwnAudio: true } : {}) };
    if (tr !== "cut") clip.transitionS = Math.min(1, Math.max(0.2, flash ? Math.min(c.transitionS ?? 0.2, 0.3) : c.transitionS ?? 0.5));
    if (c.audioLeadS && i > 0) clip.audioLeadS = Math.min(2, c.audioLeadS);
    if (c.audioTrailS) clip.audioTrailS = Math.min(2, c.audioTrailS);
    if (c.freezeS) clip.freezeS = Math.min(10, c.freezeS);
    if (c.gainDb) dropped.push({ code: "studio.gain", severity: "info", shot: i, message: "a clip's own gain is not on the Studio timeline; use the mix or muteOwnAudio" });
    return clip;
  });
  const timeline: StudioTimeline = { clips, mix: t.mix ?? { dialogueDb: 0, musicDb: -12, sfxDb: -3 } };
  if (t.music?.assetId) timeline.music = t.music.assetId;
  if (t.fadeInS) timeline.fadeInS = Math.min(5, t.fadeInS);
  if (t.fadeOutS) timeline.fadeOutS = Math.min(5, t.fadeOutS);
  if (t.titles?.length) {
    timeline.titles = t.titles.map((x) => {
      if (x.x || x.y || x.font) dropped.push({ code: "studio.title.place", severity: "info", message: `title "${x.text.slice(0, 30)}": free x/y and font stay local; the Studio places it by kind` });
      const ok = (c?: string) => (c && STUDIO_COLOR.test(c) ? c : undefined);
      return { text: x.text, atS: x.t, durationS: x.durationS, kind: x.kind, ...(ok(x.color) ? { color: x.color } : {}), ...(ok(x.background) ? { background: x.background } : {}), ...(x.fontSize ? { size: Math.round(x.fontSize) } : {}) };
    });
  }
  const spoken = (t.narration ?? []).filter((n) => n.assetId);
  if (spoken.length) timeline.narration = spoken.map((n) => ({ assetId: n.assetId!, atS: n.t, ...(n.gainDb !== undefined ? { gainDb: n.gainDb } : {}) }));
  const local = (t.narration ?? []).length - spoken.length;
  if (local) dropped.push({ code: "studio.narration", severity: "warn", message: `${local} narration line(s) are files, not Studio assets: upload them (or make them with speak) and give their assetId` });
  if (t.silences?.length) timeline.silences = t.silences.map((x) => ({ atS: x.t, durationS: x.durationS }));
  if (t.lufs !== undefined) timeline.loudnessLufs = t.lufs;
  if (t.subtitles) dropped.push({ code: "studio.subtitles", severity: "info", message: "the Studio writes its own SRT from the dialogue; burn it in with export_project burnInSubtitles" });
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
    /* The lead is the take's own sound before inS: a clip that starts at its take's first frame has none. */
    if (i > 0 && c.audioLeadS && c.audioLeadS * (c.speed ?? 1) > (c.inS ?? 0) + 1e-6) W.push({ code: "clip.jl.lead", severity: "warn", shot: i, message: `audioLeadS ${c.audioLeadS} needs ${+(c.audioLeadS * (c.speed ?? 1)).toFixed(2)} s of take before inS, and inS is ${c.inS ?? 0}: trim the head of the picture (raise inS) or shorten the lead` });
    if (c.audioTrailS && c.outS + c.audioTrailS * (c.speed ?? 1) > 15.2) W.push({ code: "clip.jl.trail", severity: "warn", shot: i, message: `audioTrailS ${c.audioTrailS} runs past the longest take; the trail is the take's own sound after outS` });
    if (c.freezeS && (c.repeat ?? 1) > 1) W.push({ code: "clip.freeze.loop", severity: "info", shot: i, message: "a looped clip freezes once, after its last repeat" });
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
