import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as imaging from "@/studio/imaging";
import * as painter from "@/studio/painter";
import * as pod from "@/studio/painter-pod";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";

/* The painter pod: taken over by id, started when pictures are queued and no
   painter can draw them, kept up while it draws or logs in, stopped after
   idling, and kept in step with what RunPod says. */

const web: Actor = { user: "tester@local", via: "web" };

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

/* a fake RunPod: one CPU pod, its desired status, the actions sent to it */
const runpod = { status: "EXITED", actions: [] as string[] };

beforeAll(async () => {
  process.env.RUNPOD_API_KEY = "k";
  process.env.STUDIO_WORKER_TOKEN = "tok";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  delete process.env.PAINTER_IDLE_STOP_MINUTES;
  setDb(await memoryDb());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/pods/cpu-pod-1/action")) {
      const action = JSON.parse(String(init?.body)).action as string;
      runpod.actions.push(action);
      runpod.status = action === "start" ? "RUNNING" : "EXITED";
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/pods/cpu-pod-1")) return new Response(JSON.stringify({ id: "cpu-pod-1", name: "painter", desiredStatus: runpod.status, costPerHr: 0.08 }), { status: 200 });
    if (url.includes("/pods/")) return new Response(JSON.stringify({ error: "pod not found" }), { status: 404 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

describe("painter pod", () => {
  let projectId = "";

  it("is taken over by id, stopped", async () => {
    await expect(pod.adoptPainterPod("nope-404")).rejects.toBeTruthy();
    const st = await pod.adoptPainterPod("cpu-pod-1");
    expect(st.pod).toMatchObject({ id: "cpu-pod-1", status: "stopped", costPerHr: 0.08 });
    expect(st.idleStopMinutes).toBe(10);
  });

  it("starts when a picture is queued and nobody can draw it", async () => {
    const p = await repo.createProject({ name: "Pods" });
    projectId = p.id;
    await imaging.setImaging(projectId, { enabled: true }, web);
    const r = await imaging.generateStyleFrame(projectId, web);
    expect(r.runner).toContain("starting the painter pod");
    expect(runpod.actions).toEqual(["start"]);
    expect((await repo.currentPainterPod())!.status).toBe("starting");
    /* a second picture does not start it twice */
    await imaging.generateStyleFrame(projectId, web);
    expect(runpod.actions).toEqual(["start"]);
  });

  it("is running once its painter reports, and stays up while it draws", async () => {
    const t0 = Date.now();
    const got = await painter.claim({ painterId: "cpu-box", name: "cpu-box", want: 2, info: { backends: ["codex"], ops: ["paint", "crop", "extract"], runpodPodId: "cpu-pod-1" } });
    expect(got.jobs).toHaveLength(2);
    expect(await pod.sweepPainterPod(t0 + 1000)).toBe("running");
    /* long past the idle time, but two pictures are still being drawn */
    expect(await pod.sweepPainterPod(t0 + 60 * 60_000)).toBe("running");
    expect(runpod.actions).toEqual(["start"]);
  });

  it("stops after idling once the pictures are in", async () => {
    for (const j of (await repo.listActiveJobs()).filter((x) => x.kind === "image")) {
      await painter.finish(j.id, "cpu-box", { error: "test: no picture" });
    }
    const now = Date.now();
    await painter.claim({ painterId: "cpu-box", name: "cpu-box", want: 2, info: { backends: ["codex"], runpodPodId: "cpu-pod-1", running: [] } });
    expect(await pod.sweepPainterPod(now + 5 * 60_000)).toBe("running");
    expect(await pod.sweepPainterPod(now + 11 * 60_000)).toBe("auto-stopped");
    expect(runpod.actions).toEqual(["start", "stop"]);
    const st = await pod.painterPodState();
    expect(st.pod!.status).toBe("stopped");
    expect(st.pod!.message).toContain("idle");
  });

  it("the sweep starts it for a picture queued while it was stopped, and a login keeps it up", async () => {
    await repo.createJob({ projectId, kind: "image", targetId: projectId, backend: "painter", input: { op: "extract", videoUrl: "https://x/v.mp4", frame: 1, size: "1344x768" } });
    expect(await pod.sweepPainterPod()).toBe("started");
    expect(runpod.actions).toEqual(["start", "stop", "start"]);
    const j = (await repo.listActiveJobs()).find((x) => x.kind === "image")!;
    await painter.claim({ painterId: "cpu-box", name: "cpu-box", want: 1, info: { ops: ["extract"], runpodPodId: "cpu-pod-1" } });
    await painter.finish(j.id, "cpu-box", { error: "test" });
    await painter.claim({ painterId: "cpu-box", name: "cpu-box", want: 0, info: { runpodPodId: "cpu-pod-1", login: { state: "pending", code: "ABCD-1234" } } });
    expect(await pod.sweepPainterPod()).toBe("running");
    expect(await pod.sweepPainterPod(Date.now() + 30 * 60_000)).toBe("running");
    expect(runpod.actions.at(-1)).toBe("start");
  });

  it("follows RunPod when the pod is stopped outside the Studio, and can be forgotten", async () => {
    runpod.status = "EXITED";
    expect(await pod.sweepPainterPod()).toBe("stopped");
    expect((await repo.currentPainterPod())!.message).toContain("outside");
    expect((await pod.releasePainterPod()).pod).toBeUndefined();
    expect(await pod.wakeForWork()).toBeUndefined();
  });
});
