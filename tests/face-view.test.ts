import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { compileShot, faceRef, pickRefForViews, preferredViews } from "@/studio/compiler";
import * as imaging from "@/studio/imaging";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { LookSettings, MAX_ELEMENT_REFS, REF_VIEWS, ShotInput, ShotlistInput } from "@/studio/schemas";
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
    expect(MAX_ELEMENT_REFS).toBe(REF_VIEWS.length);
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
    /* no tagged match: a figure, not the head alone, even when the portrait was drawn first */
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

describe("the portrait is the identity the other pictures are drawn from", () => {
  let projectId = "";
  let mia = "";
  let shotId = "";
  const jobOf = async (id: string) => (await repo.getJob(id)).input as { prompt: string; refUrls?: string[]; size: string };
  const give = async (view: "face" | "front", url: string) => {
    const asset = await repo.createAsset({ projectId, url, kind: "image", source: "generated", width: 1024, height: 1024 });
    const cur = await repo.getElement(mia);
    await repo.updateElement(mia, { refAssetIds: [...cur.refAssetIds, asset.id], refViews: { [asset.id]: view } });
    return asset;
  };

  beforeAll(async () => {
    const p = await repo.createProject({ name: "Portrait", budgetCapUsd: 20 });
    projectId = p.id;
    await repo.approveScript((await repo.createScript(projectId, "INT. HALL - DAY")).id);
    mia = (await repo.createElement(projectId, { kind: "character", name: "Mia", description: "a courier in a yellow raincoat", fixedFeatures: [{ feature: "a scar", where: "left cheek" }, { feature: "a round patch", where: "his own right upper arm" }] })).id;
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "hall", shots: [shot({ characters: [mia], cinematography: { size: "ms" } as never })] }] }));
    shotId = (await repo.listShots(projectId))[0]!.id;
    await imaging.setImaging(projectId, { enabled: true, maxImages: 60 }, web);
  });

  it("plans a portrait for every character", async () => {
    const plan = imaging.planFrames(await orch.getProjectView(projectId));
    expect(plan.elements.find((e) => e.elementId === mia)?.views).toEqual(expect.arrayContaining(["face", "front"]));
  });

  it("a new character's sheet starts with the portrait, square, with only the features a head shows", async () => {
    const sheet = await imaging.generateElementSheet(mia, [], mcp);
    expect(sheet.queued.map((q) => q.view)).toEqual(["face"]);
    expect(sheet.later).toEqual(["front", "side", "back", "expression"]);
    const job = await jobOf(sheet.queued[0]!.jobId);
    expect(job.size).toBe("1024x1024");
    expect(job.prompt).toContain("a head-and-shoulders portrait, facing the camera straight on");
    expect(job.prompt).toContain("Always, where it falls inside this head-and-shoulders frame");
    expect(job.prompt).toContain("a scar on the left cheek — their OWN left");
    expect(job.prompt).toContain("Exactly one person;");
    expect(job.refUrls ?? []).toEqual([]);
  });

  it("then the front figure from the portrait, then the rest from both", async () => {
    await give("face", "https://r2/mia-face.png");
    const second = await imaging.generateElementSheet(mia, [], mcp);
    expect(second.queued.map((q) => q.view)).toEqual(["front"]);
    expect(second.later).toEqual(["side", "back", "expression"]);
    const front = await jobOf(second.queued[0]!.jobId);
    expect(front.refUrls).toEqual(["https://r2/mia-face.png"]);
    expect(front.size).toBe("1008x1344");
    expect(front.prompt).toContain("Picture 1 is Mia's face, large: copy exactly the face");
    expect(front.prompt).not.toContain("where it falls inside this head-and-shoulders frame");

    await give("front", "https://r2/mia-front.png");
    const third = await imaging.generateElementSheet(mia, ["side", "back"], mcp);
    expect(third.queued.map((q) => q.view)).toEqual(["side", "back"]);
    const side = await jobOf(third.queued[0]!.jobId);
    expect(side.refUrls).toEqual(["https://r2/mia-face.png", "https://r2/mia-front.png"]);
    expect(side.prompt).toContain("Picture 1 is Mia's face, large");
    expect(side.prompt).toContain("Picture 2 is Mia, whole: copy exactly the build, age, clothes, colours and props; the face is the one in Picture 1.");
    /* a back view shows no face: the figure alone */
    const back = await jobOf(third.queued[1]!.jobId);
    expect(back.refUrls).toEqual(["https://r2/mia-front.png"]);
    expect(back.prompt).toContain("Picture 1 is Mia: copy exactly the face, hair, build");
  });

  it("a shot frame takes the figure and the portrait of each character", async () => {
    const r = await imaging.generateShotFrame(shotId, "first", mcp);
    expect(r.method).toBe("new");
    const job = await jobOf(r.job!.id);
    expect(job.refUrls).toEqual(["https://r2/mia-front.png", "https://r2/mia-face.png"]);
    expect(r.prompt).toContain("Picture 1 is Mia: copy exactly their face, hair, build, age, clothes and colours");
    expect(r.prompt).toContain("Picture 2 is Mia's face, large: the same person — copy exactly the face");
    expect(r.prompt).toContain("take nothing else from it, not its framing, its neutral expression or its light");
  });

  it("an older character with figures only gets its portrait drawn from them; a prop has no face", async () => {
    const old = (await repo.createElement(projectId, { kind: "character", name: "Ola", description: "a clerk" })).id;
    const front = await repo.createAsset({ projectId, url: "https://r2/ola-front.png", kind: "image", source: "generated" });
    await repo.updateElement(old, { refAssetIds: [front.id], refViews: { [front.id]: "front" } });
    const r = await imaging.generateElementView(old, "face", mcp);
    const job = await jobOf(r.job.id);
    expect(job.refUrls).toEqual(["https://r2/ola-front.png"]);
    expect(job.prompt).toContain("Picture 1 is Ola: copy exactly the face, hair, build");
    const prop = (await repo.createElement(projectId, { kind: "prop", name: "Letter", description: "a folded letter" })).id;
    await expect(imaging.generateElementView(prop, "face", mcp)).rejects.toMatchObject({ code: "validation" });
    /* a prop's sheet is still one front picture */
    expect((await imaging.generateElementSheet(prop, [], mcp)).queued.map((q) => q.view)).toEqual(["front"]);
  });
});
