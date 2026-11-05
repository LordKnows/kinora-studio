import { describe, expect, it } from "vitest";

import * as director from "@/director";

/* The director layer served from the Studio MCP: styles from the generated
   catalog, the pure helpers straight from packages/director. */
describe("director layer in the connector", () => {
  it("loads the 16 style presets and finds them by slug, English or Chinese name", () => {
    const styles = director.loadStyles();
    expect(styles).toHaveLength(16);
    expect(styles.map((s) => s.style.slug)).toContain("ink-wash");
    expect(director.findStyle("ink-wash")?.style.slug).toBe("ink-wash");
    expect(director.findStyle(director.loadStyles()[0]!.style.en)?.style.slug).toBe(director.loadStyles()[0]!.style.slug);
    expect(director.findStyle("no such style")).toBeUndefined();
  });

  it("compiles a style into a Look and suggests styles for a topic", () => {
    const s = director.findStyle("ink-wash")!;
    const look = director.compileLook(s.style, { aspectRatio: "16:9" });
    expect(typeof look.genre).toBe("string");
    expect(look.aspectRatio).toBe("16:9");
    expect(director.styleToMarkdown(s.style)).toContain(s.style.en);
    const picks = director.suggestStyles("a quiet mountain poem with calligraphy", 3);
    expect(picks).toHaveLength(3);
    expect(picks[0]!.score).toBeGreaterThanOrEqual(picks[2]!.score);
  });

  it("lints a shotlist and resolves cue-map hits", () => {
    const shot = (i: number) => ({ durationS: 5, mode: "text", intent: `shot ${i}`, beats: [{ from: 0, to: 5, action: "The wind moves" }], camera: { move: "static" }, link: { type: "cut" } });
    const report = director.lintShotlist({ scenes: [{ slug: "a", shots: [shot(1), shot(2), shot(3), shot(4), shot(5), shot(6)] }] } as never, { totalSeconds: 30 });
    expect(JSON.stringify(report)).toMatch(/breath|variety|static|same/i);
    const cue = { sections: [{ id: "a", t: 0, bpm: 120, beatsPerBar: 4 }], hits: [{ id: "h1", section: "a", bar: 2, beat: 1, what: "drop" }] };
    const hits = director.hitTimes(cue as director.CueMap);
    expect(hits[0]!.t).toBeCloseTo(2, 5);
  });
});
