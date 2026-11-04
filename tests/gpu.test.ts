import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as gpu from "@/studio/gpu";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotInput, ShotlistInput } from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* Pod mode end to end with RunPod's REST API and the pod's job server mocked:
   create on demand, "no resources", pending takes submitted once the pod is
   healthy, resume failure → replacement, idle auto-stop. */

const mcp: Actor = { user: "agent", via: "mcp" };
const web: Actor = { user: "me", via: "web" };

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

type Scenario = { createMode: "ok" | "nores"; podStatus: "RUNNING" | "EXITED"; healthy: boolean; startFails: boolean };
const scenario: Scenario = { createMode: "ok", podStatus: "RUNNING", healthy: true, startFails: false };
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let podCounter = 0;

beforeAll(async () => {
  setDb(await memoryDb());
  Object.assign(process.env, {
    RUNPOD_MODE: "pod", RUNPOD_API_KEY: "k", RUNPOD_WEBHOOK_SECRET: "s", RUNPOD_POD_IMAGE: "me/comfy:1", RUNPOD_GPU_TYPES: "NVIDIA H100 80GB HBM3,NVIDIA RTX PRO 6000",
    RUNPOD_NETWORK_VOLUME_ID: "vol1", STUDIO_WORKER_TOKEN: "tok", STUDIO_PUBLIC_URL: "https://studio.example", RUNPOD_IDLE_STOP_MINUTES: "15",
    R2_ACCOUNT_ID: "acc", R2_BUCKET: "studio", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_PUBLIC_BASE_URL: "https://studio.example/media",
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://rest.runpod.io/v1/pods") && method === "POST" && url.endsWith("/pods")) {
      if (scenario.createMode === "nores") return json(500, { error: "There are no longer any instances available with the requested specifications." });
      podCounter++;
      return json(201, { id: `pod${podCounter}`, name: body.name, desiredStatus: "RUNNING", costPerHr: 2.5, machine: { gpuTypeId: "NVIDIA H100 80GB HBM3", gpuDisplayName: "H100 80GB", dataCenterId: "EU-RO-1" } });
    }
    if (/\/v1\/pods\/pod\d+$/.test(url) && method === "GET") return json(200, { id: url.split("/").pop(), name: "p", desiredStatus: scenario.podStatus, costPerHr: 2.5, machine: { gpuTypeId: "NVIDIA H100 80GB HBM3", gpuDisplayName: "H100 80GB" } });
    if (url.endsWith("/start")) return scenario.startFails ? json(500, { error: "no GPU available for this pod" }) : json(200, { id: url.split("/")[5], desiredStatus: "RUNNING", costPerHr: 2.5 });
    if (url.endsWith("/stop")) return json(200, { id: "x", desiredStatus: "EXITED" });
    if (method === "DELETE") return json(200, {});
    if (url.endsWith("/gputypes")) return json(200, [{ id: "NVIDIA H100 80GB HBM3", displayName: "H100 80GB", memoryInGb: 80, securePrice: 2.99 }, { id: "NVIDIA RTX 4090", displayName: "RTX 4090", memoryInGb: 24 }]);
    /* the pod's job server through the proxy */
    if (url.includes(".proxy.runpod.net")) {
      if (!scenario.healthy) return new Response("bad gateway", { status: 502 });
      if (url.endsWith("/health")) return json(200, { ok: true });
      if (url.endsWith("/run") || url.endsWith("/assemble")) return json(200, { id: `job-${calls.length}`, status: "IN_QUEUE" });
      if (url.includes("/status/")) return json(200, { id: "job", status: "IN_PROGRESS" });
      if (url.includes("/cancel/")) return json(200, { id: "job", status: "CANCELLED" });
    }
    return json(404, { error: `unmocked ${method} ${url}` });
  }) as typeof fetch;
});

const shot = () => ShotInput.parse({ durationS: 5, mode: "text", intent: "An empty street at dawn", beats: [{ from: 0, to: 5, action: "Fog drifts across the street" }], camera: { move: "static" } });

describe("pod mode", () => {
  let projectId = "";
  let shotId = "";

  it("starts with no pod and refuses to start without confirm from the agent", async () => {
    const project = await repo.createProject({ name: "Pod film", budgetCapUsd: 50 });
    projectId = project.id;
    const script = await repo.createScript(projectId, "A street.");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "street", shots: [shot()] }] }));
    shotId = view.scenes[0]!.shots[0]!.id;
    await repo.setShotlistApproval(projectId, "approved");
    expect((await gpu.getGpuState()).status).toBe("none");
    await expect(gpu.startGpu(mcp, false)).rejects.toMatchObject({ code: "needs_confirm" });
  });

  it("reports 暂时没资源 when no allowed GPU has capacity, and does not create takes", async () => {
    scenario.createMode = "nores";
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("unavailable");
    expect(state.message).toContain("暂时没资源");
    await expect(orch.createTakes(shotId, { n: 1, confirm: true }, mcp)).rejects.toMatchObject({ code: "backend_error", details: { noResources: true } });
    expect(await repo.listShotTakes(shotId)).toHaveLength(0);
  });

  it("creates the pod on the allow-list and parks takes until it is healthy", async () => {
    scenario.createMode = "ok";
    scenario.healthy = false;
    const { takes, gpu: state } = await orch.createTakes(shotId, { n: 1, confirm: true }, mcp);
    expect(state?.status).toBe("starting");
    expect(takes[0]!.status).toBe("queued");
    expect(takes[0]!.requestId).toBeUndefined();
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/pods"))!.body as { gpuTypeIds: string[]; ports: string[]; env: Record<string, string>; networkVolumeId: string };
    expect(create.gpuTypeIds).toEqual(["NVIDIA H100 80GB HBM3", "NVIDIA RTX PRO 6000"]);
    expect(create.ports).toEqual(["8000/http", "8188/http"]);
    expect(create.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(create.networkVolumeId).toBe("vol1");
    expect((await gpu.getGpuState()).pendingTakes).toBe(1);

    /* still booting: the sweep submits nothing */
    await orch.sweep();
    expect((await repo.listShotTakes(shotId))[0]!.requestId).toBeUndefined();

    /* healthy: the sweep submits the pending take through the proxy with a signed webhook */
    scenario.healthy = true;
    await orch.sweep();
    const take = (await repo.listShotTakes(shotId))[0]!;
    expect(take.requestId).toMatch(/^job-/);
    const run = calls.find((c) => c.url.endsWith("/run"))!;
    expect(run.url).toBe("https://pod1-8000.proxy.runpod.net/run");
    expect(String((run.body as { webhook: string }).webhook)).toContain("https://studio.example/api/runpod/hook?id=");
    expect((await gpu.getGpuState()).status).toBe("running");
  });

  it("does not auto-stop while work is in flight, and stops once idle", async () => {
    expect(await gpu.autoStopIfIdle(true)).toBe(false);
    const pod = (await repo.currentGpuPod())!;
    await repo.updateGpuPod(pod.id, { lastActivityAt: Date.now() - 20 * 60_000, startedAt: Date.now() - 30 * 60_000 });
    expect(await gpu.autoStopIfIdle(false)).toBe(true);
    scenario.podStatus = "EXITED";
    const state = await gpu.getGpuState();
    expect(state.status).toBe("stopped");
    expect(state.lifetimeUsd).toBeGreaterThan(1);
  });

  it("replaces a stopped pod that cannot get its GPU back", async () => {
    scenario.startFails = true;
    const before = (await repo.currentGpuPod())!.id;
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("starting");
    expect(state.pod!.id).not.toBe(before);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/pods/${before}`))).toBe(true);
    expect((await repo.getGpuPod(before))!.status).toBe("terminated");
  });

  it("lists GPU types flagged by the allow-list", async () => {
    const types = await gpu.listGpuTypes();
    expect(types[0]).toMatchObject({ id: "NVIDIA H100 80GB HBM3", allowed: true });
    expect(types.find((t) => t.id === "NVIDIA RTX 4090")?.allowed).toBe(false);
  });
});
