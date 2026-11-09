import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { CanvasCompose, composeCharacter, importReference } from "@/studio/canvas";
import { checkOnArrival, describeVerdict, faceAllowed, faceVerdict, type FaceVerdict } from "@/studio/face-check";
import { faceLabel, pictureTag } from "@/studio/face-verdict";
import { importImageFromBase64 } from "@/studio/images";
import * as imaging from "@/studio/imaging";
import { firstRealIn } from "@/studio/provenance";
import { addMyReference, deleteMyReference, getReference, listMyReferences, listReferences, queryReferences, recheckMyReference, setAdultContent, updateMyReference } from "@/studio/references";
import { referenceName, type RefItem, type RefPose } from "@/studio/references-model";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";

/* An uploaded or imported face goes into 18+ work only when a vision model finds a 3D render or an
   illustration of an adult who is no real person (or no face at all); photographs, anything photorealistic,
   a likeness, a minor, an unsure or missing answer keep it out. The verdict is asked once and kept. */

const user: Actor = { user: "faces3d@local", via: "web" };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 132, 0, 0, 4, 176, 8, 2, 0, 0, 0]);
let answer: Record<string, unknown> | string = {};
let failWith = "";
const asked: Array<{ url: string; auth: string | null; body: { model: string; messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> } }> = [];

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
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "studio";
  process.env.R2_ACCESS_KEY_ID = "a";
  process.env.R2_SECRET_ACCESS_KEY = "b";
  process.env.R2_PUBLIC_BASE_URL = "https://studio.example/media";
  setDb(await memoryDb());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("cloudflarestorage.com")) {
      /* HEAD (an upload's commit) and PUT (an import) answer empty; GET answers the picture */
      if (init?.method === "HEAD" || init?.method === "PUT") return new Response(null, { status: 200 });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    /* our own media (a 我的 picture brought into a project is fetched by its URL) */
    if (url.startsWith("https://studio.example/media/") && url.endsWith(".png")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    if (url.endsWith("/chat/completions")) {
      asked.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      if (failWith) return new Response(failWith, { status: 500 });
      const content = typeof answer === "string" ? answer : JSON.stringify(answer);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.TOKENSAIL_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
});

const v = (o: Partial<FaceVerdict>): FaceVerdict => ({ kind: "render_3d", likeness: false, age: "adult", confidence: 0.9, reason: "", model: "m", at: 0, ...o });

describe("what the face check lets through", () => {
  it("a 3D render or an illustration of an adult who is no real person, or no face", () => {
    expect(faceAllowed(v({}))).toBe(true);
    expect(faceAllowed(v({ kind: "illustration" }))).toBe(true);
    expect(faceAllowed(v({ kind: "no_face", age: "unclear" }))).toBe(true);
    for (const bad of [v({ kind: "real_photo" }), v({ kind: "photoreal" }), v({ likeness: true }), v({ age: "minor" }), v({ age: "unclear" }), v({ confidence: 0.5 })]) {
      expect(faceAllowed(bad)).toBe(false);
    }
    expect(faceAllowed(undefined)).toBe(false);
    expect(describeVerdict(v({ kind: "real_photo" }))).toBe("face check: a photograph, an adult");
    expect(describeVerdict(undefined)).toBe("face not checked");
  });
});

describe("checking an uploaded face", () => {
  let projectId = "";
  const upload = (name: string) => repo.createAsset({ projectId, url: `https://studio.example/media/uploads/u/${name}.png`, kind: "image", source: "upload", meta: { key: `uploads/u/${name}.png` }, name });

  it("is not checked without a key: the upload is 真实", async () => {
    projectId = (await repo.createProject({ name: "Faces 3D" })).id;
    const a = await upload("no-key");
    expect(await faceVerdict(a)).toBeUndefined();
    expect(await firstRealIn(projectId, [a.url])).toBe(`${a.handle} (真实: face not checked)`);
    expect(asked).toEqual([]);
  });

  it("asks TokenSail's Qwen once with the picture inline, and keeps the verdict on the picture", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    answer = { kind: "render_3d", likeness: false, age: "adult", confidence: 0.93, reason: "a Blender character render" };
    const a = await checkOnArrival(await upload("blender"));
    expect(a.meta.realness).toBe("sim");
    expect(await firstRealIn(projectId, [a.url])).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("https://api.tokensail.ai/v1/chat/completions");
    expect(asked[0]!.auth).toBe("Bearer sk-tokensail-test");
    expect(asked[0]!.body.model).toBe("qwen3.8-max-0902");
    expect(asked[0]!.body.messages[0]!.content[0]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    expect(((await repo.getAsset(a.id)).meta.faceCheck as FaceVerdict).kind).toBe("render_3d");
    /* asked once: the kept verdict answers next time, and tracing a picture never asks */
    expect(await faceVerdict(await repo.getAsset(a.id))).toMatchObject({ kind: "render_3d" });
    expect(await firstRealIn(projectId, [(await upload("never-checked")).url])).toMatch(/真实/);
    expect(asked).toHaveLength(1);
  });

  it("keeps out a photograph, a likeness, a minor and an answer it cannot read", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    const cases: Array<[Record<string, unknown> | string, RegExp]> = [
      [{ kind: "real_photo", likeness: false, age: "adult", confidence: 0.95, reason: "a phone photo" }, /真实: a photograph, an adult/],
      [{ kind: "render_3d", likeness: true, age: "adult", confidence: 0.9, reason: "a famous actor in 3D" }, /a real person's likeness/],
      [{ kind: "illustration", likeness: false, age: "minor", confidence: 0.9, reason: "a child" }, /a minor/],
      ["I cannot help with that.", /真实: face not checked/],
    ];
    for (const [i, [a, why]] of cases.entries()) {
      answer = a;
      const pic = await checkOnArrival(await upload(`bad-${i}`));
      expect(pic.meta.realness).toBe("real");
      expect(await firstRealIn(projectId, [pic.url])).toMatch(why);
    }
  });

  it("lets a 3D face into an 18+ Canvas picture, and refuses a photographed one", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    await setAdultContent(user, { enabled: true, confirmAdult: true });
    await imaging.setImaging(projectId, { enabled: true }, user);
    const couple = (await listReferences("pose", true)).items.find((x) => (x as RefPose).system === "couple")!;
    answer = { kind: "render_3d", likeness: false, age: "adult", confidence: 0.9, reason: "a stylised 3D head" };
    const head = await checkOnArrival(await upload("my-3d-head"));
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { assetId: head.id }, pose: { id: couple.id } }), user)).resolves.toBeTruthy();
    answer = { kind: "real_photo", likeness: false, age: "adult", confidence: 0.97, reason: "a selfie" };
    const selfie = await checkOnArrival(await upload("selfie"));
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { assetId: selfie.id }, pose: { id: couple.id } }), user)).rejects.toThrow(/真实: a photograph/);
  });
});

describe("every upload and import gets its label as it arrives", () => {
  let projectId = "";
  const B64 = Buffer.from(PNG).toString("base64");

  it("tags 模拟 or 真实", () => {
    expect(faceLabel(v({}))).toMatchObject({ allowed: true, label: "模拟" });
    expect(faceLabel(v({ kind: "real_photo" }))).toMatchObject({ allowed: false, label: "真实" });
    expect(faceLabel(undefined)).toMatchObject({ allowed: false, label: "真实" });
    expect(faceLabel(undefined).title).toContain("not checked");
  });

  it("checks a web upload when it is committed, and the answer carries the label", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.DEV_USER = "faces3d@local";
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    projectId = (await repo.createProject({ name: "Arrivals" })).id;
    answer = { kind: "render_3d", likeness: false, age: "adult", confidence: 0.92, reason: "a 3D head" };
    const { POST } = await import("@/app/api/uploads/commit/route");
    const res = await POST(new Request("https://studio.example/api/uploads/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "uploads/u/head.png", kind: "image", projectId }) }), { params: Promise.resolve({}) });
    const { asset } = (await res.json()) as { asset: { id: string; meta: { faceCheck?: FaceVerdict } } };
    expect(asset.meta.faceCheck?.kind).toBe("render_3d");
    expect(faceAllowed((await repo.getAsset(asset.id)).meta.faceCheck as FaceVerdict)).toBe(true);
  });

  it("checks an imported picture, not a library one, and leaves one it cannot check unlabelled for later", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    answer = { kind: "real_photo", likeness: false, age: "adult", confidence: 0.96, reason: "a photo" };
    const imported = await importImageFromBase64(projectId, B64, "photo.png", user);
    expect(faceLabel(imported.meta.faceCheck as FaceVerdict).label).toBe("真实");
    expect(imported.meta.realness).toBe("real");
    const before = asked.length;
    const library = await importImageFromBase64(projectId, B64, "pose.png", user, { reference: { id: "pose-1", kind: "pose" } });
    expect(library.meta.faceCheck).toBeUndefined();
    expect(library.meta.realness).toBe("sim");
    expect(asked.length).toBe(before);
    /* the model gives no answer: 真实, and it stays so — tracing never asks the model; Check again does */
    answer = "no";
    const later = await checkOnArrival(await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/later.png", kind: "image", source: "upload", meta: { key: "uploads/u/later.png" }, name: "later" }));
    expect(later.meta.faceCheck).toBeUndefined();
    expect(later.meta.realness).toBe("real");
    answer = { kind: "illustration", likeness: false, age: "adult", confidence: 0.9, reason: "anime" };
    const n = asked.length;
    expect(await firstRealIn(projectId, [later.url])).toMatch(/真实: face not checked/);
    expect(asked.length).toBe(n);
    expect(await faceVerdict(later, { force: true })).toMatchObject({ kind: "illustration" });
    expect(await firstRealIn(projectId, [later.url])).toBeUndefined();
  });
});

describe("when a check fails, the picture says why, and can be checked again", () => {
  it("keeps the reason, tags the picture 真实 with it, and a recheck replaces it with a verdict", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.DEV_USER = "faces3d@local";
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    const projectId = (await repo.createProject({ name: "Rechecks" })).id;
    failWith = "upstream overloaded";
    const shot = await checkOnArrival(await repo.createAsset({ projectId, url: "https://studio.example/media/uploads/u/game.png", kind: "image", source: "upload", meta: { key: "uploads/u/game.png" }, name: "game scene" }));
    failWith = "";
    const why = (shot.meta.faceCheckError as { why: string }).why;
    expect(why).toContain("qwen3.8-max-0902 answered 500: upstream overloaded");
    expect(faceLabel(undefined, { why })).toMatchObject({ label: "真实" });
    expect(faceLabel(undefined, { why }).title).toContain("the face check did not run");
    answer = { kind: "no_face", likeness: false, age: "adult", confidence: 0.9, reason: "a game scene, figures far away" };
    const { POST } = await import("@/app/api/projects/[id]/pictures/[ref]/face-check/route");
    const res = await POST(new Request(`https://studio.example/api/projects/${projectId}/pictures/${shot.id}/face-check`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id: projectId, ref: shot.id }) });
    const { picture } = (await res.json()) as { picture: { meta: { faceCheck?: FaceVerdict; faceCheckError?: unknown } } };
    expect(picture.meta.faceCheck?.kind).toBe("no_face");
    expect(picture.meta.faceCheckError).toBeUndefined();
    expect(faceLabel(picture.meta.faceCheck)).toMatchObject({ allowed: true, label: "模拟" });
  });
});

describe("我的: the user's own pictures in the Canvas library", () => {
  const me: Actor = { user: "mine@local", via: "web" };
  const other: Actor = { user: "someone@else", via: "web" };
  let projectId = "";
  const add = (kind: "portrait" | "costume" | "pose", name: string, extra: Record<string, unknown> = {}) =>
    addMyReference(me, { key: `uploads/mine/${name}.png`, kind, name, tags: ["3D", "测试"], ...extra });

  it("adds a portrait with its face check, a costume and a pose without one, listed first and only for their owner", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    answer = { kind: "render_3d", likeness: false, age: "adult", confidence: 0.9, reason: "a 3D head" };
    const before = asked.length;
    const head = await add("portrait", "my-head");
    expect(asked.length).toBe(before + 1);
    expect(head).toMatchObject({ kind: "portrait", title: "my-head", section: "我的", mine: { tags: ["3D", "测试"], faceCheck: { kind: "render_3d" } } });
    const coat = await add("costume", "my-coat");
    const pose = await add("pose", "my-pose", { picture: "mannequin" });
    expect(asked.length).toBe(before + 1);
    expect(coat).toMatchObject({ kind: "costume", source: "mine", mine: { tags: ["3D", "测试"] } });
    expect((coat as RefItem).mine?.faceCheck).toBeUndefined();
    expect(pose).toMatchObject({ kind: "pose", system: "mine", mine: { picture: "mannequin" } });
    const portraits = (await listReferences("portrait", false, me.user)).items;
    expect(portraits[0]!.id).toBe(head.id);
    expect((await listReferences("portrait", false, other.user)).items.some((x) => x.id === head.id)).toBe(false);
    expect((await queryReferences({ q: "测试" }, false, me.user)).total).toBe(3);
    await expect(getReference(head.id, false, other.user)).rejects.toMatchObject({ code: "not_found" });
    expect(await getReference(head.id, false, me.user)).toMatchObject({ id: head.id });
  });

  it("draws from them in Canvas: a 模拟 portrait and any costume or pose go into R18, a 真实 portrait does not", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    projectId = (await repo.createProject({ name: "Mine" })).id;
    await setAdultContent(me, { enabled: true, confirmAdult: true });
    await imaging.setImaging(projectId, { enabled: true }, me);
    const couple = (await listReferences("pose", true)).items.find((x) => (x as RefPose).system === "couple")!;
    const mine = (await listMyReferences(me)).reduce<Record<string, RefItem>>((m, x) => ({ ...m, [x.kind]: x }), {});
    const r = await composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: mine.portrait!.id }, costume: { id: mine.costume!.id }, pose: { id: couple.id } }), me);
    const job = await repo.getJob(r.job.id);
    expect(job.input.refUrls).toEqual([mine.portrait!.image, mine.costume!.image, (couple as RefPose).image]);
    expect(String(job.input.prompt)).toContain("图1中的人物，保持其脸型、五官、发型和发色一致");
    expect(String(job.input.prompt)).toContain("让人物穿上图2中展示的整套服装和配饰，每件单品");
    const done = await imaging.applyImageStatus(job, { state: "completed", output: { url: `https://studio.example/media/projects/${projectId}/images/${job.id}.png`, width: 1024, height: 1536 } });
    expect((await repo.getAsset(done.assetIds[0]!)).meta.realness).toBe("sim");
    /* my pose: described by what its picture is */
    const withPose = await composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: mine.portrait!.id }, pose: { id: mine.pose!.id } }), me);
    expect(String((await repo.getJob(withPose.job.id)).input.prompt)).toContain("人体模型（白模）");
    /* a 真实 portrait of mine */
    answer = { kind: "real_photo", likeness: false, age: "adult", confidence: 0.95, reason: "a selfie" };
    const selfie = await add("portrait", "my-selfie");
    expect(selfie.mine?.faceCheck?.kind).toBe("real_photo");
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: selfie.id }, pose: { id: couple.id } }), me)).rejects.toThrow(/my-selfie \(我的 · 真实: a photograph/);
    await expect(composeCharacter(projectId, CanvasCompose.parse({ portrait: { id: selfie.id } }), me)).resolves.toBeTruthy();
  });

  it("keeps the tag when one is brought into a project, and is renamed, retagged, rechecked and deleted by its owner only", async () => {
    process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
    const mine = await listMyReferences(me);
    const selfie = mine.find((x) => x.kind === "portrait" && referenceName(x) === "my-selfie")!;
    const coat = mine.find((x) => x.kind === "costume")!;
    const real = await importReference(projectId, { id: selfie.id, depth: false }, me);
    expect(pictureTag(real.asset.meta, false)).toMatchObject({ label: "真实" });
    expect(await firstRealIn(projectId, [real.asset.url])).toMatch(/真实/);
    const sim = await importReference(projectId, { id: coat.id, depth: false }, me);
    expect(pictureTag(sim.asset.meta, false)).toMatchObject({ label: "模拟" });
    expect(await firstRealIn(projectId, [sim.asset.url])).toBeUndefined();
    await expect(updateMyReference(other, selfie.id, { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(await updateMyReference(me, selfie.id, { name: "me, 3D now", tags: ["a", "a", "b"] })).toMatchObject({ title: "me, 3D now", mine: { tags: ["a", "b"] } });
    answer = { kind: "illustration", likeness: false, age: "adult", confidence: 0.9, reason: "a drawing" };
    expect((await recheckMyReference(me, selfie.id)).mine?.faceCheck?.kind).toBe("illustration");
    await expect(recheckMyReference(me, coat.id)).rejects.toMatchObject({ code: "validation" });
    await deleteMyReference(me, selfie.id);
    await expect(getReference(selfie.id, false, me.user)).rejects.toMatchObject({ code: "not_found" });
  });
});
