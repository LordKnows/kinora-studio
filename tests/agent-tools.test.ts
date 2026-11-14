import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { agentProjectView } from "@/studio/agent-view";
import { compileShot, placedFeature } from "@/studio/compiler";
import { sidedFeature } from "@/studio/imaging";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { LookPatch, LookSettings, ShotInput, ShotlistInput } from "@/studio/schemas";
import type { Actor, Element, Shot } from "@/studio/types";

/* What an agent's tools hand back and take in, checked against faults seen on
   live projects: a Look update that wiped the LoRAs (takes then rendered at 20
   steps), an aggregate view too large to read, and prompt lines that doubled
   their prepositions. */

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

type Client = { callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown> };
let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = res.content[0]!.text;
  return { isError: !!res.isError, text, data: JSON.parse(text) as Record<string, any> };
};

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.RUNPOD_MODE = "serverless";
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_ENDPOINT_ID = "ep";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).endsWith("/run") ? new Response(JSON.stringify({ id: `job-${Math.random()}`, status: "IN_QUEUE" }), { status: 200 }) : new Response("{}", { status: 200 }))) as typeof fetch;
  const { createStudioServer } = await import("@/mcp/server");
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new McpClient({ name: "t", version: "0" });
  await Promise.all([createStudioServer(mcp).connect(a), c.connect(b)]);
  client = c as unknown as Client;
});

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 5, mode: "text", intent: "A courier crosses the square",
    beats: [{ from: 0, to: 5, action: "The courier walks toward frame right and stops at the fountain" }],
    camera: { move: "static" }, ...over,
  });

describe("the Look is patched, never reset", () => {
  it("a patch schema fills nothing in", () => {
    expect(LookPatch.parse({ aspectRatio: "16:9" })).toEqual({ aspectRatio: "16:9" });
    expect(LookPatch.parse({})).toEqual({});
    /* the full Look still has its defaults */
    expect(LookSettings.parse({ genre: "", palette: "", camera: "", lens: "", lighting: "" })).toMatchObject({ aspectRatio: "9:16", dialogueLanguage: "zh" });
  });

  it("update_look keeps the negatives and language it was not given, and holds no LoRAs", async () => {
    const { data } = await call("start_film", { name: "Look", brief: "a courier crosses a square at dawn", totalSeconds: 10, look: { genre: "quiet drama", negative: ["no rain", "no crowd"], dialogueLanguage: "en" } });
    const projectId = data.project.id as string;
    /* LoRAs are per shot: the Look has none */
    expect(data.project.look).not.toHaveProperty("loras");

    const after = (await call("update_look", { projectId, look: { aspectRatio: "16:9" } })).data.project.look;
    expect(after.aspectRatio).toBe("16:9");
    expect(after.negative).toEqual(["no rain", "no crowd"]);
    expect(after.dialogueLanguage).toBe("en");
    expect(after.genre).toBe("quiet drama");

    /* the web's Look page patches one field at a time through the same schema */
    const web1 = await repo.setProjectLook(projectId, LookPatch.parse({ palette: "teal and amber" }));
    expect(web1.look.negative).toEqual(["no rain", "no crowd"]);

    /* a Look patch that still names LoRAs leaves them out */
    const none = (await call("update_look", { projectId, look: { loras: [{ id: "lora_h3_turbo_fl2v" }] } })).data.project.look;
    expect(none).not.toHaveProperty("loras");
    expect(none.negative).toEqual(["no rain", "no crowd"]);
  });
});

describe("the aggregate tools fit in a tool result", () => {
  let projectId: string;
  let shotId: string;
  let takeId: string;

  beforeAll(async () => {
    const p = await repo.createProject({ name: "Compact", brief: "b" });
    projectId = p.id;
    const script = await repo.createScript(projectId, "EXT. SQUARE - DAY\nA courier crosses.");
    await repo.approveScript(script.id);
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", shots: [shot()] }] }));
    shotId = (await repo.listShots(projectId))[0]!.id;
    await repo.setShotlistApproval(projectId, "approved");
    /* twelve pictures, each with the long record a generated picture carries */
    for (let i = 0; i < 12; i++) {
      await repo.createAsset({ projectId, url: `https://r2/img${i}.png`, kind: "image", source: "generated", width: 1344, height: 768, meta: { purpose: i % 2 ? "edit" : "shot_first", op: "paint", label: `frame ${i}`, prompt: "SCENE: ".padEnd(3000, "x"), autoReview: { verdict: i % 3 ? "pass" : "fail", findings: [{ problem: "y".repeat(500) }] }, checks: [{ code: "crop", level: "warn" }, { code: "blank", level: "ok" }] } });
    }
    const { takes } = await orch.createTakes(shotId, { n: 2, confirm: true }, web);
    takeId = takes[0]!.id;
  });

  it("get_project summarises takes and counts pictures; the detail tools keep the rest", async () => {
    const full = JSON.stringify(await orch.getProjectView(projectId), null, 2).length;
    const { text, data } = await call("get_project", { projectId });
    expect(text.length).toBeLessThan(full / 4);
    expect(data.assets.byKind.image).toBe(12);
    expect(data.assets.picturesByPurpose).toEqual({ edit: 6, shot_first: 6 });
    const sh = data.scenes[0].shots[0];
    expect(sh.spec.intent).toBe("A courier crosses the square");
    expect(sh.takes).toHaveLength(2);
    expect(sh.takes[0]).toMatchObject({ workflow: "T2VA", status: "queued", steps: 8 });
    expect(sh.takes[0].loras[0]).toContain("turbo");
    expect(sh.takes[0].prompt).toBeUndefined();
    expect(sh.takes[0].input).toBeUndefined();
    expect(data.canGenerate).toBe(true);

    const shotlist = await call("get_shotlist", { projectId });
    expect(shotlist.data.scenes[0].shots[0].takes[0].prompt).toBeUndefined();
    const list = await call("list_takes", { shotId });
    expect(list.data.takes[0].prompt).toBeUndefined();
    /* one take, whole */
    const one = await call("get_take", { takeId });
    expect(one.data.take.prompt).toContain("courier");
    expect(one.data.take.input.steps).toBe(8);
  });

  it("list_assets is one line per asset, whole records only by id", async () => {
    const { data, text } = await call("list_assets", { projectId, kind: "image" });
    expect(data.count).toBe(12);
    expect(text).not.toContain("xxxx");
    expect(data.assets[0]).toMatchObject({ kind: "image", width: 1344, op: "paint", checks: ["warn:crop"] });
    expect(data.assets.map((a: { autoReview: string }) => a.autoReview).filter((v: string) => v === "fail")).toHaveLength(4);
    const edits = await call("list_assets", { projectId, purpose: "edit" });
    expect(edits.data.count).toBe(6);
    const refused = await call("list_assets", { projectId, full: true });
    expect(refused.isError).toBe(true);
    const whole = await call("list_assets", { projectId, ids: [data.assets[0].id], full: true });
    expect(whole.data.assets[0].meta.prompt).toContain("SCENE: ");
  });

  it("leaves the library's elements out of a project's own view", async () => {
    await repo.createElement(null, { kind: "character", name: "Library person", description: "" });
    await repo.createElement(projectId, { kind: "character", name: "Courier", description: "a courier" });
    const view = await orch.getProjectView(projectId);
    expect(view.elements.map((e) => e.name)).toContain("Library person");
    expect((agentProjectView(view).elements as Element[]).map((e) => e.name)).toEqual(["Courier"]);
  });
});

describe("delete_element", () => {
  let projectId: string;
  let shotId: string;
  beforeAll(async () => {
    projectId = (await repo.createProject({ name: "Elements", brief: "b" })).id;
    const script = await repo.createScript(projectId, "EXT. SQUARE - DAY\nA courier crosses.");
    await repo.approveScript(script.id);
    await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", shots: [shot()] }] }));
    shotId = (await repo.listShots(projectId))[0]!.id;
  });

  it("asks first, refuses an element a shot uses, and puts a deleted one in the trash", async () => {
    const lonely = await repo.createElement(projectId, { kind: "prop", name: "Spare lantern", description: "an unused lantern" });
    /* not confirmed: it asks */
    const asked = await call("delete_element", { elementId: lonely.id });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain("confirm: true");
    expect(await repo.getElement(lonely.id)).toBeTruthy();
    /* confirmed: gone, and named in the trash */
    const done = await call("delete_element", { elementId: lonely.id, confirm: true });
    expect(done.isError).toBe(false);
    expect(done.data.deleted).toMatchObject({ kind: "prop", name: "Spare lantern" });
    expect(done.data.trashId).toBeTruthy();
    await expect(repo.getElement(lonely.id)).rejects.toThrow();
    /* a shot uses it: refused, whatever confirm says */
    const used = await repo.createElement(projectId, { kind: "character", name: "Used one", description: "a courier" });
    const sh = await repo.getShot(shotId);
    await repo.updateShot(shotId, { spec: { ...sh.spec, characters: [used.id] } });
    const refused = await call("delete_element", { elementId: used.id, confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is used by shot");
    expect(await repo.getElement(used.id)).toBeTruthy();
  });
});

describe("prompt lines read as sentences", () => {
  it("a fixed feature's place keeps its own preposition or determiner", () => {
    expect(placedFeature({ feature: "thin black rectangular glasses", where: "on his face" })).toBe("thin black rectangular glasses on his face");
    expect(placedFeature({ feature: "round navy patch", where: "his own RIGHT upper arm, outer side" })).toBe("round navy patch on his own RIGHT upper arm, outer side");
    expect(placedFeature({ feature: "dragon tattoo", where: "left forearm, inner side" })).toBe("dragon tattoo on the left forearm, inner side");
    expect(placedFeature({ feature: "scarf", where: "around the neck" })).toBe("scarf around the neck");
    /* the picture prompts say it the same way, with the side spelled out */
    expect(sidedFeature({ feature: "patch", where: "his own right upper arm" })).toContain("patch on his own right upper arm — their OWN right");
    expect(sidedFeature({ feature: "glasses", where: "on his face" })).toBe("glasses on his face");
  });

  it("compiles them into the shot, and ends a Chinese sentence once", () => {
    const el: Element = { id: "ele_v", projectId: "p", kind: "character", name: "The Veteran", description: "a veteran player", refAssetIds: [], fixedFeatures: [{ feature: "glasses", where: "on his face" }], refViews: {}, createdAt: 0, updatedAt: 0 } as unknown as Element;
    const s = { id: "sht_1", projectId: "p", sceneId: "scn", index: 0, spec: shot({ intent: "开场即离场，转折落在回头一笑。", characters: ["ele_v"] }), createdAt: 0, updatedAt: 0 } as unknown as Shot;
    const look = LookSettings.parse({ genre: "anime", palette: "", camera: "", lens: "", lighting: "" });
    const ctx = { shot: s, project: { id: "p", look } as never, elements: new Map([[el.id, el]]), assets: new Map(), look };
    const job = compileShot({ ...ctx, format: "lightx2v" } as never);
    expect(job.prompt).toContain("The Veteran always has glasses on his face, in every frame.");
    expect(job.prompt).not.toContain("on the on");
    expect(job.prompt).toContain("回头一笑。");
    expect(job.prompt).not.toContain("。.");
  });
});
