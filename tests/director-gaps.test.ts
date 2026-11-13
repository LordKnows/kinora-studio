import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { buildAssemblerInput, exportFindings } from "@/studio/backends/assembler";
import * as craft from "@/studio/craft";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { DEFAULT_LOOK, ShotInput, ShotlistInput, TimelineInput } from "@/studio/schemas";
import * as treatments from "@/studio/treatment";
import type { Actor, Shot, Take } from "@/studio/types";

/* The plan a film is held to: the treatment kept with the script, the sound
   design table on the scenes, subtitles that follow the lines, and a batch of
   takes on one confirmation. In-memory SQLite, RunPod mocked. */

const mcp: Actor = { user: "agent", via: "mcp" };

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

const runs: string[] = [];

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.RUNPOD_MODE = "serverless";
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_ENDPOINT_ID = "ep";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/run")) { runs.push(url); return new Response(JSON.stringify({ id: `job-${runs.length}`, status: "IN_QUEUE" }), { status: 200 }); }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

const treatment = () => ({
  title: "The Ferry", style: "ink-wash", totalSeconds: 30,
  logline: "A ferryman crosses the same river every day until the day the river crosses him.",
  arc: { setup: "The ferryman's routine", turn: "The river floods", ending: "He crosses on foot" },
  candidates: [{ name: "journey", shape: "one crossing seen whole" }, { name: "before-after", shape: "the river before and after the flood" }, { name: "list", shape: "five passengers, the last is the river" }],
  chosen: "journey", whyChosen: "The crossing is the native handscroll move.",
  benchmark: [{ work: "Song landscape scrolls", learn: "value order", dontLearn: "any composition" }],
  hook: { description: "an oar breaks the mist", atSecond: 1 }, endingEcho: "the oar laid on the far bank",
  signatureShot: "a long handscroll pan", nativeMove: "The handscroll",
  sequences: [{ name: "dawn", seconds: 10, purpose: "routine", pace: "slow" }, { name: "flood", seconds: 8, purpose: "the turn", pace: "frantic" }, { name: "bank", seconds: 12, purpose: "release", pace: "still" }],
  soundDesign: [{ sequence: "dawn", ambience: "water", foley: "oar", music: "guqin" }, { sequence: "flood", ambience: "roar", foley: "splash", music: "drum" }, { sequence: "bank", ambience: "wind", foley: "steps", music: "one pluck" }],
  silences: [{ atSecond: 9, why: "before the flood" }, { atSecond: 18, why: "before the bank" }],
  audioBridges: [{ atSecond: 10, kind: "j_cut", what: "the roar arrives early" }, { atSecond: 18, kind: "l_cut", what: "water trails into the bank" }],
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({ durationS: 5, mode: "text", intent: "The river at dawn", beats: [{ from: 0, to: 5, action: "Mist drifts over the water" }], camera: { move: "static" }, link: { type: "cut" }, ...over });

describe("the treatment is kept with the script", () => {
  it("is checked, kept, superseded, and missed when it is not there", async () => {
    const project = await repo.createProject({ name: "Ferry", budgetCapUsd: 20 });
    const v1 = await repo.createScript(project.id, "EXT. RIVER - DAWN\nThe ferryman poles across.");
    // a script with no treatment: the lint says so
    expect(treatments.treatmentLint(await treatments.currentTreatment(project.id), v1.version).map((w) => w.code)).toEqual(["treatment.missing"]);
    await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "dawn", shots: [shot()] }] }));
    expect((await orch.lintProject(project.id)).warnings.some((w) => w.code === "treatment.missing" && w.severity === "warn")).toBe(true);

    // a broken one is not kept, and says what is wrong
    const broken = await treatments.saveTreatment(project.id, v1.version, { ...treatment(), chosen: "nope" }, "ink-wash");
    expect(broken).toMatchObject({ kept: false, ok: false });
    expect(broken.warnings.some((w) => w.code === "treatment.chosen")).toBe(true);
    expect(await treatments.currentTreatment(project.id)).toBeUndefined();

    // a sound one is kept for this version; its own warnings ride along
    const flat = { ...treatment(), hook: { description: "an oar breaks the mist", atSecond: 6 } };
    const saved = await treatments.saveTreatment(project.id, v1.version, flat, "中国水墨");
    expect(saved.kept).toBe(true);
    const kept = await treatments.currentTreatment(project.id);
    expect(kept).toMatchObject({ scriptVersion: 1, style: "ink-wash" });
    expect(kept!.treatment.chosen).toBe("journey");
    const lint = (await orch.lintProject(project.id)).warnings.map((w) => w.code);
    expect(lint).not.toContain("treatment.missing");
    expect(lint).toContain("treatment.hook");

    // a new script version without one: the old one stands, and is called stale
    const v2 = await repo.createScript(project.id, "EXT. RIVER - DAWN\nThe ferryman poles across. The river rises.");
    expect(treatments.treatmentLint(await treatments.currentTreatment(project.id), v2.version).map((w) => w.code)).toEqual(["treatment.stale", "treatment.hook"]);
    // sent again, it supersedes
    await treatments.saveTreatment(project.id, v2.version, treatment(), "ink-wash");
    expect((await repo.listNotes(project.id, "treatment")).map((n) => n.status).sort()).toEqual(["current", "superseded"]);
    expect(treatments.treatmentLint(await treatments.currentTreatment(project.id), v2.version)).toEqual([]);

    // the story reviewer reads it after the script
    const packet = await craft.reviewPacket(project.id, "story");
    expect(packet.reviewerPrompt).toContain("--- TREATMENT (written for script v2) ---");
    expect(packet.reviewerPrompt).toContain("## Candidate structures");
    expect(packet.reviewerPrompt.indexOf("--- SCRIPT ---")).toBeLessThan(packet.reviewerPrompt.indexOf("--- TREATMENT"));
  });

  it("a script reviewed without one is told so", async () => {
    const project = await repo.createProject({ name: "Bare", budgetCapUsd: 5 });
    await repo.createScript(project.id, "A cat walks.");
    expect((await craft.reviewPacket(project.id, "story")).reviewerPrompt).toContain("There is no treatment with this script");
  });
});

describe("the sound design table", () => {
  it("rides on the scene, fills a shot's ambience, and is held against the timeline", async () => {
    const project = await repo.createProject({ name: "Sound", budgetCapUsd: 20 });
    await repo.createScript(project.id, "EXT. RIVER");
    await treatments.saveTreatment(project.id, 1, treatment(), "ink-wash");
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({
      scenes: [
        { slug: "dawn", sound: { ambience: "slow water against a wooden hull", foley: "an oar dipping", music: "sparse guqin enters at the turn", silence: "before the flood" }, shots: [shot(), shot({ sound: { sfx: ["a splash"], ambience: "a storm", music: "N/A" } })] },
        { slug: "bank", shots: [shot({ intent: "The far bank" })] },
      ],
    }));
    expect(view.scenes[0]!.sound?.ambience).toBe("slow water against a wooden hull");
    // a shot with no ambience of its own takes the scene's; one with its own keeps it
    const [a, b] = view.scenes[0]!.shots;
    expect((await orch.compileForShot(a!.id)).prompt).toContain("slow water against a wooden hull");
    const own = (await orch.compileForShot(b!.id)).prompt;
    expect(own).toContain("a storm");
    expect(own).not.toContain("slow water against a wooden hull");
    // a scene without a row falls back as before
    expect((await orch.compileForShot(view.scenes[1]!.shots[0]!.id)).prompt.toLowerCase()).toContain("natural room tone");

    // saved again without the row: the row stays (as the palette does)
    const again = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "dawn", shots: [shot(), shot()] }, { slug: "bank", shots: [shot()] }] }));
    expect(again.scenes[0]!.sound?.music).toBe("sparse guqin enters at the turn");
    // set and cleared on its own
    const bank = await repo.updateScene(again.scenes[1]!.id, { sound: { ambience: "wind over mud", foley: "steps", music: "none" } });
    expect(bank.sound?.foley).toBe("steps");

    const lint = await orch.lintProject(project.id);
    expect(lint.warnings.some((w) => w.code === "sound.table")).toBe(false);
    expect(lint.warnings.some((w) => w.code === "sound.plan")).toBe(false); // no timeline yet

    // with a timeline that carries none of the plan, every gap is named
    const stored = await treatments.currentTreatment(project.id);
    const scenes = (await orch.getProjectView(project.id)).scenes;
    const bare = TimelineInput.parse({ clips: [{ shotId: "s", takeId: "t", outS: 5 }, { shotId: "s2", takeId: "t2", outS: 5 }] });
    const gaps = treatments.soundPlanFindings(scenes, bare, stored);
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toContain("the timeline has no music");
    expect(gaps[1]).toContain("2 silence(s) were planned");
    expect(gaps[2]).toContain("2 sound bridge(s) were planned");
    // and a timeline that carries it is quiet ("none" is not a score)
    const full = TimelineInput.parse({ clips: [{ shotId: "s", takeId: "t", outS: 5, audioTrailS: 0.4 }, { shotId: "s2", takeId: "t2", inS: 0.6, outS: 5, audioLeadS: 0.5 }], music: "ast_music", silences: [{ atS: 4.5, durationS: 0.5 }, { atS: 8, durationS: 0.5 }] });
    expect(treatments.soundPlanFindings(scenes, full, stored)).toEqual([]);
    expect(treatments.soundPlanFindings([{ ...scenes[1]!, sound: { ambience: "", foley: "", music: "N/A" } }], bare, undefined)).toEqual([]);
  });
});

describe("subtitles follow the lines", () => {
  const spec = ShotInput.parse({
    durationS: 8, mode: "text", intent: "Two lines and a thought", beats: [{ from: 0, to: 8, action: "Mara and Joe talk across the counter" }], camera: { move: "static" },
    dialogue: [
      { speaker: "mara", text: "You came.", startS: 1, endS: 2.5 },
      { speaker: "joe", text: "I said I would.", startS: 4, endS: 6 },
      { speaker: "mara", text: "He always says that.", kind: "inner" },
    ],
  });
  const s: Shot = { id: "s1", projectId: "p", sceneId: "c", index: 0, spec, createdAt: 0, updatedAt: 0 };
  const t: Take = { id: "t1", projectId: "p", shotId: "s1", n: 1, backend: "runpod", workflow: "T2VA", prompt: "", input: {}, status: "completed", resultUrl: "https://r2/t1.mp4", thumbUrls: [], createdAt: 0 };
  const base = { exportId: "e", projectId: "p", preset: "master-768p", look: DEFAULT_LOOK, shots: new Map([["s1", s]]), takes: new Map([["t1", t]]), elementNames: new Map([["mara", "Mara"], ["joe", "Joe"]]), burnIn: false, videoSize: "1344x768" };

  it("a line with a time window is captioned there, shifted by the trim", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", inS: 0.5, outS: 8 }] });
    const srt = buildAssemblerInput({ ...base, timeline }).subtitles.srt;
    expect(srt).toContain("00:00:00,500 --> 00:00:02,000\nMara: You came.");
    expect(srt).toContain("00:00:03,500 --> 00:00:05,500\nJoe: I said I would.");
    expect(srt).toContain("Mara: He always says that."); // not voiced yet: still captioned from the shot
  });

  it("a line voiced on the narration track is captioned once, from its audio", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", outS: 8 }], narration: [{ assetId: "ast_v", atS: 6.2 }] });
    const input = buildAssemblerInput({ ...base, timeline, audioUrls: new Map([["ast_v", "https://r2/v.wav"]]), audioTexts: new Map([["ast_v", "He always says that"]]) });
    expect(input.subtitles.srt).not.toContain("He always says that");
    expect(input.audio.narration).toEqual([{ url: "https://r2/v.wav", at_s: 6.2, text: "He always says that" }]);
  });

  it("a line the cut trimmed away gets no cue", () => {
    const timeline = TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", inS: 3, outS: 8 }] });
    const srt = buildAssemblerInput({ ...base, timeline }).subtitles.srt;
    expect(srt).not.toContain("You came.");
    expect(srt).toContain("00:00:01,000 --> 00:00:03,000\nJoe: I said I would.");
  });

  it("cues too short to read are findings", () => {
    const input = buildAssemblerInput({ ...base, timeline: TimelineInput.parse({ clips: [{ shotId: "s1", takeId: "t1", outS: 8 }] }) });
    const findings = exportFindings(input, { duration_s: 8, subtitles: [
      { start_s: 0, end_s: 2.5, text: "Mara: You came." },
      { start_s: 3, end_s: 3.8, text: "Joe: 那一年，河水涨了十二米，淹过了整座渡口。" },
    ] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("1 subtitle cue(s) cannot be read");
    expect(findings[0]).toContain("cue 2 at 3.0 s");
  });
});

describe("a batch of takes on one confirmation", () => {
  it("lists one total, renders what can render, and names what cannot", async () => {
    const project = await repo.createProject({ name: "Batch", budgetCapUsd: 20 });
    const script = await repo.createScript(project.id, "EXT. RIVER");
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [shot(), shot({ intent: "The far bank" }), shot({ intent: "The oar" }), shot({ mode: "keyframe", intent: "He steps ashore", link: { type: "continuous" } })] }] }));
    const ids = view.scenes[0]!.shots.map((x) => x.id);
    // the two checkpoints come first
    await expect(orch.createTakeBatch(project.id, { n: 1, confirm: false }, mcp)).rejects.toMatchObject({ code: "not_approved", details: { checkpoint: "script" } });
    await repo.approveScript(script.id);
    await repo.setShotlistApproval(project.id, "approved");

    // nothing was read by a reviewer: nothing renders, and it says why
    const unread = await orch.createTakeBatch(project.id, { n: 1, confirm: true }, mcp);
    expect(unread.queued).toEqual([]);
    expect(unread.refused.map((x) => x.code)).toEqual(["not_reviewed", "not_reviewed", "not_reviewed"]);
    expect(unread.waiting.map((x) => x.shotId)).toEqual([ids[3]]);
    expect(runs).toHaveLength(0);

    // the user said to render them as they are: one figure to confirm, nothing spent yet
    const why = "the user asked to render the previz without a review";
    let asked: { code?: string; details?: { estimateUsd: number; shots: Array<{ shotId: string; estimateUsd: number }>; waiting: unknown[] } } = {};
    await orch.createTakeBatch(project.id, { n: 1, confirm: false, skipReview: why }, mcp).catch((e) => { asked = e; });
    expect(asked.code).toBe("needs_confirm");
    expect(asked.details!.shots.map((x) => x.shotId)).toEqual(ids.slice(0, 3));
    expect(asked.details!.estimateUsd).toBeCloseTo(asked.details!.shots.reduce((a, x) => a + x.estimateUsd, 0), 3);
    expect(asked.details!.waiting).toHaveLength(1);
    expect(runs).toHaveLength(0);

    // confirmed once: all three are queued, the linked shot waits for its anchor
    const done = await orch.createTakeBatch(project.id, { n: 1, confirm: true, skipReview: why }, mcp);
    expect(done.queued.map((x) => x.shotId)).toEqual(ids.slice(0, 3));
    expect(done.queued.every((x) => x.takeIds.length === 1)).toBe(true);
    expect(done.waiting.map((x) => x.shotId)).toEqual([ids[3]]);
    expect(runs).toHaveLength(3);
    expect(done.estimateUsd).toBeCloseTo(asked.details!.estimateUsd, 3);

    // a subset by id (the probe), and a shot that is not this project's
    await expect(orch.createTakeBatch(project.id, { shotIds: ["sht_nope"], n: 1, confirm: false }, mcp)).rejects.toMatchObject({ code: "validation" });
    let probe: { details?: { shots: unknown[] } } = {};
    await orch.createTakeBatch(project.id, { shotIds: [ids[1]!], n: 2, confirm: false, skipReview: why }, mcp).catch((e) => { probe = e; });
    expect(probe.details!.shots).toHaveLength(1);

    // over the cap: refused whole, before anything is queued
    await repo.updateProject(project.id, { budgetCapUsd: 0.01 });
    await expect(orch.createTakeBatch(project.id, { shotIds: ids.slice(0, 3), n: 4, confirm: true, skipReview: why }, mcp)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(runs).toHaveLength(3);
  });
});

describe("LoRAs are the director's to assign, shot by shot", () => {
  it("the lint asks for the pass, naming what the style suggests; assign_loras answers it", async () => {
    const project = await repo.createProject({ name: "Cel", budgetCapUsd: 20 });
    const lint = async (code: string) => (await orch.lintProject(project.id)).warnings.filter((w) => w.code === code);
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [shot(), shot({ intent: "The city at night" }), shot({ mode: "keyframe", intent: "She turns to the window" })] }] }));
    await orch.applyStyleToProject(project.id, "cel-anime-80s");
    const [ask] = await lint("lora.unassigned");
    expect(ask).toMatchObject({ severity: "info" });
    expect(ask!.message).toContain("3 of the film's 3 shot(s)");
    expect(ask!.message).toContain("lora_prithiv_anime_motion");
    /* nothing is applied for the user: the shots have no LoRAs until the director assigns them */
    expect((await repo.listShots(project.id)).every((sh) => sh.spec.loras === undefined)).toBe(true);

    const [a, b, c] = view.scenes[0]!.shots;
    await repo.setShotlistApproval(project.id, "approved");
    /* a speed LoRA is the use-turbo switch's; a LoRA must be trained for the shot's workflow; a refused call writes nothing */
    await expect(orch.assignLoras(project.id, [{ shotId: c!.id, loras: [{ id: "lora_h3_turbo_fl2v", why: "faster" }] }])).rejects.toMatchObject({ code: "validation" });
    await expect(orch.assignLoras(project.id, [{ shotId: c!.id, loras: [{ id: "lora_prithiv_anime_motion", why: "anime" }] }, { shotId: a!.id, loras: [{ id: "lora_prithiv_anime_motion", why: "anime" }] }])).rejects.toMatchObject({ code: "validation" });
    expect((await repo.getShot(c!.id)).spec.loras).toBeUndefined();

    const done = await orch.assignLoras(project.id, [
      { shotId: c!.id, loras: [{ id: "lora_prithiv_anime_motion", strength: 0.8, why: "a keyframe shot that animates a drawn hero frame" }] },
      { shotId: a!.id, loras: [] },
      { shotId: b!.id, loras: [] },
    ]);
    expect(done.shots[0]).toMatchObject({ slate: "1·3", useTurbo: true, useLoras: true, loras: [{ id: "lora_prithiv_anime_motion", strength: 0.8, why: expect.stringContaining("hero frame") }] });
    expect(await lint("lora.unassigned")).toEqual([]);
    /* not structural: the approval stands */
    expect((await repo.getProject(project.id)).shotlistApproval).toBe("approved");

    /* the shot becomes a text shot: what it was given can no longer load */
    await orch.patchShot(c!.id, { mode: "text" });
    expect((await lint("lora.workflow"))[0]).toMatchObject({ severity: "warn", scene: "a", shot: 3 });
  });

  it("list_loras with a project gives each shot its workflows, switches and what could load on it", async () => {
    const project = await repo.createProject({ name: "News", budgetCapUsd: 20 });
    await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [shot({ mode: "keyframe" }), shot()] }] }));
    await orch.applyStyleToProject(project.id, "newsreel");
    const plan = await orch.loraPlan(project.id);
    expect(plan.styleSuggests.map((x) => x.id)).toEqual(["lora_fal_realism_people"]);
    expect(plan.shots[0]).toMatchObject({ slate: "1·1", workflows: ["I2VA", "FL2VA"], useTurbo: true, useLoras: true, state: "unassigned" });
    expect(plan.shots[0]!.canLoad).toContain("lora_prithiv_anime_motion");
    expect(plan.shots[1]!.canLoad).not.toContain("lora_prithiv_anime_motion");
    expect(plan.shots.every((s) => !s.canLoad.some((id) => id.startsWith("lora_h3_turbo")))).toBe(true);
  });

  it("a re-saved shotlist keeps the user's switches and the director's assignment", async () => {
    const project = await repo.createProject({ name: "Keep", budgetCapUsd: 20 });
    const list = ShotlistInput.parse({ scenes: [{ slug: "a", shots: [shot()] }] });
    const [s1] = (await orch.saveShotlist(project.id, list)).scenes[0]!.shots;
    await orch.assignLoras(project.id, [{ shotId: s1!.id, loras: [{ id: "lora_fal_realism_people", why: "faces must read as photographed" }] }]);
    await orch.patchShot(s1!.id, { useTurbo: false });
    await orch.saveShotlist(project.id, list);
    const spec = (await repo.getShot(s1!.id)).spec;
    expect(spec.useTurbo).toBe(false);
    expect(spec.loras?.map((l) => l.id)).toEqual(["lora_fal_realism_people"]);
  });

  it("an old project's Look LoRAs move onto its shots, once", async () => {
    const { getDb } = await import("@/db");
    const d = await getDb();
    const project = await repo.createProject({ name: "Old", budgetCapUsd: 20 });
    const [inherits, override, none] = (await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "a", shots: [shot(), shot(), shot()] }] }))).scenes[0]!.shots;
    /* the old model: speed + a style LoRA in the Look; one shot overrides with its own, one with none */
    const look = { ...(await repo.getProject(project.id)).look, loras: [{ id: "lora_h3_turbo_fl2v" }, { id: "lora_h3_turbo_ref2v" }, { id: "lora_fal_realism_people", strength: 0.6 }] };
    await d.run("UPDATE projects SET look_json = ? WHERE id = ?", [JSON.stringify(look), project.id]);
    const old = (id: string, loras?: unknown[]) => repo.getShot(id).then((sh) => { const spec: Record<string, unknown> = { ...sh.spec }; delete spec.useTurbo; if (loras) spec.loras = loras; else delete spec.loras; return d.run("UPDATE shots SET spec_json = ? WHERE id = ?", [JSON.stringify(spec), id]); });
    await old(inherits!.id);
    await old(override!.id, [{ id: "lora_h3_turbo_fl2v" }, { id: "lora_jojocodex_physics", strength: 0.4 }]);
    await old(none!.id, []);

    await repo.carryLookLorasNow();
    const a = (await repo.getShot(inherits!.id)).spec;
    expect(a).toMatchObject({ useTurbo: true, loras: [{ id: "lora_fal_realism_people", strength: 0.6, why: expect.stringContaining("Look") }] });
    expect((await repo.getShot(override!.id)).spec).toMatchObject({ useTurbo: true, loras: [{ id: "lora_jojocodex_physics", strength: 0.4 }] });
    expect((await repo.getShot(none!.id)).spec).toMatchObject({ useTurbo: false, loras: [] });
    const row = await d.get("SELECT look_json FROM projects WHERE id = ?", [project.id]);
    expect(JSON.parse(String(row!.look_json))).not.toHaveProperty("loras");

    /* run again: nothing changes */
    await repo.carryLookLorasNow();
    expect((await repo.getShot(inherits!.id)).spec).toEqual(a);
  });
});
