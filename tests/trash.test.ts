import { beforeAll, describe, expect, it } from "vitest";

import { assertVisible } from "@/auth/scope";
import { getDb, setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { getProjectView, removeElement, removeProject, removeScene, removeShot, removeTake } from "@/studio/orchestrator";
import { deletePictures } from "@/studio/pictures";
import * as repo from "@/studio/repo";
import { ShotInput } from "@/studio/schemas";
import * as sharing from "@/studio/sharing";
import * as trash from "@/studio/trash";
import type { Actor } from "@/studio/types";

/* Undo for deletes: what a delete removes is kept in the trash and written
   back with the same ids, with what the delete changed elsewhere undone. */

const alice: Actor = { user: "alice@example.com", via: "web" };

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

const spec = (intent: string): ShotInput => ShotInput.parse({ durationS: 5, mode: "text", intent, beats: [{ from: 0, to: 5, action: intent }], camera: { move: "static" } });

let projectId: string;
let sceneA: string;
let sceneB: string;
let shots: string[];

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  projectId = (await sharing.createProjectAs(alice, { name: "Undo film", visibility: "private" })).id;
  sceneA = (await repo.createScene(projectId, { slug: "alley" })).id;
  sceneB = (await repo.createScene(projectId, { slug: "roof" })).id;
  shots = [];
  for (const intent of ["shot one", "shot two", "shot three"]) shots.push((await repo.createShot(projectId, sceneA, spec(intent))).id);
  await repo.createShot(projectId, sceneB, spec("roof shot one"));
  await repo.createTake({ projectId, shotId: shots[1]!, backend: "runpod", workflow: "T2VA", prompt: "shot two", input: {} });
  await repo.setShotlistApproval(projectId, "approved");
});

describe("a shot", () => {
  it("comes back with its takes, in its place", async () => {
    const before = (await repo.listSceneShots(sceneA)).map((s) => s.id);
    const { trashId } = await removeShot(shots[1]!, alice.user);
    expect((await repo.listSceneShots(sceneA)).map((s) => s.id)).toEqual([shots[0], shots[2]]);
    expect((await trash.listForProject(projectId)).map((e) => e.label)).toContain("shot 1·2 · shot two");
    await trash.restore(trashId);
    const after = await repo.listSceneShots(sceneA);
    expect(after.map((s) => s.id)).toEqual(before);
    expect(after.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(await repo.listShotTakes(shots[1]!)).toHaveLength(1);
  });

  it("is someone else's to see only if its project is", async () => {
    const { trashId } = await removeShot(shots[2]!);
    await expect(assertVisible({ user: "bob@example.com", via: "web" }, trashId)).rejects.toMatchObject({ code: "not_found" });
    await expect(assertVisible(alice, trashId)).resolves.toBeUndefined();
    await trash.restore(trashId);
  });

  it("cannot be put back twice", async () => {
    const { trashId } = await removeShot(shots[2]!);
    await trash.restore(trashId);
    await expect(trash.restore(trashId)).rejects.toThrow(/put back already/);
  });

  it("the delete returns the shotlist to draft, and Undo approves it again if nothing changed since", async () => {
    await repo.setShotlistApproval(projectId, "approved");
    const { trashId } = await removeShot(shots[0]!);
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("draft");
    await trash.restore(trashId);
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("approved");
  });

  it("but not when a shot was changed in between: then the approval is the user's again", async () => {
    await repo.setShotlistApproval(projectId, "approved");
    const { trashId } = await removeShot(shots[0]!);
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateShot(shots[1]!, { spec: { ...(await repo.getShot(shots[1]!)).spec, intent: "shot two, changed" } });
    await trash.restore(trashId);
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("draft");
  });
});

describe("a scene", () => {
  it("comes back with its shots and their takes", async () => {
    const { trashId } = await removeScene(sceneA);
    expect((await repo.listScenes(projectId)).map((s) => s.id)).toEqual([sceneB]);
    await trash.restore(trashId);
    expect((await repo.listScenes(projectId)).map((s) => s.id)).toEqual([sceneA, sceneB]);
    expect((await repo.listSceneShots(sceneA)).map((s) => s.id)).toEqual(shots);
    expect(await repo.listShotTakes(shots[1]!)).toHaveLength(1);
  });
});

describe("pictures and an element", () => {
  it("a picture comes back where it was used: a shot's first frame and an element's reference", async () => {
    const pic = await repo.createAsset({ projectId, url: `https://studio.example/media/projects/${projectId}/images/a.png`, kind: "image", source: "upload" });
    const el = await repo.createElement(projectId, { kind: "character", name: "Mara", description: "", refAssetIds: [pic.id], refViews: { [pic.id]: "front" } });
    await repo.updateShot(shots[0]!, { heroAssetId: pic.id });
    const plan = await deletePictures(projectId, [pic.id], alice, { confirm: true });
    expect(plan.trashId).toBeTruthy();
    expect((await repo.getShot(shots[0]!)).heroAssetId).toBeUndefined();
    expect((await repo.getElement(el.id)).refAssetIds).toEqual([]);
    await trash.restore(plan.trashId!);
    expect((await repo.getAsset(pic.id)).handle).toBe(pic.handle);
    expect((await repo.getShot(shots[0]!)).heroAssetId).toBe(pic.id);
    const back = await repo.getElement(el.id);
    expect(back.refAssetIds).toEqual([pic.id]);
    expect(back.refViews?.[pic.id]).toBe("front");
  });

  it("a restored picture keeps its handle; if another holds it by then, it gets the next number", async () => {
    const a = await repo.createAsset({ projectId, url: "https://studio.example/media/projects/x/b.png", kind: "image", source: "upload" });
    const plan = await deletePictures(projectId, [a.id], alice, { confirm: true });
    const b = await repo.createAsset({ projectId, url: "https://studio.example/media/projects/x/c.png", kind: "image", source: "upload" });
    expect(b.seq).not.toBe(a.seq); /* handles are not handed out twice */
    /* force the clash a restore guards against */
    await (await getDb()).run("UPDATE assets SET seq = ? WHERE id = ?", [a.seq!, b.id]);
    await trash.restore(plan.trashId!);
    const top = Math.max(...(await repo.listAssets(projectId)).filter((x) => x.id !== a.id).map((x) => x.seq ?? 0));
    expect((await repo.getAsset(a.id)).seq).toBe(top + 1);
  });

  it("an element comes back with the same id, so shots that name it work again", async () => {
    const el = await repo.createElement(projectId, { kind: "prop", name: "Lantern", description: "brass" });
    const { trashId } = await removeElement(el.id);
    await expect(repo.getElement(el.id)).rejects.toThrow();
    await trash.restore(trashId);
    expect((await repo.getElement(el.id)).name).toBe("Lantern");
  });
});

describe("a whole project", () => {
  it("comes back with everything in it, for the people who could see it", async () => {
    const before = await getProjectView(projectId);
    const { trashId } = await removeProject(projectId, alice.user);
    await expect(repo.getProject(projectId)).rejects.toThrow();
    const listed = (await trash.listProjects()).find((p) => p.id === trashId);
    expect(listed).toMatchObject({ label: "Undo film", owner: alice.user, visibility: "private" });
    await trash.restore(trashId);
    const after = await getProjectView(projectId);
    expect(after.scenes.map((s) => s.shots.map((x) => x.id))).toEqual(before.scenes.map((s) => s.shots.map((x) => x.id)));
    expect(after.assets.map((a) => a.id).sort()).toEqual(before.assets.map((a) => a.id).sort());
    expect(after.project).toMatchObject({ name: "Undo film", owner: alice.user, visibility: "private" });
  });

  it("a thing in a deleted project waits for its project", async () => {
    const { trashId } = await removeShot(shots[0]!);
    const gone = await removeProject(projectId);
    await expect(trash.restore(trashId)).rejects.toThrow(/project was deleted/);
    await trash.restore(gone.trashId);
    await trash.restore(trashId);
    expect((await repo.getShot(shots[0]!)).id).toBe(shots[0]);
  });

  it("expired entries are emptied by the sweep and cannot be restored", async () => {
    const { trashId } = await removeShot(shots[2]!);
    expect(await trash.purgeExpired(Date.now() + (trash.TRASH_DAYS + 1) * 86_400_000)).toBeGreaterThan(0);
    await expect(trash.get(trashId)).rejects.toThrow();
  });
});

describe("a take", () => {
  it("is deleted, loses its place as the pick, and comes back as the pick; a take that waits, or is in the cut, is kept", async () => {
    const shotId = shots[0]!;
    const make = async (status: "completed" | "queued") => {
      const t = await repo.createTake({ projectId, shotId, backend: "runpod", workflow: "T2VA", prompt: "p", input: {} });
      return status === "queued" ? t : repo.updateTake(t.id, { status: "completed", finishedAt: Date.now(), resultUrl: "https://r2/x.mp4" });
    };
    const waiting = await make("queued");
    await expect(removeTake(waiting.id, alice.user)).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("waiting or rendering") });
    await repo.updateTake(waiting.id, { status: "canceled", finishedAt: Date.now() });

    const done = await make("completed");
    await repo.updateShot(shotId, { selectedTakeId: done.id });
    const inCut = await make("completed");
    await repo.setTimeline(projectId, { clips: [{ shotId, takeId: inCut.id, inS: 0, outS: 5 }] } as never);
    await expect(removeTake(inCut.id, alice.user)).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("in the cut") });

    const { trashId, wasPicked } = await removeTake(done.id, alice.user);
    expect(wasPicked).toBe(true);
    await expect(repo.getTake(done.id)).rejects.toThrow();
    expect((await repo.getShot(shotId)).selectedTakeId).toBeUndefined();
    expect((await trash.listForProject(projectId)).some((e) => e.kind === "take" && e.label.includes("the pick"))).toBe(true);
    await trash.restore(trashId);
    expect((await repo.getTake(done.id)).status).toBe("completed");
    expect((await repo.getShot(shotId)).selectedTakeId).toBe(done.id);
  });
});
