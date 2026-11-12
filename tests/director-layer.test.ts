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

describe("a style of the user's own", () => {
  it("forks a library style, keeps it, resolves it everywhere and guards it", async () => {
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
    const styles = await import("@/studio/styles");
    const repo = await import("@/studio/repo");
    const orch = await import("@/studio/orchestrator");
    const imaging = await import("@/studio/imaging");
    const { ShotlistInput } = await import("@/studio/schemas");
    const mia = { user: "mia@example.com", via: "mcp" as const };
    const joe = { user: "joe@example.com", via: "mcp" as const };

    // a draft: nothing stored, the three groups laid out
    const draft = await styles.forkDraft({ base: "中国水墨", slug: "night-ink", en: "Night Ink", cn: "夜墨" });
    expect(draft.basedOn).toBe("ink-wash");
    expect(draft.groups.map((g) => g.group)).toEqual(["safe", "character", "essence"]);
    expect((await styles.allStyles()).some((s) => s.style.slug === "night-ink")).toBe(false);

    // the user's change: a night palette, carried into the Look
    const style = draft.style;
    style.line = "Pale ink on blue-black paper, one vermilion seal.";
    style.colour.examplePalette = "paper #101418, ink #e8e2d2, vermilion #d8402c";
    style.engine.look.palette = "pale ink on blue-black paper, one vermilion seal red, no other colour";
    const saved = await styles.saveStyle(mia, { style, basedOn: "ink-wash", why: { "§3 palette": "the brand film plays at night" } });
    expect(saved.style).toMatchObject({ slug: "night-ink", origin: "mine", by: "mia@example.com", basedOn: "ink-wash" });
    expect(saved.changes.map((c) => c.section)).toEqual(["§3 palette"]);
    expect(saved.changes[0]).toMatchObject({ group: "safe", why: "the brand film plays at night" });
    expect(saved.warnings.filter((w) => w.severity !== "info")).toEqual([]);
    expect(saved.changesMarkdown).toContain("| §3 palette | safe |");

    // listed first, found by any of its names, suggested with the library
    const all = await styles.allStyles();
    expect(all[0]!.style.slug).toBe("night-ink");
    expect(all.filter((s) => s.origin === "library")).toHaveLength(16);
    expect((await styles.resolveStyle("夜墨"))?.style.slug).toBe("night-ink");
    expect((await styles.resolveStyle("Night Ink"))?.origin).toBe("mine");
    expect((await styles.styleChanges("night-ink"))?.basedOn).toBe("ink-wash");

    // a project uses it like any style
    const project = await repo.createProject({ name: "Night", budgetCapUsd: 20 });
    await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [{ durationS: 5, mode: "text", intent: "the river at night", beats: [{ from: 0, to: 5, action: "Mist drifts" }], camera: { move: "static" }, link: { type: "cut" } }] }] }));
    const applied = await orch.applyStyleToProject(project.id, "night-ink");
    expect(applied.view.scenes[0]!.shots[0]!.spec.cinematography?.animation).toBe("inkwash");
    const after = await repo.getProject(project.id);
    expect(after.look.style).toBe("night-ink");
    // and its line reaches the picture prompts
    await styles.warm(after.look.style);
    expect(imaging.stylePrompt(after)).toContain("Night Ink: Pale ink on blue-black paper");

    // guards: a library slug, someone else's style, a broken style
    await expect(styles.saveStyle(mia, { style: { ...style, slug: "watercolor" } })).rejects.toThrow(/library style/);
    await expect(styles.saveStyle(joe, { style })).rejects.toThrow(/someone else's style/);
    await expect(styles.saveStyle(mia, { style: { ...style, slug: "broken", essence: [] } })).rejects.toThrow(/essence/);
    await expect(styles.deleteStyle(joe, "night-ink")).rejects.toThrow(/someone else/);
    await expect(styles.deleteStyle(mia, "ink-wash")).rejects.toThrow(/library style/);

    // a change of essence is kept, and said for what it is
    const other = structuredClone(style);
    other.slug = "gold-lacquer"; other.en = "Gold Lacquer"; other.cn = "金漆";
    other.essence = ["Gold line on black lacquer", "Light rakes across raised strokes", "No paper anywhere"];
    const kept = await styles.saveStyle(mia, { style: other, basedOn: "night-ink" });
    expect(kept.warnings.some((w) => w.code === "style.essence")).toBe(true);
    expect(kept.style.basedOn).toBe("night-ink");

    // H3 has no negative prompt: a style's constraints are statements, and a ban list is named on the way in
    const banned = structuredClone(style);
    banned.slug = "night-ink-bans"; banned.engine.negative = ["blurry", "no extra people"];
    const named = await styles.saveStyle(mia, { style: banned, basedOn: "ink-wash" });
    expect(named.warnings.filter((w) => w.code.startsWith("style.constraints")).map((w) => w.code)).toEqual(["style.constraints.bare", "style.constraints.ban"]);
    expect(saved.warnings.some((w) => w.code.startsWith("style.constraints"))).toBe(false);
    await styles.deleteStyle(mia, "night-ink-bans");

    // overwrite one's own, then delete
    style.sound.instruments = ["guqin", "a low synth drone"];
    const again = await styles.saveStyle(mia, { style, basedOn: "ink-wash" });
    expect(again.changes.map((c) => c.section)).toEqual(["§3 palette", "§7 sound palette"]);
    expect((await repo.listUserStyles()).filter((r) => r.slug === "night-ink")).toHaveLength(1);
    expect(await styles.deleteStyle(mia, "night-ink")).toEqual({ deleted: "night-ink" });
    expect(await styles.resolveStyle("night-ink")).toBeUndefined();
  });
});
