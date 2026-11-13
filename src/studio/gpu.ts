import { assertConfirmed } from "./checkpoints";
import { config } from "./config";
import { StudioError } from "./errors";
import * as repo from "./repo";
import { PodBackend, type PodDownloads } from "./backends/pod";
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
    /* The pod is also the fallback painter (workers/painter): it claims image
       jobs from the Studio like any painter while it runs. Codex's login
       lives on the volume; the API path needs the key. */
    STUDIO_URL: config.publicUrl(),
    ...(config.painterOnPod() ? { PAINTER_ON_POD: "1", PAINTER_TOKEN: config.painterToken() ?? pod.workerToken, PAINTER_NAME: "gpu-pod" } : { PAINTER_ON_POD: "0" }),
    ...imagesApiEnv(),
  };
}

function imagesApiEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  /* H3_IMAGE=0: skip MiniMax-H3-Image's download on the GPU pod; COMFY_PAINT_TIMEOUT_S: how long a picture may wait in the pod's ComfyUI queue;
     COMFYUI_VERSION: the ComfyUI release the pod runs in place of the image's (start.sh; "image" = the image's own);
     REGEN_2K=0: no Open-H3-Regenerate-2K (21 GB, node packs) on the pod */
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "IMAGE_MODEL", "CODEX_PAINT_MODEL", "H3_IMAGE", "COMFY_PAINT_TIMEOUT_S", "COMFYUI_VERSION", "REGEN_2K"]) {
    const v = process.env[name];
    if (v) out[name] = v;
  }
  return out;
}

/* ---- the pod's Viggle Remake models (pictures are drawn by painters: painter.ts) ---- */

async function runningPodBackend(): Promise<PodBackend> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running" || !pod.hostUrl) throw new StudioError("backend_error", "the GPU pod is not running: start it on the Machine page first", { podStatus: pod?.status ?? "none" });
  return podBackend(pod);
}

export async function remakeStatus(): Promise<unknown> {
  return (await runningPodBackend()).request("GET", "/remake/status");
}

export async function remakeInstall(modes: Array<"edit" | "swap">): Promise<unknown> {
  return (await runningPodBackend()).request("POST", "/remake/install", { modes });
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
    /* Every attempt is bounded (a stalled connection used to hang the boot at attempt 1 for good), every
       second one forces IPv4 (a host whose IPv6 route stalls), and after the first failure one probe per
       IP family says where it stops: connect, TLS or the answer. */
    "for i in 1 2 3 4 5 6; do fam=; if [ $((i % 2)) = 0 ]; then fam=-4; fi; echo [studio] fetching job server, attempt $i $fam; curl -fsSL $fam --connect-timeout 20 --max-time 120 -A Mozilla/5.0 -o /app/bundle.tgz $STUDIO_BUNDLE_URL; rc=$?; if [ $rc = 0 ]; then break; fi; echo [studio] attempt $i failed, curl exit $rc; if [ $i = 1 ]; then for v in -4 -6; do curl -sS -o /dev/null $v --connect-timeout 10 --max-time 30 -A Mozilla/5.0 -w [studio]probe$v:connect=%{time_connect}s/tls=%{time_appconnect}s/http=%{http_code} $STUDIO_BUNDLE_URL; echo; done; fi; sleep 10; done",
    "if ! test -s /app/bundle.tgz; then echo [studio] cannot fetch the job server from $STUDIO_BUNDLE_URL - is /api/pod/ in the Access bypass list and STUDIO_WORKER_TOKEN the same as in the Studio; sleep 600; exit 1; fi",
    "tar xzf /app/bundle.tgz || (echo [studio] bundle is not a tarball; head -c 300 /app/bundle.tgz; sleep 600; exit 1)",
    "python3 -m pip install -q requests boto3 websocket-client >/dev/null 2>&1 || true",
    "(command -v ffmpeg >/dev/null 2>&1 && command -v aria2c >/dev/null 2>&1) || (apt-get update -qq && apt-get install -y -qq ffmpeg aria2 >/dev/null 2>&1) || true",
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

export function podBackend(pod: repo.GpuPod, kind: "video" | "assemble" | "voice" = "video"): PodBackend {
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
  /* A stopped pod the fallback started (no model volume) is let go: resuming it would download the models
     again in its data center; a fresh start tries the volume first. */
  if (pod && pod.status === "stopped" && !pod.adopted && isFallbackPod(pod)) {
    try {
      await client.terminatePod(pod.id);
    } catch {
      /* already gone */
    }
    await repo.updateGpuPod(pod.id, { status: "terminated", message: "a fallback pod without the model volume; replaced, the volume first", stoppedAt: Date.now() });
    pod = undefined;
  }
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
        const podName = placement.fallback ? `${pc.podName}${FALLBACK_SUFFIX}` : pc.podName;
        const record = await client.createPod({
          name: podName,
          imageName: pc.image,
          gpuTypeIds: batch,
          cloudType: pc.cloudType,
          /* on a volume the models live there: the container disk holds ComfyUI, its venv and outputs */
          containerDiskInGb: placement.networkVolumeId ? pc.volumeContainerDiskGb : pc.containerDiskGb,
          volumeMountPath: pc.volumeMountPath,
          networkVolumeId: placement.networkVolumeId,
          dataCenterIds: placement.dataCenterIds,
          ports: [`${pc.podPort}/http`, `${pc.comfyPort}/http`],
          env: podEnv(),
          allowedCudaVersions: pc.cudaVersions,
          /* As the entrypoint: runpod/comfyui's own ENTRYPOINT would otherwise swallow the command. */
          ...(pc.bootstrap ? { dockerEntrypoint: bootstrapCommand(), dockerStartCmd: bootstrapCommand(), dockerStartLine: bootstrapCommandLine() } : {}),
        }, pc.bodyOverrides);
        await repo.insertGpuPod({
          id: record.id, name: record.name || podName, image: pc.image, gpuTypeId: record.gpuTypeId ?? batch[0], gpuName: record.gpuDisplayName,
          dataCenter: record.dataCenterId ?? placement.dataCenterIds[0],
          status: "starting",
          message: placement.fallback
            ? `${FALLBACK_NOTE}: no listed GPU in ${podVolumeDcs().join(", ")}, so this pod downloads the models first (~145 GB, a slower start); the next start tries the volume again`
            : "created; pulling the image and loading models",
          costPerHr: record.costPerHr, hostUrl: podProxyUrl(record.id, pc.podPort),
        });
        await repo.updateGpuPod(record.id, { startedAt: Date.now() });
        return getGpuState();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const noResources = caught instanceof StudioError && Boolean((caught.details as { noResources?: boolean } | undefined)?.noResources);
        attempts.push(`${placement.dataCenterIds.join("/") || "any"} × ${batch.length === 1 ? batch[0] : "allow-list"}: ${message}`);
        if (!noResources) {
          /* Not a capacity answer: the same request would fail on every GPU, so the walk stops here. */
          const note = `pod creation failed on the first attempt (${batch.length === 1 ? batch[0] : "allow-list"}); other GPUs were not tried because this error is not about capacity: ${message}`;
          await repo.insertGpuPod({ id: `${UNAVAILABLE_PREFIX}${Date.now()}`, name: pc.podName, image: pc.image, status: "unavailable", message: note });
          throw new StudioError("backend_error", note, caught instanceof StudioError ? caught.details : undefined);
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

/**
 * What the shared pod is doing for someone other than `user`: takes, upscales
 * and exports in flight, and pictures only the pod draws, in projects `user`
 * does not own (other users', and projects from before private projects).
 * Counts only: what they are stays in their projects.
 */
export async function othersInFlight(user: string): Promise<{ takes: number; exports: number; pictures: number }> {
  const takes = [...(await repo.listActiveTakes()), ...(await repo.listActiveUpscales())];
  const exports = await repo.listActiveExports();
  const { isPodBackend } = await import("./painter");
  const pictures = (await repo.listActiveJobs()).filter((j) => j.kind === "image" && isPodBackend(j));
  const all = [...takes, ...exports, ...pictures];
  if (!all.length) return { takes: 0, exports: 0, pictures: 0 };
  const access = await repo.projectAccessRows(all.map((x) => x.projectId));
  const notMine = (projectId: string) => access.get(projectId)?.owner !== user;
  return {
    takes: new Set(takes.filter((t) => notMine(t.projectId)).map((t) => t.id)).size,
    exports: exports.filter((e) => notMine(e.projectId)).length,
    pictures: pictures.filter((j) => notMine(j.projectId)).length,
  };
}

/** Stop the pod. A user asks first when it is working for someone else (the pod is shared); the sweep's idle stop does not. */
export async function stopGpu(asker?: { actor: Actor; confirm: boolean }): Promise<GpuState> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.id.startsWith(UNAVAILABLE_PREFIX) || pod.status === "stopped" || pod.status === "terminated") return getGpuState();
  if (asker && !asker.confirm) {
    const o = await othersInFlight(asker.actor.user);
    const parts = [o.takes && `${o.takes} take(s)`, o.exports && `${o.exports} export(s)`, o.pictures && `${o.pictures} picture(s)`].filter(Boolean);
    if (parts.length) {
      throw new StudioError("needs_confirm", `The GPU pod is shared: ${parts.join(", ")} of other projects are queued or rendering on it. Stopping interrupts what is rendering and holds the rest until the pod is started again. Confirm to stop anyway.`, { othersInFlight: o });
    }
  }
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

/** The pod's voice worker as its /health says (voice_handler.voice_status). */
export type PodVoice = { ready?: boolean; why?: string | null; model?: string; missing?: string[]; setup?: string; loaded?: boolean };

/** Whether the GPU pod can speak right now: undefined when no pod is up to ask, or it does not answer. */
export async function podVoiceStatus(): Promise<PodVoice | undefined> {
  const h = await livePodHealth();
  if (!h) return undefined;
  return h.voice ?? { ready: false, why: "the pod's job server has no voice worker (an older bundle): restart the pod to take the new one" };
}

/** What the GPU pod says right now (/health), or undefined when there is no pod up to ask (or it does not answer in 8 s). */
async function livePodHealth(): Promise<{ downloads?: PodDownloads; image_models?: Record<string, { ready?: boolean; missing?: string[] }>; voice?: PodVoice } | undefined> {
  const pod = await repo.currentGpuPod();
  if (!pod?.hostUrl || (pod.status !== "running" && pod.status !== "starting")) return undefined;
  const ask = new PodBackend({ hostUrl: pod.hostUrl, token: config.runpodPod().workerToken }).health().catch(() => undefined);
  const h = await Promise.race([ask, new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000))]);
  return h?.detail && typeof h.detail === "object" ? (h.detail as never) : undefined;
}

/**
 * Refuse work the GPU pod should not take now, with the reason the user
 * sees: while its boot chain downloads models (a render or a picture would
 * read from the disk being written, crawl, and slow the download), or, for
 * an image model, while that model's files are not on it whole. A pod that
 * is off or does not answer is not asked: the work queues as before.
 */
export async function assertPodCanWork(what: string, imageModel?: { id: string; label: string }): Promise<void> {
  if (config.runpodMode() !== "pod" || !gpuConfigured()) return;
  const h = await livePodHealth();
  const d = h?.downloads;
  if (d?.active) {
    const now = d.current ? `, now ${d.current.split(" ")[1] ?? d.current}` : "";
    throw new StudioError("validation", `The GPU pod is still downloading models (${d.gb_left ?? "?"} GB left${now}): ${what} now would crawl and slow the download. Try again when it is done — the GPU panel shows the progress.`, { downloading: d });
  }
  const m = imageModel ? h?.image_models?.[imageModel.id] : undefined;
  if (imageModel && m && m.ready === false) {
    const missing = (m.missing ?? []).map((f) => f.split("/").pop()).join(", ");
    const failed = (d?.failed ?? []).length ? `; the last download failed for ${(d!.failed ?? []).map((f) => f.split(" ")[1] ?? f).join(", ")}` : "";
    const skipped = (d?.skipped ?? []).length ? `; skipped for lack of disk room: ${(d!.skipped ?? []).map((f) => f.replace(/^skipped /, "")).join(", ")}` : "";
    throw new StudioError("validation", `${imageModel.label} is not on the GPU pod whole yet (missing: ${missing}${failed}${skipped}). Restart the pod (Stop, then Start): every boot fetches what is missing or cut off.`, { missing: m.missing });
  }
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

export type PodPlacement = { dataCenterIds: string[]; networkVolumeId?: string; fallback?: boolean };

function podVolumeDcs(): string[] {
  const pc = config.runpodPod();
  return pc.volumes.length ? pc.volumes.map((v) => v.dataCenterId).filter(Boolean) : pc.dataCenterIds;
}

/** Model volumes that pin their pod to a data center (a regular network volume; a global one goes anywhere). */
function pinnedVolumes(): boolean {
  const pc = config.runpodPod();
  return pc.volumes.length ? pc.volumes.every((v) => !!v.dataCenterId) : !!pc.networkVolumeId && pc.dataCenterIds.length > 0;
}

/** Where a pod may live: one entry per model volume (each volume pins its
    data center), the data center of the last pod first. When the volumes pin
    their data centers, a last resort follows: no volume, any data center — a
    local-disk pod that downloads the models (RUNPOD_VOLUME_FALLBACK=none
    turns it off). It always stays last, whatever ran before. */
export async function podPlacements(): Promise<PodPlacement[]> {
  const pc = config.runpodPod();
  const list: PodPlacement[] = pc.volumes.length
    ? pc.volumes.map((v) => ({ dataCenterIds: v.dataCenterId ? [v.dataCenterId] : [], networkVolumeId: v.volumeId }))
    : [{ dataCenterIds: pc.dataCenterIds, networkVolumeId: pc.networkVolumeId }];
  const last = (await repo.listGpuPods(5)).find((p) => p.dataCenter)?.dataCenter;
  if (last) list.sort((a, b) => Number(b.dataCenterIds.includes(last)) - Number(a.dataCenterIds.includes(last)));
  if (pinnedVolumes() && pc.volumeFallback === "local") list.push({ dataCenterIds: [], fallback: true });
  return list;
}

/** A pod started by the fallback (no model volume while volumes are configured): not worth resuming. Its
    name says so; a pod in a data center none of the volumes is in is one too. */
export function isFallbackPod(pod: { name?: string | null; dataCenter?: string | null }): boolean {
  if (!pinnedVolumes()) return false;
  return !!pod.name?.endsWith(FALLBACK_SUFFIX) || (!!pod.dataCenter && !podVolumeDcs().includes(pod.dataCenter));
}

const FALLBACK_NOTE = "without the model volume";
const FALLBACK_SUFFIX = "-local";

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
export async function applyBoot(podId: string, opts: { restart: boolean }): Promise<{ restarted: boolean; envKept: number; entrypointApplied: boolean }> {
  const client = pods();
  const raw = await client.getPodRaw(podId);
  if (!raw) throw new StudioError("not_found", `RunPod has no pod ${podId}`);
  const existing = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? (raw.env as Record<string, unknown>) : {};
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) if (typeof v === "string") kept[k] = v;
  /* The image's ENTRYPOINT ignores a start command, so the boot script has
     to become the entrypoint. RunPod's v2 PATCH may not accept that field;
     then only args + env are set and the pod card says it must be rebuilt. */
  let entrypointApplied = true;
  try {
    await client.updatePod(podId, { entrypoint: bootstrapCommand(), env: { ...kept, ...podEnv() } });
  } catch (caught) {
    const status = (caught as StudioError).details as { status?: number } | undefined;
    if (status?.status !== 400 && status?.status !== 422) throw caught;
    entrypointApplied = false;
    await client.updatePod(podId, { args: bootstrapCommandLine(), env: { ...kept, ...podEnv() } });
  }
  const status = String(raw.status ?? raw.desiredStatus ?? "").toUpperCase();
  const running = status === "RUNNING" || status === "STARTING";
  let restarted = false;
  const caveat = entrypointApplied ? "" : " — RunPod refused to change the entrypoint, and this image ignores a start command: terminate this pod and press Start so the studio creates one with the boot script as entrypoint";
  if (opts.restart && running && entrypointApplied) {
    await client.restartPod(podId);
    restarted = true;
    await repo.updateGpuPod(podId, { status: "starting", message: "boot command applied; restarting", startedAt: Date.now() });
  } else {
    await repo.updateGpuPod(podId, { message: `${running ? "boot command applied; takes effect on the next restart" : "boot command applied"}${caveat}` });
  }
  return { restarted, envKept: Object.keys(kept).length, entrypointApplied };
}

/** Web action: apply the boot command to the current pod and restart it. */
export async function repairGpu(): Promise<GpuState & { repair: { restarted: boolean; envKept: number; entrypointApplied: boolean } }> {
  const pod = await repo.currentGpuPod();
  if (!pod || pod.id.startsWith(UNAVAILABLE_PREFIX) || pod.status === "terminated") throw new StudioError("not_found", "no pod to repair");
  const repair = await applyBoot(pod.id, { restart: true });
  return { ...(await getGpuState()), repair };
}

/** Everything to paste into the RunPod console when creating the pod by hand. */
export function manualPodRecipe(): { image: string; ports: string[]; containerDiskGb: number; volumeMountPath: string; env: Record<string, string>; dockerStartCmd: string; entrypoint: string[]; gpuTypes: string[]; notes: string[] } {
  const pc = config.runpodPod();
  return {
    image: pc.image,
    ports: [`${pc.podPort}/http`, `${pc.comfyPort}/http`],
    containerDiskGb: pc.volumes.length || pc.networkVolumeId ? pc.volumeContainerDiskGb : pc.containerDiskGb,
    volumeMountPath: pc.volumeMountPath,
    env: podEnv(),
    dockerStartCmd: pc.bootstrap ? bootstrapCommandLine() : "(image default)",
    entrypoint: pc.bootstrap ? bootstrapCommand() : [],
    gpuTypes: pc.gpuTypeIds,
    notes: [
      "Attach the model volume (minimax-h3-models) at the mount path. A global volume must NOT be mounted at /workspace: the image cannot build its Python env there.",
      "Expose the HTTP ports; the studio reaches the job server through RunPod's proxy on the first port.",
      "Paste the env vars exactly; STUDIO_BUNDLE_URL carries the worker token.",
      "runpod/comfyui has ENTRYPOINT /start.sh, which ignores a start command: the boot script must be the pod's entrypoint. Letting the studio create the pod (Start) sets it; by hand, the template needs an entrypoint override, which the console may not offer.",
      "When you adopt the pod the studio tries to set the entrypoint and env itself; if RunPod refuses, the pod card says so and the pod has to be recreated by the studio.",
      "After the pod is created, paste its id into Machine → Adopt a pod created by hand.",
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

/* VRAM of the GPU types the studio may run on, for choices that depend on it
   (which H3 decoder a 2K pass can afford). Unknown types count as small. */
const VRAM_GB: Array<[RegExp, number]> = [
  [/H200/, 141], [/B200|B300/, 180], [/H100/, 80], [/A100.*80GB|A100-SXM4-80GB/, 80], [/A100-SXM4-40GB/, 40], [/RTX PRO 6000/, 96], [/RTX PRO 5000/, 72], [/RTX PRO 4500/, 32], [/RTX PRO 4000/, 24],
  [/RTX 6000 Ada|A6000|L40/, 48], [/RTX 5000 Ada|A5000/, 24], [/RTX 5090/, 32], [/RTX 5080/, 16], [/RTX 4090|RTX 3090/, 24], [/MI300X/, 192],
];

export function gpuVramGb(gpuTypeId: string | undefined): number | undefined {
  if (!gpuTypeId) return undefined;
  for (const [re, gb] of VRAM_GB) if (re.test(gpuTypeId)) return gb;
  return undefined;
}

/** The decoder for an Open-H3-Regenerate pass on the current pod: the
    pack's fast decoder needs ~21 GB free beside the loaded models (45 GB
    for 15 s clips), so only cards of 72 GB and up get it; REGEN_DECODER
    forces either. */
export async function regenDecoder(): Promise<"fast" | "core"> {
  const forced = process.env.REGEN_DECODER;
  if (forced === "fast" || forced === "core") return forced;
  const pod = await repo.currentGpuPod();
  const gb = gpuVramGb(pod?.gpuTypeId ?? pod?.gpuName);
  return gb !== undefined && gb >= 72 ? "fast" : "core";
}
