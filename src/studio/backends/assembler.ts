import { checkLines } from "@/director";

import type { LookSettings, TimelineInput } from "../schemas";
import type { Shot, Take } from "../types";

/* §4.4 — the input the assembler worker takes. Built here so the UI, the
   export endpoint and the tests agree on one shape. */

export type AssemblerTransition = TimelineInput["clips"][number]["transition"];

export type AssemblerClip = {
  url: string; in_s: number; out_s: number; transition_in: AssemblerTransition; transition_s?: number; repeat?: number; speed?: number; mute?: boolean;
  audio_lead_s?: number; audio_trail_s?: number; freeze_s?: number;
};

export type AssemblerTitle = { text: string; at_s: number; duration_s: number; kind: "card" | "overlay" | "caption"; position?: string; color?: string; background?: string; size?: number };

export type AssemblerInput = {
  export_job_id: string;
  preset: string;
  video_size: string;
  clips: AssemblerClip[];
  audio: {
    keep_clip_audio: boolean;
    music_url?: string;
    mix_db: { dialogue: number; sfx: number; music: number };
    music_duck_under_dialogue: boolean;
    /** With `text`, the assembler writes a subtitle cue as long as the line's audio. */
    narration?: Array<{ url: string; at_s: number; gain_db?: number; text?: string }>;
    silences?: Array<{ at_s: number; duration_s: number }>;
    /** Absent leaves the mix as it is. */
    loudness_lufs?: number;
  };
  picture?: { fade_in_s?: number; fade_out_s?: number; titles?: AssemblerTitle[] };
  subtitles: { srt: string; burn_in: boolean };
  output: { key: string };
};

/** What the web platforms play at; an export lands here unless the timeline says otherwise. */
export const DEFAULT_LOUDNESS_LUFS = -14;

/** How long a clip plays on the film: trimmed, retimed, repeated, plus its freeze. */
export function clipSeconds(clip: { inS: number; outS: number; speed?: number; repeat?: number; freezeS?: number }): number {
  return (Math.max(0, clip.outS - clip.inS) / (clip.speed ?? 1)) * (clip.repeat ?? 1) + (clip.freezeS ?? 0);
}

export function buildAssemblerInput(args: {
  exportId: string;
  projectId: string;
  preset: string;
  look: LookSettings;
  timeline: TimelineInput;
  shots: Map<string, Shot>;
  takes: Map<string, Take>;
  elementNames: Map<string, string>;
  musicUrl?: string;
  /** Asset id → url, for the narration lines. */
  audioUrls?: Map<string, string>;
  /** Asset id → what the audio says (a line made with speak keeps its text). */
  audioTexts?: Map<string, string>;
  burnIn: boolean;
  videoSize: string;
}): AssemblerInput {
  const clips: AssemblerClip[] = [];
  const srtCues: Array<{ start: number; end: number; text: string }> = [];
  /* What the narration track says, so the same line is not captioned twice. */
  const narrated = new Set((args.timeline.narration ?? []).map((n) => sameText(args.audioTexts?.get(n.assetId) ?? "")).filter(Boolean));
  let cursor = 0;
  for (const clip of args.timeline.clips) {
    const take = args.takes.get(clip.takeId);
    const shot = args.shots.get(clip.shotId);
    if (!take?.resultUrl || !shot) continue;
    /* master-upscaled: the Open-H3-Regenerate-2K file when the take has one,
       else the 768p file (the export response lists those). */
    const upscaled = args.preset === "master-upscaled" && take.upscale?.status === "completed" && take.upscale.url ? take.upscale.url : undefined;
    /* The rendered file is the truth: H3 snaps to a frame grid, so the spec's
       duration can overshoot the take by a few frames. */
    const outS = Math.min(clip.outS, take.outputSeconds ?? shot.spec.durationS);
    const speed = clip.speed ?? 1;
    const len = Math.max(0, outS - clip.inS) / speed;
    const repeat = clip.repeat ?? 1;
    /* A take whose sound failed review plays silent. */
    const mute = clip.muteOwnAudio || take.review?.audioOk === false;
    clips.push({
      url: upscaled ?? take.resultUrl,
      in_s: clip.inS,
      out_s: outS,
      transition_in: clip.transition,
      ...(clip.transition !== "cut" ? { transition_s: clip.transitionS ?? 0.4 } : {}),
      ...(repeat > 1 ? { repeat } : {}),
      ...(speed !== 1 ? { speed } : {}),
      ...(mute ? { mute: true } : {}),
      ...(clip.audioLeadS ? { audio_lead_s: clip.audioLeadS } : {}),
      ...(clip.audioTrailS ? { audio_trail_s: clip.audioTrailS } : {}),
      ...(clip.freezeS ? { freeze_s: clip.freezeS } : {}),
    });
    /* A line with its own time window (startS / endS inside the shot) sits
       there; the rest are spread evenly across the clip, good enough for a
       first SRT the editor can nudge. A line that is voiced on the narration
       track gets its cue from that audio instead, as long as it really is. */
    const lines = shot.spec.dialogue.filter((line) => !(line.kind !== "onscreen" && narrated.has(sameText(line.text))));
    if (lines.length) {
      const slice = len / lines.length;
      lines.forEach((line, i) => {
        const windowed = line.startS !== undefined && line.endS !== undefined && line.endS > line.startS;
        const start = windowed ? clamp((line.startS! - clip.inS) / speed, 0, len) : i * slice;
        const end = windowed ? clamp((line.endS! - clip.inS) / speed, 0, len) : (i + 1) * slice - 0.05;
        if (end - start < 0.2) return; // the cut trimmed the line away
        srtCues.push({ start: cursor + start, end: cursor + end, text: `${args.elementNames.get(line.speaker) ?? line.speaker}: ${line.text}` });
      });
    }
    cursor += len * repeat + (clip.freezeS ?? 0);
  }
  const tl = args.timeline;
  const narration = (tl.narration ?? []).flatMap((n) => {
    const url = args.audioUrls?.get(n.assetId);
    const text = args.audioTexts?.get(n.assetId)?.trim();
    return url ? [{ url, at_s: n.atS, ...(n.gainDb !== undefined ? { gain_db: n.gainDb } : {}), ...(text ? { text } : {}) }] : [];
  });
  const titles: AssemblerTitle[] = (tl.titles ?? []).map((t) => ({
    text: t.text, at_s: t.atS, duration_s: t.durationS, kind: t.kind,
    ...(t.position ? { position: t.position } : {}), ...(t.color ? { color: t.color } : {}), ...(t.background ? { background: t.background } : {}), ...(t.size ? { size: t.size } : {}),
  }));
  const loudness = tl.loudnessLufs === undefined ? DEFAULT_LOUDNESS_LUFS : tl.loudnessLufs;
  const picture = { ...(tl.fadeInS ? { fade_in_s: tl.fadeInS } : {}), ...(tl.fadeOutS ? { fade_out_s: tl.fadeOutS } : {}), ...(titles.length ? { titles } : {}) };
  return {
    export_job_id: args.exportId,
    preset: args.preset,
    video_size: args.preset === "social-9x16" ? "768x1344" : args.preset === "preview-480p" ? "854x480" : args.videoSize,
    clips,
    audio: {
      keep_clip_audio: true,
      ...(args.musicUrl ? { music_url: args.musicUrl } : {}),
      mix_db: { dialogue: args.timeline.mix.dialogueDb, sfx: args.timeline.mix.sfxDb, music: args.timeline.mix.musicDb },
      music_duck_under_dialogue: true,
      ...(narration.length ? { narration } : {}),
      ...(tl.silences?.length ? { silences: tl.silences.map((x) => ({ at_s: x.atS, duration_s: x.durationS })) } : {}),
      ...(loudness !== null ? { loudness_lufs: loudness } : {}),
    },
    ...(Object.keys(picture).length ? { picture } : {}),
    subtitles: { srt: toSrt(srtCues), burn_in: args.burnIn },
    output: { key: `projects/${args.projectId}/exports/${args.exportId}.${args.preset}.mp4` },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Two wordings of one line: spaces and punctuation aside. */
function sameText(text: string): string {
  return text.replace(/[\s\p{P}]+/gu, "").toLowerCase();
}

export function toSrt(cues: Array<{ start: number; end: number; text: string }>): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n");
}

function stamp(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(rem).padStart(3, "0")}`;
}

/* ---- what the assembler measured on the finished file ---- */

export type ExportChecks = { lufs?: number | null; true_peak_db?: number | null; black?: number[][]; silent?: number[][] };

const TOLERANCE_S = 0.35;

function covered(range: number[], windows: number[][]): boolean {
  const [a, b] = range as [number, number];
  return windows.some(([x, y]) => a >= x! - TOLERANCE_S && b <= y! + TOLERANCE_S);
}

/**
 * Read the measurements against what the timeline asked for: black picture
 * and missing sound are findings only where nothing on the timeline put them
 * there (a fade, a title card, a fade through black, a silence).
 */
export function exportFindings(input: AssemblerInput, output: { duration_s?: number; cuts_s?: number[]; checks?: ExportChecks; warnings?: string[]; subtitles?: Array<{ start_s: number; end_s: number; text: string }> }): string[] {
  const out: string[] = [...(output.warnings ?? [])];
  const checks = output.checks ?? {};
  const duration = output.duration_s ?? 0;
  const span = (r: number[]) => `${r[0]!.toFixed(2)}–${r[1]!.toFixed(2)} s`;

  const meant: number[][] = [];
  const pic = input.picture ?? {};
  if (pic.fade_in_s) meant.push([0, pic.fade_in_s]);
  if (pic.fade_out_s) meant.push([duration - pic.fade_out_s, duration]);
  for (const t of pic.titles ?? []) if (t.kind === "card") meant.push([t.at_s, t.at_s + t.duration_s]);
  /* cuts_s lists the joins of the repeated parts too; a through-black join is one whose clip asked for it. */
  let join = -1;
  input.clips.forEach((clip, i) => {
    if (i > 0) join += 1;
    const at = output.cuts_s?.[join];
    if (i > 0 && clip.transition_in === "fade_black" && at !== undefined) { const d = clip.transition_s ?? 0.4; meant.push([at - d, at + d]); }
    join += (clip.repeat ?? 1) - 1;
  });
  for (const r of checks.black ?? []) if (!covered(r, meant)) out.push(`black picture at ${span(r)} that no fade, title card or transition on the timeline explains`);

  const quiet = (input.audio.silences ?? []).map((x) => [x.at_s, x.at_s + x.duration_s]);
  for (const r of checks.silent ?? []) {
    if (covered(r, quiet)) continue;
    out.push(duration && r[0]! <= TOLERANCE_S && r[1]! >= duration - TOLERANCE_S ? "the film has no sound at all" : `no sound at ${span(r)}, and no silence on the timeline there`);
  }

  const target = input.audio.loudness_lufs;
  if (typeof checks.lufs === "number") {
    if (target !== undefined && Math.abs(checks.lufs - target) > 1.5) out.push(`loudness is ${checks.lufs} LUFS, the target was ${target}`);
    if (target === undefined && (checks.lufs < -24 || checks.lufs > -10)) out.push(`loudness is ${checks.lufs} LUFS (web platforms play at about -14); set loudnessLufs on the timeline to level it`);
  }
  if (typeof checks.true_peak_db === "number" && checks.true_peak_db > -0.5) out.push(`true peak is ${checks.true_peak_db} dBFS: the mix clips`);

  /* The subtitles as they were written into the file: long enough to read, and one at a time. */
  const cues = (output.subtitles ?? []).map((c, i) => ({ id: `cue ${i + 1}`, text: c.text.replace(/^[^:：]{1,24}[:：]\s*/, ""), t0: c.start_s, t1: c.end_s }));
  const short = checkLines(cues);
  if (short.length) {
    out.push(`${short.length} subtitle cue(s) cannot be read in the time they have: ${short.slice(0, 4).map((x) => `${x.id} at ${cues.find((c) => c.id === x.id)!.t0.toFixed(1)} s (${x.message})`).join("; ")}${short.length > 4 ? " …" : ""}. Give the line more time (a longer clip, a time window on the line) or fewer words`);
  }
  return out;
}
