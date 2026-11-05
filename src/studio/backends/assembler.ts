import type { LookSettings, TimelineInput } from "../schemas";
import type { Shot, Take } from "../types";

/* §4.4 — the input the assembler worker takes. Built here so the UI, the
   export endpoint and the tests agree on one shape. */

export type AssemblerClip = { url: string; in_s: number; out_s: number; transition_in: "cut" | "dissolve"; transition_s?: number; repeat?: number };

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
  };
  subtitles: { srt: string; burn_in: boolean };
  output: { key: string };
};

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
  burnIn: boolean;
  videoSize: string;
}): AssemblerInput {
  const clips: AssemblerClip[] = [];
  const srtCues: Array<{ start: number; end: number; text: string }> = [];
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
    const len = Math.max(0, outS - clip.inS);
    const repeat = clip.repeat ?? 1;
    clips.push({
      url: upscaled ?? take.resultUrl,
      in_s: clip.inS,
      out_s: outS,
      transition_in: clip.transition,
      ...(clip.transition === "dissolve" ? { transition_s: clip.transitionS ?? 0.4 } : {}),
      ...(repeat > 1 ? { repeat } : {}),
    });
    /* Dialogue lines are spread evenly across the clip; good enough for a
       first SRT the editor can nudge. */
    const lines = shot.spec.dialogue;
    if (lines.length) {
      const slice = len / lines.length;
      lines.forEach((line, i) => {
        srtCues.push({
          start: cursor + i * slice,
          end: cursor + (i + 1) * slice - 0.05,
          text: `${args.elementNames.get(line.speaker) ?? line.speaker}: ${line.text}`,
        });
      });
    }
    cursor += len * repeat;
  }
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
    },
    subtitles: { srt: toSrt(srtCues), burn_in: args.burnIn },
    output: { key: `projects/${args.projectId}/exports/${args.exportId}.${args.preset}.mp4` },
  };
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
