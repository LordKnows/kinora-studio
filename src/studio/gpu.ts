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
  pod?: { id: string; name: string; gpuName?: string; gpuTypeId?: string; dataCenter?: string; costPerHr?: number; hostUrl?: string; createdAt: number; startedAt?: number; lastActivityAt?: number };
  uptimeSeconds: number;
  sessionUsd: number;
  lifetimeUsd: number;
  allowedGpuTypes: string[];
  idleStopMinutes: number;
  pendingTakes: number;
};

const UNAVAILABLE_PREFIX = "unavailable_";

function pods(): RunPodPodsClient {
  return new RunPodPodsClient(config.runpod().apiKey);
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
  };
}

/* On a stock ComfyUI image the pod boots the image's own entrypoint (ComfyUI,
   Jupyter) and then pulls the studio job server from the Studio and runs it.
   Idempotent across restarts; everything lands under /app/h3-runpod. */
export function bootstrapCommand(): string[] {
  const script = [
    "set -e",
    "mkdir -p /app && cd /app",
    'curl -fsSL -A "Mozilla/5.0 CinemaStudio" "$STUDIO_BUNDLE_URL" | tar xz',
    "python3 -m pip install -q requests boto3 >/dev/null 2>&1 || true",
    "command -v ffmpeg >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null 2>&1) || true",
    "exec bash /app/h3-runpod/start.sh",
  ].join(" && ");
  return ["bash", "-lc", script];
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
    pod: { id: pod.id, name: pod.name, gpuName: pod.gpuName, gpuTypeId: pod.gpuTypeId, dataCenter: pod.dataCenter, costPerHr: pod.costPerHr, hostUrl: pod.hostUrl, createdAt: pod.createdAt, startedAt: pod.startedAt, lastActivityAt: pod.lastActivityAt },
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
    const healthy = (await new PodBackend({ hostUrl: patch.hostUrl!, token: config.runpodPod().workerToken }).health()).ok;
    patch.status = healthy ? "running" : "starting";
    patch.message = healthy ? null : "booting: ComfyUI and the job server are not answering yet";
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
  if (pod && pod.status === "stopped") {
    try {
      const record = await client.startPod(pod.id);
      await repo.updateGpuPod(pod.id, { status: "starting", message: "resuming", startedAt: Date.now(), costPerHr: record.costPerHr, hostUrl: podProxyUrl(pod.id, pc.podPort) });
      return getGpuState();
    } catch (caught) {
      /* The stopped pod lost its GPU: let it go and start over on the allow-list. */
      const why = caught instanceof Error ? caught.message : String(caught);
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
  for (const placement of await podPlacements()) {
    try {
      const record = await client.createPod({
        name: pc.podName,
        imageName: pc.image,
        gpuTypeIds,
        cloudType: pc.cloudType,
        containerDiskInGb: pc.containerDiskGb,
        volumeMountPath: pc.volumeMountPath,
        networkVolumeId: placement.networkVolumeId,
        dataCenterIds: placement.dataCenterIds,
        ports: [`${pc.podPort}/http`, `${pc.comfyPort}/http`],
        env: podEnv(),
        allowedCudaVersions: pc.cudaVersions,
        ...(pc.bootstrap ? { dockerStartCmd: bootstrapCommand() } : {}),
      }, pc.bodyOverrides);
      await repo.insertGpuPod({
        id: record.id, name: record.name || pc.podName, image: pc.image, gpuTypeId: record.gpuTypeId, gpuName: record.gpuDisplayName,
        dataCenter: record.dataCenterId ?? placement.dataCenterIds[0],
        status: "starting", message: "created; pulling the image and loading models", costPerHr: record.costPerHr, hostUrl: podProxyUrl(record.id, pc.podPort),
      });
      await repo.updateGpuPod(record.id, { startedAt: Date.now() });
      return getGpuState();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const noResources = caught instanceof StudioError && Boolean((caught.details as { noResources?: boolean } | undefined)?.noResources);
      attempts.push(`${placement.dataCenterIds.join("/") || "any"}: ${message}`);
      if (!noResources) {
        await repo.insertGpuPod({ id: `${UNAVAILABLE_PREFIX}${Date.now()}`, name: pc.podName, image: pc.image, status: "unavailable", message: `pod creation failed: ${message}` });
        throw caught;
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
