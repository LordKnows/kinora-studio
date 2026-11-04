import { assertConfirmed } from "./checkpoints";
import { config } from "./config";
import { StudioError } from "./errors";
import * as repo from "./repo";
import { PodBackend } from "./backends/pod";
import { KNOWN_GPU_TYPES, KNOWN_GPU_TYPE_SET, RunPodPodsClient, podProxyUrl, type GpuType } from "./backends/runpod-pods";
import type { Actor, GpuTypeStats } from "./types";

/* Pod mode: the studio owns one RunPod pod. It is created on the first
   render, started and stopped from the web UI or the agent, stopped by the
   sweep after idling, and replaced when a stopped pod cannot get its GPU back
   (common: stopped pods lose their card). Only the GPU types on the
   allow-list are ever requested; when none has capacity the state says so. */

export type GpuStatus = repo.GpuPodStatus | "none";

export type GpuState = {
  mode: "pod" | "serverless";
  configured: boolean;
  status: GpuStatus;
  message?: string;
  pod?: { id: string; name: string; gpuName?: string; gpuTypeId?: string; dataCenter?: string; costPerHr?: number; hostUrl?: string; createdAt: number; startedAt?: number; lastActivityAt?: number; adopted?: boolean };
  uptimeSeconds: number;
  sessionUsd: number;
  lifetimeUsd: number;
  allowedGpuTypes: string[];
  idleStopMinutes: number;
  pendingTakes: number;
};

const UNAVAILABLE_PREFIX = "unavailable_";

function pods(): RunPodPodsClient {
  return new RunPodPodsClient(config.runpod().apiKey, { version: config.runpodPod().api });
}

export function gpuConfigured(): boolean {
  try {
    config.runpod();
    config.runpodPod();
    return true;
  } catch {
    return false;
  }
}

function podEnv(): Record<string, string> {
  const r2 = config.r2();
  const pod = config.runpodPod();
  return {
    R2_ENDPOINT: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    R2_BUCKET: r2.bucket,
    R2_ACCESS_KEY_ID: r2.accessKeyId,
    R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
    R2_PUBLIC_BASE_URL: r2.publicBaseUrl,
    STUDIO_WORKER_TOKEN: pod.workerToken,
    STUDIO_PORT: String(pod.podPort),
    COMFY_URL: `http://127.0.0.1:${pod.comfyPort}`,
    STUDIO_BUNDLE_URL: `${config.publicUrl()}/api/pod/bundle?token=${encodeURIComponent(pod.workerToken)}`,
    STUDIO_VOLUME_PATH: pod.volumeMountPath,
  };
}

/* On a stock ComfyUI image the pod boots the image's own entrypoint (ComfyUI,
   Jupyter) and then pulls the studio job server from the Studio and runs it.
   Idempotent across restarts; everything lands under /app/h3-runpod. */
export function bootstrapCommand(): string[] {
  /* No quote characters inside the script: the RunPod console takes the
     command as one string and splits it shell-style, so the script is wrapped
     in single quotes there and must not contain any. Every failure is logged
     and followed by a long sleep so the pod's container log shows the reason
     instead of a bare restart loop. */
  const script = [
    "mkdir -p /app",
    "cd /app",
    "command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl >/dev/null 2>&1) || true",
    "for i in 1 2 3 4 5 6; do echo [studio] fetching job server, attempt $i; if curl -fsSL -A Mozilla/5.0 -o /app/bundle.tgz $STUDIO_BUNDLE_URL; then break; fi; sleep 10; done",
    "if ! test -s /app/bundle.tgz; then echo [studio] cannot fetch the job server from $STUDIO_BUNDLE_URL - is /api/pod/ in the Access bypass list and STUDIO_WORKER_TOKEN the same as in the Studio; sleep 600; exit 1; fi",
    "tar xzf /app/bundle.tgz || (echo [studio] bundle is not a tarball; head -c 300 /app/bundle.tgz; sleep 600; exit 1)",
    "python3 -m pip install -q requests boto3 >/dev/null 2>&1 || true",
    "command -v ffmpeg >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null 2>&1) || true",
    "echo [studio] starting ComfyUI and the job server",
    "bash /app/h3-runpod/start.sh",
    "echo [studio] job server exited with status $?; sleep 600; exit 1",
  ].join("; ");
  return ["bash", "-lc", script];
}

/** The same command as one line for the RunPod console (single-quoted). */
export function bootstrapCommandLine(): string {
  return bootstrapCommand().map((p) => (p.includes(" ") ? `'${p}'` : p)).join(" ");
}

export async function getGpuState(): Promise<GpuState> {
  const mode = config.runpodMode();
  const configured = gpuConfigured();
  let allowed: string[] = [];
  let idle = 15;
  if (configured) {
    const pc = config.runpodPod();
    allowed = pc.gpuTypeIds;
    idle = pc.idleStopMinutes;
  }
  const pod = await repo.currentGpuPod();
  const pending = (await repo.listPendingTakes()).length;
  if (!pod) return { mode, configured, status: "none", uptimeSeconds: 0, sessionUsd: 0, lifetimeUsd: 0, allowedGpuTypes: allowed, idleStopMinutes: idle, pendingTakes: pending };
  const uptime = pod.status === "running" || pod.status === "starting" ? Math.max(0, Math.floor((Date.now() - (pod.startedAt ?? pod.createdAt)) / 1000)) : 0;
  const rate = (pod.costPerHr ?? 0) / 3600;
  return {
    mode, configured, status: pod.status, message: pod.message,
    pod: { id: pod.id, name: pod.name, gpuName: pod.gpuName, gpuTypeId: pod.gpuTypeId, dataCenter: pod.dataCenter, costPerHr: pod.costPerHr, hostUrl: pod.hostUrl, createdAt: pod.createdAt, startedAt: pod.startedAt, lastActivityAt: pod.lastActivityAt, adopted: pod.adopted },
    uptimeSeconds: uptime,
    sessionUsd: round(uptime * rate),
    lifetimeUsd: round((pod.accumulatedSeconds + uptime) * rate),
    allowedGpuTypes: allowed, idleStopMinutes: idle, pendingTakes: pending,
  };
}

export function podBackend(pod: repo.GpuPod, kind: "video" | "assemble" = "video"): PodBackend {
  if (!pod.hostUrl) throw new StudioError("backend_error", "pod has no host url yet");
  return new PodBackend({ hostUrl: pod.hostUrl, token: config.runpodPod().workerToken, kind });
}

/** Ask RunPod and the pod itself where things stand, and persist it. */
export async function refreshGpu(): Promise<repo.GpuPod | undefined> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status === "unavailable" || pod.status === "terminated" || pod.id.startsWith(UNAVAILABLE_PREFIX)) return pod;
  const record = await pods().getPod(pod.id);
  if (!record) return repo.updateGpuPod(pod.id, { status: "terminated", message: "pod no longer exists on RunPod", stoppedAt: Date.now() });
  const desired = record.desiredStatus.toUpperCase();
  const patch: Parameters<typeof repo.updateGpuPod>[1] = {
    costPerHr: record.costPerHr, gpuTypeId: record.gpuTypeId, gpuName: record.gpuDisplayName, dataCenter: record.dataCenterId,
    hostUrl: podProxyUrl(pod.id, config.runpodPod().podPort),
  };
  if (desired === "RUNNING") {
    const health = await new PodBackend({ hostUrl: patch.hostUrl!, token: config.runpodPod().workerToken }).health();
    patch.status = health.ok ? "running" : "starting";
    const ports = record.exposedPorts.length ? ` RunPod reports exposed ports: ${record.exposedPorts.join(", ")}.` : " RunPod reports no exposed ports yet.";
    patch.message = health.ok ? null : `booting: ${health.why ?? "not answering yet"}${/\(404\)|404/.test(health.why ?? "") ? ports : ""}`;
    if (pod.status !== "running" && pod.status !== "starting") patch.startedAt = Date.now();
    else if (!pod.startedAt) patch.startedAt = Date.now();
  } else if (desired === "EXITED" || desired === "STOPPED" || desired === "TERMINATED") {
    if (pod.status === "running" || pod.status === "starting" || pod.status === "stopping") {
      patch.accumulatedSeconds = pod.accumulatedSeconds + Math.max(0, Math.floor((Date.now() - (pod.startedAt ?? pod.createdAt)) / 1000));
      patch.stoppedAt = Date.now();
      patch.startedAt = null;
    }
    patch.status = desired === "TERMINATED" ? "terminated" : "stopped";
    patch.message = null;
  }
  return repo.updateGpuPod(pod.id, patch);
}

/** Make sure a pod is on its way up. Resume the stopped one if RunPod still
    has a card for it; otherwise terminate it and create a fresh pod on the
    allow-list. "unavailable" is the answer when no listed GPU has capacity. */
export async function startGpu(actor: Actor, confirm: boolean): Promise<GpuState> {
  if (!gpuConfigured()) throw new StudioError("backend_error", "RunPod pod mode is not configured (RUNPOD_API_KEY, RUNPOD_POD_IMAGE, STUDIO_WORKER_TOKEN, R2_*)");
  const pc = config.runpodPod();
  if (pc.gpuTypeIds.length === 0) throw new StudioError("validation", "RUNPOD_GPU_TYPES is empty: list the GPU types the pod may use");
  let pod = await refreshGpu();
  if (pod && (pod.status === "running" || pod.status === "starting" || pod.status === "creating")) return getGpuState();
  if (actor.via === "mcp") assertConfirmed(confirm, estimatedPodUsdPerHour(pod), "starting the GPU pod (billed per hour while it runs)");

  const client = pods();
  /* A stopped pod is resumed; an adopted pod that could not get its GPU
     last time is retried the same way, never replaced by a new one. */
  if (pod && (pod.status === "stopped" || (pod.adopted && pod.status === "unavailable"))) {
    try {
      if (pod.adopted && pc.bootstrap) await applyBoot(pod.id, { restart: false });
      const record = await client.startPod(pod.id);
      await repo.updateGpuPod(pod.id, { status: "starting", message: "resuming", startedAt: Date.now(), costPerHr: record.costPerHr, hostUrl: podProxyUrl(pod.id, pc.podPort) });
      return getGpuState();
    } catch (caught) {
      const why = caught instanceof Error ? caught.message : String(caught);
      if (pod.adopted) {
        /* A hand-made pod is never replaced: say so and let the user resume it in the console. */
        await repo.updateGpuPod(pod.id, { status: "unavailable", message: `暂时没资源 — resume failed (${why}). This pod was created by hand; start it in the RunPod console or adopt another.` });
        return getGpuState();
      }
      /* The stopped pod lost its GPU: let it go and start over on the allow-list. */
      try {
        await client.terminatePod(pod.id);
      } catch {
        /* already gone */
      }
      await repo.updateGpuPod(pod.id, { status: "terminated", message: `resume failed (${why}); replaced`, stoppedAt: Date.now() });
      pod = undefined;
    }
  }

  /* GPU types × placements: RunPod tries every allowed GPU inside one call;
     we walk the placements (one model volume per data center) ourselves. */
  const gpuTypeIds = await prioritizedGpuTypes();
  if (gpuTypeIds.length === 0) {
    await repo.insertGpuPod({ id: `${UNAVAILABLE_PREFIX}${Date.now()}`, name: pc.podName, image: pc.image, status: "unavailable", message: `none of RUNPOD_GPU_TYPES [${pc.gpuTypeIds.join(", ")}] matches a RunPod GPU type` });
    return getGpuState();
  }
  const attempts: string[] = [];
  /* v1 takes the whole allow-list in one call; v2 takes one GPU type per
     call, so the walk is GPU types × placements, priority order first. */
  const gpuBatches = client.version === "v2" ? gpuTypeIds.map((id) => [id]) : [gpuTypeIds];
  for (const placement of await podPlacements()) {
    for (const batch of gpuBatches) {
      try {
        const record = await client.createPod({
          name: pc.podName,
          imageName: pc.image,
          gpuTypeIds: batch,
          cloudType: pc.cloudType,
          containerDiskInGb: pc.containerDiskGb,
          volumeMountPath: pc.volumeMountPath,
          networkVolumeId: placement.networkVolumeId,
          dataCenterIds: placement.dataCenterIds,
          ports: [`${pc.podPort}/http`, `${pc.comfyPort}/http`],
          env: podEnv(),
          allowedCudaVersions: pc.cudaVersions,
          ...(pc.bootstrap ? { dockerStartCmd: bootstrapCommand(), dockerStartLine: bootstrapCommandLine() } : {}),
        }, pc.bodyOverrides);
        await repo.insertGpuPod({
          id: record.id, name: record.name || pc.podName, image: pc.image, gpuTypeId: record.gpuTypeId ?? batch[0], gpuName: record.gpuDisplayName,
          dataCenter: record.dataCenterId ?? placement.dataCenterIds[0],
          status: "starting", message: "created; pulling the image and loading models", costPerHr: record.costPerHr, hostUrl: podProxyUrl(record.id, pc.podPort),
        });
        await repo.updateGpuPod(record.id, { startedAt: Date.now() });
        return getGpuState();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const noResources = caught instanceof StudioError && Boolean((caught.details as { noResources?: boolean } | undefined)?.noResources);
        attempts.push(`${placement.dataCenterIds.join("/") || "any"} × ${batch.length === 1 ? batch[0] : "allow-list"}: ${message}`);
        if (!noResources) {
          await repo.insertGpuPod({ id: `${UNAVAILABLE_PREFIX}${Date.now()}`, name: pc.podName, image: pc.image, status: "unavailable", message: `pod creation failed: ${message}` });
          throw caught;
        }
      }
    }
  }
  await repo.insertGpuPod({
    id: `${UNAVAILABLE_PREFIX}${Date.now()}`, name: pc.podName, image: pc.image, status: "unavailable",
    message: `暂时没资源 — none of [${gpuTypeIds.join(", ")}] has capacity in any placement right now (${attempts.join(" | ")})`,
  });
  return getGpuState();
}

export async function stopGpu(): Promise<GpuState> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.id.startsWith(UNAVAILABLE_PREFIX) || pod.status === "stopped" || pod.status === "terminated") return getGpuState();
  await repo.updateGpuPod(pod.id, { status: "stopping", message: "stopping" });
  try {
    await pods().stopPod(pod.id);
  } catch (caught) {
    await repo.updateGpuPod(pod.id, { status: "running", message: `stop failed: ${caught instanceof Error ? caught.message : caught}` });
    throw caught;
  }
  const uptime = Math.max(0, Math.floor((Date.now() - (pod.startedAt ?? pod.createdAt)) / 1000));
  await repo.updateGpuPod(pod.id, { status: "stopped", message: null, stoppedAt: Date.now(), startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime });
  return getGpuState();
}

export async function terminateGpu(): Promise<GpuState> {
  const pod = await repo.currentGpuPod();
  if (!pod) return getGpuState();
  if (!pod.id.startsWith(UNAVAILABLE_PREFIX) && pod.status !== "terminated") {
    try {
      await pods().terminatePod(pod.id);
    } catch (caught) {
      const status = (caught as StudioError).details as { status?: number } | undefined;
      if (status?.status !== 404) throw caught;
    }
  }
  const uptime = pod.status === "running" || pod.status === "starting" ? Math.max(0, Math.floor((Date.now() - (pod.startedAt ?? pod.createdAt)) / 1000)) : 0;
  await repo.updateGpuPod(pod.id, { status: "terminated", message: null, stoppedAt: Date.now(), startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime });
  return getGpuState();
}

export async function touchGpuActivity(): Promise<void> {
  const pod = await repo.currentGpuPod();
  if (pod && !pod.id.startsWith(UNAVAILABLE_PREFIX)) await repo.updateGpuPod(pod.id, { lastActivityAt: Date.now() });
}

/** Called by the sweep: stop a running pod that has had nothing to do. */
export async function autoStopIfIdle(hasWork: boolean): Promise<boolean> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running" || hasWork) return false;
  const since = Math.max(pod.lastActivityAt ?? 0, pod.startedAt ?? pod.createdAt);
  if (Date.now() - since < config.runpodPod().idleStopMinutes * 60_000) return false;
  await stopGpu();
  await repo.updateGpuPod(pod.id, { message: `auto-stopped after ${config.runpodPod().idleStopMinutes} idle minutes` });
  return true;
}

export async function listGpuTypes(): Promise<Array<GpuType & { allowed: boolean }>> {
  const types = await pods().listGpuTypes();
  const allowed = new Set(await resolveGpuTypeIds(config.runpodPod().gpuTypeIds, types));
  return types.map((t) => ({ ...t, allowed: allowed.has(t.id) })).sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.displayName.localeCompare(b.displayName));
}

/** The per-GPU-type ledger: speed and price per second of video. */
export async function gpuStats(): Promise<GpuTypeStats[]> {
  return repo.gpuTypeStats();
}

/** Measured speed for estimates: the running pod's GPU type when known,
    otherwise the cheapest-per-video-second type we have data for. */
export async function measuredForEstimate(): Promise<{ secondsPerOutputSecond?: number; usdPerHr?: number; gpuTypeId?: string }> {
  const stats = await repo.gpuTypeStats();
  if (stats.length === 0) return {};
  const pod = await repo.currentGpuPod();
  const current = pod?.gpuTypeId ? stats.find((s) => s.gpuTypeId === pod.gpuTypeId) : undefined;
  const pick = current ?? [...stats].sort((a, b) => (a.usdPerVideoSecond ?? Infinity) - (b.usdPerVideoSecond ?? Infinity))[0]!;
  return { secondsPerOutputSecond: pick.secondsPerOutputSecond || undefined, usdPerHr: pod?.costPerHr ?? pick.usdPerHr, gpuTypeId: pick.gpuTypeId };
}

/** RUNPOD_GPU_TYPES entries are matched case-insensitively as substrings of
    the gpuTypeIds POST /pods accepts ("RTX 5090" → "NVIDIA GeForce RTX 5090"),
    so the allow-list survives RunPod's naming. Exact ids pass through. Only
    ids in RunPod's enum are ever sent. Order = priority. */
export async function resolveGpuTypeIds(patterns: string[], known?: Array<{ id: string }>): Promise<string[]> {
  const universe = [...KNOWN_GPU_TYPES, ...(known ?? []).map((t) => t.id).filter((id) => KNOWN_GPU_TYPE_SET.has(id))];
  const ids = [...new Set(universe)];
  const out: string[] = [];
  for (const pattern of patterns) {
    const needle = pattern.toLowerCase();
    const matches = ids.includes(pattern) ? [pattern] : ids.filter((id) => id.toLowerCase().includes(needle));
    for (const m of matches) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** The allow-list in the order a pod should try it. RUNPOD_GPU_PRIORITY=cost
    sorts by measured USD per second of video (unknown types last); otherwise
    the configured order stands and RunPod picks by availability. */
export async function prioritizedGpuTypes(known?: Array<{ id: string }>): Promise<string[]> {
  const ids = await resolveGpuTypeIds(config.runpodPod().gpuTypeIds, known);
  if ((process.env.RUNPOD_GPU_PRIORITY ?? "availability") !== "cost") return ids;
  const stats = new Map((await repo.gpuTypeStats()).map((s) => [s.gpuTypeId, s.usdPerVideoSecond ?? Infinity]));
  return [...ids].sort((a, b) => (stats.get(a) ?? Infinity) - (stats.get(b) ?? Infinity));
}

/** Where a pod may live: one entry per model volume (each volume pins its
    data center). The data center of the last pod goes first. */
export async function podPlacements(): Promise<Array<{ dataCenterIds: string[]; networkVolumeId?: string }>> {
  const pc = config.runpodPod();
  const list = pc.volumes.length
    ? pc.volumes.map((v) => ({ dataCenterIds: v.dataCenterId ? [v.dataCenterId] : [], networkVolumeId: v.volumeId }))
    : [{ dataCenterIds: pc.dataCenterIds, networkVolumeId: pc.networkVolumeId }];
  const last = (await repo.listGpuPods(5)).find((p) => p.dataCenter)?.dataCenter;
  if (last) list.sort((a, b) => Number(b.dataCenterIds.includes(last)) - Number(a.dataCenterIds.includes(last)));
  return list;
}

/** Take over a pod created in the RunPod console (the way around volume
    types the API cannot attach yet). The studio then starts, stops and uses
    it like its own, but never terminates and replaces it. */
export async function adoptPod(podId: string): Promise<GpuState> {
  const pc = config.runpodPod();
  const record = await pods().getPod(podId);
  if (!record) throw new StudioError("not_found", `RunPod has no pod ${podId} for this API key`);
  const current = await repo.currentGpuPod();
  if (current && current.id !== podId && !current.id.startsWith(UNAVAILABLE_PREFIX)) {
    await repo.updateGpuPod(current.id, { status: "terminated", message: `replaced by adopted pod ${podId}` });
  }
  const running = record.desiredStatus.toUpperCase() === "RUNNING";
  await repo.insertGpuPod({
    id: record.id, name: record.name || podId, image: pc.image, gpuTypeId: record.gpuTypeId, gpuName: record.gpuDisplayName, dataCenter: record.dataCenterId,
    status: running ? "starting" : "stopped", message: running ? "adopted; checking the job server" : "adopted (stopped)", costPerHr: record.costPerHr,
    hostUrl: podProxyUrl(record.id, pc.podPort), adopted: true,
  });
  if (running) await repo.updateGpuPod(record.id, { startedAt: Date.now() });
  if (pc.bootstrap) {
    try {
      await applyBoot(record.id, { restart: running });
    } catch (caught) {
      await repo.updateGpuPod(record.id, { message: `adopted; boot command not applied (${caught instanceof Error ? caught.message : caught}) — set it in the console or use Apply boot` });
      return getGpuState();
    }
  }
  await refreshGpu();
  return getGpuState();
}

/** Put the studio's start command and env on a pod that was created by
    hand, so the job server comes up at boot without console edits. Env the
    pod already has is kept when RunPod returns it; the studio's keys win.
    With restart, a running pod is restarted so the change takes effect. */
export async function applyBoot(podId: string, opts: { restart: boolean }): Promise<{ restarted: boolean; envKept: number }> {
  const client = pods();
  const raw = await client.getPodRaw(podId);
  if (!raw) throw new StudioError("not_found", `RunPod has no pod ${podId}`);
  const existing = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? (raw.env as Record<string, unknown>) : {};
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) if (typeof v === "string") kept[k] = v;
  await client.updatePod(podId, { args: bootstrapCommandLine(), env: { ...kept, ...podEnv() } });
  const status = String(raw.status ?? raw.desiredStatus ?? "").toUpperCase();
  const running = status === "RUNNING" || status === "STARTING";
  let restarted = false;
  if (opts.restart && running) {
    await client.restartPod(podId);
    restarted = true;
    await repo.updateGpuPod(podId, { status: "starting", message: "boot command applied; restarting", startedAt: Date.now() });
  } else {
    await repo.updateGpuPod(podId, { message: running ? "boot command applied; takes effect on the next restart" : "boot command applied" });
  }
  return { restarted, envKept: Object.keys(kept).length };
}

/** Web action: apply the boot command to the current pod and restart it. */
export async function repairGpu(): Promise<GpuState & { repair: { restarted: boolean; envKept: number } }> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.id.startsWith(UNAVAILABLE_PREFIX) || pod.status === "terminated") throw new StudioError("not_found", "no pod to repair");
  const repair = await applyBoot(pod.id, { restart: true });
  return { ...(await getGpuState()), repair };
}

/** Everything to paste into the RunPod console when creating the pod by hand. */
export function manualPodRecipe(): { image: string; ports: string[]; containerDiskGb: number; volumeMountPath: string; env: Record<string, string>; dockerStartCmd: string; gpuTypes: string[]; notes: string[] } {
  const pc = config.runpodPod();
  return {
    image: pc.image,
    ports: [`${pc.podPort}/http`, `${pc.comfyPort}/http`],
    containerDiskGb: pc.containerDiskGb,
    volumeMountPath: pc.volumeMountPath,
    env: podEnv(),
    dockerStartCmd: pc.bootstrap ? bootstrapCommandLine() : "(image default)",
    gpuTypes: pc.gpuTypeIds,
    notes: [
      "Attach the model volume (minimax-h3-models) at the mount path. A global volume must NOT be mounted at /workspace: the image cannot build its Python env there.",
      "Expose the HTTP ports; the studio reaches the job server through RunPod's proxy on the first port.",
      "Paste the env vars exactly; STUDIO_BUNDLE_URL carries the worker token.",
      "With RUNPOD_API=v2 the start command and env are applied by the studio when you adopt the pod; pasting them is only needed on v1.",
      "After the pod is created, paste its id into Settings → GPU pod → Adopt.",
    ],
  };
}

/** What RunPod shows this key: the volumes it can attach, with the one the
    studio is configured to use flagged. */
export async function listVolumes(): Promise<{ configured: string | undefined; volumes: Array<{ id: string; name: string; size?: number; dataCenterId?: string; isConfigured: boolean }>; raw: unknown }> {
  const pc = config.runpodPod();
  const configured = pc.volumes[0]?.volumeId ?? pc.networkVolumeId;
  const { volumes, raw } = await pods().listNetworkVolumes();
  return { configured, volumes: volumes.map((v) => ({ ...v, isConfigured: v.id === configured })), raw };
}

export function estimatedPodUsdPerHour(pod?: repo.GpuPod): number {
  return pod?.costPerHr ?? Number(process.env.RUNPOD_POD_USD_PER_HOUR ?? "3");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
