import { describe, expect, it } from "vitest";

import { FAULT_ROUTES, faultClass, faultRoutes, fixSummary, pictureFaults } from "@director/faults";

import { fixLedger, fixTally, retakeChanges } from "@/studio/craft-core";
import { preRenderGuards } from "@/studio/orchestrator";
import { TAKE_FAULTS } from "@/studio/schemas";
import type { Take } from "@/studio/types";

/* From a fault on a take to the fix that fits it (packages/director/src/faults.ts),
   and the record of which change got past which fault. */

const take = (n: number, over: Partial<Take> = {}): Take => ({
  id: `t${n}`, projectId: "p", shotId: "s", n, backend: "runpod", workflow: "I2VA", prompt: "the prompt", status: "completed", thumbUrls: [], createdAt: n,
  input: { seconds: 5, steps: 8, images: [{ role: "first_frame", url: "https://r2/a.png" }], loras: [{ name: "turbo", strength: 1 }] }, ...over,
});
const review = (faults: string[], score = 2) => ({ score, notes: "", by: "human" as const, at: 0, faults: faults as never });

describe("fault routes", () => {
  it("every fault tag has a route, and a first fix", () => {
    for (const f of TAKE_FAULTS) {
      expect(FAULT_ROUTES[f], f).toBeDefined();
      expect(FAULT_ROUTES[f]!.fixes.length, f).toBeGreaterThan(0);
    }
  });

  it("a picture fault goes to a frame or Remake, a motion fault to the shot, an edge to the edit, sound to the timeline", () => {
    expect(faultRoutes(["identity_drift"])[0]!.fixes[0]!.kind).toBe("remake");
    expect(faultRoutes(["identity_drift"])[0]!.not).toContain("rewording the prompt alone");
    expect(faultRoutes(["action_wrong"])[0]!.fixes[0]!.kind).toBe("revise");
    expect(faultRoutes(["action_wrong"])[0]!.not).toContain("Remake");
    expect(faultRoutes(["action_timing"])[0]!.fixes[0]!.kind).toBe("timeline");
    expect(faultRoutes(["tail_snap"])[0]!.fixes[0]!.kind).toBe("trim");
    expect(faultRoutes(["audio_bad"])[0]!.fixes[0]!.kind).toBe("timeline");
    expect(faultClass("wardrobe_or_prop_lost")).toBe("picture");
    expect(pictureFaults(["identity_drift", "action_timing", "count_changed", "face_or_hand_artifact"])).toEqual(["identity_drift", "count_changed"]);
    expect(fixSummary(["tail_snap"])).toEqual(["tail_snap: tailTrimS on auto_timeline, or the clip's outS"]);
    /* a tag from a newer client still gets an answer */
    expect(faultRoutes(["something_new"])[0]!.class).toBe("other");
  });
});

describe("what a retake changed", () => {
  it("names the inputs that differ, and the seed when nothing does", () => {
    const a = take(1);
    expect(retakeChanges(a, take(2))).toEqual(["seed"]);
    expect(retakeChanges(a, take(2, { prompt: "other words" }))).toEqual(["prompt"]);
    expect(retakeChanges(a, take(2, { input: { ...a.input, images: [{ role: "first_frame", url: "https://r2/b.png" }] } }))).toEqual(["frames"]);
    expect(retakeChanges(a, take(2, { workflow: "FL2VA", prompt: "p2", input: { ...a.input, seconds: 7, steps: 20, loras: [] } }))).toEqual(["mode", "length", "steps", "loras", "prompt"]);
    expect(retakeChanges(a, take(2, { input: { ...a.input, studio_experiments: { officialFormat: true } }, prompt: "official" }))).toEqual(["experiments", "prompt"]);
    expect(retakeChanges(a, take(2, { workflow: "REMAKE" }))).toEqual(["remake"]);
  });

  it("warns when a picture fault is answered with new words only", () => {
    const none = { rejected: [], any: [] };
    const w = preRenderGuards("pass", none, [], { changed: ["prompt"], after: ["identity_drift", "action_timing"] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/tagged identity_drift and this render changes only the prompt.*remake_take mode swap/);
    /* a new frame is the fix the route asks for: no warning; and a motion fault may be reworded */
    expect(preRenderGuards("pass", none, [], { changed: ["frames", "prompt"], after: ["identity_drift"] })).toEqual([]);
    expect(preRenderGuards("pass", none, [], { changed: ["prompt"], after: ["action_wrong"] })).toEqual([]);
  });
});

describe("which change got past which fault", () => {
  it("pairs every faulted take with the take after it", () => {
    const frames = { seconds: 5, steps: 8, images: [{ role: "first_frame", url: "https://r2/b.png" }], loras: [{ name: "turbo", strength: 1 }] };
    const shots = [
      /* reworded: the fault came back; then a new frame: it held */
      { id: "s1", selectedTakeId: "t3", takes: [take(1, { review: review(["identity_drift"]) }), take(2, { prompt: "reworded", review: review(["identity_drift"]) }), take(3, { prompt: "reworded", input: frames })] },
      /* a Remake carries its own record; nobody judged it */
      { id: "s2", takes: [take(1, { review: review(["wardrobe_or_prop_lost"]) }), take(2, { workflow: "REMAKE", input: { studio_retake: { of: 1, changed: ["remake"], after: ["wardrobe_or_prop_lost"], change: "Remake (edit) of take #1: the beret" } } })] },
    ];
    const rows = fixLedger(shots);
    expect(rows.map((r) => [r.shotId, r.fault, r.from, r.to, r.changed.join("+"), r.outcome])).toEqual([
      ["s1", "identity_drift", 1, 2, "prompt", "came_back"],
      ["s1", "identity_drift", 2, 3, "frames", "held"],
      ["s2", "wardrobe_or_prop_lost", 1, 2, "remake", "unjudged"],
    ]);
    expect(rows[2]!.note).toBe("Remake (edit) of take #1: the beret");
    expect(fixTally(rows)).toEqual([
      { fault: "identity_drift", change: "frames", held: 1, cameBack: 0, unjudged: 0 },
      { fault: "identity_drift", change: "prompt", held: 0, cameBack: 1, unjudged: 0 },
      { fault: "wardrobe_or_prop_lost", change: "remake", held: 0, cameBack: 0, unjudged: 1 },
    ]);
  });
});
