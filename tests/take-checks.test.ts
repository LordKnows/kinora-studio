import { describe, expect, it } from "vitest";

import { ShotInput } from "@/studio/schemas";
import { readFileSync } from "node:fs";

import { FINDING_LABELS, findingAt, measuredBasis, readTake, suggestedFaults, takeChecks, type TakeChecks } from "@/studio/take-checks";
import type { Take } from "@/studio/types";

/* What the worker measured on a take (motion and sound over time, the ends
   against their frames), read against the shot's beats, lines and frames. */

const FPS = 8, HZ = 10;
const spec = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 5, mode: "keyframe", intent: "The cup slides across the table", characters: [],
    beats: [{ from: 0, to: 2.5, action: "The cup slides across the table" }, { from: 2.5, to: 5, action: "The cup rocks and settles" }],
    camera: { move: "static" }, ...over,
  });
const take = (checks?: TakeChecks): Take => ({
  id: "t1", projectId: "p", shotId: "s", n: 1, backend: "runpod", workflow: "FL2VA", prompt: "", status: "completed", thumbUrls: [], createdAt: 0,
  input: { seconds: 5, ...(checks ? { studio_checks: checks } : {}) },
});
/** `seconds` of motion at `level`, one value per 1/FPS s. */
const still = (seconds: number, level = 0.0002) => Array.from({ length: Math.round(seconds * FPS) }, () => level);
const sound = (seconds: number, db: number) => Array.from({ length: Math.round(seconds * HZ) }, () => db);
const codes = (t: Take, s: ShotInput) => readTake(t, s).findings.map((f) => f.code);

describe("a take's measurements against its shot", () => {
  it("has nothing to say about a take that carries none", () => {
    expect(takeChecks(take())).toBeUndefined();
    expect(readTake(take(), spec())).toEqual({ findings: [], measures: { beats: 2, idleBeats: 0, timedLines: 0, quietLines: 0, findings: 0 } });
    expect(measuredBasis(take())).toBe("no measurements on this take");
  });

  it("an action over in half a second, then a held picture", () => {
    /* the slide the first beat gives 2.5 s happens in 0.5 s; nothing moves in the second beat */
    const t = take({ version: 1, motion: { fps: FPS, values: [...still(0.5, 0.03), ...still(4.5)] } });
    const { findings, measures } = readTake(t, spec());
    expect(findings.map((f) => f.code)).toEqual(["motion.early", "motion.idle_beat"]);
    expect(findings[0]!.message).toMatch(/of the movement in beat 1 \(0–2\.5 s\) falls in its first 0\.8 s and the picture then holds/);
    expect(findings[0]!.at).toEqual([0, 2.5]);
    expect(suggestedFaults(findings)).toEqual(["action_timing"]);
    expect(measures.earlyShare).toBeGreaterThan(0.9);
    expect(measures.idleBeats).toBe(1);
  });

  it("says nothing when the movement runs through the beats", () => {
    const t = take({ version: 1, motion: { fps: FPS, values: still(5, 0.01) } });
    expect(codes(t, spec())).toEqual([]);
    expect(readTake(t, spec()).measures.earlyShare).toBeCloseTo(0.3, 1);
  });

  it("a still, a jump nobody asked for, a snap at the tail", () => {
    expect(codes(take({ version: 1, motion: { fps: FPS, values: still(5) } }), spec())).toEqual(["motion.still"]);
    const jump = [...still(2.5, 0.01), 0.3, ...still(2.4, 0.01)];
    expect(codes(take({ version: 1, motion: { fps: FPS, values: jump } }), spec())).toEqual(["motion.jump"]);
    /* the same change where the shot asks for a hard cut is the cut */
    const cut = spec({ beats: [{ from: 0, to: 2.5, action: "An empty table in the morning light" }, { from: 2.5, to: 5, action: "The cup stands on the table", cut: true }] });
    expect(codes(take({ version: 1, motion: { fps: FPS, values: jump } }), cut)).toEqual([]);
    /* and a cut that was asked for and does not show is named */
    expect(codes(take({ version: 1, motion: { fps: FPS, values: still(5, 0.01) } }), cut)).toEqual(["motion.no_cut"]);
    const snap = [...still(4.75, 0.01), 0.2, 0.01];
    const found = readTake(take({ version: 1, motion: { fps: FPS, values: snap } }), spec()).findings;
    expect(found.map((f) => [f.code, f.suggests])).toEqual([["motion.tail", "tail_snap"]]);
  });

  it("nothing audible where a line should be spoken", () => {
    const withLine = spec({ characters: ["mia"], dialogue: [{ speaker: "mia", text: "Not tonight.", delivery: "neutral", kind: "onscreen", startS: 3, endS: 4 }] });
    const moving = { fps: FPS, values: still(5, 0.01) };
    /* sound in the first two seconds only: the line's window is quiet */
    const quiet = take({ version: 1, motion: moving, audio: { hz: HZ, db: [...sound(2, -20), ...sound(3, -70)] } });
    const r = readTake(quiet, withLine);
    expect(r.findings.map((f) => [f.code, f.suggests, f.at])).toEqual([["sound.line_quiet", "audio_bad", [3, 4]]]);
    expect(r.measures).toMatchObject({ timedLines: 1, quietLines: 1 });
    /* sound in the window: no finding. The level cannot tell speech from other sound, and does not claim to */
    expect(codes(take({ version: 1, motion: moving, audio: { hz: HZ, db: sound(5, -22) } }), withLine)).toEqual([]);
    expect(codes(take({ version: 1, motion: moving, audio: { hz: HZ, db: sound(5, -80) } }), withLine)).toEqual(["sound.silent"]);
    expect(codes(take({ version: 1, motion: moving, audio: null }), withLine)).toEqual(["sound.none"]);
  });

  it("the ends against the frames the take was given", () => {
    const moving = { fps: FPS, values: still(5, 0.01) };
    /* landed: the last frame is as close to its picture as the first frame is to its own */
    expect(codes(take({ version: 1, motion: moving, first_frame_diff: 0.011, last_frame_diff: 0.02 }), spec())).toEqual([]);
    const missed = readTake(take({ version: 1, motion: moving, first_frame_diff: 0.011, last_frame_diff: 0.14 }), spec());
    expect(missed.findings.map((f) => f.code)).toEqual(["frame.end"]);
    expect(missed.findings[0]!.message).toContain("difference 0.140, against 0.011 at the first frame");
    expect(missed.measures).toMatchObject({ startDiff: 0.011, endDiff: 0.14 });
    expect(codes(take({ version: 1, motion: moving, first_frame_diff: 0.2 }), spec())).toEqual(["frame.start"]);
    expect(measuredBasis(take({ version: 1, motion: moving, audio: { hz: HZ, db: sound(5, -20) }, last_frame_diff: 0.02 }))).toBe("measured on the file: motion over time, sound level over time, last frame against its picture");
  });

  it("reads a take that runs the frame grid's length, not the spec's", () => {
    /* a 5 s shot renders 5.17 s: 41 values at 8 fps; the beats scale with it */
    const t = take({ version: 1, motion: { fps: FPS, values: [...still(0.5, 0.03), ...still(4.625)] } });
    expect(readTake(t, spec()).findings[0]!.at).toEqual([0, 2.6]);
  });

  it("every finding has a line for the Board, in English and in Chinese", async () => {
    const written = [...readFileSync("src/studio/take-checks.ts", "utf8").matchAll(/code: "([a-z_.]+)"/g)].map((m) => m[1]!);
    expect(written.length).toBeGreaterThan(8);
    const { board } = await import("@/studio-ui/zh/board");
    for (const code of new Set(written)) {
      expect(FINDING_LABELS[code], code).toBeDefined();
      expect((board as Record<string, string>)[FINDING_LABELS[code]!], code).toBeDefined();
    }
    expect(findingAt({ code: "x", message: "", at: [0, 2.5] })).toBe("0–2.5 s");
    expect(findingAt({ code: "x", message: "", at: [3, 3] })).toBe("3 s");
    expect(findingAt({ code: "x", message: "" })).toBe("");
  });
});
