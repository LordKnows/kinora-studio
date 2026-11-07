import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as craft from "@/studio/craft";
import * as imaging from "@/studio/imaging";
import * as orch from "@/studio/orchestrator";
import * as painter from "@/studio/painter";
import * as pictures from "@/studio/pictures";
import { remakeFrames, remakePrompt, remakeTake } from "@/studio/remake";
import * as repo from "@/studio/repo";
import { ShotInput, ShotlistInput } from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* GPT Image and Viggle Remake in the Studio: the web-only switch, quota and
   stop, jobs drawn by painters (claim, upload, answer, lease) and what lands
   where, the picture plan, the prompts, the frame review, picture names, the
   Remake take, and the MCP tools. */

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

const posts: Array<{ url: string; body: { input: Record<string, unknown>; webhook?: string } }> = [];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 64, 0, 0, 3, 0]);

beforeAll(async () => {
  process.env.H3_PROMPT_FORMAT = "blocks";
  process.env.RUNPOD_MODE = "pod";
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_WORKER_TOKEN = "tok";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "studio";
  process.env.R2_ACCESS_KEY_ID = "a";
  process.env.R2_SECRET_ACCESS_KEY = "b";
  process.env.R2_PUBLIC_BASE_URL = "https://studio.example/media";
  setDb(await memoryDb());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === "POST" && (url.endsWith("/paint") || url.endsWith("/run"))) {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: `pod-${posts.length}`, status: "IN_QUEUE" }), { status: 200 });
    }
    if (url.includes("/status/")) return new Response(JSON.stringify({ id: "x", status: "IN_PROGRESS" }), { status: 200 });
    if (/\.(png|jpg)(\?|$)/.test(url) || url.includes("cloudflarestorage.com")) return new Response(PNG, { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await repo.insertGpuPod({ id: "pod1", name: "p", image: "img", status: "running", hostUrl: "https://pod1-8000.proxy.runpod.net", costPerHr: 1 });
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({ durationS: 5, mode: "keyframe", intent: "The courier crosses the square", beats: [{ from: 0, to: 5, action: "The courier walks toward frame right across the wet square" }], camera: { move: "static" }, motion: ["subject"], ...over });

describe("GPT Image switch and jobs", () => {
  let projectId = "";
  let shots: string[] = [];
  let mia = "";

  it("is off by default; only the web switches it", async () => {
    const p = await repo.createProject({ name: "Courier", budgetCapUsd: 20 });
    projectId = p.id;
    const sc = await repo.createScript(projectId, "EXT. SQUARE - DAY");
    await repo.approveScript(sc.id);
    mia = (await repo.createElement(projectId, { kind: "character", name: "Mia", description: "a courier in a yellow raincoat", fixedFeatures: [{ feature: "a scar", where: "left cheek" }] })).id;
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", palette: { colors: ["#1d2430", "#d9c7a3"] }, shots: [
      shot({ characters: [mia], blocking: [{ who: mia, from: "left", to: "right" }], composition: { subjectX: "left" } }),
      shot({ camera: { move: "push_in", amplitude: "moderate", speed: "slow" }, intent: "Push in on her face" }),
      shot({ mode: "keyframe", link: { type: "continuous" }, intent: "She keeps walking" }),
      shot({ mode: "reference", characters: [mia], intent: "Mia looks back" }),
      shot({ frames: { first: "Mia at the door", last: "Mia inside, door shut" }, intent: "She goes in" }),
      shot({ mode: "text", intent: "Empty square at dusk" }),
    ] }] }));
    shots = (await repo.listShots(projectId)).map((s) => s.id);
    await expect(imaging.generateShotFrame(shots[0]!, "first", mcp)).rejects.toMatchObject({ code: "forbidden" });
    await expect(imaging.setImaging(projectId, { enabled: true }, mcp)).rejects.toMatchObject({ code: "forbidden" });
    await imaging.setImaging(projectId, { enabled: true, maxImages: 3 }, web);
    expect(imaging.imagingSummary(await repo.getProject(projectId))).toMatchObject({ enabled: true, backend: "codex", leftImages: 3 });
  });

  it("plans pictures cheapest first", async () => {
    const plan = imaging.planFrames(await orch.getProjectView(projectId));
    const by = new Map(plan.shots.map((r) => [r.shotId, r]));
    expect(by.get(shots[0]!)).toMatchObject({ first: "new" });
    expect(by.get(shots[1]!)).toMatchObject({ first: "new", last: "crop_from_first" });
    expect(by.get(shots[2]!)).toMatchObject({ first: "anchor" });
    expect(by.get(shots[3]!)).toMatchObject({ first: "sheets" });
    expect(by.get(shots[4]!)).toMatchObject({ first: "edit_from_last", last: "new" });
    expect(by.get(shots[5]!)).toMatchObject({ first: "none" });
    expect(plan.shots[0]!.order).toBeLessThanOrEqual(plan.shots[plan.shots.length - 1]!.order);
    expect(plan.elements.find((e) => e.elementId === mia)?.views).toContain("front");
  });

  it("queues a first frame for a painter, which claims, uploads and answers", async () => {
    const r = await imaging.generateShotFrame(shots[0]!, "first", mcp);
    expect(r.method).toBe("new");
    expect(r.prompt).toContain("Mia is on the left of the frame");
    expect(r.prompt).toContain("left third");
    expect(r.prompt).toContain("#1d2430");
    expect(r.prompt).toContain("a scar on the left cheek — their OWN left");
    expect(r.prompt).toContain("PEOPLE: Exactly 1 person in the frame: Mia.");
    expect(r.runner).toContain("no painter is online");
    const before = posts.length;
    /* a painter that cannot draw with Codex (not logged in) does not get it */
    const idle = await painter.claim({ painterId: "box", name: "box", want: 2, info: { backends: [], ops: ["paint", "crop", "extract"] } });
    expect(idle.jobs).toEqual([]);
    const got = await painter.claim({ painterId: "box", name: "box", want: 2, info: { backends: ["codex"], ops: ["paint", "crop", "extract"] } });
    expect(got.jobs.map((j) => j.jobId)).toEqual([r.job!.id]);
    expect(got.jobs[0]!.input).toMatchObject({ op: "paint", backend: "codex", size: "1344x768", check: { review: true, redraws: 1, kind: "shot_first" }, output: { key: `projects/${projectId}/images/${r.job!.id}.png` } });
    expect(posts.length).toBe(before); /* nothing went to the GPU pod */
    /* only this job's keys can be signed, and only by the painter holding it */
    await expect(painter.uploadUrls(r.job!.id, "box", [`projects/${projectId}/images/other.png`])).rejects.toMatchObject({ code: "validation" });
    await expect(painter.uploadUrls(r.job!.id, "someone-else", [`projects/${projectId}/images/${r.job!.id}.png`])).rejects.toMatchObject({ code: "forbidden" });
    const ups = await painter.uploadUrls(r.job!.id, "box", [`projects/${projectId}/images/${r.job!.id}.png`]);
    expect(ups[0]!.putUrl).toContain("X-Amz-Signature");
    const done = await painter.finish(r.job!.id, "box", { output: { url: ups[0]!.publicUrl, preview_url: "https://studio.example/media/a.preview.jpg", width: 1344, height: 768, drawn: 2, checks: [{ id: "cropped", level: "warn", message: "4% cut" }], review: { verdict: "pass", findings: [] } } });
    expect(done.status).toBe("completed");
    const hero = await repo.getAsset((await repo.getShot(shots[0]!)).heroAssetId!);
    expect(hero.id).toBe(done.assetIds[0]);
    expect(hero.meta).toMatchObject({ painter: "box", autoReview: { verdict: "pass" }, review: "pending" });
    expect(hero.handle).toMatch(/^IMG-\d+$/);
    expect(hero.name).toBe("square #1 · first");
    /* the redraw counted: two pictures drawn */
    expect((await repo.getProject(projectId)).imaging!.usedImages).toBe(2);
  });

  it("crops a push-in's end frame without spending quota", async () => {
    await repo.updateShot(shots[1]!, { heroAssetId: (await repo.getShot(shots[0]!)).heroAssetId! });
    const r = await imaging.generateShotFrame(shots[1]!, "last", mcp);
    expect(r.method).toBe("crop_from_first");
    const got = await painter.claim({ painterId: "box", name: "box", want: 1, info: { backends: [], ops: ["paint", "crop", "extract"] } });
    expect(got.jobs[0]!.input).toMatchObject({ op: "crop" });
    expect(got.jobs[0]!.input.check).toBeUndefined();
    const key = `projects/${projectId}/images/${r.job!.id}.png`;
    await expect(painter.finish(r.job!.id, "box", { output: { url: "https://elsewhere.example/x.png" } })).resolves.toMatchObject({ status: "failed" });
    const r2 = await imaging.generateShotFrame(shots[1]!, "last", mcp);
    await painter.claim({ painterId: "box", name: "box", want: 1, info: { backends: [], ops: ["crop"] } });
    const done = await painter.finish(r2.job!.id, "box", { output: { url: `https://studio.example/media/projects/${projectId}/images/${r2.job!.id}.png`, width: 1344, height: 768 } });
    expect(key).toContain(r.job!.id);
    expect((await repo.getShot(shots[1]!)).endAssetId).toBe(done.assetIds[0]);
    expect((await repo.getProject(projectId)).imaging!.usedImages).toBe(2);
  });

  it("a painter that goes silent or forgets a job gives it back; three losses fail it", async () => {
    const p = await repo.createProject({ name: "Lease" });
    const job = await repo.createJob({ projectId: p.id, kind: "image", targetId: p.id, backend: "painter", input: { op: "extract", videoUrl: "https://x/v.mp4", frame: 3, size: "1344x768" } });
    const a = await painter.claim({ painterId: "a", name: "a", want: 4, info: { ops: ["extract"] } });
    expect(a.jobs.map((j) => j.jobId)).toContain(job.id);
    /* silent for longer than the lease: back in the queue */
    expect(await painter.sweepImageLeases(Date.now() + painter.LEASE_LOST_MS + 1000)).toBeGreaterThan(0);
    expect(await repo.getJob(job.id)).toMatchObject({ status: "queued", attempts: 1 });
    /* claimed again, then the painter restarts and no longer lists it */
    await painter.claim({ painterId: "b", name: "b", want: 4, info: { ops: ["extract"] } });
    await repo.updateJob(job.id, {});
    const db = (await import("@/db")).getDb;
    await (await db()).run("UPDATE jobs SET claimed_at = ? WHERE id = ?", [Date.now() - 120_000, job.id]);
    await painter.claim({ painterId: "b", name: "b", want: 0, info: { ops: ["extract"], running: [] } });
    expect(await repo.getJob(job.id)).toMatchObject({ status: "queued", attempts: 2 });
    await painter.claim({ painterId: "b", name: "b", want: 4, info: { ops: ["extract"] } });
    await painter.sweepImageLeases(Date.now() + painter.LEASE_LOST_MS + 1000);
    expect(await repo.getJob(job.id)).toMatchObject({ status: "failed" });
    expect((await repo.getJob(job.id)).error).toContain("given up after 3 tries");
  });

  it("the Machine page asks a painter to log in to Codex", async () => {
    const p = await painter.requestCodexLogin("box");
    expect(p.commands.map((c) => c.type)).toEqual(["codex_login"]);
    const next = await painter.claim({ painterId: "box", name: "box", want: 0, info: { backends: [] } });
    expect(next.commands.map((c) => c.type)).toEqual(["codex_login"]);
    expect((await repo.getPainter("box")).commands).toEqual([]);
    const listed = await painter.listPainters();
    expect(listed.find((x) => x.id === "box")?.online).toBe(true);
  });

  it("an element sheet starts with the front; quota and a quota error stop painting", async () => {
    const sheet = await imaging.generateElementSheet(mia, ["front", "side", "back"], mcp);
    expect(sheet.queued.map((q) => q.view)).toEqual(["front"]);
    expect(sheet.later).toEqual(["side", "back"]);
    const job = await repo.getJob(sheet.queued[0]!.jobId);
    expect(String(job.input.prompt)).toContain("front view");
    /* 2 drawn + the sheet's front running = 3 of 3 */
    await expect(imaging.generateStyleFrame(projectId, mcp)).rejects.toMatchObject({ code: "budget_exceeded" });
    await imaging.applyImageStatus(job, { state: "failed", error: "quota: codex: You've hit your usage limit" });
    expect((await repo.getProject(projectId)).imaging!.stoppedReason).toContain("usage limit");
    await imaging.setImaging(projectId, { enabled: true, maxImages: 10, clearStop: true }, web);
    expect((await repo.getProject(projectId)).imaging!.stoppedReason).toBeUndefined();
  });

  it("a frame review marks the picture", async () => {
    const hero = (await repo.getShot(shots[0]!)).heroAssetId!;
    const packet = await craft.reviewPacket(projectId, "frame", hero);
    expect(packet.reviewerPrompt).toContain("PASS or FAIL");
    await craft.recordReview(projectId, { stage: "frame", shotId: hero, verdict: "pass", reviewer: "fresh_agent", basis: "picture and sheet", findings: [] });
    expect((await repo.getAsset(hero)).meta.review).toBe("pass");
  });

  it("Remake: frames on the 17n+5 grid, a six-section prompt, a new take that asks first", async () => {
    expect(remakeFrames(5.17)).toBe(124);
    expect(remakeFrames(10.13)).toBe(243);
    expect(remakeFrames(15.1)).toBe(345);
    await repo.setShotlistApproval(projectId, "approved");
    const take = await repo.createTake({ projectId, shotId: shots[0]!, backend: "runpod", workflow: "I2VA", prompt: "p", input: { seconds: 5 } });
    await repo.updateTake(take.id, { status: "completed", resultUrl: "https://studio.example/media/t.mp4", outputSeconds: 5.17 });
    const key = await repo.createAsset({ projectId, url: "https://studio.example/media/k.png", kind: "image", source: "generated", meta: { frame: 12 } });
    const prompt = remakePrompt({ spec: (await repo.getShot(shots[0]!)).spec, elements: new Map(), mode: "edit", changes: [{ subject: "the courier's hat", target: "she wears a red beret in every frame, as in <Picture 1>" }], keyframes: [{ assetId: key.id, frame: 12 }], frames: 124 });
    for (const s of ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]) expect(prompt).toContain(s);
    expect(prompt).toContain("At 00:00.500 the scene matches <Picture 1>.");
    expect(prompt).toContain("<Subject 1> (appears in [Shot 1]): changed - she wears a red beret");
    await expect(remakeTake(take.id, { mode: "edit", keyframes: [{ assetId: key.id }], changes: [{ subject: "the hat", target: "a red beret throughout" }] }, mcp)).rejects.toMatchObject({ code: "needs_confirm" });
    const r = await remakeTake(take.id, { mode: "edit", keyframes: [{ assetId: key.id }], changes: [{ subject: "the hat", target: "a red beret throughout" }], confirm: true }, mcp);
    expect(r.take.workflow).toBe("REMAKE");
    expect(r.take.input).toMatchObject({ workflow: "REMAKE", mode: "edit", pins: [12], frames: 124, video: "https://studio.example/media/t.mp4" });
    expect(r.warnings[0]).toContain("frame review");
    expect(posts[posts.length - 1]!.url.endsWith("/run")).toBe(true);
  });
});

describe("picture names and batch delete", () => {
  it("numbers pictures per project, renames them and finds them by handle", async () => {
    const p = await repo.createProject({ name: "Names" });
    const other = await repo.createProject({ name: "Other" });
    const a = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/projects/n/a.png", kind: "image", source: "upload", meta: { key: "projects/n/a.png" } });
    const b = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/projects/n/b.png", kind: "image", source: "generated", meta: { label: "Mia · front" } });
    const v = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/v.mp4", kind: "video", source: "generated" });
    const c = await repo.createAsset({ projectId: other.id, url: "https://studio.example/media/projects/o/c.png", kind: "image", source: "upload" });
    expect([a.handle, b.handle, v.handle, c.handle]).toEqual(["IMG-1", "IMG-2", undefined, "IMG-1"]);
    expect(b.name).toBe("Mia · front");
    expect(await repo.resolveAssetRef(p.id, "IMG-2")).toBe(b.id);
    expect(await repo.resolveAssetRef(p.id, "img2")).toBe(b.id);
    expect(await repo.resolveAssetRef(p.id, "#1")).toBe(a.id);
    expect(await repo.resolveAssetRef(p.id, b.id)).toBe(b.id);
    await expect(repo.resolveAssetRef(p.id, "IMG-9")).rejects.toMatchObject({ code: "not_found" });
    expect((await pictures.renamePicture(p.id, "IMG-1", "  kitchen   wide v2 ")).name).toBe("kitchen wide v2");
    await expect(pictures.renamePicture(p.id, c.id, "x")).rejects.toMatchObject({ code: "validation" });
  });

  it("deletes a batch: in-use pictures ask first and come off their shots, elements and the Look", async () => {
    const p = await repo.createProject({ name: "Tidy" });
    const sc = await repo.createScript(p.id, "EXT. PIER - DAY");
    await repo.approveScript(sc.id);
    const mk = (n: string) => repo.createAsset({ projectId: p.id, url: `https://studio.example/media/projects/${p.id}/images/${n}.png`, kind: "image", source: "generated", meta: { previewUrl: `https://studio.example/media/projects/${p.id}/images/${n}.preview.jpg` } });
    const hero = await mk("hero");
    const sheet = await mk("sheet");
    const style = await mk("style");
    const draft = await mk("draft");
    const el = await repo.createElement(p.id, { kind: "character", name: "Ola", description: "a fisher", refAssetIds: [sheet.id], refViews: { [sheet.id]: "front" } });
    await orch.saveShotlist(p.id, ShotlistInput.parse({ scenes: [{ slug: "pier", shots: [shot({ characters: [el.id] })] }] }));
    const sh = (await repo.listShots(p.id))[0]!;
    await repo.updateShot(sh.id, { heroAssetId: hero.id });
    await repo.setProjectLook(p.id, { styleFrameAssetId: style.id });
    const deleted: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : undefined;
      if ((req?.method ?? init?.method) === "DELETE") {
        deleted.push(decodeURIComponent(new URL(req?.url ?? String(input)).pathname));
        return new Response(null, { status: 204 });
      }
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      /* the agent may only delete unused pictures */
      await expect(pictures.deletePictures(p.id, [hero.handle!, draft.handle!], mcp, { confirm: true, allowInUse: false })).rejects.toMatchObject({ code: "forbidden" });
      const unused = await pictures.deletePictures(p.id, [draft.handle!], mcp, { confirm: true, allowInUse: false });
      expect(unused.deleted.map((d) => d.handle)).toEqual([draft.handle]);
      expect(deleted.some((k) => k.endsWith("/draft.png")) && deleted.some((k) => k.endsWith("/draft.preview.jpg"))).toBe(true);
      /* the web: in-use ones ask first */
      await expect(pictures.deletePictures(p.id, [hero.id, sheet.id, style.id], web)).rejects.toMatchObject({ code: "needs_confirm" });
      const r = await pictures.deletePictures(p.id, [hero.id, sheet.id, style.id], web, { confirm: true });
      expect(r.deleted).toHaveLength(3);
      expect(r.detached.map((d) => d.kind).sort()).toEqual(["element_ref", "first_frame", "style_frame"]);
      expect((await repo.getShot(sh.id)).heroAssetId).toBeUndefined();
      expect((await repo.getElement(el.id)).refAssetIds).toEqual([]);
      expect((await repo.getElement(el.id)).refViews).toEqual({});
      expect((await repo.getProject(p.id)).look.styleFrameAssetId).toBeUndefined();
      await expect(repo.getAsset(hero.id)).rejects.toMatchObject({ code: "not_found" });
      /* handles are not reused */
      expect((await mk("next")).handle).toBe("IMG-5");
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("remote MCP image tools", () => {
  it("lists them, and view_frames returns pictures", async () => {
    const { createStudioServer } = await import("@/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createStudioServer(mcp);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["image_status", "plan_frames", "generate_element_sheet", "generate_shot_frame", "edit_frame", "extract_frame", "generate_style_frame", "get_image_job", "list_image_jobs", "view_frames", "remake_take", "derive_end_frame", "review_packet", "rename_picture", "delete_pictures"]) expect(names).toContain(n);
    const p = await repo.createProject({ name: "View" });
    const asset = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/projects/v/a.png", kind: "image", source: "generated", meta: { previewUrl: "https://studio.example/media/projects/v/a.preview.jpg" } });
    const res = await client.callTool({ name: "view_frames", arguments: { projectId: p.id, assetIds: [asset.id] } });
    const content = res.content as Array<{ type: string; mimeType?: string }>;
    expect(content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    const off = await client.callTool({ name: "generate_style_frame", arguments: { projectId: p.id } });
    expect(JSON.stringify(off.content)).toContain("GPT Image is off");
    await client.close();
  });
});
