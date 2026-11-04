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
  process.env.H3_PROMPT_FORMAT = "blocks";
  setDb(await memoryDb());
  Object.assign(process.env, {
    RUNPOD_MODE: "pod", RUNPOD_API_KEY: "k", RUNPOD_WEBHOOK_SECRET: "s", RUNPOD_POD_IMAGE: "me/comfy:1", RUNPOD_GPU_TYPES: "H100 80GB,RTX PRO 6000",
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
    if (url.endsWith("/gputypes")) return json(200, [{ id: "NVIDIA H100 80GB HBM3", displayName: "H100 80GB", memoryInGb: 80, securePrice: 2.99 }, { id: "NVIDIA RTX 4090", displayName: "RTX 4090", memoryInGb: 24 }, { id: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", displayName: "RTX PRO 6000", memoryInGb: 96 }]);
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
    /* substrings resolved to RunPod's exact ids, allow-list order kept */
    expect(create.gpuTypeIds).toEqual(["NVIDIA H100 80GB HBM3", "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", "NVIDIA RTX PRO 6000 Blackwell Server Edition", "NVIDIA RTX PRO 6000 Blackwell Workstation Edition"]);
    expect(create.ports).toEqual(["8000/http", "8188/http"]);
    expect(create.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(create.env.STUDIO_BUNDLE_URL).toBe("https://studio.example/api/pod/bundle?token=tok");
    expect(create.networkVolumeId).toBe("vol1");
    /* stock image: the pod bootstraps the job server from the studio */
    const cmd = (create as unknown as { dockerStartCmd: string[] }).dockerStartCmd;
    expect(cmd[0]).toBe("bash");
    expect(cmd[2]).toContain("$STUDIO_BUNDLE_URL");
    expect(cmd[2]).toContain("start.sh");
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

  it("adopts a pod created by hand and never replaces it when its GPU is gone", async () => {
    scenario.startFails = true;
    scenario.podStatus = "EXITED";
    const deletesBefore = calls.filter((c) => c.method === "DELETE").length;
    const adopted = await gpu.adoptPod("pod77");
    expect(adopted.pod!.id).toBe("pod77");
    expect(adopted.pod!.adopted).toBe(true);
    expect(adopted.status).toBe("stopped");
    const state = await gpu.startGpu(web, true);
    expect(state.pod!.id).toBe("pod77");
    expect(state.status).toBe("unavailable");
    expect(calls.filter((c) => c.method === "DELETE").length).toBe(deletesBefore);
    expect((await repo.getGpuPod("pod77"))!.adopted).toBe(true);
    scenario.startFails = false;
    scenario.podStatus = "RUNNING";
    expect((await gpu.startGpu(web, true)).status).toBe("starting");
    const recipe = gpu.manualPodRecipe();
    expect(recipe.image).toBe("me/comfy:1");
    expect(recipe.ports).toContain("8000/http");
    expect(recipe.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(recipe.env.STUDIO_BUNDLE_URL).toContain("/api/pod/bundle?token=tok");
  });

  it("falls back to GraphQL, then the built-in catalog, when the REST listing fails", async () => {
    const { RunPodPodsClient, KNOWN_GPU_TYPES } = await import("@/studio/backends/runpod-pods");
    const seen: string[] = [];
    const client = new RunPodPodsClient("k", {
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("/gputypes")) return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
        if (url.includes("graphql")) return new Response(JSON.stringify({ data: { gpuTypes: [{ id: "NVIDIA H200", displayName: "H200", memoryInGb: 141 }] } }), { status: 200 });
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    expect((await client.listGpuTypes()).map((t) => t.id)).toEqual(["NVIDIA H200"]);
    expect(seen.some((u) => u.includes("graphql"))).toBe(true);

    const dead = new RunPodPodsClient("k", { fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch });
    const types = await dead.listGpuTypes();
    expect(types.map((t) => t.id)).toEqual(KNOWN_GPU_TYPES);
    expect(types[0]!.source).toBe("catalog");
    expect(await gpu.resolveGpuTypeIds(["RTX 5090", "RTX PRO 6000", "H100 80GB"], types)).toEqual([
      "NVIDIA GeForce RTX 5090",
      "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", "NVIDIA RTX PRO 6000 Blackwell Server Edition", "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
      "NVIDIA H100 80GB HBM3",
    ]);
    /* ids outside RunPod's enum never reach POST /pods, whatever the listing says */
    expect(await gpu.resolveGpuTypeIds(["RTX 4090"], [{ id: "NVIDIA RTX 4090 Mystery Edition" }])).toEqual(["NVIDIA GeForce RTX 4090"]);
  });

  it("lists GPU types flagged by the allow-list", async () => {
    const types = await gpu.listGpuTypes();
    expect(types.find((t) => t.id === "NVIDIA H100 80GB HBM3")?.allowed).toBe(true);
    expect(types.find((t) => t.id === "NVIDIA RTX 4090")?.allowed).toBe(false);
  });

  it("walks one placement per model volume and reports 暂时没资源 only after all fail", async () => {
    process.env.RUNPOD_NETWORK_VOLUMES = "EU-RO-1:vol_eu,US-TX-3:vol_us";
    await gpu.terminateGpu();
    scenario.createMode = "nores";
    const before = calls.length;
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("unavailable");
    const creates = calls.slice(before).filter((c) => c.method === "POST" && c.url.endsWith("/pods")).map((c) => c.body as { dataCenterIds: string[]; networkVolumeId: string });
    expect(creates.map((c) => c.networkVolumeId)).toEqual(["vol_eu", "vol_us"]);
    expect(creates.map((c) => c.dataCenterIds)).toEqual([["EU-RO-1"], ["US-TX-3"]]);
    scenario.createMode = "ok";
    delete process.env.RUNPOD_NETWORK_VOLUMES;
  });
});

describe("gpu stats and loras", () => {
  it("records GPU type, price and output seconds on completed takes and aggregates per type", async () => {
    const { mapRunPodStatus } = await import("@/studio/backends/runpod");
    const project = await repo.createProject({ name: "Stats", budgetCapUsd: 50 });
    const script = await repo.createScript(project.id, "x");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "s", shots: [shot()] }] }));
    await repo.setShotlistApproval(project.id, "approved");
    const sid = view.scenes[0]!.shots[0]!.id;
    /* a running pod at $2.5/h on an H100 (from the earlier tests' replacement pod) */
    scenario.podStatus = "RUNNING";
    scenario.healthy = true;
    await gpu.refreshGpu();
    const { takes } = await orch.createTakes(sid, { n: 2, confirm: true }, web);
    for (const take of takes) {
      const fresh = await repo.getTake(take.id);
      await orch.applyTakeStatus(fresh, mapRunPodStatus({ id: fresh.requestId!, status: "COMPLETED", executionTime: 60_000, output: { url: "https://r2/x.mp4", duration_s: 5 } }));
    }
    const done = await repo.getTake(takes[0]!.id);
    expect(done.gpuTypeId).toBe("NVIDIA H100 80GB HBM3");
    expect(done.gpuCostPerHr).toBe(2.5);
    expect(done.outputSeconds).toBe(5);
    expect(done.costUsd).toBeCloseTo((60_000 / 3_600_000) * 2.5, 2);

    const stats = await gpu.gpuStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ gpuTypeId: "NVIDIA H100 80GB HBM3", takes: 2, genSeconds: 120, videoSeconds: 10, secondsPerOutputSecond: 12, usdPerHr: 2.5 });
    expect(stats[0]!.usdPerVideoSecond).toBeCloseTo((12 * 2.5) / 3600, 4);

    const basis = await gpu.measuredForEstimate();
    expect(basis.secondsPerOutputSecond).toBe(12);
    const compiled = await orch.compileForShot(sid);
    expect(compiled.estimate.source).toBe("measured");

    process.env.RUNPOD_GPU_PRIORITY = "cost";
    expect((await gpu.prioritizedGpuTypes())[0]).toBe("NVIDIA H100 80GB HBM3");
    process.env.RUNPOD_GPU_PRIORITY = "availability";
  });

  it("applies project LoRAs, shot overrides, trigger words and the speed LoRA's step hint", async () => {
    const speed = await repo.createLora({ name: "H3 lightx2v 8-step", kind: "speed", filename: "h3_lightx2v_8step.safetensors", hfUrl: "https://huggingface.co/o/r/blob/main/h3_lightx2v_8step.safetensors", triggerWords: "", defaultStrength: 1, stepsHint: 8, workflows: [], notes: "" });
    const style = await repo.createLora({ name: "Neon noir", kind: "style", filename: "neon_noir.safetensors", triggerWords: "neon noir, wet asphalt", defaultStrength: 0.7, workflows: ["T2VA"], notes: "" });
    const project = await repo.createProject({ name: "Lora film", look: { loras: [{ id: speed.id }, { id: style.id, strength: 0.5 }] } });
    const script = await repo.createScript(project.id, "x");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "s", shots: [shot(), shot()] }] }));
    const [a, b] = view.scenes[0]!.shots;

    const ca = await orch.compileForShot(a!.id);
    expect(ca.input.loras).toEqual([
      { name: "H3 lightx2v 8-step", file: "h3_lightx2v_8step.safetensors", strength: 1, hf_url: "https://huggingface.co/o/r/blob/main/h3_lightx2v_8step.safetensors", kind: "speed" },
      { name: "Neon noir", file: "neon_noir.safetensors", strength: 0.5, kind: "style" },
    ]);
    expect(ca.input.steps).toBe(8);
    expect(ca.prompt).toContain("neon noir, wet asphalt");

    await orch.patchShot(b!.id, { loras: [] });
    const cb = await orch.compileForShot(b!.id);
    expect(cb.input.loras).toEqual([]);
    expect(cb.prompt).not.toContain("neon noir");

    /* a style LoRA scoped to T2VA is dropped on other workflows */
    const hero = await repo.createAsset({ projectId: project.id, url: "https://r2/h.png", kind: "image", source: "upload" });
    await orch.patchShot(a!.id, { mode: "keyframe", heroAssetId: hero.id });
    const ck = await orch.compileForShot(a!.id);
    expect(ck.workflow).toBe("I2VA");
    expect(ck.input.loras.map((l) => l.name)).toEqual(["H3 lightx2v 8-step"]);
  });
});
