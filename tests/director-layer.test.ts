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

describe("director layer on a saved project", () => {
  it("lints, applies a style and plans a batch over the project's own shotlist", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { setDb } = await import("@/db");
    type Db = import("@/db").Db;
    const { migrate } = await import("@/db/migrate");
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db: Db = {
      async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
      async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
      async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
      async exec(sql: string) { sqlite.exec(sql); },
    };
    await migrate(db);
    setDb(db);
    const repo = await import("@/studio/repo");
    const orch = await import("@/studio/orchestrator");
    const { ShotlistInput } = await import("@/studio/schemas");
    const project = await repo.createProject({ name: "Styled", budgetCapUsd: 20 });
    const bare = (i: number) => ({ durationS: 5, mode: "text", intent: `shot ${i}`, beats: [{ from: 0, to: 5, action: "The wind moves" }], camera: { move: "static" }, link: { type: "cut" } });
    await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [bare(1), bare(2), bare(3)] }] }));
    const lint = await orch.lintProject(project.id, { totalSeconds: 15 });
    expect(lint.warnings.some((w) => w.code === "tier3.missing" && w.scene === "a" && w.shot === 1)).toBe(true);
    expect(lint.counts.warn).toBeGreaterThan(0);
    const applied = await orch.applyStyleToProject(project.id, "ink-wash");
    const spec = applied.view.scenes[0]!.shots[0]!.spec;
    expect(spec.cinematography && Object.keys(spec.cinematography).length).toBeGreaterThan(0);
    expect((await repo.getProject(project.id)).look.style).toBe("ink-wash");
    /* a style sets its own cinematography defaults; whatever it leaves unset still shows in the lint */
    expect((await orch.lintProject(project.id)).warnings.every((w) => w.code !== "tier3.missing" || !w.message.includes(Object.keys(spec.cinematography ?? {})[0] ?? "∅"))).toBe(true);
    const plan = await orch.planProjectBatch(project.id);
    expect(plan.order).toHaveLength(3);
    expect(plan.passes[0]).toHaveLength(3);
    expect(plan.shots[0]!.label).toContain("a #1");
    expect(plan.totalEstimateUsd).toBeGreaterThan(0);
  });
});
