import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as director from "@/director";
import { mapRunPodStatus } from "@/studio/backends/runpod";
import { compileShot, pickRefForViews, preferredViews } from "@/studio/compiler";
import * as craft from "@/studio/craft";
import { hashOf, renderHash } from "@/studio/craft-core";
import { imageInfo } from "@/studio/images";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotInput, ShotlistInput } from "@/studio/schemas";
import { contrastRatio, paletteRoles, sketchBoardSvg } from "@/studio/sketch";
import type { Actor, Element, Shot } from "@/studio/types";

/* The director's craft layer (after Eian Lu's Claude Code + Seedance
   workflow): staging fields and their prompt lines, the craft and fragility
   lint, cold-reader reviews gating the spend, the envelope, the timeline's
   hard cuts and handles, seams, the sketch board and image import. */

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

let calls = 0;
beforeAll(async () => {
  process.env.H3_PROMPT_FORMAT = "blocks";
  setDb(await memoryDb());
  process.env.RUNPOD_MODE = "serverless";
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_ENDPOINT_ID = "ep";
  process.env.RUNPOD_ASSEMBLER_ENDPOINT_ID = "asm";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls++;
    if (url.endsWith("/run")) return new Response(JSON.stringify({ id: `job-${calls}`, status: "IN_QUEUE" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 5, mode: "text", intent: "The courier crosses the square",
    beats: [{ from: 0, to: 5, action: "The courier walks toward frame right across the wet square" }],
    camera: { move: "static" }, motion: ["subject"], ...over,
  });

const list = (...shots: ShotInput[]) => ({ scenes: [{ slug: "square", shots }] }) as never;

describe("craft lint", () => {
  it("finds dead frames, loose directions, negations, unison and unlisted props", () => {
    const w = director.lintShotlist(list(
      shot({ motion: [], beats: [{ from: 0, to: 5, action: "The kettle does not pour while everyone turns to the left at the same time" }] }),
    ), { elements: [{ id: "k1", name: "kettle", kind: "prop" }] });
    const codes = w.map((x) => x.code);
    expect(codes).toContain("motion.dead");
    expect(codes).toContain("wording.direction");
    expect(codes).toContain("wording.negation");
    expect(codes).toContain("performance.simultaneous");
    expect(codes).toContain("props.unlisted");
  });

  it("keeps screen direction across the cut and an exit on the other side", () => {
    const a = shot({ characters: ["c1"], blocking: [{ who: "c1", from: "off_left", to: "off_right" }] });
    const b = shot({ characters: ["c1"], blocking: [{ who: "c1", from: "off_right", to: "left" }] });
    const codes = director.lintShotlist(list(a, b)).map((x) => x.code);
    expect(codes).toContain("blocking.axis");
    expect(codes).toContain("blocking.exit");
    const ok = director.lintShotlist(list(a, shot({ characters: ["c1"], blocking: [{ who: "c1", from: "off_left", to: "center" }] }))).map((x) => x.code);
    expect(ok).not.toContain("blocking.axis");
  });

  it("counts eye-level shots, runs of one size, missing frame plans and handles", () => {
    const eye = (size: string) => shot({ cinematography: { size, angle: "eye" } as never });
    const codes = director.lintShotlist(list(eye("ms"), eye("ms"), eye("ms"), eye("cu"), shot({ mode: "keyframe" }), shot({ screenS: 5 }))).map((x) => x.code);
    expect(codes).toContain("rhythm.eyelevel");
    expect(codes).toContain("rhythm.sizerun");
    expect(codes).toContain("frames.missing");
    expect(codes).toContain("duration.handles");
  });

  it("scores fragile pictures; cartoon wording only matters in animation", () => {
    const f = director.shotFragility(shot({ characters: ["a", "b", "c"], beats: [{ from: 0, to: 5, action: "She checks her reflection in the mirror then reads the sign then waves" }] }) as never);
    expect(f.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["mirror", "text", "chain", "crowd"]));
    const cartoon = shot({ beats: [{ from: 0, to: 5, action: "A cartoon cloud drifts over the roofs" }] });
    expect(director.lintShotlist(list(cartoon)).map((x) => x.code)).not.toContain("fragile.cartoon");
    expect(director.lintShotlist(list({ ...cartoon, cinematography: { animation: "flat2d" } } as ShotInput)).map((x) => x.code)).toContain("fragile.cartoon");
  });

  it("treatment: turns need a staggered reaction and a reason; fragile story text is flagged", () => {
    const base = {
      title: "T", style: "flat-explainer", totalSeconds: 20, logline: "A courier delivers the last letter of the day.",
      arc: { setup: "rain, one letter left", turn: "the wind takes it", ending: "it lands at the door" },
      candidates: [{ name: "a", shape: "linear chase through town" }, { name: "b", shape: "reverse order from the door" }, { name: "c", shape: "seen from the letter itself" }],
      chosen: "a", whyChosen: "simplest to read", benchmark: [{ work: "x", learn: "pacing", dontLearn: "characters" }],
      hook: { description: "the letter flies", atSecond: 1 }, endingEcho: "same door as the opening", signatureShot: "the letter crossing the square",
      nativeMove: "x", sequences: [{ name: "s1", seconds: 10, purpose: "set", pace: "slow" }, { name: "s2", seconds: 5, purpose: "chase", pace: "brisk" }, { name: "s3", seconds: 5, purpose: "end", pace: "still" }],
      soundDesign: [{ sequence: "s1", ambience: "rain", foley: "steps", music: "N/A" }, { sequence: "s2", ambience: "wind", foley: "paper", music: "N/A" }, { sequence: "s3", ambience: "rain", foley: "door", music: "N/A" }],
      turns: [{ problem: "the wind takes the letter", solution: "he chases it", reaction: "everyone in the café looks up at the same time" }],
    };
    const r = director.validateTreatment(base);
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("treatment.reaction");
    expect(codes).toContain("treatment.why");
    expect(director.validateTreatment({ ...base, logline: "She reads the sign in the mirror reflection." }).warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["treatment.fragile.mirror", "treatment.fragile.text"]));
    expect(director.treatmentToMarkdown(base as never)).toContain("## Turns");
  });
});

describe("compiler staging", () => {
  const el = (over: Partial<Element>): Element => ({ id: "c1", projectId: "p", kind: "character", name: "Mia", description: "a courier in a yellow raincoat", refAssetIds: [], createdAt: 0, updatedAt: 0, ...over });
  const asShot = (spec: ShotInput, over: Partial<Shot> = {}): Shot => ({ id: "s1", projectId: "p", sceneId: "sc", index: 0, spec, createdAt: 0, updatedAt: 0, ...over });
  const look = { genre: "", palette: "", camera: "", lens: "", lighting: "", aspectRatio: "16:9", resolution: "768p", upscale: false, negative: [], loras: [] } as never;

  it("writes blocking, composition, the scene palette and fixed features", () => {
    const spec = shot({ characters: ["c1"], blocking: [{ who: "c1", from: "off_left", to: "right", note: "steady walk" }], composition: { subjectX: "left", headroom: "normal" } });
    const job = compileShot({
      shot: asShot(spec), look, assets: new Map(),
      elements: new Map([["c1", el({ fixedFeatures: [{ feature: "a dragon tattoo", where: "left forearm" }] })]]),
      scene: { id: "sc", projectId: "p", index: 0, slug: "square", summary: "", palette: { colors: ["#1d2430", "#d9c7a3"], note: "red only on the scarf" }, createdAt: 0 },
    });
    expect(job.prompt).toContain("Mia enters from frame left, then moves to frame right (steady walk).");
    expect(job.prompt).toContain("about 38% from the left edge");
    expect(job.prompt).toContain("Scene palette #1d2430, #d9c7a3 — red only on the scarf");
    expect(job.prompt).toContain("Mia always has a dragon tattoo on the left forearm");
  });

  it("experiments change the prompt only when on", () => {
    const spec = shot({ mode: "keyframe", characters: ["c1"], frames: { first: "Mia at the left third, facing right" } });
    const assets = new Map([["h", { id: "h", projectId: "p", url: "https://r2/h.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }], ["e", { id: "e", projectId: "p", url: "https://r2/e.png", kind: "image" as const, source: "upload" as const, meta: {}, createdAt: 0 }]]);
    const ctx = { shot: asShot(spec, { heroAssetId: "h", endAssetId: "e" }), look, assets, elements: new Map([["c1", el({})]]) };
    const off = compileShot(ctx).prompt;
    const on = compileShot({ ...ctx, experiments: { frameHolds: true, restateFrame: true, positiveCast: true } }).prompt;
    expect(off).not.toContain("holds perfectly still");
    expect(on).toContain("0–0.2s: the picture holds perfectly still");
    expect(on).toContain("settles exactly on the final frame");
    expect(on).toContain("The first frame shows: Mia at the left third");
    expect(on).toContain("Only the people and objects already in the first frame appear");
  });

  it("picks the reference whose view matches the shot", () => {
    const e = el({ refAssetIds: ["front", "side", "expr"], refViews: { front: "front", side: "side", expr: "expression" } });
    expect(pickRefForViews(e, preferredViews(shot({ cinematography: { angle: "profile" } as never })))).toBe("side");
    expect(pickRefForViews(e, preferredViews(shot({ cinematography: { size: "cu" } as never })))).toBe("expr");
    expect(pickRefForViews(el({ refAssetIds: ["only"] }), ["side"])).toBe("only");
  });
});

describe("reviews, guards, envelope, timeline", () => {
  let projectId = "";
  let s1 = "";
  let s2 = "";

  it("sets up an approved project with a keyframe chain", async () => {
    const p = await repo.createProject({ name: "Courier", budgetCapUsd: 20, look: { aspectRatio: "16:9" } });
    projectId = p.id;
    const sc = await repo.createScript(projectId, "EXT. SQUARE - DAY\nThe courier crosses.");
    await repo.approveScript(sc.id);
    const hero = await repo.createAsset({ projectId, url: "https://r2/hero.png", kind: "image", source: "upload", width: 1344, height: 768 });
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", shots: [shot(), shot({ mode: "keyframe", link: { type: "continuous" }, intent: "He keeps walking" })] }] }));
    const shots = await repo.listShots(projectId);
    s1 = shots[0]!.id;
    s2 = shots[1]!.id;
    await repo.updateShot(s2, { heroAssetId: hero.id });
    await repo.setShotlistApproval(projectId, "approved");
  });

  it("asks for confirmation with the review state until the shot has a passing review", async () => {
    await expect(orch.createTakes(s1, { n: 1, confirm: false }, mcp)).rejects.toMatchObject({ code: "needs_confirm", details: { review: "none" } });
    const packet = await craft.reviewPacket(projectId, "shot", s1);
    expect(packet.reviewerPrompt).toContain("PASS or FAIL");
    expect(packet.reviewerPrompt).toContain("The courier walks toward frame right");
    const story = await craft.reviewPacket(projectId, "story");
    expect(story.reviewerPrompt).toContain("EXT. SQUARE");
    await craft.recordReview(projectId, { stage: "shot", shotId: s1, verdict: "pass", reviewer: "fresh_agent", basis: "prompt and spec", findings: [] });
    expect((await craft.reviewPacket(projectId, "shot", s1)).current).toBe("pass");
    /* a revision makes the review stale */
    await orch.patchShot(s1, { camera: { move: "static", amplitude: "moderate", speed: "slow", note: "hold on the fountain" } });
    expect((await craft.reviewPacket(projectId, "shot", s1)).current).toBe("stale");
    await craft.recordReview(projectId, { stage: "shot", shotId: s1, verdict: "pass", reviewer: "fresh_agent", basis: "prompt and spec", findings: [] });
  });

  it("the envelope is granted on the web only, then covers reviewed shots and logs the spend", async () => {
    await expect(craft.grantAutopilot(projectId, { envelopeUsd: 2 }, mcp)).rejects.toMatchObject({ code: "forbidden" });
    await craft.grantAutopilot(projectId, { envelopeUsd: 2, hours: 2 }, web);
    const { takes } = await orch.createTakes(s1, { n: 1, confirm: false }, mcp);
    expect(takes).toHaveLength(1);
    const p = await repo.getProject(projectId);
    expect(p.autopilot!.usedUsd).toBeGreaterThan(0);
    const decisions = await repo.listNotes(projectId, "decision");
    expect(decisions.some((d) => String(d.body.decision).startsWith("auto-confirmed"))).toBe(true);
  });

  it("warns, and the envelope refuses, when the same input already failed", async () => {
    const take = (await repo.listShotTakes(s1))[0]!;
    const done = await orch.applyTakeStatus(take, mapRunPodStatus({ id: take.requestId!, status: "COMPLETED", executionTime: 10_000, output: { url: "https://r2/t1.mp4", last_frame_url: "https://r2/t1.last.png", thumb_urls: [], execution_ms: 10_000, duration_s: 5.17 } }));
    await orch.reviewTake(done.id, 1, "walks the wrong way", web, { faults: ["wrong_direction"] });
    await expect(orch.reviewTake(done.id, 3, "fine", mcp, {})).rejects.toMatchObject({ code: "validation" });
    await expect(orch.createTakes(s1, { n: 1, confirm: false }, mcp)).rejects.toMatchObject({ code: "needs_confirm", details: { warnings: [expect.stringContaining("rejected take #1")] } });
  });

  it("auto timeline: hard cuts, a 2-frame head trim on frame-driven takes, muted audio from review", async () => {
    const t1 = (await repo.listShotTakes(s1))[0]!;
    await orch.selectTake(s1, t1.id);
    await orch.reviewTake(t1.id, 2, "wrong way, and the sound hums", web, { faults: ["wrong_direction"], audioOk: false });
    const { takes } = await orch.createTakes(s2, { n: 1, confirm: true }, mcp);
    const t2 = await orch.applyTakeStatus(takes[0]!, mapRunPodStatus({ id: takes[0]!.requestId!, status: "COMPLETED", executionTime: 10_000, output: { url: "https://r2/t2.mp4", last_frame_url: "https://r2/t2.last.png", thumb_urls: [], execution_ms: 10_000, duration_s: 5.17 } }));
    expect(t2.workflow).toBe("I2VA");
    const tl = await orch.autoTimeline(projectId);
    expect(tl.clips.map((c) => c.transition)).toEqual(["cut", "cut"]);
    expect(tl.clips[0]!.inS).toBe(0);
    expect(tl.clips[0]!.muteOwnAudio).toBe(true);
    expect(tl.clips[1]!.inS).toBeCloseTo(2 / 24, 3);
  });

  it("flags a seam whose anchor pick changed after the linked shot rendered", async () => {
    expect(await orch.checkSeams(projectId)).toHaveLength(0);
    const { takes } = await orch.createTakes(s1, { n: 1, confirm: true, seed: 99 }, mcp);
    const alt = await orch.applyTakeStatus(takes[0]!, mapRunPodStatus({ id: takes[0]!.requestId!, status: "COMPLETED", executionTime: 10_000, output: { url: "https://r2/t3.mp4", last_frame_url: "https://r2/t3.last.png", thumb_urls: [], execution_ms: 10_000 } }));
    await orch.selectTake(s1, alt.id);
    const seams = await orch.checkSeams(projectId);
    expect(seams.map((s) => s.code)).toContain("seam.anchor");
  });

  it("rough cut lists what is missing; the plan proposes a probe", async () => {
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", shots: [shot(), shot({ mode: "keyframe", link: { type: "continuous" }, intent: "He keeps walking" }), shot({ intent: "She reads the sign in the mirror", beats: [{ from: 0, to: 5, action: "She reads the sign in the mirror reflection" }] })] }] }));
    const rc = await orch.roughCut(projectId);
    expect(rc.missing.map((m) => m.shot)).toEqual(["square #3"]);
    const plan = await orch.planProjectBatch(projectId);
    expect(plan.probe.shotIds).toHaveLength(1);
    expect(plan.shots.find((x) => x.shotId === plan.probe.shotIds[0])!.fragile).toEqual(expect.arrayContaining(["mirror", "text"]));
  });

  it("requirements dedupe; the retro counts faults", async () => {
    const added = await craft.addRequirements(projectId, [{ text: "16:9, 30 seconds" }, { text: "16:9, 30 seconds" }, { text: "no dialogue" }]);
    expect(added).toHaveLength(2);
    const lint = await orch.lintProject(projectId);
    expect(lint.warnings.map((w) => w.code)).toContain("requirements.open");
    const retro = await craft.buildRetro(projectId);
    expect(retro).toContain("wrong_direction: 1");
    expect(retro).toContain("16:9, 30 seconds");
  });
});

describe("sketch, palette, images, hashes", () => {
  it("draws one card per shot and a grayscale version; flags a flat palette", async () => {
    const p = await repo.createProject({ name: "Sketch" });
    await orch.saveShotlist(p.id, ShotlistInput.parse({ scenes: [{ slug: "a", palette: { colors: ["#777777", "#7a7a7a"] }, shots: [shot({ cinematography: { size: "cu" } as never, composition: { subjectX: "right" } }), shot({ motion: [] })] }] }));
    const view = await orch.getProjectView(p.id);
    const svg = sketchBoardSvg(view);
    expect(svg.match(/<clipPath/g)).toHaveLength(2);
    expect(svg).toContain("dead frame");
    expect(sketchBoardSvg(view, { gray: true })).toContain('filter="url(#gray)"');
    expect(paletteRoles({ colors: ["#777777", "#7a7a7a"] }).ratio).toBeLessThan(2);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    const lint = await orch.lintProject(p.id);
    expect(lint.warnings.map((w) => w.code)).toContain("palette.contrast");
  });

  it("reads PNG and JPEG sizes from the header", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 5, 64], 16);
    png.set([0, 0, 3, 0], 20);
    expect(imageInfo(png)).toEqual({ type: "png", width: 1344, height: 768 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x05, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01]);
    expect(imageInfo(jpg)).toEqual({ type: "jpeg", width: 1344, height: 768 });
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("hashes are stable and order-sensitive", () => {
    expect(hashOf("abc")).toBe(hashOf("abc"));
    expect(renderHash("I2VA", "p", [{ url: "a", role: "first_frame" }])).not.toBe(renderHash("I2VA", "p", [{ url: "b", role: "first_frame" }]));
  });
});

describe("remote MCP", () => {
  it("serves the craft tools from the Studio connector", async () => {
    const { createStudioServer } = await import("@/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createStudioServer(mcp);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["review_packet", "record_review", "list_reviews", "add_requirements", "set_requirement", "list_requirements", "log_decision", "list_decisions", "get_autopilot", "review_take", "rough_cut", "check_seams", "sketch_board", "get_retro", "import_image", "request_upload", "commit_upload", "derive_end_frame", "set_scene_palette"]) {
      expect(names).toContain(n);
    }
    const p = await repo.createProject({ name: "MCP" });
    const res = await client.callTool({ name: "add_requirements", arguments: { projectId: p.id, items: [{ text: "30 seconds" }] } });
    expect(JSON.stringify(res.content)).toContain("30 seconds");
    const lint = await client.callTool({ name: "lint_shotlist", arguments: { shotlist: { scenes: [{ slug: "a", shots: [shot({ motion: [] })] }] } } });
    expect(JSON.stringify(lint.content)).toContain("motion.dead");
    await client.close();
  });
});
