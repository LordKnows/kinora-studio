import { beforeAll, describe, expect, it, vi } from "vitest";

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

type Scenario = { createMode: "ok" | "nores"; podStatus: "RUNNING" | "EXITED"; healthy: boolean; jobState?: string; startFails: boolean; volumeKind: "network" | "global"; noresWithVolume?: boolean; health?: unknown };
const scenario: Scenario = { createMode: "ok", podStatus: "RUNNING", healthy: true, startFails: false, volumeKind: "network" };
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
const podsV2 = new Map<string, { env?: Record<string, string>; args?: string }>();
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
    /* v2 (api.runpod.io/v2): the default. One gpu per create, mounts.network, /action, PATCH. */
    if (url === "https://api.runpod.io/v2/pods" && method === "POST") {
      if (scenario.createMode === "nores" || (scenario.noresWithVolume && body.mounts)) return json(500, { error: "There are no longer any instances available with the requested specifications." });
      if (!body.gpu?.id || body.gpu.count !== 1) return json(422, { error: "gpu.id and gpu.count are required" });
      if (scenario.volumeKind === "global") {
        if (body.mounts?.network) return json(400, { error: `Network volume "${body.mounts.network[0].volumeId}" not found` });
        if (!body.mounts?.global?.[0]?.volumeId) return json(422, { error: "unknown mount kind" });
      } else if (body.mounts && (!body.mounts.network?.[0]?.volumeId || !body.mounts.network[0].path)) return json(422, { error: "mounts.network[].volumeId and path are required" });
      if (body.args !== undefined && typeof body.args !== "string") return json(422, { error: "args must be a string" });
      if (body.entrypoint !== undefined && !Array.isArray(body.entrypoint)) return json(422, { error: "entrypoint must be an array" });
      podCounter++;
      podsV2.set(`pod${podCounter}`, { env: body.env, args: body.args });
      /* a pod without a volume lands wherever RunPod has the card */
      return json(201, { id: `pod${podCounter}`, name: body.name, status: "RUNNING", cost: 2.5, gpu: { id: body.gpu.id, count: 1 }, dataCenterId: body.mounts ? body.dataCenterIds?.[0] ?? "EU-RO-1" : "US-KS-2", mounts: body.mounts });
    }
    if (/\/v2\/pods\/pod\d+$/.test(url) && method === "GET") {
      const id = url.split("/").pop()!;
      return json(200, { id, name: "p", status: scenario.podStatus, cost: 2.5, gpu: { id: "NVIDIA H100 80GB HBM3", count: 1 }, env: podsV2.get(id)?.env ?? { JUPYTER_PASSWORD: "jp" } });
    }
    if (/\/v2\/pods\/pod\d+$/.test(url) && method === "PATCH") {
      const id = url.split("/").pop()!;
      podsV2.set(id, { env: body.env ?? podsV2.get(id)?.env, args: body.args ?? podsV2.get(id)?.args });
      return json(200, { id, status: scenario.podStatus });
    }
    if (url.endsWith("/action") && method === "POST") {
      if (body.action === "start") return scenario.startFails ? json(500, { error: "no GPU available for this pod" }) : json(200, { id: url.split("/")[5], status: "RUNNING" });
      return json(200, { id: url.split("/")[5], status: body.action === "stop" ? "EXITED" : "RUNNING" });
    }
    if (url.startsWith("https://api.runpod.io/v2/pods/") && method === "DELETE") return json(200, {});
    if (url.endsWith("/v2/network-volumes")) return json(200, { networkVolumes: [{ id: "vol1", name: "minimax-h3-models", size: 200 }] });
    if (url.endsWith("/v2/global-volumes")) return json(200, { globalVolumes: [{ id: "gvol1", name: "global-models", size: 500 }] });
    /* v1 (rest.runpod.io/v1), still selectable with RUNPOD_API=v1 */
    if (url.startsWith("https://rest.runpod.io/v1/pods") && method === "POST" && url.endsWith("/pods")) {
      if (scenario.createMode === "nores") return json(500, { error: "There are no longer any instances available with the requested specifications." });
      podCounter++;
      return json(201, { id: `pod${podCounter}`, name: body.name, desiredStatus: "RUNNING", costPerHr: 2.5, machine: { gpuTypeId: "NVIDIA H100 80GB HBM3", gpuDisplayName: "H100 80GB", dataCenterId: "EU-RO-1" } });
    }
    if (/\/v1\/pods\/pod\d+$/.test(url) && method === "GET") return json(200, { id: url.split("/").pop(), name: "p", desiredStatus: scenario.podStatus, costPerHr: 2.5, machine: { gpuTypeId: "NVIDIA H100 80GB HBM3", gpuDisplayName: "H100 80GB" } });
    if (url.endsWith("/start")) return scenario.startFails ? json(500, { error: "no GPU available for this pod" }) : json(200, { id: url.split("/")[5], desiredStatus: "RUNNING", costPerHr: 2.5 });
    if (url.endsWith("/stop")) return json(200, { id: "x", desiredStatus: "EXITED" });
    if (method === "DELETE") return json(200, {});
    if (url.endsWith("/networkvolumes")) return json(200, []);
    if (url.endsWith("/gputypes")) return json(200, [{ id: "NVIDIA H100 80GB HBM3", displayName: "H100 80GB", memoryInGb: 80, securePrice: 2.99 }, { id: "NVIDIA RTX 4090", displayName: "RTX 4090", memoryInGb: 24 }, { id: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", displayName: "RTX PRO 6000", memoryInGb: 96 }]);
    /* the pod's job server through the proxy */
    if (url.includes(".proxy.runpod.net")) {
      if (!scenario.healthy) return new Response("bad gateway", { status: 502 });
      if (url.endsWith("/health")) return json(200, scenario.health ?? { ok: true });
      if (url.endsWith("/run") || url.endsWith("/assemble")) return json(200, { id: `job-${calls.length}`, status: "IN_QUEUE" });
      if (url.includes("/status/")) return json(200, { id: "job", status: scenario.jobState ?? "IN_PROGRESS" });
      if (url.includes("/cancel/")) return json(200, { id: "job", status: "CANCELLED" });
    }
    return json(404, { error: `unmocked ${method} ${url}` });
  }) as typeof fetch;
});

const shot = () => ShotInput.parse({ durationS: 5, mode: "text", intent: "An empty street at dawn", beats: [{ from: 0, to: 5, action: "Fog drifts across the street" }], camera: { move: "static" } });

describe("pod mode", () => {
  let projectId = "";
  let shotId = "";

  it("starts with no pod; the director cannot start one, a person can", async () => {
    const project = await repo.createProject({ name: "Pod film", budgetCapUsd: 50 });
    projectId = project.id;
    const script = await repo.createScript(projectId, "A street.");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "street", shots: [shot()] }] }));
    shotId = view.scenes[0]!.shots[0]!.id;
    await repo.setShotlistApproval(projectId, "approved");
    expect((await gpu.getGpuState()).status).toBe("none");
    /* only a person starts the pod (it bills by the hour): the director is refused, confirmed or not, and nothing is created */
    await expect(gpu.startGpu(mcp, false)).rejects.toMatchObject({ code: "forbidden" });
    await expect(gpu.startGpu(mcp, true)).rejects.toMatchObject({ code: "forbidden" });
    expect((await gpu.getGpuState()).status).toBe("none");
  });

  it("reports 暂时没资源 when no allowed GPU has capacity, and does not create takes", async () => {
    scenario.createMode = "nores";
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("unavailable");
    expect(state.message).toContain("暂时没资源");
    await expect(orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp)).rejects.toMatchObject({ code: "forbidden", details: { gpuNotRunning: true } });
    expect(await repo.listShotTakes(shotId)).toHaveLength(0);
  });

  it("a render is refused while the GPU is not running, from the page and from the director", async () => {
    /* the pod is "unavailable" here: no GPU to render on */
    await expect(orch.createTakes(shotId, { n: 1, confirm: true }, web)).rejects.toMatchObject({ code: "validation", details: { gpuNotRunning: true } });
    await expect(orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp)).rejects.toMatchObject({ code: "forbidden", details: { gpuNotRunning: true } });
    expect(await repo.listShotTakes(shotId)).toHaveLength(0);
  });

  it("a person creates the pod on the allow-list; a take rolled while it does not answer is parked until it is healthy", async () => {
    scenario.createMode = "ok";
    scenario.healthy = true;
    const before = calls.length;
    expect((await gpu.startGpu(web, true)).status).toBe("starting");
    await gpu.refreshGpu();
    /* it is up; now it stops answering (busy): a take rolled meanwhile waits for it */
    scenario.healthy = false;
    const { takes, gpu: state } = await orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp);
    expect(state?.status).toBe("running");
    expect(takes[0]!.status).toBe("queued");
    expect(takes[0]!.requestId).toBeUndefined();
    const creates = calls.slice(before).filter((c) => c.method === "POST" && c.url === "https://api.runpod.io/v2/pods");
    expect(creates).toHaveLength(1);
    const create = creates[0]!.body as { gpu: { id: string; count: number }; ports: string[]; env: Record<string, string>; mounts: { network: Array<{ volumeId: string; path: string }> }; args?: string; entrypoint: string[]; cloud: string; image: string; disk: number };
    /* v2: one GPU per request; the first substring of the allow-list resolved to RunPod's exact id */
    expect(create.gpu).toEqual({ id: "NVIDIA H100 80GB HBM3", count: 1 });
    expect(create.image).toBe("me/comfy:1");
    expect(create.cloud).toBe("SECURE");
    /* on a model volume the container disk only holds ComfyUI and outputs */
    expect(create.disk).toBe(80);
    expect(create.ports).toEqual(["8000/http", "8188/http"]);
    expect(create.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(create.env.STUDIO_BUNDLE_URL).toBe("https://studio.example/api/pod/bundle?token=tok");
    /* the model volume as a network mount at the ComfyUI workspace */
    expect(create.mounts).toEqual({ network: [{ volumeId: "vol1", path: "/runpod-volume" }] });
    expect(create.env.STUDIO_VOLUME_PATH).toBe("/runpod-volume");
    /* stock image: the boot script replaces the image's ENTRYPOINT (which would swallow a start command) */
    expect(create.args).toBeUndefined();
    expect(create.entrypoint.slice(0, 2)).toEqual(["bash", "-lc"]);
    expect(create.entrypoint[2]).toContain("$STUDIO_BUNDLE_URL");
    expect(create.entrypoint[2]).toContain("start.sh");
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

  it("hands a waiting take over as soon as the pod answers, without waiting for the sweep", async () => {
    scenario.healthy = false;
    const { takes } = await orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp);
    const id = takes[0]!.id;
    expect(takes[0]!.requestId).toBeUndefined();
    /* still not answering: it keeps waiting */
    await orch.handOverWaitingTakes([id]);
    expect((await repo.getTake(id)).requestId).toBeUndefined();
    /* answering: the call that a project's event stream makes submits it (the pod is asked at most every 8 s) */
    scenario.healthy = true;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10_000 });
    await orch.handOverWaitingTakes([id]);
    vi.useRealTimers();
    expect((await repo.getTake(id)).requestId).toMatch(/^job-/);
    /* and a second hand-over of the same take submits nothing more */
    const runs = calls.filter((c) => c.url.endsWith("/run")).length;
    await orch.handOverWaitingTakes([id]);
    expect(calls.filter((c) => c.url.endsWith("/run")).length).toBe(runs);
    /* nothing of this test is left in flight for the ones after it */
    await repo.updateTake(id, { status: "canceled", finishedAt: Date.now() });
  });

  it("cancels a take that is queued and refuses one that is rendering", async () => {
    const make = async () => (await orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp)).takes[0]!;
    const cancels = () => calls.filter((c) => c.url.includes("/cancel/")).length;
    /* rendering on the pod: refused, nothing sent to the pod, and the take is brought up to date */
    scenario.jobState = "IN_PROGRESS";
    const rendering = await make();
    expect(rendering.requestId).toMatch(/^job-/);
    const before = cancels();
    await expect(orch.cancelTake(rendering.id)).rejects.toMatchObject({ code: "validation" });
    expect(cancels()).toBe(before);
    expect((await repo.getTake(rendering.id)).status).toBe("running");
    await expect(orch.cancelTake(rendering.id)).rejects.toMatchObject({ code: "validation" });
    /* waiting in the pod's line: cancelled */
    scenario.jobState = "IN_QUEUE";
    const waiting = await make();
    expect((await orch.cancelTake(waiting.id)).status).toBe("canceled");
    expect(cancels()).toBe(before + 1);
    /* not yet handed over: cancelled here, the pod is not asked */
    scenario.healthy = false;
    const parked = await make();
    expect(parked.requestId).toBeUndefined();
    expect((await orch.cancelTake(parked.id)).status).toBe("canceled");
    expect(cancels()).toBe(before + 1);
    scenario.healthy = true;
    scenario.jobState = undefined;
    await repo.updateTake(rendering.id, { status: "canceled", finishedAt: Date.now() });
  });

  it("keeps calling a pod that was running running when one health look fails", async () => {
    const pod = (await repo.currentGpuPod())!;
    await repo.updateGpuPod(pod.id, { status: "running" });
    scenario.healthy = false;
    const seen = await gpu.refreshGpu();
    expect(seen?.status).toBe("running");
    expect(seen?.message).toContain("did not answer just now");
    scenario.healthy = true;
    expect((await gpu.refreshGpu())?.message ?? null).toBeNull();
  });

  it("stops the pod once, when asked and nothing is left to render", async () => {
    const pod = (await repo.currentGpuPod())!;
    await repo.updateGpuPod(pod.id, { status: "running" });
    scenario.healthy = true;
    /* what the tests before left in flight is not part of this one */
    for (const t of await repo.listActiveTakes()) await repo.updateTake(t.id, { status: "canceled", finishedAt: Date.now() });
    /* not asked: an idle pod is left to the idle timer */
    expect(await orch.stopGpuIfDone()).toBe(false);
    expect((await gpu.setStopWhenDone(true)).stopWhenDone).toBe(true);
    /* a take in flight: it is not stopped */
    const take = (await orch.createTakes(shotId, { n: 1, confirm: true, skipReview: "test: the user asked to render it as it is" }, mcp)).takes[0]!;
    expect(await orch.stopGpuIfDone()).toBe(false);
    expect((await repo.currentGpuPod())!.status).toBe("running");
    /* everything has rendered: it stops, and the switch is spent */
    await repo.updateTake(take.id, { status: "canceled", finishedAt: Date.now() });
    expect(await orch.stopGpuIfDone()).toBe(true);
    const after = (await repo.currentGpuPod())!;
    expect(after.status).toBe("stopped");
    expect(after.stopWhenDone).toBe(false);
    /* with no pod up there is nothing to ask for */
    await expect(gpu.setStopWhenDone(true)).rejects.toMatchObject({ code: "validation" });
    /* a stop by hand spends the switch too */
    await repo.updateGpuPod(pod.id, { status: "running", stoppedAt: null });
    await gpu.setStopWhenDone(true);
    await gpu.stopGpu();
    expect((await repo.currentGpuPod())!.stopWhenDone).toBe(false);
    /* leave the pod running for the tests after this one */
    await repo.updateGpuPod(pod.id, { status: "running", stoppedAt: null, startedAt: Date.now() });
  });

  it("the director can stop the GPU", async () => {
    const pod = (await repo.currentGpuPod())!;
    await repo.updateGpuPod(pod.id, { status: "running", stoppedAt: null });
    for (const t of await repo.listActiveTakes()) await repo.updateTake(t.id, { status: "canceled", finishedAt: Date.now() });
    expect((await gpu.stopGpu({ actor: mcp, confirm: true })).status).toBe("stopped");
    /* and cannot bring it back (RunPod says it is stopped) */
    scenario.podStatus = "EXITED";
    await expect(gpu.startGpu(mcp, true)).rejects.toMatchObject({ code: "forbidden" });
    scenario.podStatus = "RUNNING";
    await repo.updateGpuPod(pod.id, { status: "running", stoppedAt: null, startedAt: Date.now() });
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
    /* adoption puts the studio's boot command on the pod, keeping the env the pod already had */
    const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v2/pods/pod77"))!.body as { entrypoint: string[]; env: Record<string, string> };
    expect(patch.entrypoint[2]).toContain("$STUDIO_BUNDLE_URL");
    expect(patch.env.JUPYTER_PASSWORD).toBe("jp");
    expect(patch.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(calls.some((c) => c.url.endsWith("/v2/pods/pod77/action") && (c.body as { action: string }).action === "restart")).toBe(false);
    const state = await gpu.startGpu(web, true);
    expect(state.pod!.id).toBe("pod77");
    expect(state.status).toBe("unavailable");
    expect(calls.filter((c) => c.method === "DELETE").length).toBe(deletesBefore);
    expect((await repo.getGpuPod("pod77"))!.adopted).toBe(true);
    scenario.startFails = false;
    scenario.podStatus = "RUNNING";
    const resumed = await gpu.startGpu(web, true);
    expect(resumed.status).toBe("starting");
    expect(resumed.pod!.id).toBe("pod77");
    /* the repair action re-applies the boot command and restarts a running pod */
    const repaired = await gpu.repairGpu();
    expect(repaired.repair.restarted).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/v2/pods/pod77/action") && (c.body as { action: string }).action === "restart")).toBe(true);
    const recipe = gpu.manualPodRecipe();
    expect(recipe.image).toBe("me/comfy:1");
    expect(recipe.ports).toContain("8000/http");
    expect(recipe.env.STUDIO_WORKER_TOKEN).toBe("tok");
    expect(recipe.env.STUDIO_BUNDLE_URL).toContain("/api/pod/bundle?token=tok");
    expect(recipe.dockerStartCmd.startsWith("bash -lc '")).toBe(true);
    expect(gpu.bootstrapCommand()[2]).not.toMatch(/['"]/);
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

  it("tries the other volume encodings when the network mount is 'not found' (global volume)", async () => {
    scenario.volumeKind = "global";
    await gpu.terminateGpu();
    const before = calls.length;
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("starting");
    const creates = calls.slice(before).filter((c) => c.method === "POST" && c.url.endsWith("/v2/pods")).map((c) => c.body as { mounts: Record<string, unknown> });
    expect(creates).toHaveLength(2);
    expect(Object.keys(creates[0]!.mounts)).toEqual(["network"]);
    expect(Object.keys(creates[1]!.mounts)).toEqual(["global"]);
    scenario.volumeKind = "network";
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
    const creates = calls.slice(before).filter((c) => c.method === "POST" && c.url.endsWith("/pods")).map((c) => c.body as { dataCenterIds: string[]; mounts: { network: Array<{ volumeId: string }> }; gpu: { id: string }; disk: number; name: string });
    /* placements outermost, every allowed GPU type inside each; last, no volume in any data center */
    expect(creates).toHaveLength(12);
    expect([...new Set(creates.slice(0, 8).map((c) => c.mounts.network[0]!.volumeId))]).toEqual(["vol_eu", "vol_us"]);
    expect(creates.slice(8).every((c) => !c.mounts && !c.dataCenterIds && c.disk === 200 && c.name.endsWith("-local"))).toBe(true);
    expect(creates.slice(0, 8).every((c) => c.disk === 80)).toBe(true);
    expect(creates.slice(0, 4).every((c) => c.dataCenterIds[0] === "EU-RO-1" && c.mounts.network[0]!.volumeId === "vol_eu")).toBe(true);
    expect(creates.slice(4, 8).every((c) => c.dataCenterIds[0] === "US-TX-3" && c.mounts.network[0]!.volumeId === "vol_us")).toBe(true);
    expect(creates.slice(0, 4).map((c) => c.gpu.id)).toEqual(["NVIDIA H100 80GB HBM3", "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", "NVIDIA RTX PRO 6000 Blackwell Server Edition", "NVIDIA RTX PRO 6000 Blackwell Workstation Edition"]);
    scenario.createMode = "ok";
    delete process.env.RUNPOD_NETWORK_VOLUMES;
  });

  it("with no GPU in the volume's data center, starts a local-disk pod anywhere; once stopped, it is replaced and the volume tried first", async () => {
    process.env.RUNPOD_NETWORK_VOLUMES = "EU-RO-1:vol_eu";
    await gpu.terminateGpu();
    scenario.noresWithVolume = true;
    let state = await gpu.startGpu(web, true);
    expect(state.status).toBe("starting");
    expect(state.pod).toMatchObject({ dataCenter: "US-KS-2", name: "cinema-studio-h3-local" });
    expect(state.message).toMatch(/^without the model volume: no listed GPU in EU-RO-1/);
    /* stopped (idle), then started again: EU-RO-1 has a card now */
    await gpu.stopGpu();
    scenario.podStatus = "EXITED";
    expect((await gpu.getGpuState()).status).toBe("stopped");
    scenario.noresWithVolume = false;
    const before = calls.length;
    state = await gpu.startGpu(web, true);
    scenario.podStatus = "RUNNING";
    const after = calls.slice(before);
    expect(after.some((c) => c.method === "DELETE")).toBe(true);
    expect(after.some((c) => c.url.endsWith("/action") && (c.body as { action?: string } | undefined)?.action === "start")).toBe(false);
    const create = after.find((c) => c.method === "POST" && c.url.endsWith("/pods"))!.body as { mounts: { network: Array<{ volumeId: string }> }; dataCenterIds: string[]; disk: number };
    expect(create).toMatchObject({ dataCenterIds: ["EU-RO-1"], disk: 80 });
    expect(create.mounts.network[0]!.volumeId).toBe("vol_eu");
    expect(state.pod).toMatchObject({ dataCenter: "EU-RO-1", name: "cinema-studio-h3" });
    delete process.env.RUNPOD_NETWORK_VOLUMES;
  });

  it("while the pod downloads models, or lacks a model's files, GPU work is refused with the reason", async () => {
    await gpu.terminateGpu();
    scenario.createMode = "ok";
    await gpu.startGpu(web, true);
    scenario.health = { ok: true, models: { ready: true }, downloads: { active: true, gb_left: 42.5, current: "models-h3-image.txt minimax_h3_image_pruned_int8_convrot.safetensors 20979314802", failed: [], skipped: [] } };
    try {
    await gpu.refreshGpu();
    const state = await gpu.getGpuState();
    expect(state.status).toBe("starting");
    expect(state.message).toMatch(/downloading models: 42\.5 GB left \(now minimax_h3_image_pruned_int8_convrot\.safetensors\)/);
    await expect(gpu.assertPodCanWork("a take")).rejects.toThrow(/still downloading models \(42\.5 GB left, now minimax_h3_image_pruned_int8_convrot\.safetensors\): a take now would crawl/);
    /* done downloading, but one file of the model failed */
    scenario.health = { ok: true, models: { ready: true }, downloads: { active: false, gb_left: 21, failed: ["models-h3-image.txt minimax_h3_image_pruned_int8_convrot.safetensors"], skipped: [] },
      image_models: { "minimax-h3-image": { ready: false, missing: ["diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors"] }, "another-pod-model": { ready: true, missing: [] } } };
    await expect(gpu.assertPodCanWork("a picture", { id: "minimax-h3-image", label: "MiniMax H3 Image" })).rejects.toThrow(/MiniMax H3 Image is not on the GPU pod whole yet \(missing: minimax_h3_image_pruned_int8_convrot\.safetensors; the last download failed for minimax_h3_image_pruned_int8_convrot\.safetensors\)\. Restart the pod/);
    await expect(gpu.assertPodCanWork("a picture", { id: "another-pod-model", label: "Another pod model" })).resolves.toBeUndefined();
    await expect(gpu.assertPodCanWork("a take")).resolves.toBeUndefined();
    await gpu.refreshGpu();
    expect((await gpu.getGpuState()).status).toBe("running");
    } finally {
      scenario.health = undefined;
    }
  });

  it("RUNPOD_VOLUME_FALLBACK=none waits for the volume's data center instead", async () => {
    Object.assign(process.env, { RUNPOD_NETWORK_VOLUMES: "EU-RO-1:vol_eu", RUNPOD_VOLUME_FALLBACK: "none" });
    await gpu.terminateGpu();
    scenario.noresWithVolume = true;
    const before = calls.length;
    const state = await gpu.startGpu(web, true);
    expect(state.status).toBe("unavailable");
    expect(calls.slice(before).filter((c) => c.method === "POST" && c.url.endsWith("/pods")).every((c) => (c.body as { mounts?: unknown }).mounts)).toBe(true);
    scenario.noresWithVolume = false;
    delete process.env.RUNPOD_NETWORK_VOLUMES;
    delete process.env.RUNPOD_VOLUME_FALLBACK;
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
    /* from the page a render waits for a running GPU: it is started first, as the Start button does */
    await gpu.startGpu(web, true);
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

  it("regenerates a completed take at 2K through the pod and the master-upscaled export uses it", async () => {
    const { mapRunPodStatus } = await import("@/studio/backends/runpod");
    const project = await repo.createProject({ name: "Regen", budgetCapUsd: 50 });
    const script = await repo.createScript(project.id, "x");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "s", shots: [shot()] }] }));
    await repo.setShotlistApproval(project.id, "approved");
    const sid = view.scenes[0]!.shots[0]!.id;
    scenario.podStatus = "RUNNING";
    scenario.healthy = true;
    await gpu.refreshGpu();
    const { takes } = await orch.createTakes(sid, { n: 1, confirm: true }, web);
    const take = await repo.getTake(takes[0]!.id);
    await orch.applyTakeStatus(take, mapRunPodStatus({ id: take.requestId!, status: "COMPLETED", executionTime: 60_000, output: { url: "https://r2/x.mp4", duration_s: 5 } }));
    /* not completed → refused; completed → queued and submitted as a REGEN job with the take's own prompt */
    await expect(orch.regenerateTake(take.id, { resolution: "2k", startSigma: 0.8, confirm: false }, mcp)).rejects.toMatchObject({ code: "needs_confirm" });
    const before = calls.length;
    const { take: queued, estimate } = await orch.regenerateTake(take.id, { resolution: "2k", startSigma: 0.8, confirm: true }, mcp);
    expect(estimate.usd).toBeGreaterThan(0);
    expect(queued.upscale).toMatchObject({ status: "queued", resolution: "2k", startSigma: 0.8 });
    expect(queued.upscale!.requestId).toMatch(/^job-/);
    const run = calls.slice(before).find((c) => c.url.endsWith("/run"))!;
    const input = (run.body as { input: Record<string, unknown> }).input;
    expect(input.workflow).toBe("REGEN");
    expect(input.video).toBe("https://r2/x.mp4");
    expect(input.resolution).toBe("2k");
    expect(input.start_sigma).toBe(0.8);
    expect(input.decoder).toBe("fast"); // the test pod is an H100 80 GB
    expect(gpu.gpuVramGb("NVIDIA GeForce RTX 5090")).toBe(32);
    expect(gpu.gpuVramGb("NVIDIA RTX PRO 6000 Blackwell Workstation Edition")).toBe(96);
    expect(gpu.gpuVramGb("something new")).toBeUndefined();
    expect(String((run.body as { webhook: string }).webhook)).toContain("id=regen%3A");
    await expect(orch.regenerateTake(take.id, { resolution: "2k", startSigma: 0, confirm: true }, web)).rejects.toMatchObject({ code: "validation" });
    /* progress while running, then the 2K file lands beside the 768p one and is billed */
    const running = await orch.applyUpscaleStatus(await repo.getTake(take.id), { state: "running", progress: { stage: "upscaling" } });
    expect(running.upscale).toMatchObject({ status: "running", progress: { stage: "upscaling" } });
    const spentBefore = (await repo.getProject(project.id)).spentUsd;
    const done = await orch.applyUpscaleStatus(await repo.getTake(take.id), mapRunPodStatus({ id: queued.upscale!.requestId!, status: "COMPLETED", executionTime: 150_000, output: { url: "https://r2/x.2k.mp4", resolution: "2k", thumb_urls: ["https://r2/x.2k.thumbs/0.jpg"] } }));
    expect(done.upscale).toMatchObject({ status: "completed", url: "https://r2/x.2k.mp4" });
    expect(done.upscale!.costUsd).toBeCloseTo((150_000 / 3_600_000) * 2.5, 3);
    expect((await repo.getProject(project.id)).spentUsd).toBeGreaterThan(spentBefore);
    expect(done.resultUrl).toBe("https://r2/x.mp4");
    /* the export preset picks the 2K file */
    const { buildAssemblerInput } = await import("@/studio/backends/assembler");
    const shotRow = await repo.getShot(sid);
    const timeline = { clips: [{ shotId: sid, takeId: take.id, inS: 0, outS: 5, transition: "cut" as const }], music: undefined, mix: {} } as never;
    const upscaled = buildAssemblerInput({ exportId: "e", projectId: project.id, preset: "master-upscaled", look: project.look, timeline, shots: new Map([[sid, shotRow]]), takes: new Map([[take.id, done]]), elementNames: new Map(), burnIn: false, videoSize: "1344x768" });
    expect(upscaled.clips[0]!.url).toBe("https://r2/x.2k.mp4");
    const plain = buildAssemblerInput({ exportId: "e", projectId: project.id, preset: "master-768p", look: project.look, timeline, shots: new Map([[sid, shotRow]]), takes: new Map([[take.id, done]]), elementNames: new Map(), burnIn: false, videoSize: "1344x768" });
    expect(plain.clips[0]!.url).toBe("https://r2/x.mp4");
  });

  it("loads the turbo LoRA for the workflow and the shot's assigned LoRAs, as the shot's two switches say", async () => {
    const library = await repo.listLoras();
    const turboT2V = library.find((l) => l.kind === "speed" && l.workflows.includes("T2VA"))!;
    const turboR2V = library.find((l) => l.kind === "speed" && l.workflows.includes("R2VA"))!;
    expect(turboT2V.workflows).toContain("I2VA");
    const style = await repo.createLora({ name: "Neon noir", kind: "style", filename: "neon_noir.safetensors", triggerWords: "neon noir, wet asphalt", defaultStrength: 0.7, workflows: ["T2VA"], notes: "" });
    const project = await repo.createProject({ name: "Lora film" });
    const script = await repo.createScript(project.id, "x");
    await repo.approveScript(script.id);
    const view = await orch.saveShotlist(project.id, ShotlistInput.parse({ scenes: [{ slug: "s", shots: [shot(), shot()] }] }));
    const [a, b] = view.scenes[0]!.shots;
    await orch.assignLoras(project.id, [{ shotId: a!.id, loras: [{ id: style.id, strength: 0.5, why: "the wet night street" }] }]);

    /* both switches on (the default): one turbo LoRA, the one for T2VA, and the assigned one */
    const ca = await orch.compileForShot(a!.id);
    expect(ca.input.loras).toEqual([
      { name: turboT2V.name, file: turboT2V.filename, strength: turboT2V.defaultStrength, ...(turboT2V.hfUrl ? { hf_url: turboT2V.hfUrl } : {}), kind: "speed" },
      { name: "Neon noir", file: "neon_noir.safetensors", strength: 0.5, kind: "style" },
    ]);
    expect(ca.input.steps).toBe(8);
    expect(ca.input.sampling).toBeUndefined();
    expect(ca.prompt).toContain("neon noir, wet asphalt");

    /* use LoRA off: the turbo LoRA alone, and no trigger words */
    await orch.patchShot(a!.id, { useLoras: false });
    const off = await orch.compileForShot(a!.id);
    expect(off.input.loras.map((l) => l.name)).toEqual([turboT2V.name]);
    expect(off.prompt).not.toContain("neon noir");

    /* use turbo off: the base chain and 20 steps, unless the caller sets steps */
    await orch.patchShot(b!.id, { useTurbo: false });
    const cb = await orch.compileForShot(b!.id);
    expect(cb.input.loras).toEqual([]);
    expect(cb.input.steps).toBe(20);
    expect(cb.input.sampling).toEqual({ sampler: "res_multistep", scheduler: "simple", shift_video: 12, shift_audio: 3 });
    expect(cb.warnings.some((w) => w.includes("base sampling chain"))).toBe(true);
    const cb8 = await orch.compileForShot(b!.id, { steps: 8 });
    expect(cb8.input.steps).toBe(8);
    expect(cb8.warnings.some((w) => w.includes("wants about 20 steps"))).toBe(true);

    /* a keyframe shot: the turbo LoRA for I2VA; the T2VA-only style LoRA stays out, and the compiler says so */
    const hero = await repo.createAsset({ projectId: project.id, url: "https://r2/h.png", kind: "image", source: "upload" });
    await orch.patchShot(a!.id, { useLoras: true, mode: "keyframe", heroAssetId: hero.id });
    const ck = await orch.compileForShot(a!.id);
    expect(ck.workflow).toBe("I2VA");
    expect(ck.input.loras.map((l) => l.name)).toEqual([turboT2V.name]);
    expect(ck.warnings.some((w) => w.includes("Neon noir is not trained for I2VA"))).toBe(true);

    /* a reference shot: the ref2v turbo LoRA, never two */
    await orch.patchShot(b!.id, { useTurbo: true, mode: "reference", heroAssetId: hero.id });
    const cr = await orch.compileForShot(b!.id);
    expect(cr.workflow).toBe("R2VA");
    expect(cr.input.loras.map((l) => l.name)).toEqual([turboR2V.name]);
  });
});
