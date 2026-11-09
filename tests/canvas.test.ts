import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { buildCanvasPrompt } from "@/studio/canvas-prompt";
import { CanvasCompose, composeCharacter, importReference } from "@/studio/canvas";
import * as imaging from "@/studio/imaging";
import { adultAllowed, getReference, listReferences as loadList, queryReferences, setAdultContent } from "@/studio/references";
import type { RefCostume, RefPortrait, RefPose } from "@/studio/references-model";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";

/* Canvas: the reference library (metadata only, pictures on their
   galleries), the 18+ gate (hidden until the user confirms on the web, for
   the agent too), the composed prompt, and compose / import going through
   the ordinary GPT Image job path. */

const web: Actor = { user: "canvas@local", via: "web" };
const agent: Actor = { user: "canvas@local", via: "mcp" };
const other: Actor = { user: "someone@else", via: "web" };

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

const fetched: string[] = [];
const lists = new Map<string, Awaited<ReturnType<typeof loadList>>>();
/* the catalog loads asynchronously; the tests read snapshots taken in beforeAll */
const listReferences = (kind: "pose" | "costume" | "portrait", adult: boolean) => lists.get(`${kind}:${adult}`)!;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 132, 0, 0, 4, 176, 8, 2, 0, 0, 0]);

beforeAll(async () => {
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "studio";
  process.env.R2_ACCESS_KEY_ID = "a";
  process.env.R2_SECRET_ACCESS_KEY = "b";
  process.env.R2_PUBLIC_BASE_URL = "https://studio.example/media";
  setDb(await memoryDb());
  for (const kind of ["pose", "costume", "portrait"] as const) for (const adult of [false, true]) lists.set(`${kind}:${adult}`, await loadList(kind, adult));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (/\.(png|jpg|webp)(\?|$)/.test(url) || url.includes("cloudflarestorage.com")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

describe("reference library", () => {
  it("ships metadata only, with gallery URLs, and hides 18+ items by default", () => {
    const poses = listReferences("pose", false);
    expect(poses.items.length + poses.hidden).toBe(1439);
    expect(poses.hidden).toBe(674);
    expect(poses.items.every((p) => !p.nsfw)).toBe(true);
    const all = listReferences("pose", true);
    expect(all.items).toHaveLength(1439);
    const p = all.items[0] as RefPose;
    expect(p.thumb).toBe(`https://ai-pose-gallery.pages.dev/thumbs/${p.id}.jpg`);
    expect(p.depthImage).toBe(`https://ai-pose-depth-gallery.pages.dev/img/${p.id}.png`);
    const costumes = listReferences("costume", false);
    expect(costumes.items.length + costumes.hidden).toBe(3224);
    expect(costumes.items.some((c) => (c as RefCostume).category === "内衣・睡衣")).toBe(false);
    const portraits = listReferences("portrait", false);
    expect(portraits.items).toHaveLength(1499);
    expect(portraits.hidden).toBe(0);
    expect((portraits.items[0] as RefPortrait).image).toMatch(/^https:\/\/ai-portrait-gallery\.pages\.dev\/img\/full\/.+\.png$/);
    const shisei = costumes.items.find((c) => (c as RefCostume).source === "shisei") as RefCostume;
    expect(shisei.views?.length).toBeGreaterThan(1);
    expect(shisei.image).toMatch(/^https:\/\/raw\.githubusercontent\.com\/wquguru\/shisei\/[0-9a-f]{40}\//);
  });

  it("searches Chinese names and tags, a page at a time", async () => {
    const r = await queryReferences({ kind: "costume", q: "牛仔", pageSize: 5 }, false);
    expect(r.total).toBeGreaterThan(5);
    expect((await queryReferences({ kind: "costume", q: "水手服" }, false)).items.every((x) => (x as RefCostume).name.includes("水手服") || (x as RefCostume).tags.includes("水手服"))).toBe(true);
    expect(r.items).toHaveLength(5);
    expect(r.items.every((x) => x.kind === "costume")).toBe(true);
    const sitting = await queryReferences({ kind: "pose", angle: "side", system: "standard" }, false);
    expect(sitting.items.every((x) => x.kind === "pose" && x.angle === "side" && x.system === "standard")).toBe(true);
    /* an 18+ system asked for without the gate: nothing comes back, and says how much is hidden */
    const hidden = await queryReferences({ kind: "pose", system: "couple" }, false);
    expect(hidden.total).toBe(0);
    expect(hidden.hidden).toBe(275);
  });

  it("answers forbidden for an 18+ item until unlocked", async () => {
    const nsfw = listReferences("pose", true).items.find((x) => x.nsfw)!;
    await expect(getReference(nsfw.id, false)).rejects.toMatchObject({ code: "forbidden" });
    expect((await getReference(nsfw.id, true)).id).toBe(nsfw.id);
    await expect(getReference("nope", true)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the 18+ switch", () => {
  it("is off by default, switched on the web only with the adult confirmation, per user", async () => {
    expect(await adultAllowed(web)).toBe(false);
    await expect(setAdultContent(agent, { enabled: true, confirmAdult: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setAdultContent(web, { enabled: true })).rejects.toMatchObject({ code: "validation" });
    expect((await setAdultContent(web, { enabled: true, confirmAdult: true })).adultContent).toBe(true);
    expect(await adultAllowed(web)).toBe(true);
    /* the director acting for the same user sees what the user unlocked; another user does not */
    expect(await adultAllowed(agent)).toBe(true);
    expect(await adultAllowed(other)).toBe(false);
    expect(await adultAllowed({ user: "mcp-static", via: "mcp" })).toBe(false);
    expect((await setAdultContent(web, { enabled: false })).adultContent).toBe(false);
    expect(await adultAllowed(web)).toBe(false);
  });
});

describe("the composed prompt", () => {
  let portrait: RefPortrait, costume: RefCostume, pose: RefPose;
  beforeAll(() => {
    portrait = listReferences("portrait", false).items.find((x) => (x as RefPortrait).hairstyle !== "标准基础款") as RefPortrait;
    costume = listReferences("costume", false).items.find((x) => (x as RefCostume).source === "gia") as RefCostume;
    pose = listReferences("pose", false).items.find((x) => (x as RefPose).angle === "diag") as RefPose;
  });

  it("names every picture by its place and gives it one job", () => {
    const text = buildCanvasPrompt({ portrait: { item: portrait }, costume: { item: costume }, pose: { item: pose }, style: "realistic" });
    expect(text).toContain("请根据提供的 3 张参考图");
    expect(text).toContain(`图1中的人物，保持其脸型、五官、发型（${portrait.title}）`);
    expect(text).toContain(`图2中展示的整套服装和配饰（参考名称：${costume.name}）`);
    expect(text).toContain(`图3中人体模型的动作和镜头角度摆姿势（${pose.name}，斜侧）`);
    expect(text).toContain("穿着图2的服装");
    expect(text).toContain("画面中的人物均为成年人");
    expect(text).toContain("真实人物照片");
  });

  it("draws a faceless figure without a portrait, says when the pose is a depth map, and adds the note", () => {
    const text = buildCanvasPrompt({ costume: { item: costume }, pose: { item: pose, depth: true }, style: "anime", note: "逆光" });
    expect(text).toContain("无脸展示");
    expect(text).toContain("灰度深度图");
    expect(text).toContain("• 补充要求：逆光");
    expect(text).toContain("人物穿搭展示图");
    expect(buildCanvasPrompt({})).toBe("");
  });
});

describe("compose and import", () => {
  let projectId = "";
  let elementId = "";
  const portrait = () => listReferences("portrait", false).items[3]!;
  const costume = () => listReferences("costume", false).items.find((x) => (x as RefCostume).source === "gia")!;
  const charadb = () => listReferences("costume", false).items.find((x) => (x as RefCostume).source === "charadb")!;
  const pose = () => listReferences("pose", false).items[0]!;

  it("needs GPT Image on, like every picture", async () => {
    projectId = (await repo.createProject({ name: "Canvas" })).id;
    elementId = (await repo.createElement(projectId, { kind: "character", name: "Mia", description: "" })).id;
    const input = CanvasCompose.parse({ portrait: { id: portrait().id } });
    await expect(composeCharacter(projectId, input, web)).rejects.toMatchObject({ code: "forbidden" });
    await imaging.setImaging(projectId, { enabled: true }, web);
  });

  it("queues a canvas job whose references are the galleries' own URLs, and lands on the element", async () => {
    const input = CanvasCompose.parse({ portrait: { id: portrait().id }, costume: { id: costume().id }, pose: { id: pose().id, depth: true }, attach: { elementId } });
    const r = await composeCharacter(projectId, input, web);
    const job = await repo.getJob(r.job.id);
    expect(job.kind).toBe("image");
    expect(job.input.purpose).toBe("canvas");
    expect(job.input.refUrls).toEqual([(portrait() as RefPortrait).image, (costume() as RefCostume).image, (pose() as RefPose).depthImage]);
    expect(String(job.input.prompt)).toContain("灰度深度图");
    expect(r.refs.map((x) => x.role)).toEqual(["portrait", "costume", "pose"]);
    /* nothing was fetched by the Studio: the painter downloads the references of the job */
    expect(fetched.filter((u) => u.includes("pages.dev"))).toEqual([]);
    const done = await imaging.applyImageStatus(job, { state: "completed", output: { url: `https://studio.example/media/projects/${projectId}/images/${job.id}.png`, width: 1024, height: 1536 } });
    const asset = await repo.getAsset(done.assetIds[0]!);
    expect(asset.meta.purpose).toBe("canvas");
    expect((asset.meta.canvas as { refs: unknown[] }).refs).toHaveLength(3);
    expect(asset.handle).toMatch(/^IMG-\d+$/);
    const el = await repo.getElement(elementId);
    expect(el.refAssetIds).toContain(asset.id);
    expect(el.refViews?.[asset.id]).toBe("full_body");
  });

  it("refuses 18+ references without the gate, CharaDB on an uploaded face, and more than five pictures", async () => {
    const nsfw = listReferences("pose", true).items.find((x) => x.nsfw)!;
    await expect(composeCharacter(projectId, CanvasCompose.parse({ pose: { id: nsfw.id } }), web)).rejects.toMatchObject({ code: "forbidden" });
    const upload = await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/face.png", kind: "image", source: "upload", meta: {}, name: "face" });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { assetId: upload.id }, costume: { id: charadb().id } }), web)).rejects.toMatchObject({ code: "validation" });
    const extras = Array.from({ length: 3 }, () => ({ assetId: upload.id }));
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: portrait().id }, costume: { id: costume().id }, pose: { id: pose().id }, extras }), web)).rejects.toMatchObject({ code: "validation" });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: costume().id } }), web)).rejects.toMatchObject({ code: "validation" });
    const elsewhere = await repo.createAsset({ projectId: (await repo.createProject({ name: "Other" })).id, url: "https://studio.example/media/uploads/u/x.png", kind: "image", source: "upload", meta: {} });
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { assetId: elsewhere.id } }), web)).rejects.toMatchObject({ code: "validation" });
  });

  it("imports one reference picture into the project, fetched once from its gallery", async () => {
    fetched.length = 0;
    const p = pose() as RefPose;
    const { asset } = await importReference(projectId, { id: p.id, depth: false, attach: { elementId, view: "detail" } }, web);
    /* one GET from the gallery; the other request is the PUT of the copy into our own R2 */
    expect(fetched.filter((u) => !u.includes("cloudflarestorage.com"))).toEqual([p.image]);
    expect(asset.projectId).toBe(projectId);
    expect(asset.meta.reference).toMatchObject({ id: p.id, kind: "pose" });
    expect((await repo.getElement(elementId)).refAssetIds).toContain(asset.id);
  });
});

describe("Canvas MCP tools", () => {
  it("lists references for the agent with the user's gate, and composes", async () => {
    const { createStudioServer } = await import("@/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createStudioServer({ user: "agent-user@local", via: "mcp" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_references", "get_reference", "compose_character"]) expect(names).toContain(n);
    const res = await client.callTool({ name: "list_references", arguments: { kind: "pose", system: "sensual" } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { adult: boolean; total: number; hidden: number };
    expect(body.adult).toBe(false);
    expect(body.total).toBe(0);
    expect(body.hidden).toBeGreaterThan(0);
    const p = await repo.createProject({ name: "Agent canvas" });
    const off = await client.callTool({ name: "compose_character", arguments: { projectId: p.id, pose: { id: listReferences("pose", false).items[0]!.id } } });
    expect(JSON.stringify(off.content)).toContain("image generation is off");
    await client.close();
  });
});
