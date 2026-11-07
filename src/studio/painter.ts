import { config } from "./config";
import { StudioError } from "./errors";
import { newId } from "./ids";
import * as repo from "./repo";
import { presignPut, publicUrl } from "./storage/r2";
import type { Job, Painter } from "./types";

/*
 * Painters: the machines that draw the Studio's pictures, away from the GPU.
 *
 * The Studio only queues image jobs (D1). A painter — workers/painter/
 * painter.py on a small CPU box, a VPS, the user's computer, or the GPU pod
 * as a fallback — polls /api/painter/claim with what it can do, takes jobs,
 * draws them with Codex (the user's ChatGPT plan) or the images API, crops
 * and extracts frames, PUTs the results to R2 through presigned URLs and
 * posts them back. Nothing calls into a painter, so it needs no public
 * address; the claim answer also carries commands for it (the Codex
 * device-code login started from the Machine page).
 *
 * A painter that stops polling loses its jobs back to the queue (lease), so
 * a restart or a dead box never strands a picture.
 */

/** A painter that polled this recently counts as online. */
export const ONLINE_MS = 90_000;
/** A running job whose painter has been silent this long goes back to the queue. */
export const LEASE_LOST_MS = 4 * 60_000;
/** A job its painter does not report this long after it was handed over never reached it (or the painter
    restarted): it is handed to the same painter again. A claim whose answer was lost — the Worker cut off
    after the job was booked (error 1102), a network drop — must not count as a failed picture. */
const UNSEEN_MS = 15_000;
/** Hand-overs of one job before it fails (each is counted in `attempts`). */
export const MAX_HANDOVERS = 8;
/** Hand-overs (re-deliveries included) after which a job whose painter went silent fails instead of going back to the queue. */
export const MAX_ATTEMPTS = 5;
/** Painters not heard from for this long are forgotten (a pod-based painter has a new id per pod). */
const FORGET_PAINTERS_MS = 24 * 60 * 60_000;
/** Queued this long with no painter taking it: fail it so nobody waits forever. */
const QUEUE_TIMEOUT_MS = 3 * 60 * 60_000;

const leaseOf = (painterId: string) => `painter:${painterId}`;
export const painterOfJob = (job: Job): string | undefined => (job.requestId?.startsWith("painter:") ? job.requestId.slice("painter:".length) : undefined);

/* ---------- auth ---------- */

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkPainterToken(req: Request): void {
  const want = config.painterToken();
  if (!want) throw new StudioError("forbidden", "set PAINTER_TOKEN (or STUDIO_WORKER_TOKEN) on the Worker before connecting a painter");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (req.headers.get("x-studio-token") ?? "").trim();
  if (!got || !sameString(got, want)) throw new StudioError("unauthorized", "bad painter token");
}

/* ---------- what the painters can do ---------- */

export function isOnline(p: Painter, now = Date.now()): boolean {
  return now - p.lastSeenAt < ONLINE_MS;
}

/** Can this painter take this job right now? */
export function canServe(p: Painter, job: Pick<Job, "input">): boolean {
  const op = String(job.input.op ?? "paint");
  if (!(p.info.ops ?? ["paint", "crop", "extract"]).includes(op)) return false;
  if (op !== "paint") return true;
  return (p.info.backends ?? []).includes(String(job.input.backend ?? "codex"));
}

export type RunnerSummary = { online: number; ready: boolean; drawers: string[]; painters: Array<{ id: string; name: string; onPod: boolean; backends: string[]; busy: number }>; note?: string };

/** Who could draw a job of this op / backend now, for the answer to a button or a tool. */
export async function runnerSummary(op = "paint", backend = "codex"): Promise<RunnerSummary> {
  const all = (await repo.listPainters()).filter((p) => isOnline(p));
  const probe = { input: { op, backend } };
  const able = all.filter((p) => canServe(p, probe));
  const painters = all.map((p) => ({ id: p.id, name: p.name, onPod: !!p.info.onPod, backends: p.info.backends ?? [], busy: p.info.running?.length ?? 0 }));
  let note: string | undefined;
  if (!all.length) note = "no painter is online: start the painter pod (Machine page → Painters), or the GPU pod, which draws when no painter does";
  else if (!able.length) note = op === "paint" && backend === "codex"
    ? `painter${all.length > 1 ? "s" : ""} online (${all.map((p) => p.name).join(", ")}) but Codex is not logged in there: Machine page → Painters → Log in`
    : op === "paint" ? `no online painter has the images API (OPENAI_API_KEY) set` : `no online painter takes ${op} jobs`;
  return { online: all.length, ready: able.length > 0, drawers: able.map((p) => (p.info.onPod ? "the GPU pod" : p.name)), painters, note };
}

/* ---------- the painter's side ---------- */

export type ClaimInput = {
  painterId: string;
  name: string;
  info: Painter["info"];
  /** How many more jobs it can start now. */
  want: number;
};

export type ClaimedJob = { jobId: string; input: Record<string, unknown> };

/** What a painter is handed for a job: everything to draw it, nothing to look up. */
export function painterInput(job: Job): Record<string, unknown> {
  const i = job.input as Record<string, unknown> & { op: string };
  return {
    op: i.op, size: i.size, output: { key: outputKey(job) }, studio_job_id: job.id,
    ...(i.op === "paint" ? { backend: i.backend, prompt: i.prompt, refs: i.refUrls ?? [], base: i.baseUrl, region: i.region, quality: i.quality, check: i.check } : {}),
    ...(i.op === "crop" ? { base: i.baseUrl, crop: i.crop } : {}),
    ...(i.op === "extract" ? { video: i.videoUrl, frame: i.frame } : {}),
  };
}

export const outputKey = (job: Pick<Job, "id" | "projectId">) => `projects/${job.projectId}/images/${job.id}.png`;

/** Heartbeat + claim in one call: record the painter, settle its leases, hand it work and commands. */
export async function claim(input: ClaimInput): Promise<{ jobs: ClaimedJob[]; commands: Painter["commands"]; pollMs: number }> {
  const id = input.painterId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 80);
  if (!id) throw new StudioError("validation", "painterId is required");
  const now = Date.now();
  /* two processes heartbeating under one id (a second pod on the same volume, a copy left running) steal
     each other's jobs: say so where the user looks */
  const before = await repo.getPainter(id).catch(() => undefined);
  const clash = !!before?.info.instance && !!input.info.instance && before.info.instance !== input.info.instance && now - before.lastSeenAt < 20_000;
  const info = { ...input.info, running: (input.info.running ?? []).slice(0, 50), ...(clash ? { lastError: `two painter processes are using the id ${id} (seen ${before!.info.host ?? "?"} and ${input.info.host ?? "?"}): stop one of them` } : {}) };
  const painter = await repo.upsertPainter(id, input.name.slice(0, 80) || id, info);
  const running = new Set(painter.info.running ?? []);
  const want = Math.max(0, Math.min(4, Math.floor(input.want)));
  const jobs: ClaimedJob[] = [];
  /* jobs booked to it that it does not report: the answer that carried them was lost, or it restarted —
     hand them over again rather than failing the picture */
  for (const job of (await repo.listActiveJobs()).filter((j) => j.kind === "image" && j.status === "running" && painterOfJob(j) === id)) {
    if (running.has(job.id) || now - (job.claimedAt ?? 0) < UNSEEN_MS) continue;
    if ((job.attempts ?? 1) >= MAX_HANDOVERS) {
      await repo.updateJob(job.id, { status: "failed", error: `handed to the painter ${painter.name} ${job.attempts} times without it drawing it`, finishedAt: now });
      continue;
    }
    if (jobs.length >= want) continue;
    await repo.rehandJob(job.id);
    jobs.push({ jobId: job.id, input: painterInput(job) });
  }
  if (jobs.length < want) {
    for (const job of await repo.listQueuedJobs("image", 50)) {
      if (jobs.length >= want) break;
      if (!canServe(painter, job)) continue;
      if (!(await repo.claimJob(job.id, leaseOf(id)))) continue;
      jobs.push({ jobId: job.id, input: painterInput(job) });
    }
  }
  const commands = painter.commands;
  if (commands.length) await repo.setPainterCommands(id, []);
  /* a painter pod that hands out or draws pictures is not idle */
  if (jobs.length || running.size) {
    const { touchPainterPod } = await import("./painter-pod");
    await touchPainterPod(painter.info.runpodPodId);
  }
  /* poll fast while something is pending (a login, jobs in the queue), slowly when idle */
  const pending = commands.length > 0 || painter.info.login?.state === "pending" || jobs.length > 0 || running.size > 0;
  return { jobs, commands, pollMs: pending ? 2000 : 5000 };
}

async function heldJob(jobId: string, painterId: string): Promise<Job> {
  const job = await repo.getJob(jobId);
  if (job.kind !== "image") throw new StudioError("validation", "not an image job");
  if (painterOfJob(job) !== painterId || job.status !== "running") throw new StudioError("forbidden", "this painter does not hold the job (it was given back to the queue, or finished)", { lost: true });
  return job;
}

/** Presigned PUTs for the files of a job: the picture, its preview, the diff. Only those keys. */
export async function uploadUrls(jobId: string, painterId: string, keys: string[]): Promise<Array<{ key: string; putUrl: string; publicUrl: string }>> {
  const job = await heldJob(jobId, painterId);
  const stem = outputKey(job).slice(0, -".png".length);
  const allowed = new Set([`${stem}.png`, `${stem}.preview.jpg`, `${stem}.diff.jpg`]);
  const out = [];
  for (const key of keys.slice(0, 6)) {
    if (!allowed.has(key)) throw new StudioError("validation", `a painter may only write ${[...allowed].join(", ")}`);
    out.push({ key, putUrl: (await presignPut(key, "", 0)).url, publicUrl: publicUrl(key) });
  }
  return out;
}

/** The painter's answer: a picture (the files already in R2) or an error. */
export async function finish(jobId: string, painterId: string, result: { output?: Record<string, unknown>; error?: string }): Promise<Job> {
  const job = await heldJob(jobId, painterId);
  const { applyImageStatus } = await import("./imaging");
  const { touchPainterPod } = await import("./painter-pod");
  await touchPainterPod((await repo.getPainter(painterId).catch(() => undefined))?.info.runpodPodId ?? "-");
  if (result.error || !result.output) return applyImageStatus(job, { state: "failed", error: (result.error ?? "the painter answered without a picture").slice(0, 2000) });
  const expected = publicUrl(outputKey(job));
  if (result.output.url !== expected) return applyImageStatus(job, { state: "failed", error: `the painter wrote ${String(result.output.url)}, not ${expected}` });
  return applyImageStatus(job, { state: "completed", output: result.output });
}

/* ---------- the web side ---------- */

export async function listPainters(): Promise<Array<Painter & { online: boolean }>> {
  const now = Date.now();
  return (await repo.listPainters()).map((p) => ({ ...p, online: isOnline(p, now) }));
}

/** Ask a painter to start `codex login --device-auth`; the code comes back in its next heartbeat. */
export async function requestCodexLogin(painterId: string): Promise<Painter> {
  const p = await repo.getPainter(painterId);
  if (!isOnline(p)) throw new StudioError("backend_error", `${p.name} is offline: start it first`);
  if (!p.commands.some((c) => c.type === "codex_login")) await repo.setPainterCommands(p.id, [...p.commands, { id: newId("cmd"), type: "codex_login", at: Date.now() }]);
  return repo.getPainter(p.id);
}

export async function forgetPainter(painterId: string): Promise<void> {
  const p = await repo.getPainter(painterId);
  if (isOnline(p)) throw new StudioError("validation", `${p.name} is still online; stop it first`);
  await repo.deletePainter(p.id);
}

/* ---------- the sweep ---------- */

async function requeueOrFail(job: Job, why: string): Promise<void> {
  const lease = job.requestId ?? "";
  if ((job.attempts ?? 1) >= MAX_ATTEMPTS) {
    await repo.updateJob(job.id, { status: "failed", error: `${why}; given up after ${job.attempts} tries`, finishedAt: Date.now() });
    return;
  }
  await repo.releaseJob(job.id, lease, `${why}; back in the queue`);
}

/** Running jobs whose painter went silent go back to the queue; jobs nobody took for hours fail. */
export async function sweepImageLeases(now = Date.now()): Promise<number> {
  await repo.forgetPaintersBefore(now - FORGET_PAINTERS_MS).catch(() => undefined);
  const painters = new Map((await repo.listPainters()).map((p) => [p.id, p]));
  let changed = 0;
  for (const job of (await repo.listActiveJobs()).filter((j) => j.kind === "image")) {
    if (job.status === "queued" && !job.requestId && now - job.createdAt > QUEUE_TIMEOUT_MS) {
      await repo.updateJob(job.id, { status: "failed", error: "no painter took it within 3 hours", finishedAt: now });
      changed++;
      continue;
    }
    const pid = painterOfJob(job);
    /* a job handed to the GPU pod's old /paint lane before painters existed: nobody reports it any more */
    if (job.status === "running" && job.requestId && !pid && now - job.createdAt > 30 * 60_000) {
      await repo.updateJob(job.id, { status: "failed", error: "sent to the GPU pod before pictures moved to painters; draw it again", finishedAt: now });
      changed++;
      continue;
    }
    if (job.status !== "running" || !pid) continue;
    const p = painters.get(pid);
    if (!p || now - p.lastSeenAt > LEASE_LOST_MS) {
      await requeueOrFail(job, `the painter ${p?.name ?? pid} went silent`);
      changed++;
    }
  }
  return changed;
}

/** Whether the GPU pod is drawing something right now (it must not be idle-stopped under it). */
export async function podIsPainting(): Promise<boolean> {
  const onPod = new Set((await repo.listPainters()).filter((p) => p.info.onPod && isOnline(p)).map((p) => p.id));
  if (!onPod.size) return false;
  return (await repo.listActiveJobs()).some((j) => j.kind === "image" && j.status === "running" && onPod.has(painterOfJob(j) ?? ""));
}
