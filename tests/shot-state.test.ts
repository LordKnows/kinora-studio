import { describe, expect, it } from "vitest";

import { carriedStates } from "@director/state";

import { isStructuralChange } from "@/studio/checkpoints";
import { compileShot } from "@/studio/compiler";
import { shotFramePrompt } from "@/studio/imaging";
import type { ShotView } from "@/studio/orchestrator";
import { ShotInput } from "@/studio/schemas";

/* The state an element carries from shot to shot (packages/director/src/state.ts)
   in the compiled prompt and in a frame's brief. */

const spec = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 5, mode: "keyframe", intent: "Mia waits under the awning", characters: ["mia"],
    beats: [{ from: 0, to: 5, action: "Mia watches the rain" }], camera: { move: "static" }, ...over,
  });
const base = { id: "s", projectId: "p", sceneId: "c", index: 0, createdAt: 0, updatedAt: 0 };
const look = { genre: "drama", palette: "", camera: "", lens: "", lighting: "", aspectRatio: "16:9" as const, resolution: "768p" as const, upscale: false, negative: [], dialogueLanguage: "en" };
const assets = new Map([["h", { id: "h", projectId: "p", url: "https://r2/h.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }], ["m", { id: "m", projectId: "p", url: "https://r2/mia.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }]]);
const elements = new Map([["mia", { id: "mia", projectId: "p", kind: "character" as const, name: "Mia", description: "short black hair, a tan trench coat", refAssetIds: ["m"], createdAt: 0, updatedAt: 0 }]]);

const film = [
  spec({ state: [{ who: "mia", holding: "the closed red umbrella", condition: "soaked through, hair dripping" }] }),
  spec(),
  spec({ mode: "reference", state: [{ who: "mia", holding: "" }] }),
];
const states = carriedStates(film);

describe("the state a shot inherits", () => {
  it("is written into the prompt of every later shot, in every mode", () => {
    const first = compileShot({ shot: { ...base, spec: film[0]!, heroAssetId: "h" }, look, elements, assets, states: states[0], format: "lightx2v-lines" });
    expect(first.prompt).toContain("Mia, by the end of the shot: holding the closed red umbrella; soaked through, hair dripping.");
    expect(first.prompt).not.toContain("from the start of the shot");

    const second = compileShot({ shot: { ...base, spec: film[1]!, heroAssetId: "h" }, look, elements, assets, states: states[1], format: "lightx2v-lines" });
    expect(second.prompt).toContain("Mia, from the start of the shot: holding the closed red umbrella; soaked through, hair dripping.");
    expect(second.prompt).not.toContain("by the end of the shot");

    /* a reference-mode shot reads the sheet, so the words are all that carry it */
    const third = compileShot({ shot: { ...base, spec: film[2]! }, look, elements, assets, states: states[2], experiments: { officialFormat: true } });
    expect(third.workflow).toBe("R2VA");
    expect(third.prompt).toContain("Mia, from the start of the shot: holding the closed red umbrella; soaked through, hair dripping. Mia, by the end of the shot: soaked through, hair dripping.");
  });

  it("says nothing when nothing is carried", () => {
    const plain = compileShot({ shot: { ...base, spec: spec(), heroAssetId: "h" }, look, elements, assets, format: "lightx2v-lines" });
    expect(plain.prompt).not.toMatch(/of the shot:/);
  });

  it("is drawn into a first frame from what the shots before left, and into a last frame from the shot's own record", () => {
    const view = { ...base, spec: film[2]!, takes: [] } as unknown as ShotView;
    const firstFrame = shotFramePrompt(view, "first", { elements, look, states: states[2] });
    expect(firstFrame).toContain("At this moment, unlike the reference sheets: Mia: holding the closed red umbrella; soaked through, hair dripping.");
    const lastFrame = shotFramePrompt(view, "last", { elements, look, states: states[2] });
    expect(lastFrame).toContain("At this moment, unlike the reference sheets: Mia: soaked through, hair dripping.");
    expect(shotFramePrompt(view, "first", { elements, look })).not.toContain("At this moment");
  });

  it("resets the shotlist approval when it changes: later prompts change with it", () => {
    expect(isStructuralChange(film[1] as never, { ...film[1]!, state: [{ who: "mia", condition: "dry again" }] } as never)).toBe(true);
    expect(isStructuralChange(film[1] as never, { ...film[1]! } as never)).toBe(false);
  });
});
