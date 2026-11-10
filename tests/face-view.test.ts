import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { compileShot, faceRef, pickRefForViews, preferredViews } from "@/studio/compiler";
import * as imaging from "@/studio/imaging";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ElementPatch, LookSettings, LoraPatch, MAX_DETAILS, MAX_ELEMENT_REFS, REF_VIEWS, ShotInput, ShotPatch, ShotlistInput, VoiceCardPatch } from "@/studio/schemas";
import { detailTargets, missingDetails, sheetStage } from "@/studio/sheet";
import type { Actor, Asset, Element, Shot } from "@/studio/types";

/* The face view: one head-and-shoulders portrait per character. Every other
   view is a whole figure, where the face is a small part of the picture, or a
   grid of four; the portrait is what pictures copy the face from, and the
   reference a close-up gives the video model. */

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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return /\.(png|jpg)(\?|$)/.test(url) ? new Response(PNG, { status: 200 }) : new Response("{}", { status: 200 });
  }) as typeof fetch;
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({ durationS: 5, mode: "keyframe", intent: "Mia looks up", beats: [{ from: 0, to: 5, action: "Mia looks up from the letter and smiles" }], camera: { move: "static" }, motion: ["subject"], ...over });

const el = (over: Partial<Element>): Element => ({ id: "ele_m", projectId: "p", kind: "character", name: "Mia", description: "a courier", refAssetIds: [], fixedFeatures: [], refViews: {}, createdAt: 0, updatedAt: 0, ...over }) as Element;

describe("which reference a shot takes", () => {
  it("lists the face first among the views", () => {
    expect(REF_VIEWS[0]).toBe("face");
    /* one per view, and up to three details */
    expect(MAX_ELEMENT_REFS).toBe(REF_VIEWS.length - 1 + MAX_DETAILS);
  });

  it("a close-up takes the portrait; wider shots keep the figure", () => {
    const mia = el({ refAssetIds: ["f", "fr", "ex", "fb"], refViews: { f: "face", fr: "front", ex: "expression", fb: "full_body" } });
    const size = (s: string) => preferredViews(shot({ cinematography: { size: s } as never }));
    expect(pickRefForViews(mia, size("cu"))).toBe("f");
    expect(pickRefForViews(mia, size("ecu"))).toBe("f");
    expect(pickRefForViews(mia, size("ms"))).toBe("fr");
    expect(pickRefForViews(mia, size("ls"))).toBe("fb");
    /* without a portrait a close-up still gets what it got before */
    expect(pickRefForViews(el({ refAssetIds: ["fr", "ex"], refViews: { fr: "front", ex: "expression" } }), size("cu"))).toBe("ex");
    /* no tagged match: a whole figure — never the expression grid or a detail — then the portrait */
    expect(pickRefForViews(el({ refAssetIds: ["f", "ex", "d", "fr"], refViews: { f: "face", ex: "expression", d: "detail", fr: "front" } }), ["side"])).toBe("fr");
    expect(pickRefForViews(el({ refAssetIds: ["ex", "d", "f"], refViews: { ex: "expression", d: "detail", f: "face" } }), ["side"])).toBe("f");
    expect(pickRefForViews(el({ refAssetIds: ["f", "x"], refViews: { f: "face" } }), ["side"])).toBe("x");
    expect(pickRefForViews(el({ refAssetIds: ["f"], refViews: { f: "face" } }), ["side"])).toBe("f");
    expect(faceRef(mia)).toBe("f");
    expect(faceRef(el({ refAssetIds: ["fr"], refViews: { fr: "front" } }))).toBeUndefined();
  });

  it("R2VA says what a portrait is for: identity, not framing", () => {
    const mia = el({ refAssetIds: ["ast_f", "ast_fr"], refViews: { ast_f: "face", ast_fr: "front" } });
    const assets = new Map<string, Asset>([["ast_f", { id: "ast_f", url: "https://r2/mia-face.png", kind: "image" } as Asset], ["ast_fr", { id: "ast_fr", url: "https://r2/mia-front.png", kind: "image" } as Asset]]);
    const look = LookSettings.parse({ genre: "drama", palette: "", camera: "", lens: "", lighting: "" });
    const compile = (size: string, format?: string) => compileShot({
      shot: { id: "sht_1", projectId: "p", sceneId: "s", index: 0, spec: shot({ mode: "reference", characters: [mia.id], cinematography: { size } as never }) } as unknown as Shot,
      project: { id: "p", look } as never, elements: new Map([[mia.id, mia]]), assets, look, ...(format ? { format } : {}),
    } as never);
    const close = compile("cu");
    expect(close.workflow).toBe("R2VA");
    expect(close.input.images).toEqual([{ url: "https://r2/mia-face.png", role: "reference", label: "Mia" }]);
    expect(close.prompt).toContain("Image 1: Mia, the character. Keep face and hair exactly. The reference is a portrait: it gives the identity only, not this shot's framing, expression or light.");
    const medium = compile("ms");
    expect(medium.input.images).toEqual([{ url: "https://r2/mia-front.png", role: "reference", label: "Mia" }]);
    expect(medium.prompt).toContain("Image 1: Mia, the character. Keep face, hair and wardrobe exactly.");
    /* the turbo LoRA's own format keeps its two lines per subject */
    const native = compile("cu", "lightx2v").prompt;
    expect(native).toContain("<Subject 1> is Mia in the first reference image, the character. Keep face and hair exactly. The reference is a portrait");
    expect(native).toContain("<Subject 1> (appears in [Shot 1]): fully_preserved - face and hair exactly are retained.");
  });
});

describe("a character's sheet is drawn in the order identity is built", () => {
  let projectId = "";
  let mia = "";
  let shotId = "";
  const jobOf = async (id: string) => (await repo.getJob(id)).input as { prompt: string; refUrls?: string[]; size: string };
  /* a picture arriving on the element, as the painter's answer attaches it */
  const give = async (view: "face" | "expression" | "detail" | "front" | "side", url: string, feature?: string) => {
    const asset = await repo.createAsset({ projectId, url, kind: "image", source: "generated", width: 1024, height: 1024 });
    await repo.attachElementRef(mia, asset.id, { view, feature });
    return asset;
  };

  beforeAll(async () => {
    const p = await repo.createProject({ name: "Portrait", budgetCapUsd: 20 });
    projectId = p.id;
    await repo.approveScript((await repo.createScript(projectId, "INT. HALL - DAY")).id);
    mia = (await repo.createElement(projectId, { kind: "character", name: "Mia", description: "a courier in a yellow raincoat", fixedFeatures: [
      { feature: "a scar", where: "left cheek" },
      { feature: "a round patch", where: "her own right upper arm" },
      { feature: "the number 7", where: "the back of the raincoat" },
    ] })).id;
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "hall", shots: [shot({ characters: [mia], cinematography: { size: "ms" } as never }), shot({ characters: [mia], cinematography: { size: "cu" } as never, intent: "Close on Mia" })] }] }));
    shotId = (await repo.listShots(projectId))[0]!.id;
    await imaging.setImaging(projectId, { enabled: true, maxImages: 80 }, web);
  });

  it("details are the fixed features off the face, three at most, or the ones marked", async () => {
    const m = await repo.getElement(mia);
    expect(detailTargets(m).map((f) => f.feature)).toEqual(["a round patch", "the number 7"]);
    const many = el({ fixedFeatures: ["a", "b", "c", "d"].map((x) => ({ feature: x, where: "left hand" })) });
    expect(detailTargets(many)).toHaveLength(MAX_DETAILS);
    /* a mark wins over the guess, and false keeps one out */
    expect(detailTargets(el({ fixedFeatures: [{ feature: "ring", where: "left hand" }, { feature: "glass eye", where: "left eye", detail: true }] })).map((f) => f.feature)).toEqual(["glass eye"]);
    expect(detailTargets(el({ fixedFeatures: [{ feature: "ring", where: "left hand", detail: false }, { feature: "watch", where: "right wrist" }] })).map((f) => f.feature)).toEqual(["watch"]);
    expect(detailTargets(el({ kind: "prop", fixedFeatures: [{ feature: "dent", where: "left side" }] }))).toEqual([]);
  });

  it("plans the sheet per character: portrait, expressions, details, figure", async () => {
    const need = imaging.planFrames(await orch.getProjectView(projectId)).elements.find((e) => e.elementId === mia)!;
    expect(need.views).toEqual(["face", "expression", "detail", "front"]);
    expect(need.details).toEqual(["a round patch", "the number 7"]);
    expect(need.stage).toBe("face");
  });

  it("stage 1: the portrait alone, square, with only the features a head shows", async () => {
    const sheet = await imaging.generateElementSheet(mia, [], mcp);
    expect(sheet.stage).toBe("face");
    expect(sheet.queued.map((q) => q.view)).toEqual(["face"]);
    expect(sheet.later).toEqual(["expression", "detail", "front", "side", "back"]);
    expect(sheet.next).toContain("show it to the user before going on");
    const job = await jobOf(sheet.queued[0]!.jobId);
    expect(job.size).toBe("1024x1024");
    expect(job.prompt).toContain("a head-and-shoulders portrait, facing the camera straight on");
    expect(job.prompt).toContain("Always, where it falls inside this head-and-shoulders frame");
    expect(job.refUrls ?? []).toEqual([]);
  });

  it("stage 2: expressions from the portrait alone, and one close picture per detail", async () => {
    await give("face", "https://r2/mia-face.png");
    const sheet = await imaging.generateElementSheet(mia, [], mcp);
    expect(sheet.stage).toBe("expression and details");
    expect(sheet.queued.map((q) => [q.view, q.feature])).toEqual([["expression", undefined], ["detail", "a round patch"], ["detail", "the number 7"]]);
    expect(sheet.later).toEqual(["front", "side", "back"]);
    const expr = await jobOf(sheet.queued[0]!.jobId);
    expect(expr.refUrls).toEqual(["https://r2/mia-face.png"]);
    expect(expr.prompt).toContain("Picture 1 is Mia's face, large: copy exactly the face");
    expect(expr.prompt).toContain("the same identity in all four, only the expression changes");
    const patch = await jobOf(sheet.queued[1]!.jobId);
    expect(patch.size).toBe("1024x1024");
    expect(patch.refUrls).toEqual(["https://r2/mia-face.png"]);
    expect(patch.prompt).toContain("A single close picture of one detail of a film character");
    expect(patch.prompt).toContain("DETAIL: a round patch on her own right upper arm — their OWN right; never mirrored.");
    expect(patch.prompt).toContain("take only the skin tone, the hair colour and the rendering from it. The face itself is not in this picture.");
    expect(patch.prompt).toContain("lettering only where the detail itself is lettering");
    /* a detail is checked as a detail, not as a whole figure on an empty backdrop */
    expect((await repo.getJob(sheet.queued[1]!.jobId)).input.check).toMatchObject({ kind: "element_detail" });
    expect((await repo.getJob(sheet.queued[0]!.jobId)).input.check).toMatchObject({ kind: "element_sheet" });
    /* the attach carries the feature, so the picture is bound to it when it lands */
    expect((await repo.getJob(sheet.queued[2]!.jobId)).input.attach).toMatchObject({ elementRef: { elementId: mia, view: "detail", feature: "the number 7" } });
  });

  it("stage 3: the front figure from the portrait and the details — never the expression grid", async () => {
    await give("expression", "https://r2/mia-expr.png");
    await give("detail", "https://r2/mia-patch.png", "a round patch");
    /* one detail still missing: the stage does not move on */
    const waiting = await imaging.generateElementSheet(mia, [], mcp);
    expect(waiting.stage).toBe("expression and details");
    expect(waiting.queued.map((q) => q.feature)).toEqual(["the number 7"]);
    await give("detail", "https://r2/mia-seven.png", "the number 7");
    expect(missingDetails(await repo.getElement(mia))).toEqual([]);

    const sheet = await imaging.generateElementSheet(mia, [], mcp);
    expect(sheet.stage).toBe("front");
    expect(sheet.queued.map((q) => q.view)).toEqual(["front"]);
    expect(sheet.later).toEqual(["side", "back"]);
    const front = await jobOf(sheet.queued[0]!.jobId);
    expect(front.size).toBe("1008x1344");
    expect(front.refUrls).toEqual(["https://r2/mia-face.png", "https://r2/mia-patch.png", "https://r2/mia-seven.png"]);
    expect(front.prompt).toContain("Picture 2 is a close detail of Mia: a round patch on her own right upper arm.");
    expect(front.prompt).toContain("Picture 3 is a close detail of Mia: the number 7 on the back of the raincoat.");
    expect(front.prompt).not.toContain("mia-expr");
  });

  it("stage 4: side and back from the portrait, the front and the details; then the sheet is complete", async () => {
    await give("front", "https://r2/mia-front.png");
    const sheet = await imaging.generateElementSheet(mia, [], mcp);
    expect(sheet.stage).toBe("other views");
    expect(sheet.queued.map((q) => q.view)).toEqual(["side", "back"]);
    const side = await jobOf(sheet.queued[0]!.jobId);
    expect(side.refUrls).toEqual(["https://r2/mia-face.png", "https://r2/mia-front.png", "https://r2/mia-patch.png", "https://r2/mia-seven.png"]);
    expect(side.prompt).toContain("Picture 2 is Mia, whole: copy exactly the build, age, clothes, colours and props; the face is the one in Picture 1.");
    /* a back view shows no face, and the detail on the back comes first */
    const back = await jobOf(sheet.queued[1]!.jobId);
    expect(back.refUrls).toEqual(["https://r2/mia-front.png", "https://r2/mia-seven.png", "https://r2/mia-patch.png"]);
    expect(back.prompt).toContain("Picture 1 is Mia: copy exactly the face, hair, build");

    await give("side", "https://r2/mia-side.png");
    const m = await repo.getElement(mia);
    await repo.attachElementRef(mia, (await repo.createAsset({ projectId, url: "https://r2/mia-back.png", kind: "image", source: "generated" })).id, { view: "back" });
    expect(m.refAssetIds).toHaveLength(6);
    expect(sheetStage(await repo.getElement(mia)).stage).toBe("complete");
    const done = await imaging.generateElementSheet(mia, [], mcp);
    expect(done.queued).toEqual([]);
    expect(done.stage).toBe("complete");
  });

  it("a redrawn view takes the old one's place; a detail replaces only its own feature; the portrait is never pushed out", async () => {
    const before = await repo.getElement(mia);
    const oldFront = before.refAssetIds.find((a) => before.refViews![a] === "front")!;
    const at = before.refAssetIds.indexOf(oldFront);
    const newer = await give("front", "https://r2/mia-front-2.png");
    const after = await repo.getElement(mia);
    expect(after.refAssetIds).toHaveLength(before.refAssetIds.length);
    expect(after.refAssetIds[at]).toBe(newer.id);
    expect(after.refAssetIds).not.toContain(oldFront);
    expect(after.refViews![oldFront]).toBeUndefined();
    const seven = await give("detail", "https://r2/mia-seven-2.png", "the number 7");
    const m = await repo.getElement(mia);
    expect(m.refAssetIds.filter((a) => m.refViews![a] === "detail")).toHaveLength(2);
    expect(m.refFeatures![seven.id]).toBe("the number 7");
    expect(Object.values(m.refFeatures!).sort()).toEqual(["a round patch", "the number 7"]);
    /* untagged uploads over the limit go first; the portrait stays */
    for (let i = 0; i < MAX_ELEMENT_REFS; i++) await repo.attachElementRef(mia, (await repo.createAsset({ projectId, url: `https://r2/extra${i}.png`, kind: "image", source: "upload" })).id);
    const full = await repo.getElement(mia);
    expect(full.refAssetIds).toHaveLength(MAX_ELEMENT_REFS);
    expect(Object.values(full.refViews!).sort()).toEqual(["back", "detail", "detail", "expression", "face", "front", "side"]);
  });

  it("a shot frame takes the figure and the portrait; a close-up also the expressions, never as the figure", async () => {
    const medium = await imaging.generateShotFrame(shotId, "first", mcp);
    const job = await jobOf(medium.job!.id);
    expect(job.refUrls).toEqual(["https://r2/mia-front-2.png", "https://r2/mia-face.png"]);
    expect(medium.prompt).toContain("Picture 2 is Mia's face, large: the same person — copy exactly the face");
    const close = await imaging.generateShotFrame((await repo.listShots(projectId))[1]!.id, "first", mcp);
    const cu = await jobOf(close.job!.id);
    expect(cu.refUrls).toEqual(["https://r2/mia-front-2.png", "https://r2/mia-face.png", "https://r2/mia-expr.png"]);
    expect(close.prompt).toContain("Picture 3 shows Mia's face four times with four expressions: use it only to see how this one face looks when its expression changes. Draw Mia once");
  });

  it("an uploaded portrait is the face; an older character gets its portrait from its figure; a prop has neither", async () => {
    const ola = (await repo.createElement(projectId, { kind: "character", name: "Ola", description: "a clerk" })).id;
    const own = await repo.createAsset({ projectId, url: "https://r2/ola-own.png", kind: "image", source: "upload" });
    await repo.attachElementRef(ola, own.id, { view: "face" });
    /* no fixed features: no details, the expressions alone, then the figure */
    const second = await imaging.generateElementSheet(ola, [], mcp);
    expect(second.queued.map((q) => q.view)).toEqual(["expression"]);
    expect((await jobOf(second.queued[0]!.jobId)).refUrls).toEqual(["https://r2/ola-own.png"]);
    await expect(imaging.generateElementSheet(ola, ["detail"], mcp)).rejects.toMatchObject({ code: "validation" });

    const old = (await repo.createElement(projectId, { kind: "character", name: "Ben", description: "a guard" })).id;
    const front = await repo.createAsset({ projectId, url: "https://r2/ben-front.png", kind: "image", source: "generated" });
    await repo.attachElementRef(old, front.id, { view: "front" });
    const first = await imaging.generateElementSheet(old, [], mcp);
    expect(first.queued.map((q) => q.view)).toEqual(["face"]);
    const job = await jobOf(first.queued[0]!.jobId);
    expect(job.refUrls).toEqual(["https://r2/ben-front.png"]);
    expect(job.prompt).toContain("Picture 1 is Ben: copy exactly the face, hair, build");

    const prop = (await repo.createElement(projectId, { kind: "prop", name: "Letter", description: "a folded letter" })).id;
    await expect(imaging.generateElementView(prop, "face", mcp)).rejects.toMatchObject({ code: "validation" });
    await expect(imaging.generateElementView(prop, "detail", mcp)).rejects.toMatchObject({ code: "validation" });
    expect((await imaging.generateElementSheet(prop, [], mcp)).queued.map((q) => q.view)).toEqual(["front"]);
  });
});

describe("a patch changes only what it names", () => {
  it("the patch schemas fill nothing in", () => {
    expect(ElementPatch.parse({ name: "Mia" })).toEqual({ name: "Mia" });
    expect(ShotPatch.parse({ intent: "A new intent for it" })).toEqual({ intent: "A new intent for it" });
    expect(VoiceCardPatch.parse({ name: "v" })).toEqual({ name: "v" });
    expect(LoraPatch.parse({ notes: "n" })).toEqual({ notes: "n" });
    expect(ElementPatch.parse({})).toEqual({});
  });

  it("through the tools: update_element keeps the description, revise_shot keeps the cast, the sound and the lines", async () => {
    const { createStudioServer } = await import("@/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([createStudioServer(mcp).connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;

    const p = await repo.createProject({ name: "Patch" });
    const made = await call("create_element", { projectId: p.id, kind: "character", name: "Ines", description: "a diver with a shaved head" });
    const ines = made.element.id as string;
    const patched = await call("update_element", { elementId: ines, fixedFeatures: [{ feature: "an anchor tattoo", where: "left forearm", detail: true }] });
    expect(patched.element.description).toBe("a diver with a shaved head");
    expect(patched.element.fixedFeatures).toEqual([{ feature: "an anchor tattoo", where: "left forearm", detail: true }]);

    const prop = (await repo.createElement(p.id, { kind: "prop", name: "Mask", description: "a brass mask" })).id;
    await orch.saveShotlist(p.id, ShotlistInput.parse({ scenes: [{ slug: "dock", shots: [shot({
      characters: [ines], props: [prop], link: { type: "montage" },
      dialogue: [{ speaker: ines, text: "下去吧。", delivery: "flat", kind: "onscreen" }], sound: { sfx: ["a chain rattles"], ambience: "harbour wind", music: "N/A" },
    })] }] }));
    const sid = (await repo.listShots(p.id))[0]!.id;
    const before = (await repo.getShot(sid)).spec;
    const revised = (await call("revise_shot", { shotId: sid, patch: { intent: "Ines checks the mask and looks down" } })).shot.spec;
    expect(revised.intent).toBe("Ines checks the mask and looks down");
    expect(revised.characters).toEqual([ines]);
    expect(revised.props).toEqual([prop]);
    expect(revised.dialogue).toEqual(before.dialogue);
    expect(revised.sound).toEqual(before.sound);
    expect(revised.link).toEqual({ type: "montage" });

    /* the user's own portrait, tagged face, is the identity; a detail brought in is bound to its feature */
    const own = await repo.createAsset({ projectId: p.id, url: "https://r2/ines-face.png", kind: "image", source: "upload" });
    const tattoo = await repo.createAsset({ projectId: p.id, url: "https://r2/ines-tattoo.png", kind: "image", source: "upload" });
    const refs = await call("select_element_refs", { elementId: ines, assetIds: [own.id], views: { [own.id]: "face" } });
    expect(refs.element.refAssetIds).toEqual([own.id]);
    expect(sheetStage(await repo.getElement(ines))).toMatchObject({ stage: "expression and details", now: [{ view: "expression" }, { view: "detail", feature: "an anchor tattoo" }] });
    const both = await call("select_element_refs", { elementId: ines, assetIds: [own.id, tattoo.id], views: { [own.id]: "face", [tattoo.id]: "detail" }, features: { [tattoo.id]: "an anchor tattoo" } });
    expect(both.element.refFeatures).toEqual({ [tattoo.id]: "an anchor tattoo" });
    expect(sheetStage(await repo.getElement(ines)).now).toEqual([{ view: "expression" }]);
  });
});
