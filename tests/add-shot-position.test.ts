import { beforeEach, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { addShot } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotInput } from "@/studio/schemas";
import * as sharing from "@/studio/sharing";

/* A new shot goes at the end of its scene, or at a place the caller names. */

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

let sceneId: string;
const names = async () => (await repo.listSceneShots(sceneId)).map((s) => s.spec.intent);

beforeEach(async () => {
  setDb(await memoryDb());
  const projectId = (await sharing.createProjectAs({ user: "alice@example.com", via: "web" }, { name: "Order", visibility: "private" })).id;
  sceneId = (await repo.createScene(projectId, { slug: "alley" })).id;
  for (const intent of ["shot one", "shot two", "shot three"]) await addShot(sceneId, spec(intent));
});

describe("addShot position", () => {
  it("without a position goes last", async () => {
    await addShot(sceneId, spec("new shot"));
    expect(await names()).toEqual(["shot one", "shot two", "shot three", "new shot"]);
  });

  it("at 1 goes first, and the rest move down with their own numbers", async () => {
    const shot = await addShot(sceneId, spec("new shot"), 1);
    expect(shot.index).toBe(0);
    expect(await names()).toEqual(["new shot", "shot one", "shot two", "shot three"]);
    expect((await repo.listSceneShots(sceneId)).map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it("in the middle goes there", async () => {
    const shot = await addShot(sceneId, spec("new shot"), 3);
    expect(shot.index).toBe(2);
    expect(await names()).toEqual(["shot one", "shot two", "new shot", "shot three"]);
  });

  it("past the end, or below 1, is clamped", async () => {
    await addShot(sceneId, spec("far shot"), 99);
    await addShot(sceneId, spec("zero shot"), 0);
    expect(await names()).toEqual(["zero shot", "shot one", "shot two", "shot three", "far shot"]);
  });

  it("puts the shotlist back to draft", async () => {
    const projectId = (await repo.getScene(sceneId)).projectId;
    await repo.setShotlistApproval(projectId, "approved");
    await addShot(sceneId, spec("new shot"), 2);
    expect((await repo.getProject(projectId)).shotlistApproval).toBe("draft");
  });
});
