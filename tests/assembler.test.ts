import { describe, expect, it } from "vitest";

import { buildAssemblerInput, toSrt } from "@/studio/backends/assembler";
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
