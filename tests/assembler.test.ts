import { describe, expect, it } from "vitest";

import { buildAssemblerInput, clipSeconds, exportFindings, toSrt } from "@/studio/backends/assembler";
import { DEFAULT_LOOK, ShotInput, TimelineInput } from "@/studio/schemas";
import type { Shot, Take } from "@/studio/types";

const spec = ShotInput.parse({
  durationS: 6, mode: "text", intent: "Two lines in a diner",
  beats: [{ from: 0, to: 6, action: "Mara and Joe talk across the counter" }],
  camera: { move: "static" },
  dialogue: [{ speaker: "mara", text: "You came." }, { speaker: "joe", text: "I said I would." }],
});

const shot: Shot = { id: "s1", projectId: "p", sceneId: "c", index: 0, spec, createdAt: 0, updatedAt: 0 };
const take: Take = { id: "t1", projectId: "p", shotId: "s1", n: 1, backend: "runpod", workflow: "T2VA", prompt: "", input: {}, status: "completed", resultUrl: "https://r2/t1.mp4", thumbUrls: [], createdAt: 0 };

describe("assembler input", () => {
  it("builds clips, spreads dialogue into SRT cues and names the output key", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", inS: 1, outS: 5, transition: "dissolve" }], mix: { musicDb: -10 } });
    const input = buildAssemblerInput({
      exportId: "exp_1", projectId: "p", preset: "master-768p", look: DEFAULT_LOOK, timeline,
      shots: new Map([["s1", shot]]), takes: new Map([["t1", take]]), elementNames: new Map([["mara", "Mara"], ["joe", "Joe"]]),
      burnIn: true, videoSize: "1344x768",
    });
    expect(input.clips).toEqual([{ url: "https://r2/t1.mp4", in_s: 1, out_s: 5, transition_in: "dissolve", transition_s: 0.4 }]);
    expect(input.audio.mix_db.music).toBe(-10);
    expect(input.subtitles.burn_in).toBe(true);
    expect(input.subtitles.srt).toContain("Mara: You came.");
    expect(input.subtitles.srt).toContain("00:00:02,000 --> 00:00:03,950");
    expect(input.output.key).toBe("projects/p/exports/exp_1.master-768p.mp4");
    expect(input.video_size).toBe("1344x768");
  });

  it("skips clips whose take has no result and picks the social size", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "missing", outS: 6 }] });
    const input = buildAssemblerInput({
      exportId: "e", projectId: "p", preset: "social-9x16", look: DEFAULT_LOOK, timeline,
      shots: new Map([["s1", shot]]), takes: new Map(), elementNames: new Map(), burnIn: false, videoSize: "1344x768",
    });
    expect(input.clips).toHaveLength(0);
    expect(input.video_size).toBe("768x1344");
  });

  it("formats SRT timestamps", () => {
    expect(toSrt([{ start: 61.5, end: 62, text: "x" }])).toBe("1\n00:01:01,500 --> 00:01:02,000\nx\n");
  });
});

describe("the extended timeline", () => {
  const base = { exportId: "e", projectId: "p", preset: "master-768p", look: DEFAULT_LOOK, shots: new Map([["s1", shot]]), takes: new Map([["t1", take]]), elementNames: new Map<string, string>(), burnIn: false, videoSize: "1344x768" };

  it("an old timeline still parses, and lands on -14 LUFS", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", outS: 5 }] });
    const input = buildAssemblerInput({ ...base, timeline });
    expect(input.clips).toEqual([{ url: "https://r2/t1.mp4", in_s: 0, out_s: 5, transition_in: "cut" }]);
    expect(input.audio.loudness_lufs).toBe(-14);
    expect(input.picture).toBeUndefined();
    expect(input.audio.narration).toBeUndefined();
  });

  it("maps transitions, J/L cuts, a freeze, titles, narration, silences and fades", () => {
    const timeline = TimelineInput.parse({
      clips: [
        { shotId: "s1", takeId: "t1", inS: 0, outS: 5, audioTrailS: 0.4, freezeS: 2 },
        { shotId: "s1", takeId: "t1", inS: 1, outS: 5, transition: "fade_black", transitionS: 0.6, audioLeadS: 0.5 },
      ],
      fadeInS: 0.5, fadeOutS: 1,
      titles: [{ text: "一路颠沛流离", atS: 5, durationS: 2, kind: "card" }, { text: "369", atS: 8, durationS: 2, position: "top_right", color: "#ffffff", background: "black@0.5", size: 40 }],
      narration: [{ assetId: "ast_v", atS: 6, gainDb: -3 }, { assetId: "ast_gone", atS: 9 }],
      silences: [{ atS: 4.5, durationS: 0.5 }],
      loudnessLufs: null,
    });
    const input = buildAssemblerInput({ ...base, timeline, audioUrls: new Map([["ast_v", "https://r2/v.wav"]]) });
    expect(input.clips[0]).toMatchObject({ transition_in: "cut", audio_trail_s: 0.4, freeze_s: 2 });
    expect(input.clips[1]).toMatchObject({ transition_in: "fade_black", transition_s: 0.6, audio_lead_s: 0.5 });
    expect(input.picture).toEqual({
      fade_in_s: 0.5, fade_out_s: 1,
      titles: [
        { text: "一路颠沛流离", at_s: 5, duration_s: 2, kind: "card" },
        { text: "369", at_s: 8, duration_s: 2, kind: "overlay", position: "top_right", color: "#ffffff", background: "black@0.5", size: 40 },
      ],
    });
    expect(input.audio.narration).toEqual([{ url: "https://r2/v.wav", at_s: 6, gain_db: -3 }]);
    expect(input.audio.silences).toEqual([{ at_s: 4.5, duration_s: 0.5 }]);
    expect(input.audio.loudness_lufs).toBeUndefined(); // null leaves the mix as it is
    expect(clipSeconds(timeline.clips[0]!)).toBe(7);
  });

  it("refuses a title colour that could be read as filter syntax, and a lead over 2 s", () => {
    expect(TimelineInput.safeParse({ titles: [{ text: "x", atS: 0, durationS: 3, color: "red:x=0" }] }).success).toBe(false);
    expect(TimelineInput.safeParse({ clips: [{ shotId: "s", takeId: "t", outS: 5, audioLeadS: 3 }] }).success).toBe(false);
    expect(TimelineInput.safeParse({ clips: [{ shotId: "s", takeId: "t", outS: 5, transition: "star_wipe" }] }).success).toBe(false);
  });

  it("subtitle cues after a freeze start after it", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", outS: 4, freezeS: 2 }, { shotId: "s1", takeId: "t1", outS: 4 }] });
    const input = buildAssemblerInput({ ...base, timeline });
    expect(input.subtitles.srt).toContain("00:00:06,000 --> 00:00:07,950");
  });
});

describe("what the assembler measured, read against the timeline", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    export_job_id: "e", preset: "master-768p", video_size: "1344x768",
    clips: [{ url: "a", in_s: 0, out_s: 5, transition_in: "cut" as const }, { url: "b", in_s: 0, out_s: 5, transition_in: "fade_black" as const, transition_s: 0.5 }],
    audio: { keep_clip_audio: true, mix_db: { dialogue: 0, sfx: -3, music: -12 }, music_duck_under_dialogue: true, loudness_lufs: -14, silences: [{ at_s: 6, duration_s: 1.5 }] },
    picture: { fade_in_s: 0.5, fade_out_s: 1, titles: [{ text: "x", at_s: 2, duration_s: 2, kind: "card" as const }] },
    subtitles: { srt: "", burn_in: false }, output: { key: "k.mp4" },
    ...over,
  });

  it("says nothing when every black frame and silence was asked for", () => {
    const findings = exportFindings(input(), {
      duration_s: 9.5, cuts_s: [4.75],
      checks: { lufs: -14.3, true_peak_db: -2, black: [[0, 0.3], [2, 4.02], [4.6, 4.95], [8.7, 9.5]], silent: [[6.02, 7.5]] },
    });
    expect(findings).toEqual([]);
  });

  it("names black picture and missing sound that nothing explains, and a missed loudness target", () => {
    const findings = exportFindings(input(), {
      duration_s: 9.5, cuts_s: [4.75], warnings: ["clip 2: asked for 0.5 s of lead and 0 s of trail, the take had 0.00 s before its in point and 0.00 s after its out point"],
      checks: { lufs: -19.2, true_peak_db: -0.1, black: [[5.5, 6.4]], silent: [[1, 3.2]] },
    });
    expect(findings).toHaveLength(5);
    expect(findings[0]).toContain("the take had 0.00 s before its in point");
    expect(findings[1]).toContain("black picture at 5.50–6.40 s");
    expect(findings[2]).toContain("no sound at 1.00–3.20 s");
    expect(findings[3]).toBe("loudness is -19.2 LUFS, the target was -14");
    expect(findings[4]).toContain("the mix clips");
  });

  it("a film with no sound at all is one finding, and an unlevelled quiet mix is said", () => {
    const quiet = input({ audio: { keep_clip_audio: true, mix_db: { dialogue: 0, sfx: -3, music: -12 }, music_duck_under_dialogue: true }, picture: undefined });
    expect(exportFindings(quiet, { duration_s: 10, cuts_s: [5], checks: { lufs: null, black: [], silent: [[0, 10]] } })).toEqual(["the film has no sound at all"]);
    expect(exportFindings(quiet, { duration_s: 10, cuts_s: [5], checks: { lufs: -31, black: [], silent: [] } })[0]).toContain("-31 LUFS");
  });

  it("an old assembler that measures nothing yields no findings", () => {
    expect(exportFindings(input(), { duration_s: 9.5 })).toEqual([]);
  });
});
