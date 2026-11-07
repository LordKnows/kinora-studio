import { RunPodPodsClient } from "./backends/runpod-pods";
import { StudioError } from "./errors";
import { isOnline, painterOfJob } from "./painter";
import * as repo from "./repo";
import type { Painter, PainterPod } from "./types";

/*
 * The painter's own pod, managed like the GPU pod but cheaper and simpler: a
 * RunPod CPU pod the user created once (image, env, start command, volume),
 * taken over by id. The Studio starts it when pictures are queued and no
 * painter can draw them, and stops it after it has had nothing to do for a
 * while — so a small always-on bill becomes minutes of use. The Studio never
 * creates or terminates it.
 *
 * The painter inside reports RUNPOD_POD_ID with its heartbeat, which is how a
 * painter is matched to this pod.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Minutes without a picture to draw before the pod is stopped (PAINTER_IDLE_STOP_MINUTES, default 10). */
export function idleStopMinutes(): number {
  const n = Number(env("PAINTER_IDLE_STOP_MINUTES") ?? "10");
  return Number.isFinite(n) && n >= 2 ? n : 10;
}

/** A pod that has not shown a painter this long after starting is reported as stuck (the start command failed?). */
const BOOT_WARN_MS = 8 * 60_000;

function client(): RunPodPodsClient {
  const key = env("RUNPOD_API_KEY");
  if (!key) throw new StudioError("backend_error", "RUNPOD_API_KEY is not set on the Worker");
  return new RunPodPodsClient(key, { version: env("RUNPOD_API") === "v1" ? "v1" : "v2" });
}

function statusOf(desired: string): PainterPod["status"] {
  const d = desired.toUpperCase();
  return d === "RUNNING" ? "running" : d === "EXITED" || d === "STOPPED" || d === "TERMINATED" ? "stopped" : "starting";
}

export type PainterPodState = {
  pod?: PainterPod & { painter?: { id: string; name: string; online: boolean; busy: number } };
  idleStopMinutes: number;
  uptimeSeconds: number;
  sessionUsd: number;
  lifetimeUsd: number;
};

function uptime(pod: PainterPod, now = Date.now()): number {
  return pod.status === "running" || pod.status === "starting" || pod.status === "stopping" ? Math.max(0, Math.floor((now - (pod.startedAt ?? now)) / 1000)) : 0;
}

/** The painter that runs in this pod, if it has ever polled. */
function painterIn(pod: PainterPod, painters: Painter[]): Painter | undefined {
  return painters.filter((p) => p.info.runpodPodId === pod.id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
}

export async function painterPodState(): Promise<PainterPodState> {
  const pod = await repo.currentPainterPod();
  if (!pod) return { idleStopMinutes: idleStopMinutes(), uptimeSeconds: 0, sessionUsd: 0, lifetimeUsd: 0 };
  const p = painterIn(pod, await repo.listPainters());
  const up = uptime(pod);
  const rate = (pod.costPerHr ?? 0) / 3600;
  return {
    pod: { ...pod, ...(p ? { painter: { id: p.id, name: p.name, online: isOnline(p), busy: p.info.running?.length ?? 0 } } : {}) },
    idleStopMinutes: idleStopMinutes(), uptimeSeconds: up, sessionUsd: up * rate, lifetimeUsd: (pod.accumulatedSeconds + up) * rate,
  };
}

/** Take over a CPU pod created in the RunPod console. */
export async function adoptPainterPod(podId: string): Promise<PainterPodState> {
  const record = await client().getPod(podId);
  if (!record) throw new StudioError("not_found", `RunPod has no pod ${podId} for this API key`);
  const status = statusOf(record.desiredStatus);
  await repo.setPainterPod({ id: record.id, name: record.name || podId, status, costPerHr: record.costPerHr, startedAt: status === "stopped" ? undefined : Date.now() });
  await repo.updatePainterPod(record.id, { message: status === "stopped" ? "taken over (stopped): it starts when pictures are queued" : "taken over (running): it stops after idling" });
  return painterPodState();
}

/** Forget the pod (it keeps running or not; the Studio stops managing it). */
export async function releasePainterPod(): Promise<PainterPodState> {
  await repo.deletePainterPods();
  return painterPodState();
}

export async function startPainterPod(reason: string): Promise<PainterPodState> {
  const pod = await repo.currentPainterPod();
  if (!pod) throw new StudioError("validation", "no painter pod: take one over on the Machine page first");
  if (pod.status === "running" || pod.status === "starting") return painterPodState();
  try {
    await client().startPod(pod.id);
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    await repo.updatePainterPod(pod.id, { status: "stopped", message: `could not start: ${msg.slice(0, 300)}` });
    throw new StudioError("backend_error", `the painter pod did not start: ${msg}`);
  }
  await repo.updatePainterPod(pod.id, { status: "starting", startedAt: Date.now(), lastActivityAt: Date.now(), message: `starting: ${reason}` });
  return painterPodState();
}

export async function stopPainterPod(reason: string): Promise<PainterPodState> {
  const pod = await repo.currentPainterPod();
  if (!pod) throw new StudioError("validation", "no painter pod");
  if (pod.status === "stopped") return painterPodState();
  await client().stopPod(pod.id);
  await repo.updatePainterPod(pod.id, { status: "stopped", stoppedAt: Date.now(), startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime(pod), message: reason });
  return painterPodState();
}

/** Something was drawn or handed out: the idle clock starts again. */
export async function touchPainterPod(runpodPodId?: string): Promise<void> {
  try {
    const pod = await repo.currentPainterPod();
    if (pod && (!runpodPodId || runpodPodId === pod.id)) await repo.updatePainterPod(pod.id, { lastActivityAt: Date.now() });
  } catch {
    /* no painter_pods table yet (migration 0014 not applied): a heartbeat must not fail for it */
  }
}

/** Pictures wait and nobody can draw them: start the pod. Answers what happened, for the button or the tool. */
export async function wakeForWork(): Promise<string | undefined> {
  const pod = await repo.currentPainterPod().catch(() => undefined);
  if (!pod) return undefined;
  if (pod.status === "running" || pod.status === "starting") {
    await touchPainterPod();
    return pod.status === "starting" ? "the painter pod is starting (1–3 minutes)" : undefined;
  }
  try {
    await startPainterPod("pictures are queued");
    return "starting the painter pod (1–3 minutes), then it draws";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/**
 * The sweep (every minute): follow the pod's real state, start it for queued
 * pictures, stop it when it has had nothing to do for idleStopMinutes.
 * Work keeps it up: queued or running image jobs, or a Codex login in progress.
 */
export async function sweepPainterPod(now = Date.now()): Promise<string | undefined> {
  const pod = await repo.currentPainterPod();
  if (!pod) return undefined;
  let status = pod.status;
  try {
    const record = await client().getPod(pod.id);
    if (!record) {
      await repo.updatePainterPod(pod.id, { status: "unavailable", message: "RunPod no longer has this pod: take over another one" });
      return "unavailable";
    }
    const real = statusOf(record.desiredStatus);
    if (real === "stopped" && status !== "stopped") {
      await repo.updatePainterPod(pod.id, { status: "stopped", stoppedAt: now, startedAt: null, accumulatedSeconds: pod.accumulatedSeconds + uptime(pod, now), message: status === "stopping" ? pod.message ?? null : "stopped outside the Studio" });
      status = "stopped";
    } else if (real !== "stopped" && status === "stopped") {
      await repo.updatePainterPod(pod.id, { status: "starting", startedAt: now, message: "started outside the Studio" });
      status = "starting";
    }
    if (record.costPerHr && record.costPerHr !== pod.costPerHr) await repo.updatePainterPod(pod.id, { costPerHr: record.costPerHr });
  } catch {
    /* RunPod unreachable: decide on what we know */
  }
  const painters = await repo.listPainters();
  const inside = painterIn(pod, painters);
  const insideOnline = !!inside && isOnline(inside, now) && (inside.lastSeenAt >= (pod.startedAt ?? 0));
  if (status === "starting" && insideOnline) {
    await repo.updatePainterPod(pod.id, { status: "running", message: "running" });
    status = "running";
  } else if (status === "starting" && now - (pod.startedAt ?? now) > BOOT_WARN_MS) {
    await repo.updatePainterPod(pod.id, { message: "started, but no painter has reported from it yet — check the pod's container log (start command, PAINTER_TOKEN, Access bypass)" });
  }
  const jobs = (await repo.listActiveJobs()).filter((j) => j.kind === "image");
  const queued = jobs.filter((j) => j.status === "queued").length;
  const runningHere = inside ? jobs.filter((j) => j.status === "running" && painterOfJob(j) === inside.id).length : 0;
  const otherCanDraw = painters.some((p) => p.id !== inside?.id && !p.info.onPod && isOnline(p, now));
  const loginPending = inside?.info.login?.state === "pending" || (inside?.commands.length ?? 0) > 0;
  if (status === "stopped" && queued > 0 && !otherCanDraw) {
    await wakeForWork();
    return "started";
  }
  if (status === "running" || status === "starting") {
    if (queued > 0 || runningHere > 0 || loginPending) {
      if (status === "running") await repo.updatePainterPod(pod.id, { lastActivityAt: now });
      return status;
    }
    const since = Math.max(pod.lastActivityAt ?? 0, pod.startedAt ?? 0);
    if (status === "running" && now - since >= idleStopMinutes() * 60_000) {
      await stopPainterPod(`auto-stopped after ${idleStopMinutes()} idle minutes`);
      return "auto-stopped";
    }
  }
  return status;
}
