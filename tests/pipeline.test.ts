import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { mapRunPodStatus, signHookUrl, verifyHookUrl } from "@/studio/backends/runpod";
import { compileShot, VIDEO_SIZES } from "@/studio/compiler";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotInput, ShotlistInput } from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* End to end over an in-memory SQLite: project → script → elements → shotlist →
   checkpoints → takes (RunPod mocked) → hook → timeline → export input. */

const web: Actor = { user: "tester@local", via: "web" };
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

const runpodCalls: Array<{ url: string; body: unknown }> = [];
let nextStatus: Record<string, unknown> = { id: "job-1", status: "IN_QUEUE" };

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_ENDPOINT_ID = "ep";
  process.env.RUNPOD_ASSEMBLER_ENDPOINT_ID = "asm";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    runpodCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/run")) return new Response(JSON.stringify({ id: `job-${runpodCalls.length}`, status: "IN_QUEUE" }), { status: 200 });
    if (url.includes("/status/")) return new Response(JSON.stringify(nextStatus), { status: 200 });
    if (url.includes("/cancel/")) return new Response(JSON.stringify({ id: "x", status: "CANCELLED" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 8, mode: "text", intent: "Establish the rain-soaked alley at night",
    beats: [{ from: 0, to: 4, action: "Rain hammers an empty alley lit by one sodium lamp" }, { from: 4, to: 8, action: "A figure in a long coat runs through frame and vanishes" }],
    camera: { move: "static" }, ...over,
  });

describe("pipeline", () => {
  let projectId = "";
  let shotId = "";

  it("creates a project, script and elements", async () => {
    const project = await repo.createProject({ name: "Neon chase", look: { genre: "neo-noir thriller", palette: "teal and amber", aspectRatio: "16:9" }, budgetCapUsd: 20 });
    projectId = project.id;
    const script = await repo.createScript(projectId, "INT. ALLEY - NIGHT\nMara runs.");
    expect(script.version).toBe(1);
    expect(script.approval).toBe("draft");
    const mara = await repo.createElement(projectId, { kind: "character", name: "Mara", description: "30s, cropped silver hair, long charcoal coat" });
    const asset = await repo.createAsset({ projectId, url: "https://r2/mara-front.png", kind: "image", source: "generated" });
    await repo.updateElement(mara.id, { refAssetIds: [asset.id] });
    const view = await orch.getProjectView(projectId);
    expect(view.elements.map((e) => e.name)).toEqual(["Mara"]);
    expect(view.canGenerate).toBe(false);
  });

  it("saves a shotlist and compiles each mode", async () => {
    const mara = (await repo.listElements(projectId))[0]!;
    const input = ShotlistInput.parse({
      scenes: [{
        slug: "alley", summary: "Mara is chased", shots: [
          shot(),
          shot({ mode: "reference", characters: [mara.id], intent: "Mara looks back over her shoulder", dialogue: [{ speaker: mara.id, text: "Not tonight.", language: "en", delivery: "breathless" }] }),
        ],
      }],
    });
    const view = await orch.saveShotlist(projectId, input);
    expect(view.scenes[0]!.shots).toHaveLength(2);
    shotId = view.scenes[0]!.shots[0]!.id;
    const refShot = view.scenes[0]!.shots[1]!;

    const compiledText = await orch.compileForShot(shotId);
    expect(compiledText.workflow).toBe("T2VA");
    expect(compiledText.prompt).toContain("LOOK\nneo-noir thriller");
    expect(compiledText.prompt).toContain("holds a static, locked-off shot");
    expect(compiledText.input.video_size).toBe(VIDEO_SIZES["16:9"]);

    const compiledRef = await orch.compileForShot(refShot.id);
    expect(compiledRef.workflow).toBe("R2VA");
    expect(compiledRef.input.images).toEqual([{ url: "https://r2/mara-front.png", role: "reference", label: "Mara" }]);
    expect(compiledRef.prompt).toContain("Image 1: Mara, the character");
    expect(compiledRef.prompt).toContain('Mara (en, breathless): "Not tonight."');
    expect(compiledRef.prompt).not.toContain("cropped silver hair");

    expect(compiledText.prompt).not.toContain("cropped silver hair");
  });

  it("keyframe mode needs a hero frame and uses FL2VA with an end frame", async () => {
    const hero = await repo.createAsset({ projectId, url: "https://r2/hero.png", kind: "image", source: "generated" });
    const end = await repo.createAsset({ projectId, url: "https://r2/end.png", kind: "image", source: "generated" });
    await expect(orch.patchShot(shotId, { mode: "keyframe" }).then(() => orch.compileForShot(shotId))).rejects.toMatchObject({ code: "validation" });
    await orch.patchShot(shotId, { heroAssetId: hero.id, endAssetId: end.id });
    const c = await orch.compileForShot(shotId);
    expect(c.workflow).toBe("FL2VA");
    expect(c.input.images.map((i) => i.role)).toEqual(["first_frame", "last_frame"]);
    expect(c.prompt).toContain("ends on the final frame");
    expect(c.prompt).not.toContain("sodium lamp" + "X");
  });

  it("refuses takes until both checkpoints pass, then submits to RunPod", async () => {
    await expect(orch.createTakes(shotId, { n: 1, confirm: true }, web)).rejects.toMatchObject({ code: "not_approved", details: { checkpoint: "script" } });
    const script = await repo.latestScript(projectId);
    await repo.approveScript(script!.id);
    await expect(orch.createTakes(shotId, { n: 1, confirm: true }, web)).rejects.toMatchObject({ code: "not_approved", details: { checkpoint: "shotlist" } });
    await repo.setShotlistApproval(projectId, "approved");

    await expect(orch.createTakes(shotId, { n: 1, confirm: false }, mcp)).rejects.toMatchObject({ code: "needs_confirm" });

    const { takes, estimate } = await orch.createTakes(shotId, { n: 2, confirm: true, seed: 7 }, mcp);
    expect(takes).toHaveLength(2);
    expect(takes.map((t) => t.status)).toEqual(["queued", "queued"]);
    expect(takes.map((t) => t.seed)).toEqual([7, 8]);
    expect(estimate.usd).toBeGreaterThan(0);
    const call = runpodCalls.find((c) => c.url.endsWith("/run"))!;
    const body = call.body as { input: Record<string, unknown>; webhook: string; policy: { executionTimeout: number } };
    expect(body.input.workflow).toBe("FL2VA");
    expect(body.input.studio_take_id).toBe(takes[0]!.id);
    expect(String(body.input.output && (body.input.output as { key: string }).key)).toContain(`/takes/${takes[0]!.id}.mp4`);
    expect(body.webhook).toContain("https://studio.example/api/runpod/hook?id=");
    expect(body.policy.executionTimeout).toBe(900000);
  });

  it("a structural revise_shot resets the shotlist approval; a note does not", async () => {
    await orch.patchShot(shotId, { camera: { move: "static", amplitude: "moderate", speed: "slow", note: "hold on the lamp" } });
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("approved");
    await orch.patchShot(shotId, { durationS: 10, beats: [{ from: 0, to: 10, action: "Rain hammers the alley for ten seconds" }] });
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("draft");
    await repo.setShotlistApproval(projectId, "approved");
  });

  it("webhook completion records the result, cost and assets; selection and timeline follow", async () => {
    const take = (await repo.listShotTakes(shotId))[0]!;
    const url = await signHookUrl("https://studio.example", "/api/runpod/hook", "s3cret", take.id);
    expect(await verifyHookUrl(new URL(url), "s3cret")).toBe(take.id);
    await expect(verifyHookUrl(new URL(url.replace(/sig=[0-9a-f]{4}/, "sig=0000")), "s3cret")).rejects.toMatchObject({ code: "unauthorized" });

    const done = await orch.applyTakeStatus(take, mapRunPodStatus({
      id: take.requestId!, status: "COMPLETED", executionTime: 42_000,
      output: { url: "https://r2/take.mp4", last_frame_url: "https://r2/take.last.png", thumb_urls: ["https://r2/t0.jpg"], execution_ms: 42_000 },
    }));
    expect(done.status).toBe("completed");
    expect(done.costUsd).toBeCloseTo(42 * 0.0012, 3);
    expect((await repo.getProject(projectId)).spentUsd).toBeCloseTo(42 * 0.0012, 3);
    expect((await repo.listAssets(projectId, "video")).some((a) => a.url === "https://r2/take.mp4")).toBe(true);

    await orch.selectTake(shotId, done.id);
    const timeline = await orch.autoTimeline(projectId);
    expect(timeline.clips).toHaveLength(1);
    expect(timeline.clips[0]!.takeId).toBe(done.id);

    nextStatus = { id: "x", status: "IN_PROGRESS" };
    const { job } = await orch.createExportJob(projectId, { preset: "master-768p", burnInSubtitles: false, confirm: true }, mcp);
    expect(job.status).toBe("queued");
    const asm = runpodCalls.filter((c) => c.url.includes("/asm/run")).pop()!.body as { input: { clips: unknown[]; subtitles: { srt: string }; output: { key: string } } };
    expect(asm.input.clips).toHaveLength(1);
    expect(asm.input.output.key).toContain(`/exports/${job.id}.master-768p.mp4`);
  });

  it("continuous shots take the previous shot's last frame", async () => {
    const scene = (await repo.listScenes(projectId))[0]!;
    const next = await orch.addShot(scene.id, shot({ mode: "keyframe", linkToPrev: "continuous", intent: "Mara keeps running" }));
    const order = (await repo.listSceneShots(scene.id)).map((s) => s.id);
    await repo.reorderShots(scene.id, [shotId, next.id, ...order.filter((id) => id !== shotId && id !== next.id)]);
    const compiled = await orch.compileForShot(next.id);
    expect(compiled.workflow).toBe("I2VA");
    expect(compiled.input.images[0]).toEqual({ url: "https://r2/take.last.png", role: "first_frame" });
  });

  it("edit mode compiles against the source take", async () => {
    const take = (await repo.listShotTakes(shotId)).find((t) => t.status === "completed")!;
    const scene = (await repo.listScenes(projectId))[0]!;
    const edit = await orch.addShot(scene.id, shot({ mode: "edit", sourceTakeId: take.id, editInstruction: "Remove the parked car on the left; keep everything else." }));
    const compiled = await orch.compileForShot(edit.id);
    expect(compiled.input.video).toBe("https://r2/take.mp4");
    expect(compiled.prompt).toContain("EDIT\nRemove the parked car");
    expect(compiled.prompt).toContain("Video 1: the source take");
    expect(compiled.prompt).not.toContain("TIMELINE");
  });

  it("sweep marks stale takes as timed out", async () => {
    const take = (await repo.listShotTakes(shotId)).find((t) => t.status === "queued")!;
    nextStatus = { id: take.requestId, status: "IN_PROGRESS" };
    const r1 = await orch.sweep();
    expect((await repo.getTake(take.id)).status).toBe("running");
    expect(r1.takes).toBe(1);
    nextStatus = { id: take.requestId, status: "FAILED", error: "CUDA OOM", executionTime: 5000 };
    await orch.sweep();
    const failed = await repo.getTake(take.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("CUDA OOM");
  });

  it("compileShot drops references past the budget with a warning", () => {
    const elements = new Map();
    const assets = new Map();
    for (let i = 0; i < 4; i++) {
      elements.set(`e${i}`, { id: `e${i}`, projectId: "p", kind: "prop", name: `Prop ${i}`, description: "", refAssetIds: [`a${i}`], createdAt: 0, updatedAt: 0 });
      assets.set(`a${i}`, { id: `a${i}`, projectId: "p", url: `https://r2/a${i}.png`, kind: "image", source: "upload", meta: {}, createdAt: 0 });
    }
    const spec = shot({ mode: "reference", props: ["e0", "e1", "e2"], characters: ["e3"] });
    const job = compileShot({
      shot: { id: "s", projectId: "p", sceneId: "c", index: 0, spec, createdAt: 0, updatedAt: 0 },
      look: { genre: "", palette: "", camera: "", lens: "", lighting: "", aspectRatio: "9:16", resolution: "768p", upscale: false, negative: [] },
      elements, assets,
    });
    expect(job.input.images).toHaveLength(3);
    expect(job.warnings[0]).toContain("dropped");
    expect(job.input.video_size).toBe("768x1344");
  });
});
