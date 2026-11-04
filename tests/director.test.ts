import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { CINEMA, renderCinematography } from "@/studio/cinematography";
import { cinematographyGuide, editingGuide, filmPlan } from "@/studio/director-guides";
import { EDIT_GRAMMAR, planDurations } from "@/studio/editing";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { Cinematography, ShotInput, ShotlistInput } from "@/studio/schemas";

/* Tier 2 (edit grammar) and Tier 3 (cinematography) through the compiler. */

async function memoryDb(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db: Db = {
    async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
    async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
    async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
    async exec(sql: string) { sqlite.exec(sql); },
  };
  await migrate(db);
  return db;
}

beforeAll(async () => {
  process.env.H3_PROMPT_FORMAT = "blocks";
  setDb(await memoryDb());
  process.env.RUNPOD_MODE = "serverless";
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 6, mode: "text", intent: "Mara crosses the lobby",
    beats: [{ from: 0, to: 6, action: "Mara walks through the lobby toward the lift" }],
    camera: { move: "tracking", amplitude: "moderate", speed: "medium" }, ...over,
  });

async function finishTake(shotId: string, lastFrameUrl: string) {
  const take = await repo.createTake({ projectId: (await repo.getShot(shotId)).projectId, shotId, backend: "runpod", workflow: "T2VA", prompt: "", input: { seconds: 6 } });
  await repo.updateTake(take.id, { status: "completed", resultUrl: `${lastFrameUrl}.mp4`, lastFrameUrl, finishedAt: Date.now() });
  await repo.updateShot(shotId, { selectedTakeId: take.id });
}

describe("duration plan", () => {
  it("tiles the running time with 5–15 s shots", () => {
    for (const total of [5, 8, 17, 30, 60, 95, 180]) {
      const plan = planDurations(total);
      expect(plan.durations.reduce((a, b) => a + b, 0)).toBe(total);
      expect(plan.durations.every((d) => d >= 5 && d <= 15)).toBe(true);
    }
    expect(planDurations(60, 6).durations).toEqual([10, 10, 10, 10, 10, 10]);
    expect(planDurations(42, 10).shots).toBe(8);
    const plan = filmPlan({ brief: "x", totalSeconds: 45 });
    expect(plan.tiers.tier2).toContain("45 s");
  });
});

describe("cinematography", () => {
  it("validates keys against the catalog and renders prose", () => {
    expect(Cinematography.safeParse({ size: "cu", lighting: ["rembrandt", "neon"], vfx: ["slowmo"], animation: "anime" }).success).toBe(true);
    expect(Cinematography.safeParse({ size: "huge" }).success).toBe(false);
    expect(Cinematography.safeParse({ lighting: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    const { block, lookLine } = renderCinematography({ size: "mcu", angle: "low", lens: "anamorphic", dof: "shallow", lighting: ["lowkey", "practicals"], grade: "tealorange", texture: "35mm", vfx: ["rain", "lensflare"], animation: "ghibli", pace: "slow" });
    expect(block).toContain("Framing: medium close-up, head and shoulders, from a low angle looking up.");
    expect(block).toContain("Lighting: low-key lighting with deep shadows; lit by practical sources in frame");
    expect(block).toContain("Technique: heavy rain on the lens and surfaces; anamorphic lens flares.");
    expect(lookLine).toContain("painterly hand-drawn animation");
    expect(CINEMA.every((c) => c.terms.length >= 5)).toBe(true);
    expect(cinematographyGuide()).toContain("| `rembrandt` |");
    expect(editingGuide()).toContain("| `match_cut` |");
    expect(EDIT_GRAMMAR.map((g) => g.type)).toContain("insert_return");
  });
});

describe("edit grammar through the compiler", () => {
  let projectId = "";
  let ids: string[] = [];

  it("builds a five-shot sequence with cut / insert / insert_return / match_cut / bridge", async () => {
    const project = await repo.createProject({ name: "Grammar", brief: "A woman crosses a lobby", targetSeconds: 30 });
    projectId = project.id;
    const hero = await repo.createAsset({ projectId, url: "https://r2/hero.png", kind: "image", source: "upload" });
    const end = await repo.createAsset({ projectId, url: "https://r2/end.png", kind: "image", source: "upload" });
    const view = await orch.saveShotlist(projectId, ShotlistInput.parse({
      scenes: [{ slug: "lobby", shots: [
        shot({ cinematography: { size: "ls", angle: "high", lighting: ["overcast"], grade: "muted" } }),
        shot({ intent: "Insert: her hand on the lift button", cinematography: { size: "insert", dof: "shallow" }, camera: { move: "static", amplitude: "subtle", speed: "slow" } }),
        shot({ intent: "Back in the lobby she reaches the lift", link: { type: "insert_return" }, mode: "keyframe" }),
        shot({ intent: "The lift doors become a vault door in a bank", link: { type: "match_cut" }, mode: "reference" }),
        shot({ intent: "Through the vault into the counting room", link: { type: "bridge" }, mode: "keyframe" }),
      ] }],
    }));
    ids = view.scenes[0]!.shots.map((s) => s.id);
    await repo.updateShot(ids[4]!, { endAssetId: end.id });
    expect((await repo.getProject(projectId)).targetSeconds).toBe(30);
    expect(hero.id).toBeTruthy();

    /* Tier 3 keys land in the prompt of a plain cut */
    const c0 = await orch.compileForShot(ids[0]!);
    expect(c0.workflow).toBe("T2VA");
    expect(c0.prompt).toContain("CINEMATOGRAPHY\nFraming: long shot, the full figure in the setting, from a high angle looking down.");
    expect(c0.prompt).toContain("Image: muted, low-saturation palette.");

    /* linked shots cannot compile before their anchor has a take */
    await expect(orch.compileForShot(ids[2]!)).rejects.toMatchObject({ code: "validation" });
    await finishTake(ids[0]!, "https://r2/s1.last.png");
    await finishTake(ids[1]!, "https://r2/s2.last.png");

    /* insert_return anchors two shots back */
    const c2 = await orch.compileForShot(ids[2]!);
    expect(c2.workflow).toBe("I2VA");
    expect(c2.input.images).toEqual([{ url: "https://r2/s1.last.png", role: "first_frame" }]);
    expect(c2.prompt).toContain("Resume the action exactly where the first frame leaves it");
    await finishTake(ids[2]!, "https://r2/s3.last.png");

    /* match_cut puts the previous last frame in as reference image 1 */
    const c3 = await orch.compileForShot(ids[3]!);
    expect(c3.workflow).toBe("R2VA");
    expect(c3.input.images[0]).toEqual({ url: "https://r2/s3.last.png", role: "reference", label: "match frame" });
    expect(c3.prompt).toContain("Image 1: the previous shot's last frame: match its composition and motion");
    expect(c3.prompt).toContain("Match cut: keep the composition");
    await finishTake(ids[3]!, "https://r2/s4.last.png");

    /* bridge = previous last frame → this shot's end frame, FL2VA */
    const c4 = await orch.compileForShot(ids[4]!);
    expect(c4.workflow).toBe("FL2VA");
    expect(c4.input.images.map((i) => i.role)).toEqual(["first_frame", "last_frame"]);
    expect(c4.input.images[0]!.url).toBe("https://r2/s4.last.png");
    expect(c4.prompt).toContain("One continuous camera move carries the first frame into the final frame.");
  });

  it("explicit anchors, jump cuts and the legacy linkToPrev still work", async () => {
    const scene = (await repo.listScenes(projectId))[0]!;
    const jump = await orch.addShot(scene.id, shot({ intent: "Hours later, the same corridor", link: { type: "jump_cut", anchorShotId: ids[2] }, mode: "keyframe" }));
    const cj = await orch.compileForShot(jump.id);
    expect(cj.input.images[0]!.url).toBe("https://r2/s3.last.png");
    expect(cj.prompt).toContain("Jump cut: time has passed");

    const legacy = await orch.addShot(scene.id, shot({ intent: "legacy continuous", linkToPrev: "continuous", mode: "keyframe" }));
    await expect(orch.compileForShot(legacy.id)).rejects.toMatchObject({ code: "validation" });
    await finishTake(jump.id, "https://r2/jump.last.png");
    const cl = await orch.compileForShot(legacy.id);
    expect(cl.input.images[0]!.url).toBe("https://r2/jump.last.png");
    expect(cl.prompt).toContain("Continue the previous shot's action");
  });
});

describe("lightx2v structured prompt and loops", () => {
  it("serialises the sections into lightx2v fields with picture / subject tokens", async () => {
    const { compileShot } = await import("@/studio/compiler");
    const base = { id: "s", projectId: "p", sceneId: "c", index: 0, createdAt: 0, updatedAt: 0 };
    const look = { genre: "neo-noir", palette: "teal and amber", camera: "", lens: "", lighting: "", aspectRatio: "16:9" as const, resolution: "768p" as const, upscale: false, negative: ["no logos"], loras: [] };
    const assets = new Map([
      ["h", { id: "h", projectId: "p", url: "https://r2/h.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
      ["e", { id: "e", projectId: "p", url: "https://r2/e.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
      ["m", { id: "m", projectId: "p", url: "https://r2/mara.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }],
    ]);
    const elements = new Map([["mara", { id: "mara", projectId: "p", kind: "character" as const, name: "Mara", description: "silver crop, charcoal coat", refAssetIds: ["m"], createdAt: 0, updatedAt: 0 }]]);

    const fl = compileShot({
      shot: { ...base, spec: shot({ mode: "keyframe", dialogue: [{ speaker: "mara", text: "Not tonight.", language: "en", delivery: "breathless" }], sound: { sfx: ["rain"], ambience: "wet street", music: "N/A" } }), heroAssetId: "h", endAssetId: "e" },
      look, elements, assets, format: "lightx2v-json",
    });
    expect(fl.workflow).toBe("FL2VA");
    const json = JSON.parse(fl.prompt) as Record<string, string>;
    expect(Object.keys(json)).toEqual(["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]);
    expect(json.integrated_multimodal_description).toMatch(/^<Picture 1> is the first frame of the shot\. <Picture 2> is the last frame of the shot\. neo-noir\. teal and amber\. Mara crosses the lobby\./);
    expect(json.integrated_multimodal_description).toContain('Dialogue — Mara (en, breathless): "Not tonight."');
    expect(json.integrated_multimodal_description).toContain("no logos");
    expect(json.overall_soundscape).toBe("Sound effects: rain. Ambience: wet street.");
    expect(json.non_diegetic_music).toBe("None");

    const r2 = compileShot({
      shot: { ...base, spec: shot({ mode: "reference", characters: ["mara"], intent: "Mara looks back", sound: { sfx: [], ambience: "", music: "slow synth pad" } }) },
      look, elements, assets, format: "lightx2v-lines",
    });
    expect(r2.workflow).toBe("R2VA");
    expect(r2.prompt.split("\n")[0]).toBe("subject_definitions: <Subject 1>: Mara, the character. Keep face, hair and wardrobe exactly.");
    expect(r2.prompt).toContain("summary: Mara looks back");
    expect(r2.prompt).toContain("retention_analysis: <Subject 1> keeps face, hair and wardrobe exactly.");
    expect(r2.prompt).toContain("non_diegetic_music: slow synth pad");
  });

  it("loop renders one period as FL2VA with the hero frame at both ends", async () => {
    const project = await repo.createProject({ name: "Loop" });
    const hero = await repo.createAsset({ projectId: project.id, url: "https://r2/wheel.png", kind: "image", source: "upload" });
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "wheel", shots: [shot({ intent: "A ferris wheel turns once", link: { type: "loop" }, mode: "keyframe", durationS: 8, beats: [{ from: 0, to: 8, action: "The wheel completes exactly one revolution and returns to its starting pose" }] })] }] }));
    const id = view.scenes[0]!.shots[0]!.id;
    await expect(orch.compileForShot(id)).rejects.toMatchObject({ code: "validation" });
    await repo.updateShot(id, { heroAssetId: hero.id });
    const c = await orch.compileForShot(id);
    expect(c.workflow).toBe("FL2VA");
    expect(c.input.images).toEqual([{ url: "https://r2/wheel.png", role: "first_frame" }, { url: "https://r2/wheel.png", role: "last_frame" }]);
    expect(c.prompt).toContain("Seamless loop");
    const { TimelineInput } = await import("@/studio/schemas");
    expect(TimelineInput.parse({ clips: [{ shotId: id, takeId: "t", outS: 8, repeat: 12 }] }).clips[0]!.repeat).toBe(12);
  });
});
