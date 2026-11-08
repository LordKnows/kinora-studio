import { isNoResources, RunPodPodsClient } from "./backends/runpod-pods";
import { config } from "./config";
import { StudioError } from "./errors";
import { isOnline, painterOfJob } from "./painter";
import * as repo from "./repo";
import type { Painter, PainterPod } from "./types";

/*
 * The painter pod: a RunPod CPU pod the Studio creates from its own settings
 * when pictures are queued and no painter can draw them, and terminates when
 * it has had nothing to do for a while. Created fresh every time — a stopped
 * pod may not get its machine back — on the network volume mounted at
 * /workspace, which keeps the Codex login and the painter's id, so a new pod
 * picks up where the last one stopped. Billed only while it draws.
 *
 * The painter inside reports RUNPOD_POD_ID with its heartbeat, which is how
 * the Studio knows the pod is up.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export const MOUNT_PATH = "/workspace";

/** Worker variables (wrangler.jsonc): where and how the pod is made. */
export function podConfig() {
  const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((x) => x.trim()).filter(Boolean);
  const vcpu = Number(env("PAINTER_POD_VCPUS") ?? "2");
  return {
    /** The network volume (Codex login, painter id); the pod is made in its data center. */
    volumeId: env("PAINTER_POD_VOLUME_ID"),
    dataCenterId: env("PAINTER_POD_DATACENTER"),
    image: env("PAINTER_POD_IMAGE") ?? "ubuntu:24.04",
    /** CPU flavors to try in order (RunPod's catalog ids): compute-optimized 3 GHz first. */
    flavors: list(env("PAINTER_POD_CPU_FLAVORS"), "cpu3c,cpu3g,cpu5c"),
    /** A power of two within the flavor's range. */
    vcpuCount: Number.isFinite(vcpu) && vcpu >= 1 ? vcpu : 2,
    diskGb: Number(env("PAINTER_POD_DISK_GB") ?? "10"),
    idleStopMinutes: Math.max(2, Number(env("PAINTER_IDLE_STOP_MINUTES") ?? "10") || 10),
  };
}

export function podConfigured(): { ok: boolean; why?: string } {
  const c = podConfig();
  if (!env("RUNPOD_API_KEY")) return { ok: false, why: "RUNPOD_API_KEY is not set on the Worker" };
  if (!config.painterToken()) return { ok: false, why: "PAINTER_TOKEN (or STUDIO_WORKER_TOKEN) is not set on the Worker" };
  if (!c.volumeId) return { ok: false, why: "PAINTER_POD_VOLUME_ID is not set on the Worker (the network volume that keeps the Codex login)" };
  if (!c.dataCenterId) return { ok: false, why: "PAINTER_POD_DATACENTER is not set on the Worker (the network volume's data center, e.g. US-CA-2)" };
  return { ok: true };
}

/** The pod's start command: tools from apt (skipped when the image has them), the painter from the Studio's bundle. */
export const BOOT_SCRIPT = [
  "set -e",
  "export DEBIAN_FRONTEND=noninteractive",
  "if ! (command -v ffmpeg && command -v curl && python3 -c 'import PIL, requests') >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 python3-pil python3-requests curl ca-certificates ffmpeg >/dev/null; fi",
  "mkdir -p /opt/painter",
  'curl -fsSL "$STUDIO_URL/api/pod/bundle?token=$PAINTER_TOKEN" | tar xz -C /opt/painter',
  "exec bash /opt/painter/h3-runpod/run_painter.sh",
].join("\n");

/** A pod that shows no painter this long after it was created is replaced: its container never started
    (RunPod hosts that fail with "unable to join session keyring: … disk quota exceeded"), or the start command failed. */
function bootTimeoutMs(): number {
  const m = Number(env("PAINTER_POD_BOOT_MINUTES") ?? "6");
  return (Number.isFinite(m) && m >= 3 ? m : 6) * 60_000;
}
/** After a failed create, wait this long before the sweep tries again (Start on the web tries at once). */
const RETRY_AFTER_MS = 5 * 60_000;
/** Pods in a row that did not start before the Studio stops trying for a while. */
const MAX_BOOT_FAILURES = 3;
const BOOT_FAILURE_WINDOW_MS = 30 * 60_000;
const GIVE_UP_FOR_MS = 30 * 60_000;
const BOOT_FAILED = "boot failed";
const GAVE_UP = "gave up";

/** Each pod is named after its flavor, so a failure can be pinned on it. */
const flavorOf = (pod: PainterPod) => (pod.name.startsWith(`${repo.PAINTER_POD_NAME}-`) ? pod.name.slice(repo.PAINTER_POD_NAME.length + 1) : undefined);

/** The configured flavors, the ones whose pods recently failed to start moved to the back. */
export async function flavorOrder(now = Date.now()): Promise<string[]> {
  const failed = new Set((await repo.listPainterPodsSince(now - 60 * 60_000)).filter((p) => p.message?.startsWith(BOOT_FAILED)).map(flavorOf).filter(Boolean));
  const flavors = podConfig().flavors;
  return [...flavors.filter((f) => !failed.has(f)), ...flavors.filter((f) => failed.has(f))];
}

function client(): RunPodPodsClient {
  const key = env("RUNPOD_API_KEY");
  if (!key) throw new StudioError("backend_error", "RUNPOD_API_KEY is not set on the Worker");
  return new RunPodPodsClient(key, { version: env("RUNPOD_API") === "v1" ? "v1" : "v2" });
}

const isLive = (p?: PainterPod) => !!p && (p.status === "starting" || p.status === "running");

function uptime(pod: PainterPod, now = Date.now()): number {
  return isLive(pod) ? Math.max(0, Math.floor((now - (pod.startedAt ?? now)) / 1000)) : 0;
}

/** The painter that runs in this pod, if it has polled. */
function painterIn(pod: PainterPod, painters: Painter[]): Painter | undefined {
  return painters.filter((p) => p.info.runpodPodId === pod.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
}

export type PainterPodState = {
  configured: boolean;
  why?: string;
  settings: { volumeId?: string; dataCenterId?: string; image: string; flavors: string[]; vcpuCount: number; idleStopMinutes: number };
  pod?: PainterPod & { live: boolean; painter?: { id: string; name: string; online: boolean; busy: number } };
  uptimeSeconds: number;
  sessionUsd: number;
  lifetimeUsd: number;
};

export async function painterPodState(): Promise<PainterPodState> {
  const c = podConfig();
  const ok = podConfigured();
  const settings = { volumeId: c.volumeId, dataCenterId: c.dataCenterId, image: c.image, flavors: c.flavors, vcpuCount: c.vcpuCount, idleStopMinutes: c.idleStopMinutes };
  const pod = await repo.currentPainterPod().catch(() => undefined);
  const base = { configured: ok.ok, why: ok.why, settings, uptimeSeconds: 0, sessionUsd: 0, lifetimeUsd: await repo.painterPodsUsd().catch(() => 0) };
  if (!pod) return base;
  const p = painterIn(pod, await repo.listPainters());
  const up = uptime(pod);
  const session = up * ((pod.costPerHr ?? 0) / 3600);
  return {
    ...base, uptimeSeconds: up, sessionUsd: session, lifetimeUsd: base.lifetimeUsd + session,
    pod: { ...pod, live: isLive(pod), ...(p ? { painter: { id: p.id, name: p.name, online: isOnline(p), busy: p.info.running?.length ?? 0 } } : {}) },
  };
}

/** Create the pod: each CPU flavor in turn while RunPod has none of it. */
export async function startPainterPod(reason: string): Promise<PainterPodState> {
  const ok = podConfigured();
  if (!ok.ok) throw new StudioError("validation", `the painter pod is not set up: ${ok.why}`);
  if (isLive(await repo.currentPainterPod())) return painterPodState();
  const c = podConfig();
  const tried: string[] = [];
  for (const flavorId of await flavorOrder()) {
    try {
      const record = await client().createCpuPod({
        name: `${repo.PAINTER_POD_NAME}-${flavorId}`, image: c.image, flavorId, vcpuCount: c.vcpuCount, diskGb: c.diskGb,
        env: { STUDIO_URL: config.publicUrl(), PAINTER_TOKEN: config.painterToken()!, PAINTER_NAME: "painter-pod", PAINTER_STATE_DIR: `${MOUNT_PATH}/painter`, PYTHONUNBUFFERED: "1" },
        entrypoint: ["bash", "-c", BOOT_SCRIPT], dataCenterId: c.dataCenterId, networkVolumeId: c.volumeId, mountPath: MOUNT_PATH,
      });
      await repo.insertPainterPod({ id: record.id, name: `${repo.PAINTER_POD_NAME}-${flavorId}`, status: "starting", costPerHr: record.costPerHr, startedAt: Date.now(), message: `created (${flavorId}, ${c.vcpuCount} vCPU, ${c.dataCenterId}) — ${reason}; installing and fetching the painter (1–3 min)` });
      return painterPodState();
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : String(caught);
      tried.push(`${flavorId}: ${msg.slice(0, 300)}`);
      /* only "none of this flavor right now" moves on to the next flavor; anything else is a setup problem */
      if (!isNoResources(msg)) break;
    }
  }
  const allBusy = tried.length === c.flavors.length && tried.every((t) => isNoResources(t));
  const message = allBusy
    ? `no CPU pod available in ${c.dataCenterId} right now (${c.flavors.join(", ")}); the Studio tries again while pictures wait`
    : `could not create the painter pod: ${tried.join(" || ")}`;
  await repo.insertPainterPod({ id: `unavailable_${Date.now()}`, name: repo.PAINTER_POD_NAME, status: "unavailable", message });
  throw new StudioError("backend_error", message, { tried });
}

/** Terminate the pod (the volume keeps the login; the next one starts from it). */
export async function stopPainterPod(reason: string): Promise<PainterPodState> {
  const pod = await repo.currentPainterPod();
  if (!pod || !isLive(pod)) return painterPodState();
  try {
    await client().terminatePod(pod.id);
  } catch (caught) {
    const status = ((caught as StudioError).details as { status?: number } | undefined)?.status;
    if (status !== 404) throw caught;
  }
  await repo.updatePainterPod(pod.id, { status: "terminated", stoppedAt: Date.now(), startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime(pod), message: reason });
  await repo.markPaintersGone(pod.id);
  return painterPodState();
}

/** Something was drawn or handed out: the idle clock starts again. */
export async function touchPainterPod(runpodPodId?: string): Promise<void> {
  try {
    const pod = await repo.currentPainterPod();
    if (pod && isLive(pod) && (!runpodPodId || runpodPodId === pod.id)) await repo.updatePainterPod(pod.id, { lastActivityAt: Date.now() });
  } catch {
    /* no painter_pods table yet (migration 0014 not applied): a heartbeat must not fail for it */
  }
}

/** Pictures wait and nobody can draw them: create the pod. Answers what happened, for the button or the tool. */
export async function wakeForWork(): Promise<string | undefined> {
  if (!podConfigured().ok) return undefined;
  const pod = await repo.currentPainterPod().catch(() => undefined);
  if (isLive(pod)) {
    await touchPainterPod();
    return pod!.status === "starting" ? "the painter pod is starting (1–3 minutes)" : undefined;
  }
  try {
    await startPainterPod("pictures are queued");
    return "starting the painter pod (1–3 minutes), then it draws";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/**
 * The sweep (every minute): follow RunPod, create the pod for queued pictures,
 * terminate it when it has had nothing to do for idleStopMinutes, or when no
 * painter ever reported from it. Work keeps it up: queued or running image
 * jobs, or a Codex login in progress.
 */
export async function sweepPainterPod(now = Date.now()): Promise<string | undefined> {
  if (!podConfigured().ok) return undefined;
  const c = podConfig();
  let pod = await repo.currentPainterPod();
  /* pictures only the GPU pod draws (ComfyUI models) never wake the CPU painter pod */
  const { isPodBackend } = await import("./painter");
  const jobs = (await repo.listActiveJobs()).filter((j) => j.kind === "image" && !isPodBackend(j));
  const queued = jobs.filter((j) => j.status === "queued").length;

  if (pod && isLive(pod)) {
    try {
      const record = await client().getPod(pod.id);
      const desired = record?.desiredStatus.toUpperCase();
      if (!record || desired === "TERMINATED" || desired === "EXITED") {
        await repo.updatePainterPod(pod.id, { status: "terminated", stoppedAt: now, startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime(pod, now), message: "stopped or deleted outside the Studio" });
        await repo.markPaintersGone(pod.id);
        pod = await repo.currentPainterPod();
      } else if (record.costPerHr && record.costPerHr !== pod.costPerHr) {
        await repo.updatePainterPod(pod.id, { costPerHr: record.costPerHr });
      }
    } catch {
      /* RunPod unreachable: decide on what we know */
    }
  }

  const painters = await repo.listPainters();
  if (!pod || !isLive(pod)) {
    const otherCanDraw = painters.some((p) => !p.info.onPod && isOnline(p, now));
    const recentFailure = pod?.status === "unavailable" && now - pod.createdAt < (pod.message?.startsWith(GAVE_UP) ? GIVE_UP_FOR_MS : RETRY_AFTER_MS);
    if (queued > 0 && !otherCanDraw && !recentFailure) {
      await wakeForWork();
      return "created";
    }
    return pod?.status;
  }

  const inside = painterIn(pod, painters);
  const insideOnline = !!inside && isOnline(inside, now) && inside.lastSeenAt >= (pod.startedAt ?? 0);
  if (pod.status === "starting") {
    if (insideOnline) {
      await repo.updatePainterPod(pod.id, { status: "running", message: "running", lastActivityAt: now });
      return "running";
    }
    if (now - (pod.startedAt ?? now) > bootTimeoutMs()) {
      const flavor = flavorOf(pod) ?? "?";
      await stopPainterPod(`${BOOT_FAILED} (${flavor}): no painter reported within ${bootTimeoutMs() / 60_000} minutes — usually a RunPod host whose containers cannot start ("session keyring … disk quota exceeded" in the pod's log); otherwise the start command (PAINTER_TOKEN, Access bypass for /api/painter/* and /api/pod/*)`);
      const failures = (await repo.listPainterPodsSince(now - BOOT_FAILURE_WINDOW_MS)).filter((p) => p.message?.startsWith(BOOT_FAILED));
      if (failures.length >= MAX_BOOT_FAILURES) {
        const flavors = [...new Set(failures.map(flavorOf).filter(Boolean))].join(", ");
        await repo.insertPainterPod({ id: `unavailable_${now}`, name: repo.PAINTER_POD_NAME, status: "unavailable",
          message: `${GAVE_UP}: ${failures.length} pods in a row did not start (${flavors}) in ${c.dataCenterId} — RunPod's hosts there are failing to start containers. The Studio tries again in ${GIVE_UP_FOR_MS / 60_000} minutes; or press Start, change PAINTER_POD_CPU_FLAVORS, or move the volume to another data center.` });
        return "gave-up";
      }
      /* replace it at once, on another flavor (another pool of hosts), while pictures wait */
      if (queued > 0) await wakeForWork();
      return "boot-timeout";
    }
    return "starting";
  }
  const runningHere = inside ? jobs.filter((j) => j.status === "running" && painterOfJob(j) === inside.id).length : 0;
  const loginPending = inside?.info.login?.state === "pending" || (inside?.commands.length ?? 0) > 0;
  if (queued > 0 || runningHere > 0 || loginPending) {
    await repo.updatePainterPod(pod.id, { lastActivityAt: now });
    return "running";
  }
  const since = Math.max(pod.lastActivityAt ?? 0, pod.startedAt ?? 0);
  if (now - since >= c.idleStopMinutes * 60_000) {
    await stopPainterPod(`terminated after ${c.idleStopMinutes} idle minutes (the volume keeps the login)`);
    return "auto-stopped";
  }
  return "running";
}
