import { describe, expect, it } from "vitest";

import { compileShot, cutTimecode, officialCameraSentence } from "@/studio/compiler";
import { ShotInput } from "@/studio/schemas";

/* experiments.officialFormat: the prompt as MiniMax's H3 prompt guides write it
   (VIDEO_PROMPT_WRITING_GUIDE_base_en / _ref_en), against the Studio's default. */

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 8, mode: "keyframe", intent: "Mara waits for the lift",
    beats: [{ from: 0, to: 3, action: "The lift doors stay shut while Mara checks her watch" }, { from: 3, to: 8, action: "Mara steps back as the doors slide open" }],
    camera: { move: "push_in", amplitude: "subtle", speed: "slow" },
    cinematography: { size: "ms", angle: "eye", lens: "normal", lighting: ["lowkey"], grade: "tealorange" }, ...over,
  });

const base = { id: "s", projectId: "p", sceneId: "c", index: 0, createdAt: 0, updatedAt: 0 };
const look = { genre: "neo-noir", palette: "teal and amber", camera: "", lens: "", lighting: "", aspectRatio: "16:9" as const, resolution: "768p" as const, upscale: false, negative: ["the lobby is empty"], dialogueLanguage: "en" };
const assets = new Map([
  ["h", { id: "h", projectId: "p", url: "https://r2/h.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
  ["e", { id: "e", projectId: "p", url: "https://r2/e.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
  ["m", { id: "m", projectId: "p", url: "https://r2/mara.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
]);
const elements = new Map([["mara", { id: "mara", projectId: "p", kind: "character" as const, name: "Mara", description: "silver crop, charcoal coat", refAssetIds: ["m"], createdAt: 0, updatedAt: 0 }]]);
const official = { officialFormat: true };

describe("experiments.officialFormat", () => {
  it("is off by default: the default serialisation is unchanged", () => {
    const plain = compileShot({ shot: { ...base, spec: shot(), heroAssetId: "h" }, look, elements, assets, format: "lightx2v-lines" });
    expect(plain.prompt.startsWith("integrated_multimodal_description: For the target video, at 0.00 seconds")).toBe(true);
    expect(plain.prompt).toContain("0–3s: The lift doors stay shut");
    expect(plain.prompt).toContain("Camera: The camera pushes in toward the subject");
  });

  it("first frame: the instruction line comes first, a blank line before the fields", () => {
    const job = compileShot({ shot: { ...base, spec: shot(), heroAssetId: "h" }, look, elements, assets, experiments: official });
    expect(job.workflow).toBe("I2VA");
    const paragraphs = job.prompt.split("\n\n");
    expect(paragraphs[0]).toBe("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.");
    expect(paragraphs[1]!.startsWith("integrated_multimodal_description: [Shot 1] neo-noir. teal and amber. Medium shot from the waist up, at eye level.")).toBe(true);
    expect(paragraphs[2]!.startsWith("overall_soundscape: ")).toBe(true);
    expect(paragraphs[3]).toBe("non_diegetic_music: N/A");
    expect(paragraphs).toHaveLength(4);
  });

  it("writes time only where the shot cuts, and the beats in order as prose", () => {
    const job = compileShot({ shot: { ...base, spec: shot(), heroAssetId: "h" }, look, elements, assets, experiments: official });
    expect(job.prompt).not.toMatch(/\d+(\.\d+)?–\d+(\.\d+)?s:/);
    expect(job.prompt).toContain("Early in the shot, the lift doors stay shut while Mara checks her watch.");
    expect(job.prompt).toContain("Through the rest of the shot, Mara steps back as the doors slide open.");

    const cuts = compileShot({
      shot: { ...base, spec: shot({ mode: "text", durationS: 9, beats: [{ from: 0, to: 3.5, action: "An empty bar" }, { from: 3.5, to: 6, action: "Boots cross the floor", cut: true }, { from: 6, to: 9, action: "Mara looks up", cut: true }] }) },
      look, elements, assets, experiments: official,
    });
    expect(cuts.workflow).toBe("T2VA");
    /* text-to-video has no instruction line: the prompt begins with the first field */
    expect(cuts.prompt.startsWith("integrated_multimodal_description: [Shot 1] ")).toBe(true);
    expect(cuts.prompt).toContain("[Shot 2] At 00:03.500, the camera cuts to a new view.");
    expect(cuts.prompt).toContain("[Shot 3] At 00:06.000, the camera cuts to a new view.");
    expect(cuts.prompt).not.toContain("For the target video");
  });

  it("first and last frame: the guide's own sentence, with the rendered length and the last shot", () => {
    const job = compileShot({ shot: { ...base, spec: shot(), heroAssetId: "h", endAssetId: "e" }, look, elements, assets, experiments: official });
    expect(job.workflow).toBe("FL2VA");
    expect(job.prompt.split("\n\n")[0]).toBe("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.");
    expect(job.prompt).toContain("The shot begins in the position and framing established by Picture 1.");
    expect(job.prompt).toContain("By the end of the shot everything settles into the pose, spacing and composition established by Picture 2.");
    expect(job.prompt).not.toContain("ends on <Picture 2>");
    /* 5 s renders 124 frames: 5.17 s */
    const five = compileShot({ shot: { ...base, spec: shot({ durationS: 5, beats: [{ from: 0, to: 5, action: "The doors slide open" }] }), heroAssetId: "h", endAssetId: "e" }, look, elements, assets, experiments: official });
    expect(five.prompt).toContain("aligns with the 5.17-second mark");
  });

  it("the camera move is a sentence of the shot, in the guide's vocabulary", () => {
    const job = compileShot({ shot: { ...base, spec: shot(), heroAssetId: "h" }, look, elements, assets, experiments: official });
    expect(job.prompt).toContain("The camera pushes in with small amplitude at slow speed.");
    expect(job.prompt).not.toContain("Camera:");
    expect(job.prompt).not.toMatch(/\b(Framing|Lens|Lighting|Image|Composition): /);
    expect(officialCameraSentence({ move: "static", amplitude: "moderate", speed: "slow" })).toBe("The camera holds a static shot for the whole duration.");
    /* the middle values are left out, as the guide says */
    expect(officialCameraSentence({ move: "pan", amplitude: "moderate", speed: "medium" })).toBe("The camera pans.");
    expect(officialCameraSentence({ move: "pull_out", amplitude: "strong", speed: "fast", note: "The doorway comes into view." })).toBe("The camera pulls out with large amplitude at fast speed. The doorway comes into view.");
    expect(cutTimecode(3.5)).toBe("00:03.500");
    expect(cutTimecode(12)).toBe("00:12.000");
  });

  it("ties a line to the beat it falls in, not to a timecode", () => {
    const spec = shot({ characters: ["mara"], dialogue: [{ speaker: "mara", text: "Not tonight.", language: "en", delivery: "breathless", kind: "onscreen", startS: 4, endS: 5 }] });
    const job = compileShot({ shot: { ...base, spec, heroAssetId: "h" }, look, elements, assets, experiments: official });
    const said = 'Mara (S1) says (breathless): <d>[English] Not tonight.</d>';
    expect(job.prompt).toContain(`Mara steps back as the doors slide open. ${said} `);
    expect(job.prompt).not.toContain("</d>.");
    expect(job.prompt).not.toContain("At 4s");
    /* the default still writes the time */
    const plain = compileShot({ shot: { ...base, spec, heroAssetId: "h" }, look, elements, assets, format: "lightx2v-lines" });
    expect(plain.prompt).toContain(`At 4s, ${said}`);
  });

  it("reference mode: six sections, the picture cited in the subject, the style before [Shot 1]", () => {
    const job = compileShot({ shot: { ...base, spec: shot({ mode: "reference", characters: ["mara"] }) }, look, elements, assets, experiments: official });
    expect(job.workflow).toBe("R2VA");
    const p = job.prompt.split("\n\n");
    expect(p.map((x) => x.split(":")[0])).toEqual(["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]);
    expect(p[0]).toBe("subject_definitions:\n<Subject 1> is Mara, the character shown in <Picture 1>. Keep face, hair and wardrobe exactly.");
    expect(p[3]!.startsWith("detailed_description:\nneo-noir. teal and amber. [Shot 1] Medium shot from the waist up, at eye level.")).toBe(true);
    expect(p[3]).toContain("The camera pushes in with small amplitude at slow speed.");
  });

  it("keeps the Look's constraints and the speech rule, once, at the end of the last shot", () => {
    const job = compileShot({ shot: { ...base, spec: shot({ characters: ["mara"] }), heroAssetId: "h" }, look, elements, assets, experiments: official });
    expect(job.prompt).toContain("The lobby is empty. Mara stays silent.");
    expect(job.prompt.match(/lobby is empty/g)).toHaveLength(1);
  });
});
