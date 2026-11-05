import { assertBudget, assertCanGenerate, assertConfirmed, isStructuralChange } from "./checkpoints";
import { CompileError, compileShot, effectiveLink, type CompiledJob } from "./compiler";
import { grammarFor } from "./editing";
import { config } from "./config";
import { actualTakeUsd, estimateExport, estimateTake, podTakeUsd, reservedUsd, type Estimate, estimateUpscale } from "./cost";
import { StudioError } from "./errors";
import * as repo from "./repo";
import { buildAssemblerInput } from "./backends/assembler";
import { RunPodBackend, signHookUrl } from "./backends/runpod";
import * as gpu from "./gpu";
import type { BackendStatus, GenerationBackend } from "./backends/types";
import type { ExportRequest, ShotInput, ShotPatch, ShotlistInput, TakeRequest, TimelineInput } from "./schemas";
import { ShotInput as ShotInputSchema, UpscaleRequest } from "./schemas";
import type { Actor, Asset, Element, ExportJob, Project, Scene, Script, Shot, Take, Timeline } from "./types";

/* §4.3 — the server-side conductor. Everything that spends money or touches a
   backend goes through here, so checkpoints, budget and the ledger are
   enforced in one place for the web UI and the MCP tools alike. */

/* ---------- backends ---------- */

/* Pod mode (default): the studio's own pod answers /run and /assemble. A
   backend is only handed out while the pod is healthy; before that, jobs sit
   in the database with no requestId and the sweep submits them later.
   Serverless mode (TODO) uses RunPod endpoints instead. */

async function readyPod(): Promise<repo.GpuPod | null> {
  const pod = await repo.currentGpuPod();
  return pod && pod.status === "running" && pod.hostUrl ? pod : null;
}

export async function videoBackend(): Promise<GenerationBackend | null> {
  if (config.runpodMode() === "serverless") {
    const rp = config.runpod();
    return new RunPodBackend({ apiKey: rp.apiKey, endpointId: config.runpodServerless().h3EndpointId });
  }
  const pod = await readyPod();
  return pod ? gpu.podBackend(pod, "video") : null;
}

export async function assemblerBackend(): Promise<GenerationBackend | null> {
  if (config.runpodMode() === "serverless") {
    const rp = config.runpod();
    const { assemblerEndpointId } = config.runpodServerless();
    if (!assemblerEndpointId) throw new StudioError("backend_error", "RUNPOD_ASSEMBLER_ENDPOINT_ID is not set");
    return new RunPodBackend({ apiKey: rp.apiKey, endpointId: assemblerEndpointId });
  }
  const pod = await readyPod();
  return pod ? gpu.podBackend(pod, "assemble") : null;
}

function runpodOrNull() {
  try {
    return config.runpod();
  } catch {
    return null;
  }
}

/* Image generation (hero frames, element sheets) is disabled for now: the
   Higgsfield image backend was removed and references are uploaded instead.
   TODO: bring back a still-image backend behind the same GenerationBackend
   interface and re-add generate_hero_frames / generate_element_refs. */

/* ---------- aggregate view ---------- */

export type ShotView = Shot & { takes: Take[]; hero?: Asset; end?: Asset; selectedTake?: Take };
export type SceneView = Scene & { shots: ShotView[] };
export type ProjectView = {
  project: Project;
  script?: Script;
  elements: Element[];
  scenes: SceneView[];
  timeline: Timeline;
  assets: Asset[];
  canGenerate: boolean;
  blockers: string[];
};

export async function getProjectView(projectId: string): Promise<ProjectView> {
  const project = await repo.getProject(projectId);
  const [script, elements, scenes, shots, takes, timeline, assets] = await Promise.all([
    repo.latestScript(projectId),
    repo.listElements(projectId, true),
    repo.listScenes(projectId),
    repo.listShots(projectId),
    repo.listProjectTakes(projectId),
    repo.getTimeline(projectId),
    repo.listAssets(projectId),
  ]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const takesByShot = new Map<string, Take[]>();
  for (const take of takes) {
    const list = takesByShot.get(take.shotId) ?? [];
    list.push(take);
    takesByShot.set(take.shotId, list);
  }
  const shotViews: ShotView[] = shots.map((shot) => {
    const list = (takesByShot.get(shot.id) ?? []).sort((a, b) => b.n - a.n);
    return {
      ...shot,
      takes: list,
      hero: shot.heroAssetId ? assetById.get(shot.heroAssetId) : undefined,
      end: shot.endAssetId ? assetById.get(shot.endAssetId) : undefined,
      selectedTake: shot.selectedTakeId ? list.find((t) => t.id === shot.selectedTakeId) : undefined,
    };
  });
  const sceneViews: SceneView[] = scenes.map((scene) => ({ ...scene, shots: shotViews.filter((s) => s.sceneId === scene.id) }));
  const blockers: string[] = [];
  if (!script) blockers.push("No script yet");
  else if (script.approval !== "approved") blockers.push("Script not approved");
  if (shots.length === 0) blockers.push("No shots yet");
  else if (project.shotlistApproval !== "approved") blockers.push("Shotlist not approved");
  return { project, script, elements, scenes: sceneViews, timeline, assets, canGenerate: blockers.length === 0, blockers };
}

/* ---------- shotlist ---------- */

export async function saveShotlist(projectId: string, input: ShotlistInput): Promise<ProjectView & { merge: repo.ShotlistMergeResult }> {
  await repo.getProject(projectId);
  const removals = await repo.shotlistRemovals(projectId, input.scenes);
  if (removals.length) {
    throw new StudioError(
      "validation",
      `this shotlist would delete ${removals.length} shot(s) that already have takes; keep them in the list, or delete them one by one on the Board`,
      { removals },
    );
  }
  const merge = await repo.mergeShotlist(projectId, input.scenes);
  await repo.setShotlistApproval(projectId, "draft");
  return { ...(await getProjectView(projectId)), merge };
}

export async function patchShot(shotId: string, patch: ShotPatch & { heroAssetId?: string | null; endAssetId?: string | null }): Promise<Shot> {
  const shot = await repo.getShot(shotId);
  const { heroAssetId, endAssetId, promptOverride, ...specPatch } = patch;
  const nextSpec = ShotInputSchema.parse({ ...shot.spec, ...specPatch, promptOverride: promptOverride === undefined ? shot.promptOverride : (promptOverride ?? undefined) });
  const updated = await repo.updateShot(shotId, {
    spec: nextSpec,
    heroAssetId,
    endAssetId,
    promptOverride: promptOverride === undefined ? undefined : (promptOverride?.trim() ? promptOverride : null),
  });
  if (isStructuralChange(shot.spec as unknown as Record<string, unknown>, nextSpec as unknown as Record<string, unknown>)) await repo.setShotlistApproval(shot.projectId, "draft");
  else await repo.touchProject(shot.projectId);
  return updated;
}

export async function addShot(sceneId: string, spec: ShotInput): Promise<Shot> {
  const scene = await repo.getScene(sceneId);
  const shot = await repo.createShot(scene.projectId, sceneId, spec);
  await repo.setShotlistApproval(scene.projectId, "draft");
  return shot;
}

export async function removeShot(shotId: string): Promise<void> {
  const shot = await repo.getShot(shotId);
  await repo.deleteShot(shotId);
  await repo.setShotlistApproval(shot.projectId, "draft");
}

/* ---------- compile ---------- */

async function compileContext(shotId: string, opts?: { steps?: number; seed?: number }) {
  const shot = await repo.getShot(shotId);
  const project = await repo.getProject(shot.projectId);
  const ids = [...shot.spec.characters, ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : [])];
  const elements = await repo.getElements(ids);
  const assetIds = new Set<string>();
  for (const el of elements.values()) for (const id of el.refAssetIds) assetIds.add(id);
  if (shot.heroAssetId) assetIds.add(shot.heroAssetId);
  if (shot.endAssetId) assetIds.add(shot.endAssetId);
  const assets = await repo.getAssets([...assetIds]);
  /* Tier 2: resolve the anchor shot's last frame for linked shots. */
  let prevLastFrameUrl: string | undefined;
  let anchorFrameUrl: string | undefined;
  let anchorLabel: string | undefined;
  const link = effectiveLink(shot.spec);
  const grammar = grammarFor(link.type);
  if (grammar.mechanism !== "none") {
    const all = await repo.listShots(shot.projectId);
    const idx = all.findIndex((s) => s.id === shot.id);
    const anchor = link.anchorShotId
      ? all.find((s) => s.id === link.anchorShotId)
      : idx >= 0 ? all[idx + (link.anchor ?? grammar.defaultAnchor)] : undefined;
    if (anchor) {
      const takes = await repo.listShotTakes(anchor.id);
      const chosen = (anchor.selectedTakeId ? takes.find((t) => t.id === anchor.selectedTakeId) : undefined) ?? takes.find((t) => t.status === "completed");
      anchorFrameUrl = chosen?.lastFrameUrl;
      anchorLabel = `shot ${anchor.index + 1}`;
      if ((link.anchor ?? grammar.defaultAnchor) === -1) prevLastFrameUrl = anchorFrameUrl;
    }
  }
  const sourceTake = shot.spec.sourceTakeId ? await repo.getTake(shot.spec.sourceTakeId) : undefined;
  const refs = shot.spec.loras ?? project.look.loras;
  const loraRows = await repo.getLoras(refs.map((r) => r.id));
  const loras = refs.flatMap((r) => {
    const lora = loraRows.get(r.id);
    return lora ? [{ ...lora, strength: r.strength ?? lora.defaultStrength }] : [];
  });
  return { shot, project, elements, assets, prevLastFrameUrl, anchorFrameUrl, anchorLabel, sourceTake, loras, steps: opts?.steps, seed: opts?.seed };
}

export async function compileForShot(shotId: string, opts?: { steps?: number; seed?: number }): Promise<CompiledJob & { estimate: Estimate }> {
  const ctx = await compileContext(shotId, opts);
  try {
    const job = compileShot({ ...ctx, look: ctx.project.look });
    return { ...job, estimate: estimateTake(ctx.shot.spec.durationS, job.input.steps, 1, await gpu.measuredForEstimate()) };
  } catch (caught) {
    if (caught instanceof CompileError) throw new StudioError("validation", caught.message, { shotId });
    throw caught;
  }
}

/* ---------- takes ---------- */

export async function createTakes(shotId: string, req: TakeRequest, actor: Actor): Promise<{ takes: Take[]; estimate: Estimate; warnings: string[]; gpu?: gpu.GpuState }> {
  const ctx = await compileContext(shotId, { steps: req.steps, seed: req.seed });
  const script = await repo.latestScript(ctx.project.id);
  assertCanGenerate(ctx.project, script);
  let compiled: CompiledJob;
  try {
    compiled = compileShot({ ...ctx, look: ctx.project.look });
  } catch (caught) {
    if (caught instanceof CompileError) throw new StudioError("validation", caught.message, { shotId });
    throw caught;
  }
  const estimate = estimateTake(ctx.shot.spec.durationS, compiled.input.steps, req.n, await gpu.measuredForEstimate());
  const reserved = reservedUsd(await repo.listProjectActiveTakes(ctx.project.id));
  assertBudget(ctx.project, estimate.usd + reserved);
  if (actor.via === "mcp") assertConfirmed(req.confirm, estimate.usd, `${req.n} take(s) of ${ctx.shot.spec.durationS}s`);

  if (!runpodOrNull()) throw new StudioError("backend_error", "RunPod is not configured (RUNPOD_API_KEY, RUNPOD_WEBHOOK_SECRET)");

  /* Pod mode: make sure the GPU is coming up. The agent has already confirmed
     the take; starting the pod is part of that spend. */
  let gpuState: gpu.GpuState | undefined;
  if (config.runpodMode() === "pod") {
    gpuState = await gpu.startGpu(actor, true);
    if (gpuState.status === "unavailable") {
      throw new StudioError("backend_error", gpuState.message ?? "no GPU available right now", { noResources: true, gpu: gpuState });
    }
  }

  const takes: Take[] = [];
  for (let i = 0; i < req.n; i++) {
    const seed = req.seed !== undefined ? req.seed + i : Math.floor(Math.random() * 2 ** 31);
    const take = await repo.createTake({
      projectId: ctx.project.id, shotId, backend: "runpod", workflow: compiled.workflow, prompt: compiled.prompt,
      input: { ...compiled.input, seed }, seed,
    });
    const input = {
      ...compiled.input,
      seed,
      studio_take_id: take.id,
      output: { key: `projects/${ctx.project.id}/shots/${shotId}/takes/${take.id}.mp4` },
    };
    takes.push(await submitTake(await repo.updateTake(take.id, { input })));
  }
  await gpu.touchGpuActivity();
  return { takes, estimate, warnings: compiled.warnings, gpu: gpuState };
}

/** Hand a queued take to the backend. With no backend ready yet (pod still
    booting) the take keeps status queued and no requestId; the sweep retries. */
export async function submitTake(take: Take): Promise<Take> {
  if (take.status !== "queued" || take.requestId) return take;
  const backend = await videoBackend();
  if (!backend) return take;
  const rp = config.runpod();
  try {
    const webhook = await signHookUrl(config.publicUrl(), "/api/runpod/hook", rp.webhookSecret, take.id);
    const { requestId } = await backend.submit(take.input, { webhook, executionTimeoutMs: rp.executionTimeoutMs });
    return await repo.updateTake(take.id, { requestId, status: "queued", error: null });
  } catch (caught) {
    const unreachable = caught instanceof StudioError && Boolean((caught.details as { unreachable?: boolean } | undefined)?.unreachable);
    if (unreachable) return take;
    return repo.updateTake(take.id, { status: "failed", error: caught instanceof Error ? caught.message : String(caught), finishedAt: Date.now() });
  }
}

export async function applyTakeStatus(take: Take, status: BackendStatus): Promise<Take> {
  if (take.status === "completed" || take.status === "failed" || take.status === "canceled" || take.status === "timeout") return take;
  switch (status.state) {
    case "queued":
      return take.status === "queued" ? take : repo.updateTake(take.id, { status: "queued" });
    case "running": {
      const changed = JSON.stringify(status.progress ?? null) !== JSON.stringify(take.progress ?? null);
      if (take.status === "running" && !changed) return take;
      return repo.updateTake(take.id, { status: "running", ...(status.progress ? { progress: status.progress } : {}) });
    }
    case "completed": {
      const out = status.output;
      const url = str(out.url) ?? str(out.video_url);
      if (!url) return repo.updateTake(take.id, { status: "failed", error: "worker completed without a video url", finishedAt: Date.now() });
      const executionMs = status.executionMs ?? num(out.execution_ms);
      /* Pod mode bills per hour: the take's share is its run time at the pod's
         rate, recorded with the GPU type so speed and price can be compared. */
      const pod = config.runpodMode() === "pod" ? await repo.currentGpuPod() : undefined;
      const costUsd = executionMs ? (pod?.costPerHr ? podTakeUsd(executionMs, pod.costPerHr) : actualTakeUsd(executionMs)) : undefined;
      const thumbUrls = Array.isArray(out.thumb_urls) ? out.thumb_urls.filter((u): u is string => typeof u === "string") : [];
      const lastFrameUrl = str(out.last_frame_url);
      const updated = await repo.updateTake(take.id, {
        status: "completed", resultUrl: url, lastFrameUrl, thumbUrls, executionMs, costUsd, finishedAt: Date.now(), error: null, progress: null,
        gpuTypeId: pod?.gpuTypeId, gpuCostPerHr: pod?.costPerHr, outputSeconds: num(out.duration_s) ?? num(take.input.seconds),
      });
      if (costUsd) await repo.addSpent(take.projectId, costUsd);
      await gpu.touchGpuActivity();
      await repo.createAsset({ projectId: take.projectId, url, kind: "video", source: "generated", durationS: num(take.input.seconds), meta: { takeId: take.id, shotId: take.shotId } });
      if (lastFrameUrl) await repo.createAsset({ projectId: take.projectId, url: lastFrameUrl, kind: "image", source: "frame-extract", meta: { takeId: take.id, shotId: take.shotId, role: "last-frame" } });
      return updated;
    }
    case "failed": {
      const executionMs = status.executionMs;
      const costUsd = executionMs ? actualTakeUsd(executionMs) : undefined;
      if (costUsd) await repo.addSpent(take.projectId, costUsd);
      return repo.updateTake(take.id, { status: "failed", error: status.error, executionMs, costUsd, finishedAt: Date.now() });
    }
    case "canceled":
      return repo.updateTake(take.id, { status: "canceled", finishedAt: Date.now() });
    case "timeout":
      return repo.updateTake(take.id, { status: "timeout", error: "worker execution timed out", finishedAt: Date.now() });
  }
}

/** Poll the backend for a take that is still in flight. Cheap enough to call
    from a GET; the cron sweep does the same for everything at once. */
export async function refreshTake(takeId: string): Promise<Take> {
  const take = await repo.getTake(takeId);
  if (take.upscale && (take.upscale.status === "queued" || take.upscale.status === "running")) return refreshUpscale(takeId);
  if (take.status !== "queued" && take.status !== "running") return take;
  if (!take.requestId) return submitTake(take);
  try {
    const backend = await videoBackend();
    if (!backend) return take;
    return await applyTakeStatus(take, await backend.status(take.requestId));
  } catch (caught) {
    if (caught instanceof StudioError && caught.code === "backend_error") return take;
    throw caught;
  }
}

/* ---------- Open-H3-Regenerate-2K ---------- */

/** Queue a higher-resolution re-generation of a completed take. Same money
    rules as a take: budget with reservations, confirm from MCP, the pod is
    started when needed and the sweep submits once it is healthy. */
export async function regenerateTake(takeId: string, req: UpscaleRequest, actor: Actor): Promise<{ take: Take; estimate: Estimate; gpu?: gpu.GpuState }> {
  const take = await repo.getTake(takeId);
  if (take.status !== "completed" || !take.resultUrl) throw new StudioError("validation", "only a completed take can be regenerated at a higher resolution");
  if (take.upscale && (take.upscale.status === "queued" || take.upscale.status === "running")) throw new StudioError("validation", "a regeneration of this take is already in flight");
  const project = await repo.getProject(take.projectId);
  const seconds = take.outputSeconds ?? num(take.input.seconds) ?? 5;
  const estimate = estimateUpscale(seconds, req.resolution, await gpu.measuredForEstimate());
  assertBudget(project, estimate.usd + reservedUsd(await repo.listProjectActiveTakes(project.id)));
  if (actor.via === "mcp") assertConfirmed(req.confirm, estimate.usd, `regenerate take ${take.n} at ${req.resolution}`);
  const queued = await repo.updateTake(take.id, { upscale: { status: "queued", resolution: req.resolution, startSigma: req.startSigma, createdAt: Date.now() } });
  let gpuState: gpu.GpuState | undefined;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    gpuState = await gpu.startGpu(actor, true);
    if (gpuState.status === "running") return { take: await submitUpscale(queued), estimate, gpu: gpuState };
  }
  return { take: queued, estimate, gpu: gpuState };
}

function upscaleInput(take: Take): Record<string, unknown> {
  const stem = String(take.input.output && typeof take.input.output === "object" ? (take.input.output as { key?: string }).key ?? "" : "").replace(/\.mp4$/, "");
  const key = `${stem || `projects/${take.projectId}/takes/${take.id}`}.${take.upscale?.resolution ?? "2k"}.mp4`;
  return {
    workflow: "REGEN", video: take.resultUrl, prompt: take.prompt, resolution: take.upscale?.resolution ?? "2k", start_sigma: take.upscale?.startSigma ?? 0,
    seconds: take.outputSeconds ?? num(take.input.seconds) ?? 5, sparse: process.env.REGEN_SPARSE_ATTN === "1", output: { key }, studio_take_id: take.id,
  };
}

export async function submitUpscale(take: Take): Promise<Take> {
  const up = take.upscale;
  if (!up || up.status !== "queued" || up.requestId) return take;
  const backend = await videoBackend();
  if (!backend) return take;
  const rp = config.runpod();
  try {
    const webhook = await signHookUrl(config.publicUrl(), "/api/runpod/hook", rp.webhookSecret, `regen:${take.id}`);
    const { requestId } = await backend.submit({ ...upscaleInput(take), decoder: await gpu.regenDecoder() }, { webhook, executionTimeoutMs: rp.executionTimeoutMs });
    return await repo.updateTake(take.id, { upscale: { ...up, requestId, status: "queued", error: undefined } });
  } catch (caught) {
    const unreachable = caught instanceof StudioError && Boolean((caught.details as { unreachable?: boolean } | undefined)?.unreachable);
    if (unreachable) return take;
    return repo.updateTake(take.id, { upscale: { ...up, status: "failed", error: caught instanceof Error ? caught.message : String(caught), finishedAt: Date.now() } });
  }
}

export async function applyUpscaleStatus(take: Take, status: BackendStatus): Promise<Take> {
  const up = take.upscale;
  if (!up || up.status === "completed" || up.status === "failed" || up.status === "canceled") return take;
  switch (status.state) {
    case "queued":
      return take;
    case "running": {
      const changed = up.status !== "running" || JSON.stringify(status.progress ?? null) !== JSON.stringify(up.progress ?? null);
      return changed ? repo.updateTake(take.id, { upscale: { ...up, status: "running", ...(status.progress ? { progress: status.progress } : {}) } }) : take;
    }
    case "completed": {
      const out = status.output;
      const url = str(out.url);
      if (!url) return repo.updateTake(take.id, { upscale: { ...up, status: "failed", error: "worker completed without a video url", finishedAt: Date.now() } });
      const executionMs = status.executionMs ?? num(out.execution_ms);
      const pod = config.runpodMode() === "pod" ? await repo.currentGpuPod() : undefined;
      const costUsd = executionMs ? (pod?.costPerHr ? podTakeUsd(executionMs, pod.costPerHr) : actualTakeUsd(executionMs)) : undefined;
      const thumbUrls = Array.isArray(out.thumb_urls) ? out.thumb_urls.filter((u): u is string => typeof u === "string") : [];
      const updated = await repo.updateTake(take.id, { upscale: { ...up, status: "completed", url, thumbUrls, executionMs, costUsd, finishedAt: Date.now(), error: undefined, progress: undefined } });
      if (costUsd) await repo.addSpent(take.projectId, costUsd);
      return updated;
    }
    case "failed":
      return repo.updateTake(take.id, { upscale: { ...up, status: "failed", error: status.error, finishedAt: Date.now(), progress: undefined } });
    case "canceled":
      return repo.updateTake(take.id, { upscale: { ...up, status: "canceled", finishedAt: Date.now(), progress: undefined } });
    case "timeout":
      return repo.updateTake(take.id, { upscale: { ...up, status: "failed", error: "timed out", finishedAt: Date.now(), progress: undefined } });
  }
}

export async function refreshUpscale(takeId: string): Promise<Take> {
  const take = await repo.getTake(takeId);
  const up = take.upscale;
  if (!up || (up.status !== "queued" && up.status !== "running")) return take;
  if (!up.requestId) return submitUpscale(take);
  try {
    const backend = await videoBackend();
    if (!backend) return take;
    return await applyUpscaleStatus(take, await backend.status(up.requestId));
  } catch (caught) {
    if (caught instanceof StudioError && caught.code === "backend_error") return take;
    throw caught;
  }
}

export async function cancelUpscale(takeId: string): Promise<Take> {
  const take = await repo.getTake(takeId);
  const up = take.upscale;
  if (!up || (up.status !== "queued" && up.status !== "running")) return take;
  if (up.requestId) {
    const backend = await videoBackend();
    if (backend) await backend.cancel(up.requestId);
  }
  return repo.updateTake(take.id, { upscale: { ...up, status: "canceled", finishedAt: Date.now(), progress: undefined } });
}

export async function cancelTake(takeId: string): Promise<Take> {
  const take = await repo.getTake(takeId);
  if (take.status === "queued" && !take.requestId) return repo.updateTake(takeId, { status: "canceled", finishedAt: Date.now() });
  if (take.requestId && (take.status === "queued" || take.status === "running")) {
    const backend = await videoBackend();
    if (backend) await backend.cancel(take.requestId);
    return repo.updateTake(takeId, { status: "canceled", finishedAt: Date.now() });
  }
  return take;
}

export async function retryTake(takeId: string, actor: Actor, confirm: boolean): Promise<Take> {
  const take = await repo.getTake(takeId);
  if (take.status !== "failed" && take.status !== "timeout") throw new StudioError("validation", "only failed or timed-out takes can be retried");
  const shot = await repo.getShot(take.shotId);
  const project = await repo.getProject(take.projectId);
  const estimate = estimateTake(shot.spec.durationS, num(take.input.steps) ?? 8);
  assertBudget(project, estimate.usd + reservedUsd(await repo.listProjectActiveTakes(project.id)));
  if (actor.via === "mcp") assertConfirmed(confirm, estimate.usd, "retrying this take");
  if (config.runpodMode() === "pod") {
    const state = await gpu.startGpu(actor, true);
    if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true, gpu: state });
  }
  const backend = await videoBackend();
  if (backend?.retry && take.requestId && config.runpodMode() === "serverless") {
    const { requestId } = await backend.retry(take.requestId);
    return repo.updateTake(takeId, { requestId, status: "queued", error: null });
  }
  const reset = await repo.resetTakeForRetry(takeId);
  await gpu.touchGpuActivity();
  return submitTake(reset);
}

export async function reviewTake(takeId: string, score: number, notes: string, actor: Actor): Promise<Take> {
  return repo.updateTake(takeId, { review: { score, notes, by: actor.via === "mcp" ? "agent" : "human", at: Date.now() } });
}

export async function selectTake(shotId: string, takeId: string): Promise<Shot> {
  const take = await repo.getTake(takeId);
  if (take.shotId !== shotId) throw new StudioError("validation", "take belongs to another shot");
  if (take.status !== "completed") throw new StudioError("validation", "only completed takes can be selected");
  return repo.updateShot(shotId, { selectedTakeId: takeId });
}

/* ---------- timeline & export ---------- */

export async function autoTimeline(projectId: string): Promise<Timeline> {
  const view = await getProjectView(projectId);
  const clips: TimelineInput["clips"] = [];
  for (const scene of view.scenes) {
    for (const shot of scene.shots) {
      const take = shot.selectedTake ?? shot.takes.find((t) => t.status === "completed");
      if (!take) continue;
      clips.push({ shotId: shot.id, takeId: take.id, inS: 0, outS: shot.spec.durationS, transition: shot.spec.linkToPrev === "continuous" ? "dissolve" : "cut", transitionS: 0.3, repeat: 1 });
    }
  }
  return repo.setTimeline(projectId, { ...view.timeline, clips });
}

export async function createExportJob(projectId: string, req: ExportRequest, actor: Actor): Promise<{ job: ExportJob; estimateUsd: number; warnings: string[] }> {
  const view = await getProjectView(projectId);
  if (view.timeline.clips.length === 0) throw new StudioError("validation", "the timeline is empty; add clips or run auto timeline first");
  const takes = new Map<string, Take>();
  const shots = new Map<string, Shot>();
  for (const scene of view.scenes) for (const shot of scene.shots) {
    shots.set(shot.id, shot);
    for (const take of shot.takes) takes.set(take.id, take);
  }
  for (const clip of view.timeline.clips) {
    const take = takes.get(clip.takeId);
    if (!take || take.status !== "completed" || !take.resultUrl) {
      throw new StudioError("not_approved", `clip for shot ${clip.shotId} points at a take that is not completed`, { checkpoint: "timeline", takeId: clip.takeId });
    }
  }
  const total = view.timeline.clips.reduce((n, c) => n + Math.max(0, c.outS - c.inS) * (c.repeat ?? 1), 0);
  const estimateUsd = estimateExport(total, req.preset === "master-upscaled");
  assertBudget(view.project, estimateUsd);
  if (actor.via === "mcp") assertConfirmed(req.confirm, estimateUsd, `exporting ${req.preset}`);
  const music = view.timeline.music ? view.assets.find((a) => a.id === view.timeline.music) : undefined;
  const exportRow = await repo.createExport(projectId, req.preset, {});
  const input = buildAssemblerInput({
    exportId: exportRow.id, projectId, preset: req.preset, look: view.project.look, timeline: view.timeline, shots, takes,
    elementNames: new Map(view.elements.map((e) => [e.id, e.name])), musicUrl: music?.url, burnIn: req.burnInSubtitles,
    videoSize: view.project.look.aspectRatio === "9:16" ? "768x1344" : "1344x768",
  });
  await repo.setExportInput(exportRow.id, input as unknown as Record<string, unknown>);
  if (!runpodOrNull()) {
    const job = await repo.updateExport(exportRow.id, { status: "failed", error: "RunPod is not configured", finishedAt: Date.now() });
    return { job, estimateUsd, warnings: [] };
  }
  if (config.runpodMode() === "pod") {
    const state = await gpu.startGpu(actor, true);
    if (state.status === "unavailable") {
      const job = await repo.updateExport(exportRow.id, { status: "failed", error: state.message ?? "no GPU available right now", finishedAt: Date.now() });
      return { job, estimateUsd, warnings: [] };
    }
  }
  const job = await submitExport(await repo.getExport(exportRow.id));
  await gpu.touchGpuActivity();
  const warnings: string[] = [];
  if (req.preset === "master-upscaled") {
    const without = view.timeline.clips.filter((c) => { const t = takes.get(c.takeId); return t && !(t.upscale?.status === "completed" && t.upscale.url); });
    if (without.length) warnings.push(`${without.length} clip(s) have no Regenerate 2K pass yet and use the 768p take: ${without.map((c) => c.takeId).join(", ")}`);
  }
  return { job, estimateUsd, warnings };
}

export async function submitExport(job: ExportJob): Promise<ExportJob> {
  if (job.status !== "queued" || job.requestId) return job;
  const backend = await assemblerBackend();
  if (!backend) return job;
  try {
    const webhook = await signHookUrl(config.publicUrl(), "/api/assembler/hook", config.runpod().webhookSecret, job.id);
    const { requestId } = await backend.submit(job.input, { webhook, executionTimeoutMs: 30 * 60_000 });
    return await repo.updateExport(job.id, { requestId, status: "queued", error: null });
  } catch (caught) {
    const unreachable = caught instanceof StudioError && Boolean((caught.details as { unreachable?: boolean } | undefined)?.unreachable);
    if (unreachable) return job;
    return repo.updateExport(job.id, { status: "failed", error: caught instanceof Error ? caught.message : String(caught), finishedAt: Date.now() });
  }
}

export async function applyExportStatus(job: ExportJob, status: BackendStatus): Promise<ExportJob> {
  if (job.status === "completed" || job.status === "failed") return job;
  switch (status.state) {
    case "queued":
      return job;
    case "running":
      return job.status === "running" ? job : repo.updateExport(job.id, { status: "running" });
    case "completed": {
      const url = str(status.output.url);
      if (!url) return repo.updateExport(job.id, { status: "failed", error: "assembler completed without a url", finishedAt: Date.now() });
      const updated = await repo.updateExport(job.id, { status: "completed", resultUrl: url, srtUrl: str(status.output.srt_url), finishedAt: Date.now() });
      await repo.createAsset({ projectId: job.projectId, url, kind: "video", source: "export", durationS: num(status.output.duration_s), meta: { exportId: job.id, preset: job.preset } });
      return updated;
    }
    case "failed":
      return repo.updateExport(job.id, { status: "failed", error: status.error, finishedAt: Date.now() });
    case "canceled":
    case "timeout":
      return repo.updateExport(job.id, { status: "failed", error: status.state, finishedAt: Date.now() });
  }
}

export async function refreshExport(exportId: string): Promise<ExportJob> {
  const job = await repo.getExport(exportId);
  if (job.status !== "queued" && job.status !== "running") return job;
  if (!job.requestId) return submitExport(job);
  try {
    const backend = await assemblerBackend();
    if (!backend) return job;
    return await applyExportStatus(job, await backend.status(job.requestId));
  } catch (caught) {
    if (caught instanceof StudioError && caught.code === "backend_error") return job;
    throw caught;
  }
}

/* ---------- sweep (cron) ---------- */

export async function sweep(): Promise<{ takes: number; exports: number; gpu?: string; autoStopped?: boolean }> {
  let gpuStatus: string | undefined;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    try {
      gpuStatus = (await gpu.refreshGpu())?.status;
    } catch (caught) {
      gpuStatus = `refresh failed: ${caught instanceof Error ? caught.message : caught}`;
    }
  }
  const [takes, exports, upscales] = await Promise.all([repo.listActiveTakes(), repo.listActiveExports(), repo.listActiveUpscales()]);
  for (const take of upscales.slice(0, 20)) {
    try {
      await refreshUpscale(take.id);
    } catch {
      /* next sweep */
    }
  }
  const timeoutMs = (() => {
    try {
      return config.runpod().executionTimeoutMs + 2 * 60 * 60_000;
    } catch {
      return 3 * 60 * 60_000;
    }
  })();
  /* Submission order: takes already running first (status refresh), then
     pending takes grouped by base model — R2VA (ref2va) and the rest (fl2va)
     load different 21 GB checkpoints, so alternating would reload every job.
     The group of whatever is running (or the larger pending group) goes first. */
  const family = (w: string) => (w === "R2VA" ? "ref2va" : "fl2va");
  const running = takes.filter((x) => x.requestId);
  const pending = takes.filter((x) => !x.requestId);
  const activeFamily = running.length ? family(running[running.length - 1]!.workflow) : undefined;
  const counts = { ref2va: pending.filter((x) => family(x.workflow) === "ref2va").length, fl2va: pending.filter((x) => family(x.workflow) === "fl2va").length };
  const firstFamily = activeFamily ?? (counts.ref2va > counts.fl2va ? "ref2va" : "fl2va");
  pending.sort((a, b) => Number(family(b.workflow) === firstFamily) - Number(family(a.workflow) === firstFamily) || a.createdAt - b.createdAt);
  const ordered = [...running, ...pending];

  let t = 0;
  for (const take of ordered.slice(0, 50)) {
    if (Date.now() - take.createdAt > timeoutMs) {
      await repo.updateTake(take.id, { status: "timeout", error: "no answer from the worker within the deadline", finishedAt: Date.now() });
      t++;
      continue;
    }
    const before = take.status;
    const after = await refreshTake(take.id);
    if (after.status !== before) t++;
  }
  let e = 0;
  for (const job of exports.slice(0, 20)) {
    const before = job.status;
    if ((await refreshExport(job.id)).status !== before) e++;
  }
  let autoStopped: boolean | undefined;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    const stillBusy = (await repo.listActiveTakes()).length > 0 || (await repo.listActiveExports()).length > 0;
    try {
      autoStopped = await gpu.autoStopIfIdle(stillBusy);
    } catch {
      autoStopped = false;
    }
  }
  return { takes: t, exports: e, gpu: gpuStatus, autoStopped };
}

/* ---------- helpers ---------- */

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
