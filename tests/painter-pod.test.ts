import { beforeAll, describe, expect, it } from "vitest";

import { getDb, setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as imaging from "@/studio/imaging";
import * as painter from "@/studio/painter";
import * as pod from "@/studio/painter-pod";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";

/* The painter pod: a CPU pod the Studio creates on the painter's network
   volume when pictures are queued and nobody can draw them, keeps while it
   draws or logs in, and terminates when idle, when nothing reports from it,
   or follows RunPod when it is removed outside the Studio. */

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

/* a fake RunPod v2: pods by id, which flavors have no capacity, what was asked */
const runpod = {
  pods: new Map<string, string>(),
  noCapacity: new Set<string>(["cpu3c"]),
  created: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  n: 0,
};

beforeAll(async () => {
  process.env.RUNPOD_API_KEY = "k";
  process.env.STUDIO_WORKER_TOKEN = "tok";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  delete process.env.PAINTER_POD_VOLUME_ID;
  delete process.env.PAINTER_POD_DATACENTER;
  setDb(await memoryDb());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    if (url === "https://api.runpod.io/v2/pods" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { cpu: { id: string } };
      runpod.created.push(body);
      if (runpod.noCapacity.has(body.cpu.id)) return new Response(JSON.stringify({ error: "There are no longer any instances available with the requested specifications" }), { status: 400 });
      const id = `cpu-pod-${++runpod.n}`;
      runpod.pods.set(id, "RUNNING");
      return new Response(JSON.stringify({ id, name: "cinema-studio-painter", desiredStatus: "RUNNING", costPerHr: 0.08 }), { status: 200 });
    }
    const m = /\/v2\/pods\/([^/]+)$/.exec(url);
    if (m) {
      const id = m[1]!;
      if (method === "DELETE") {
        runpod.deleted.push(id);
        runpod.pods.delete(id);
        return new Response("{}", { status: 200 });
      }
      const st = runpod.pods.get(id);
      return st ? new Response(JSON.stringify({ id, name: "cinema-studio-painter", desiredStatus: st, costPerHr: 0.08 }), { status: 200 }) : new Response(JSON.stringify({ error: "pod not found" }), { status: 404 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

const heartbeat = (podId: string, extra: Record<string, unknown> = {}, want = 2) =>
  painter.claim({ painterId: "painter-pod", name: "painter-pod", want, info: { backends: ["codex"], ops: ["paint", "crop", "extract"], runpodPodId: podId, ...extra } });

describe("painter pod", () => {
  let projectId = "";
  let first = "";

  it("is off until the volume and its data center are set", async () => {
    expect(pod.podConfigured()).toMatchObject({ ok: false });
    expect(await pod.wakeForWork()).toBeUndefined();
    process.env.PAINTER_POD_VOLUME_ID = "xo8dvjecz8";
    process.env.PAINTER_POD_DATACENTER = "US-CA-2";
    expect(pod.podConfigured()).toEqual({ ok: true });
  });

  it("a queued picture creates a pod on the volume, trying the next flavor when one is out", async () => {
    const p = await repo.createProject({ name: "Pods" });
    projectId = p.id;
    await imaging.setImaging(projectId, { enabled: true }, web);
    const r = await imaging.generateStyleFrame(projectId, web);
    expect(r.runner).toContain("starting the painter pod");
    expect(runpod.created.map((b) => (b.cpu as { id: string }).id)).toEqual(["cpu3c", "cpu3g"]);
    const body = runpod.created[1]!;
    expect(body).toMatchObject({ name: "cinema-studio-painter", image: "ubuntu:24.04", cpu: { id: "cpu3g", vcpuCount: 2 }, dataCenterIds: ["US-CA-2"], mounts: { network: [{ volumeId: "xo8dvjecz8", path: "/workspace" }] } });
    expect(body.env).toMatchObject({ STUDIO_URL: "https://studio.example", PAINTER_TOKEN: "tok", PAINTER_STATE_DIR: "/workspace/painter" });
    expect((body.entrypoint as string[]).slice(0, 2)).toEqual(["bash", "-c"]);
    expect((body.entrypoint as string[])[2]).toContain("/api/pod/bundle?token=$PAINTER_TOKEN");
    first = (await repo.currentPainterPod())!.id;
    expect(first).toBe("cpu-pod-1");
    /* a second picture does not create a second pod */
    await imaging.generateStyleFrame(projectId, web);
    expect(runpod.created).toHaveLength(2);
  });

  it("is running once its painter reports, and stays while it draws", async () => {
    const t0 = Date.now();
    expect((await heartbeat(first)).jobs).toHaveLength(2);
    expect(await pod.sweepPainterPod(t0 + 1000)).toBe("running");
    expect(await pod.sweepPainterPod(t0 + 60 * 60_000)).toBe("running");
    expect(runpod.deleted).toEqual([]);
  });

  it("is terminated after idling once the pictures are in", async () => {
    for (const j of (await repo.listActiveJobs()).filter((x) => x.kind === "image")) await painter.finish(j.id, "painter-pod", { error: "test: no picture" });
    const now = Date.now();
    await heartbeat(first, { running: [] });
    expect(await pod.sweepPainterPod(now + 5 * 60_000)).toBe("running");
    expect(await pod.sweepPainterPod(now + 11 * 60_000)).toBe("auto-stopped");
    expect(runpod.deleted).toEqual([first]);
    const st = await pod.painterPodState();
    expect(st.pod).toMatchObject({ status: "terminated", live: false });
    expect(st.pod!.message).toContain("idle");
  });

  it("the sweep creates a new pod for a picture queued while it was off; a login keeps it", async () => {
    await repo.createJob({ projectId, kind: "image", targetId: projectId, backend: "painter", input: { op: "extract", videoUrl: "https://x/v.mp4", frame: 1, size: "1344x768" } });
    expect(await pod.sweepPainterPod()).toBe("created");
    const second = (await repo.currentPainterPod())!.id;
    expect(second).toBe("cpu-pod-2");
    const j = (await repo.listActiveJobs()).find((x) => x.kind === "image")!;
    await heartbeat(second, {}, 1);
    await painter.finish(j.id, "painter-pod", { error: "test" });
    await heartbeat(second, { login: { state: "pending", code: "ABCD-1234" } }, 0);
    expect(await pod.sweepPainterPod()).toBe("running");
    expect(await pod.sweepPainterPod(Date.now() + 30 * 60_000)).toBe("running");
  });

  it("follows RunPod when the pod is deleted outside the Studio", async () => {
    const current = (await repo.currentPainterPod())!.id;
    runpod.pods.delete(current);
    await pod.sweepPainterPod();
    expect((await repo.currentPainterPod())!).toMatchObject({ status: "terminated", message: expect.stringContaining("outside") });
  });

  it("with no CPU anywhere it says so and waits before trying again", async () => {
    runpod.noCapacity = new Set(["cpu3c", "cpu3g", "cpu5c"]);
    await expect(pod.startPainterPod("test")).rejects.toMatchObject({ code: "backend_error" });
    const st = await pod.painterPodState();
    expect(st.pod).toMatchObject({ status: "unavailable" });
    expect(st.pod!.message).toContain("no CPU pod available in US-CA-2");
    await repo.createJob({ projectId, kind: "image", targetId: projectId, backend: "painter", input: { op: "extract", videoUrl: "https://x/v.mp4", frame: 2, size: "1344x768" } });
    const before = runpod.created.length;
    expect(await pod.sweepPainterPod()).toBe("unavailable");
    expect(runpod.created.length).toBe(before);
    runpod.noCapacity = new Set();
    expect(await pod.sweepPainterPod(Date.now() + 6 * 60_000)).toBe("created");
  });

  it("a pod nothing ever reports from is terminated", async () => {
    const live = (await repo.currentPainterPod())!;
    await (await getDb()).run("UPDATE painters SET info_json = ? WHERE id = ?", [JSON.stringify({ runpodPodId: "elsewhere" }), "painter-pod"]);
    expect(await pod.sweepPainterPod(Date.now() + 13 * 60_000)).toBe("boot-timeout");
    expect(runpod.deleted).toContain(live.id);
    expect((await repo.currentPainterPod())!.message).toContain("no painter reported");
  });
});
