import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "@/auth/hmac";
import { assertVisible, canSee, collectProjectIds } from "@/auth/scope";
import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { StudioError } from "@/studio/errors";
import * as gpu from "@/studio/gpu";
import * as repo from "@/studio/repo";
import { ShotInput } from "@/studio/schemas";
import * as sharing from "@/studio/sharing";
import type { Actor } from "@/studio/types";

/* Private projects: a project is shared (everyone, as before) or private (its
   owner only), and everything inside it follows — through the web routes, the
   director's MCP tools, and copies out to the library. The machines stay shared. */

const alice: Actor = { user: "alice@example.com", via: "web" };
const bob: Actor = { user: "bob@example.com", via: "web" };
const aliceAgent: Actor = { user: "alice@example.com", via: "mcp" };
const bobAgent: Actor = { user: "bob@example.com", via: "mcp" };

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

const shotSpec = (): ShotInput =>
  ShotInput.parse({ durationS: 5, mode: "text", intent: "A courier crosses the square", beats: [{ from: 0, to: 5, action: "The courier walks to the fountain" }], camera: { move: "static" } });

async function rejects(p: Promise<unknown>): Promise<StudioError> {
  try {
    await p;
  } catch (caught) {
    expect(caught).toBeInstanceOf(StudioError);
    return caught as StudioError;
  }
  throw new Error("expected a rejection");
}

/* a private film of alice's, a shared one of bob's, one from before private projects */
let priv: { projectId: string; sceneId: string; shotId: string; takeId: string; assetId: string; elementId: string; jobId: string };
let sharedOfBob: { projectId: string; shotId: string };
let legacyId: string;

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  const p = await sharing.createProjectAs(alice, { name: "Alice's secret", visibility: "private" });
  const scene = await repo.createScene(p.id, { slug: "INT. ROOM" });
  const shot = await repo.createShot(p.id, scene.id, shotSpec());
  const take = await repo.createTake({ projectId: p.id, shotId: shot.id, backend: "runpod", workflow: "T2VA", prompt: "x", input: {} });
  const asset = await repo.createAsset({ projectId: p.id, url: `https://studio.example/media/projects/${p.id}/images/a.png`, kind: "image", source: "upload" });
  const element = await repo.createElement(p.id, { kind: "character", name: "Mara", description: "the courier", refAssetIds: [asset.id], refViews: { [asset.id]: "front" } });
  const job = await repo.createJob({ projectId: p.id, kind: "image", targetId: element.id, backend: "codex" });
  priv = { projectId: p.id, sceneId: scene.id, shotId: shot.id, takeId: take.id, assetId: asset.id, elementId: element.id, jobId: job.id };

  const s = await sharing.createProjectAs(bob, { name: "Bob's open film" });
  const sScene = await repo.createScene(s.id, { slug: "EXT. SQUARE" });
  const sShot = await repo.createShot(s.id, sScene.id, shotSpec());
  sharedOfBob = { projectId: s.id, shotId: sShot.id };

  legacyId = (await repo.createProject({ name: "From before" })).id;
});

describe("who owns a project and who sees it", () => {
  it("a new project belongs to its creator; one from before has no owner and stays shared", async () => {
    expect(await repo.getProject(priv.projectId)).toMatchObject({ owner: alice.user, visibility: "private" });
    expect(await repo.getProject(sharedOfBob.projectId)).toMatchObject({ owner: bob.user, visibility: "shared" });
    const legacy = await repo.getProject(legacyId);
    expect(legacy.owner).toBeUndefined();
    expect(legacy.visibility).toBe("shared");
  });

  it("lists every shared project and only the caller's own private ones", async () => {
    const forAlice = (await sharing.listProjectsFor(alice)).map((p) => p.id);
    const forBob = (await sharing.listProjectsFor(bob)).map((p) => p.id);
    expect(forAlice).toEqual(expect.arrayContaining([priv.projectId, sharedOfBob.projectId, legacyId]));
    expect(forBob).toEqual(expect.arrayContaining([sharedOfBob.projectId, legacyId]));
    expect(forBob).not.toContain(priv.projectId);
    expect((await sharing.listProjectsFor(alice)).find((p) => p.id === priv.projectId)?.mine).toBe(true);
  });

  it("nobody (the static token without a user) owns or sees a private project", async () => {
    expect(canSee("mcp-static", { owner: "mcp-static", visibility: "private" })).toBe(false);
    expect(canSee("anonymous", { visibility: "shared" })).toBe(true);
    await rejects(sharing.createProjectAs({ user: "mcp-static", via: "mcp" }, { name: "x", visibility: "private" }));
  });
});

describe("the guard: every id in a request, wherever it sits", () => {
  it("finds ids in strings, arrays, nested objects and object keys, and nothing in prose", () => {
    const ids = collectProjectIds({ projectId: "prj_abcdefghijkl", list: ["sht_000000000000"], refViews: { ast_aaaaaaaaaaaa: "front" }, deep: { a: [{ b: " tke_bbbbbbbbbbbb " }] }, why: "see sht_cccccccccccc", lora: "lora_aaaaaaaaaaaa" });
    expect([...ids].sort()).toEqual(["ast_aaaaaaaaaaaa", "prj_abcdefghijkl", "sht_000000000000", "tke_bbbbbbbbbbbb"]);
  });

  it("answers not_found for anything in someone else's private project", async () => {
    for (const id of [priv.projectId, priv.sceneId, priv.shotId, priv.takeId, priv.assetId, priv.elementId, priv.jobId]) {
      const e = await rejects(assertVisible(bob, { id }));
      expect(e.code).toBe("not_found");
      expect(e.message).toContain(id);
    }
    /* hidden as a key too (refViews is keyed by asset id) */
    expect((await rejects(assertVisible(bobAgent, { refViews: { [priv.assetId]: "front" } }))).code).toBe("not_found");
  });

  it("lets the owner, through the web and the connector, and lets anyone at shared work", async () => {
    await assertVisible(alice, priv);
    await assertVisible(aliceAgent, priv);
    await assertVisible(bob, sharedOfBob, legacyId);
    await assertVisible(alice, sharedOfBob);
  });

  it("leaves ids that exist nowhere to the handler, and library rows are everyone's", async () => {
    await assertVisible(bob, { shotId: "sht_doesnotexist" });
    const lib = await repo.createElement(null, { kind: "prop", name: "Lantern", description: "" });
    await assertVisible(bob, { elementId: lib.id });
  });

  it("is shut once a project turns private, and open again once it is shared", async () => {
    const p = await sharing.createProjectAs(alice, { name: "Flip" });
    await assertVisible(bob, p.id);
    await sharing.setVisibility(alice, p.id, "private");
    await rejects(assertVisible(bob, p.id));
    await sharing.setVisibility(alice, p.id, "shared");
    await assertVisible(bob, p.id);
  });
});

describe("the director's connector", () => {
  type Client = { callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown> };
  async function connect(actor: Actor): Promise<(name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; data: Record<string, any> }>> {
    const { createStudioServer } = await import("@/mcp/server");
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new McpClient({ name: "t", version: "0" });
    await Promise.all([createStudioServer(actor).connect(a), c.connect(b)]);
    const client = c as unknown as Client;
    return async (name, args) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!res.isError, data: JSON.parse(res.content[0]!.text) as Record<string, any> };
    };
  }

  it("bob's agent neither lists nor opens alice's private project; alice's agent does both", async () => {
    const asBob = await connect(bobAgent);
    const asAlice = await connect(aliceAgent);
    const bobList = (await asBob("list_projects", {})).data.projects.map((p: { id: string }) => p.id);
    expect(bobList).not.toContain(priv.projectId);
    const denied = await asBob("get_project", { projectId: priv.projectId });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe("not_found");
    const deniedShot = await asBob("revise_shot", { shotId: priv.shotId, patch: { intent: "stolen" } });
    expect(deniedShot.isError).toBe(true);
    expect(deniedShot.data.error.code).toBe("not_found");
    expect((await repo.getShot(priv.shotId)).spec.intent).toBe("A courier crosses the square");

    const aliceList = (await asAlice("list_projects", {})).data.projects.map((p: { id: string }) => p.id);
    expect(aliceList).toContain(priv.projectId);
    const opened = await asAlice("get_project", { projectId: priv.projectId });
    expect(opened.isError).toBe(false);
  });

  it("an agent can start a private film, and cannot change who sees a project", async () => {
    const asAlice = await connect(aliceAgent);
    const { data } = await asAlice("create_project", { name: "Agent's private", visibility: "private" });
    expect(data.project).toMatchObject({ owner: alice.user, visibility: "private", mine: true });
    await rejects(sharing.setVisibility(aliceAgent, data.project.id as string, "shared"));
  });
});

describe("the web routes", () => {
  const tokens = { alice: "token-alice", bob: "token-bob" };
  beforeAll(async () => {
    process.env.AUTH_MODE = "access";
    process.env.CF_ACCESS_TEAM_DOMAIN = "team.example";
    process.env.CF_ACCESS_AUD = "aud";
    for (const [who, token] of Object.entries(tokens)) {
      await repo.saveOAuthToken({ tokenHash: await sha256Hex(token), kind: "access", clientId: "cli", user: `${who}@example.com`, scope: "", expiresAt: Date.now() + 3_600_000 });
    }
  });
  const req = (url: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    new Request(`https://studio.example${url}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

  it("a child route (a shot by id) is shut to bob and open to alice", async () => {
    const { GET } = await import("@/app/api/shots/[id]/route");
    expect((await GET(req(`/api/shots/${priv.shotId}`, tokens.bob), ctx({ id: priv.shotId }))).status).toBe(404);
    expect((await GET(req(`/api/shots/${priv.shotId}`, tokens.alice), ctx({ id: priv.shotId }))).status).toBe(200);
  });

  it("an id in the body is checked too: bob cannot pull alice's element into his project", async () => {
    const { POST } = await import("@/app/api/projects/[id]/elements/import/route");
    const res = await POST(req(`/api/projects/${sharedOfBob.projectId}/elements/import`, tokens.bob, { method: "POST", body: { elementId: priv.elementId } }), ctx({ id: sharedOfBob.projectId }));
    expect(res.status).toBe(404);
    expect((await repo.listElements(sharedOfBob.projectId)).length).toBe(0);
  });

  it("and so is an id in the query string", async () => {
    const { GET } = await import("@/app/api/projects/route");
    expect((await GET(req(`/api/projects?shot=${priv.shotId}`, tokens.bob), ctx({}))).status).toBe(404);
  });

  it("GET /api/projects lists by caller", async () => {
    const { GET } = await import("@/app/api/projects/route");
    const list = async (t: string) => ((await (await GET(req("/api/projects", t), ctx({}))).json()) as { projects: Array<{ id: string }> }).projects.map((p) => p.id);
    expect(await list(tokens.bob)).not.toContain(priv.projectId);
    expect(await list(tokens.alice)).toContain(priv.projectId);
  });
});

describe("switching who sees a project", () => {
  it("only the owner, only on the web", async () => {
    const p = await sharing.createProjectAs(alice, { name: "Mine" });
    expect((await rejects(sharing.setVisibility(bob, p.id, "private"))).code).toBe("forbidden");
    expect((await rejects(sharing.setVisibility(aliceAgent, p.id, "private"))).code).toBe("forbidden");
    expect((await sharing.setVisibility(alice, p.id, "private")).visibility).toBe("private");
    const notes = await repo.listNotes(p.id, "decision");
    expect(notes.at(-1)?.body.decision).toContain("made private");
  });

  it("a project from before is claimed by an admin, and by no one else once ADMIN_USERS is set", async () => {
    const legacy = (await repo.createProject({ name: "Old film" })).id;
    process.env.ADMIN_USERS = "Alice@Example.com";
    try {
      expect((await rejects(sharing.setVisibility(bob, legacy, "private"))).code).toBe("forbidden");
      expect(await sharing.setVisibility(alice, legacy, "private")).toMatchObject({ owner: alice.user, visibility: "private" });
    } finally {
      delete process.env.ADMIN_USERS;
    }
  });
});

describe("what is in a private project stays in it", () => {
  it("a copy into the library gets pictures of its own, outside the private project", async () => {
    const copy = await repo.copyElement(priv.elementId, null);
    expect(copy.projectId).toBeNull();
    expect(copy.refAssetIds).toHaveLength(1);
    expect(copy.refAssetIds[0]).not.toBe(priv.assetId);
    const pic = await repo.getAsset(copy.refAssetIds[0]!);
    expect(pic.projectId).toBeNull();
    expect(pic.url).toBe((await repo.getAsset(priv.assetId)).url);
    expect(copy.refViews?.[pic.id]).toBe("front");
    /* everyone can open the library copy */
    await assertVisible(bob, { elementId: copy.id, assetIds: copy.refAssetIds });
    /* while the original file is used by the copy, it is not another row's to delete */
    expect(await repo.assetFileInUse(pic.url)).toBe(true);
  });

  it("a copy within the same private project keeps its pictures", async () => {
    const copy = await repo.copyElement(priv.elementId, priv.projectId);
    expect(copy.refAssetIds).toEqual([priv.assetId]);
  });

  it("the owner cannot point a shared project's shot or element at a private picture", async () => {
    const e1 = await rejects(repo.updateShot(sharedOfBob.shotId, { heroAssetId: priv.assetId }));
    expect(e1.code).toBe("validation");
    const el = await repo.createElement(sharedOfBob.projectId, { kind: "prop", name: "Box", description: "" });
    expect((await rejects(repo.updateElement(el.id, { refAssetIds: [priv.assetId] }))).code).toBe("validation");
    expect((await rejects(repo.createElement(null, { kind: "prop", name: "Leak", description: "", refAssetIds: [priv.assetId] }))).code).toBe("validation");
  });

  it("a private project's voice card does not move to the library", async () => {
    const card = await repo.createVoiceCard(priv.projectId, { name: "Mara", states: [{ id: "base", name: "Base", description: "a low calm voice" }] });
    expect((await rejects(repo.updateVoiceCard(card.id, { projectId: null }))).code).toBe("validation");
    await rejects(assertVisible(bob, { voiceCardId: card.id }));
  });
});

describe("turning a shared project private", () => {
  it("what others took from it while it was shared keeps working, on copies of their own", async () => {
    const p = await sharing.createProjectAs(alice, { name: "Was shared" });
    const pic = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/projects/p/hero.png", kind: "image", source: "upload" });
    const audio = await repo.createAsset({ projectId: p.id, url: "https://studio.example/media/projects/p/voice.wav", kind: "audio", source: "upload" });
    const card = await repo.createVoiceCard(p.id, { name: "Mara", states: [{ id: "base", name: "Base", description: "a low calm voice", refAssetIds: [audio.id] }] });
    /* taken while shared: a library character, bob's shot, a library voice card, an element of bob's on its card */
    const libEl = await repo.createElement(null, { kind: "character", name: "Mara", description: "", refAssetIds: [pic.id], refViews: { [pic.id]: "front" } });
    await repo.updateShot(sharedOfBob.shotId, { heroAssetId: pic.id });
    const libCard = await repo.createVoiceCard(null, { name: "Mara (lib)", states: [{ id: "base", name: "Base", description: "a low calm voice", refAssetIds: [audio.id] }] });
    const bobEl = await repo.createElement(sharedOfBob.projectId, { kind: "character", name: "Mara", description: "", voiceCardId: card.id });

    await sharing.setVisibility(alice, p.id, "private");

    const el = await repo.getElement(libEl.id);
    expect(el.refAssetIds[0]).not.toBe(pic.id);
    expect(el.refViews?.[el.refAssetIds[0]!]).toBe("front");
    const shot = await repo.getShot(sharedOfBob.shotId);
    expect(shot.heroAssetId).not.toBe(pic.id);
    expect((await repo.getAsset(shot.heroAssetId!)).projectId).toBe(sharedOfBob.projectId);
    const lc = await repo.getVoiceCard(libCard.id);
    expect(lc.states[0]!.refAssetIds[0]).not.toBe(audio.id);
    const be = await repo.getElement(bobEl.id);
    expect(be.voiceCardId).not.toBe(card.id);
    expect((await repo.getVoiceCard(be.voiceCardId!)).projectId).toBe(sharedOfBob.projectId);
    /* bob can open all of it; the private originals stay shut */
    await assertVisible(bob, { el: el.refAssetIds, shot: shot.heroAssetId, card: lc.states[0]!.refAssetIds, voice: be.voiceCardId });
    await rejects(assertVisible(bob, { pic: pic.id }));
    const note = (await repo.listNotes(p.id, "decision")).at(-1)!;
    expect(String(note.body.why)).toContain("4 element(s), shot(s) or voice card(s)");
  });
});

describe("the shared GPU pod", () => {
  it("counts what it does for others, never what it is", async () => {
    expect(await gpu.othersInFlight(alice.user)).toMatchObject({ takes: 0 });
    expect(await gpu.othersInFlight(bob.user)).toMatchObject({ takes: 1 });
  });

  it("stopping it under someone else's work asks first; the idle stop does not ask", async () => {
    await repo.insertGpuPod({ id: "pod-shared", name: "studio", image: "img", status: "running" });
    const e = await rejects(gpu.stopGpu({ actor: bob, confirm: false }));
    expect(e.code).toBe("needs_confirm");
    expect(e.message).toContain("1 take(s)");
    expect(e.message).not.toContain("Alice");
  });
});

describe("nothing project-owned escapes the guard", () => {
  it("every table with a project_id has an id prefix the guard knows", async () => {
    const { getDb } = await import("@/db");
    const db = await getDb();
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
    const guarded = new Set<string>(Object.values(repo.PROJECT_TABLE_OF_PREFIX));
    /* keyed by the project id itself: the project id in the request is what is checked */
    const byProjectId = new Set(["projects", "timelines", "voice_settings"]);
    for (const t of tables) {
      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${t})`)).map((c) => c.name);
      if (!cols.includes("project_id") || byProjectId.has(t)) continue;
      expect(guarded.has(t), `${t} has project_id but no prefix in PROJECT_TABLE_OF_PREFIX`).toBe(true);
    }
  });

  it("every id prefix the repository mints is guarded or named as not a project's", () => {
    const src = readFileSync(new URL("../src/studio/repo.ts", import.meta.url), "utf8");
    const minted = new Set([...src.matchAll(/newId\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/"([a-z]+)"(?!\s*\?)/g)].map((x) => x[1]!)));
    const notProjects = new Set(["prj", "lora", "cmd", "cli", "myref", "up"]);
    for (const prefix of minted) {
      if (notProjects.has(prefix)) continue;
      expect(prefix in repo.PROJECT_TABLE_OF_PREFIX, `ids "${prefix}_…" are not checked by auth/scope.ts`).toBe(true);
    }
  });
});
