import { assertBudget, assertCanGenerate, assertConfirmed, isStructuralChange } from "./checkpoints";
import { CompileError, compileShot, effectiveLink, VIDEO_SIZES, type CompiledJob } from "./compiler";
import { grammarFor } from "./editing";
import { config } from "./config";
import { actualTakeUsd, estimateExport, estimateTake, podTakeUsd, reservedUsd, type Estimate, estimateUpscale } from "./cost";
import * as director from "@/director";
import { audioInputs, autopilotCovers, consumeAutopilot, identicalTakes, renderHash, reviewState } from "./craft-core";
import { paletteContrastWarnings } from "./sketch";

import { StudioError } from "./errors";
import { realnessOfDrawing } from "./provenance";
import * as repo from "./repo";
import { buildAssemblerInput } from "./backends/assembler";
import { RunPodBackend, signHookUrl } from "./backends/runpod";
import * as gpu from "./gpu";
import type { BackendStatus, GenerationBackend } from "./backends/types";
import type { ExportRequest, PromptExperiments, ShotInput, ShotPatch, ShotlistInput, TakeFault, TakeRequest, TimelineInput } from "./schemas";
import { ShotInput as ShotInputSchema, ShotlistInput as ShotlistInputSchema, UpscaleRequest } from "./schemas";
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
  /** Checkpoints currently passed by the director under delegated approval. */
  delegated: { script: boolean; shotlist: boolean };
};

export async function getProjectView(projectId: string): Promise<ProjectView> {
  const project = await repo.getProject(projectId);
  const [script, elements, scenes, shots, takes, timeline, assets, decisions] = await Promise.all([
    repo.latestScript(projectId),
    repo.listElements(projectId, true),
    repo.listScenes(projectId),
    repo.listShots(projectId),
    repo.listProjectTakes(projectId),
    repo.getTimeline(projectId),
    repo.listAssets(projectId),
    repo.listNotes(projectId, "decision"),
  ]);
  const standing = decisions.filter((d) => d.status === "standing" && d.body.approval);
  const delegated = {
    script: !!script && script.approval === "approved" && standing.some((d) => d.body.approval === "script" && d.body.scriptId === script.id),
    shotlist: project.shotlistApproval === "approved" && standing.some((d) => d.body.approval === "shotlist" && Math.abs((project.shotlistApprovedAt ?? 0) - d.createdAt) <= 5_000),
  };
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
  return { project, script, elements, scenes: sceneViews, timeline, assets, canGenerate: blockers.length === 0, blockers, delegated };
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

async function compileContext(shotId: string, opts?: { steps?: number; seed?: number; experiments?: PromptExperiments }) {
  const shot = await repo.getShot(shotId);
  const project = await repo.getProject(shot.projectId);
  const scene = await repo.getScene(shot.sceneId);
  const experiments = { ...(project.look.experiments ?? {}), ...(opts?.experiments ?? {}) };
  /* speakers too: an off-screen speaker need not be in the shot's characters */
  const ids = [...new Set([...shot.spec.characters, ...shot.spec.dialogue.map((l) => l.speaker), ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : [])])];
  const elements = await repo.getElements(ids);
  const assetIds = new Set<string>();
  for (const el of elements.values()) {
    for (const id of el.refAssetIds) assetIds.add(id);
    /* the voice: every state's reference audio (the compiler picks by line), the legacy single sample */
    for (const st of el.voice?.states ?? []) for (const id of st.refAssetIds) assetIds.add(id);
    if (el.voiceAssetId) assetIds.add(el.voiceAssetId);
  }
  for (const l of shot.spec.dialogue) if (l.audioAssetId) assetIds.add(l.audioAssetId);
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
  return { shot, project, scene, elements, assets, prevLastFrameUrl, anchorFrameUrl, anchorLabel, sourceTake, loras, steps: opts?.steps, seed: opts?.seed, experiments };
}

export async function compileForShot(shotId: string, opts?: { steps?: number; seed?: number; experiments?: PromptExperiments }): Promise<CompiledJob & { estimate: Estimate }> {
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
  const ctx = await compileContext(shotId, { steps: req.steps, seed: req.seed, experiments: req.experiments });
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
  /* the GPU pod still downloading models: refuse before anything is spent (the envelope included) */
  await gpu.assertPodCanWork("a take");

  /* Keep errors in front of the spend: a cold-reader review of this exact
     prompt and these frames, and no blind re-render of a rejected input. */
  const subject = renderHash(compiled.workflow, compiled.prompt, compiled.input.images, audioInputs(compiled.input));
  const review = await reviewState(ctx.project.id, "shot", subject, shotId);
  const earlier = await repo.listShotTakes(shotId);
  const same = identicalTakes(earlier, subject);
  const guards = preRenderGuards(review.state, same, earlier);
  compiled.warnings.push(...guards);
  let unreviewed: string | undefined;
  if (actor.via === "mcp") {
    /* The envelope spends without asking, so it takes an independent read: the
       agent's own review of its own shot is not one (the script checkpoint has
       the same rule). */
    const independent = review.state === "pass" && review.review?.reviewer !== "self";
    const auto = !req.confirm && independent && same.rejected.length === 0 && autopilotCovers(ctx.project, estimate.usd);
    if (!req.confirm && !auto) {
      throw new StudioError("needs_confirm", `${req.n} take(s) of ${ctx.shot.spec.durationS}s costs about ${estimate.usd.toFixed(2)} USD. Call again with confirm: true.`, {
        estimateUsd: estimate.usd, review: review.state, reviewer: review.review?.reviewer, warnings: guards,
        autopilot: ctx.project.autopilot ? { envelopeUsd: ctx.project.autopilot.envelopeUsd, usedUsd: ctx.project.autopilot.usedUsd, covers: autopilotCovers(ctx.project, estimate.usd), needs: "a passing shot review by a fresh reviewer (not your own) and no identical rejected take" } : undefined,
      });
    }
    /* A confirmation says the price is accepted, not that the shot was read.
       An agent renders an unreviewed shot only by saying so, on the record. */
    if (review.state !== "pass") {
      if (!req.skipReview) {
        throw new StudioError("not_approved", `this shot has ${review.state === "none" ? "no shot review" : review.state === "stale" ? "only a review of an earlier prompt or frame" : "a failed shot review"}: review_packet(stage 'shot') → a fresh reviewer → record_review, then render. To render without one, pass skipReview with the reason; it goes to the decision log.`, { review: review.state, estimateUsd: estimate.usd, warnings: guards });
      }
      unreviewed = req.skipReview;
    }
    if (auto) await consumeAutopilot(ctx.project, estimate.usd, `${req.n} take(s) of shot ${ctx.shot.index + 1} (${ctx.shot.spec.intent})`, `shot review passed (${review.review?.reviewer ?? "?"}); inside the envelope`, shotId);
  }

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

  if (unreviewed) {
    await repo.insertNote(ctx.project.id, "decision", "standing", {
      decision: `rendered shot ${ctx.shot.index + 1} without a passing shot review (${review.state})`, why: unreviewed, confidence: "low", spendUsd: estimate.usd, shotId, by: actor.user,
    });
  }
  const takes: Take[] = [];
  for (let i = 0; i < req.n; i++) {
    const seed = req.seed !== undefined ? req.seed + i : Math.floor(Math.random() * 2 ** 31);
    const take = await repo.createTake({
      projectId: ctx.project.id, shotId, backend: "runpod", workflow: compiled.workflow, prompt: compiled.prompt,
      input: { ...compiled.input, seed, ...(onExperiments(ctx.experiments) ? { studio_experiments: ctx.experiments } : {}) }, seed,
    });
    const input = {
      ...take.input,
      seed,
      studio_take_id: take.id,
      output: { key: `projects/${ctx.project.id}/shots/${shotId}/takes/${take.id}.mp4` },
    };
    takes.push(await submitTake(await repo.updateTake(take.id, { input })));
  }
  await gpu.touchGpuActivity();
  return { takes, estimate, warnings: compiled.warnings, gpu: gpuState };
}

function onExperiments(e: PromptExperiments | undefined): boolean {
  return !!e && Object.values(e).some(Boolean);
}

/** Warnings before a render: the review state of this exact input, and
    earlier takes that rendered the same thing. */
export function preRenderGuards(state: "pass" | "fail" | "stale" | "none", same: { rejected: Take[]; any: Take[] }, earlier: Take[] = []): string[] {
  const out: string[] = [];
  /* A re-render with no verdict on the takes before it teaches the retro nothing. */
  const unjudged = earlier.filter((t) => t.status === "completed" && !t.review);
  if (unjudged.length) out.push(`take ${unjudged.map((t) => `#${t.n}`).join(", ")} of this shot ${unjudged.length > 1 ? "have" : "has"} no review: note what was wrong first — the user's tags on the Board, or review_take with faults and a basis (you see stills only) — so the next render and the retro know what failed`);
  if (same.rejected.length) out.push(`same prompt and frames as rejected take ${same.rejected.map((t) => `#${t.n}`).join(", ")}: re-rendering the same input usually fails the same way — change the beats, wording or frames first (revise_shot), or pass a seed on purpose`);
  else if (same.any.length) out.push(`same prompt and frames as take ${same.any.map((t) => `#${t.n}`).join(", ")}; only the seed differs`);
  if (state === "none") out.push("no cold-reader review of this shot yet: review_packet(stage 'shot') → a fresh agent → record_review");
  else if (state === "stale") out.push("the last shot review covered an earlier prompt or frame; review again before spending");
  else if (state === "fail") out.push("the last shot review failed: fix its findings, then review again");
  return out;
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
      if (lastFrameUrl) {
        const shot = await repo.getShot(take.shotId).catch(() => undefined);
        const scene = shot ? await repo.getScene(shot.sceneId).catch(() => undefined) : undefined;
        const where = scene && shot ? `${scene.slug} #${shot.index + 1} · ` : "";
        /* 模拟 or 真实, from the pictures the take was rendered from */
        const realness = await realnessOfDrawing(take.projectId, { takeId: take.id });
        await repo.createAsset({ projectId: take.projectId, url: lastFrameUrl, kind: "image", source: "frame-extract", meta: { takeId: take.id, shotId: take.shotId, role: "last-frame", realness }, name: `${where}take #${take.n} last frame` });
      }
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
  await gpu.assertPodCanWork("a 2K regeneration");
  const picked = (await repo.getShot(take.shotId)).selectedTakeId === take.id;
  if (actor.via === "mcp" && !req.confirm && picked && autopilotCovers(project, estimate.usd)) await consumeAutopilot(project, estimate.usd, `regenerate take #${take.n} at ${req.resolution}`, "the user picked this take; inside the envelope", take.shotId);
  else if (actor.via === "mcp") assertConfirmed(req.confirm, estimate.usd, `regenerate take ${take.n} at ${req.resolution}`);
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
  await gpu.assertPodCanWork("a retried take");
  if (actor.via === "mcp" && !confirm && autopilotCovers(project, estimate.usd)) await consumeAutopilot(project, estimate.usd, `retry take #${take.n}`, "the take failed on the backend, not on review; inside the envelope", shot.id);
  else if (actor.via === "mcp") assertConfirmed(confirm, estimate.usd, "retrying this take");
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

export async function reviewTake(takeId: string, score: number, notes: string, actor: Actor, extra?: { faults?: TakeFault[]; audioOk?: boolean; basis?: string }): Promise<Take> {
  /* An agent sees stills, not motion, and hears nothing: its review says so. */
  if (actor.via === "mcp" && !extra?.basis) throw new StudioError("validation", "an agent review needs basis: what you actually inspected (e.g. '6 stills; motion and sound not checked')");
  return repo.updateTake(takeId, { review: {
    score, notes, by: actor.via === "mcp" ? "agent" : "human", at: Date.now(),
    ...(extra?.faults?.length ? { faults: extra.faults } : {}),
    ...(extra?.audioOk !== undefined ? { audioOk: extra.audioOk } : {}),
    ...(extra?.basis ? { basis: extra.basis } : {}),
  } });
}

export async function selectTake(shotId: string, takeId: string): Promise<Shot> {
  const take = await repo.getTake(takeId);
  if (take.shotId !== shotId) throw new StudioError("validation", "take belongs to another shot");
  if (take.status !== "completed") throw new StudioError("validation", "only completed takes can be selected");
  return repo.updateShot(shotId, { selectedTakeId: takeId });
}

/* ---------- timeline & export ---------- */

/** Frames a frame-driven take loses at its head: its first frame is the
    input image itself (a duplicate of the anchor's last frame on a continuous
    cut, and sharper than the video after it). */
export const HEAD_TRIM_FRAMES = 2;

/**
 * The timeline from the selected (or latest completed) take of every shot.
 * Every join is a hard cut: a continuous / bridge / insert-return shot starts
 * on its anchor's last frame, so a dissolve would only double the picture.
 * Frame-driven takes drop their first frames; a shot with screenS plays that
 * long and keeps the rest as handles; FL2VA takes can lose a tail where the
 * model snaps onto the end frame (tailTrimS, off until measured).
 *
 * The web Timeline's default (and its Reset) is plainer: `selectedOnly` joins
 * only the shots whose take was picked, and `fullLength` plays every clip
 * from 0 s to the end of its take, with no head, tail or screenS trim.
 */
export async function autoTimeline(projectId: string, opts?: { tailTrimS?: number; headFrames?: number; selectedOnly?: boolean; fullLength?: boolean }): Promise<Timeline> {
  const view = await getProjectView(projectId);
  const clips: TimelineInput["clips"] = [];
  const headS = (opts?.headFrames ?? HEAD_TRIM_FRAMES) / 24;
  for (const scene of view.scenes) {
    for (const shot of scene.shots) {
      const take = opts?.selectedOnly ? shot.selectedTake : shot.selectedTake ?? shot.takes.find((t) => t.status === "completed");
      if (!take || take.status !== "completed") continue;
      const fromFrame = take.workflow === "I2VA" || take.workflow === "FL2VA";
      const length = Math.min(15, take.outputSeconds ?? shot.spec.durationS);
      const inS = fromFrame && !opts?.fullLength ? round3(headS) : 0;
      let outS = length - (take.workflow === "FL2VA" && !opts?.fullLength ? (opts?.tailTrimS ?? 0) : 0);
      if (shot.spec.screenS && !opts?.fullLength) outS = Math.min(outS, inS + shot.spec.screenS);
      clips.push({
        shotId: shot.id, takeId: take.id, inS, outS: round3(Math.max(inS + 0.5, outS)), transition: "cut", repeat: 1, speed: 1,
        muteOwnAudio: take.review?.audioOk === false,
      });
    }
  }
  return repo.setTimeline(projectId, { ...view.timeline, clips });
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Out of budget, or before the last takes are in: assemble what exists, in
 * order, and say what is missing — the user sees the film so far instead of
 * an error.
 */
export async function roughCut(projectId: string): Promise<{ timeline: Timeline; missing: Array<{ shot: string; intent: string; seconds: number; atS: number }>; renderedS: number; plannedS: number; next: string }> {
  const timeline = await autoTimeline(projectId);
  const view = await getProjectView(projectId);
  const missing: Array<{ shot: string; intent: string; seconds: number; atS: number }> = [];
  let planned = 0;
  for (const scene of view.scenes) for (const shot of scene.shots) {
    const has = shot.selectedTake ?? shot.takes.find((t) => t.status === "completed");
    if (!has) missing.push({ shot: `${scene.slug} #${shot.index + 1}`, intent: shot.spec.intent, seconds: shot.spec.screenS ?? shot.spec.durationS, atS: round3(planned) });
    planned += shot.spec.screenS ?? shot.spec.durationS;
  }
  const rendered = timeline.clips.reduce((a, c) => a + (c.outS - c.inS) / (c.speed ?? 1), 0);
  return {
    timeline, missing, renderedS: round3(rendered), plannedS: round3(planned),
    next: timeline.clips.length ? "export_project with preset preview-480p (cheap) to show the user this cut; list the missing shots and what finishing them would cost" : "nothing is rendered yet",
  };
}

/**
 * Seams that can no longer match: a linked shot was rendered from one take
 * of its anchor, and the anchor's pick has changed since; or the timeline
 * trims the anchor's tail, so the cut jumps by the trimmed time.
 */
export async function checkSeams(projectId: string): Promise<LintWarning[]> {
  const view = await getProjectView(projectId);
  const flat = view.scenes.flatMap((s) => s.shots.map((sh, i) => ({ scene: s, sh, i })));
  const out: LintWarning[] = [];
  const clipFor = new Map(view.timeline.clips.map((c) => [c.shotId, c]));
  flat.forEach(({ scene, sh, i }, k) => {
    const link = effectiveLink(sh.spec);
    if (!["continuous", "bridge", "insert_return", "reverse", "jump_cut"].includes(link.type)) return;
    const anchor = link.anchorShotId ? flat.find((x) => x.sh.id === link.anchorShotId) : flat[k + (link.anchor ?? grammarFor(link.type).defaultAnchor)];
    const take = sh.selectedTake ?? sh.takes.find((t) => t.status === "completed");
    if (!anchor || !take) return;
    const first = (Array.isArray(take.input.images) ? (take.input.images as Array<{ url: string; role: string }>) : []).find((x) => x.role === "first_frame")?.url;
    const pick = anchor.sh.selectedTake ?? anchor.sh.takes.find((t) => t.status === "completed");
    const at = { scene: scene.slug, shot: i + 1 };
    if (first && pick?.lastFrameUrl && first !== pick.lastFrameUrl) {
      const from = anchor.sh.takes.find((t) => t.lastFrameUrl === first);
      out.push({ code: "seam.anchor", severity: "warn", ...at, message: `rendered from ${from ? `take #${from.n}` : "another take"} of ${anchor.scene.slug} #${anchor.i + 1}, but that shot's pick is now take #${pick.n}: the ${link.type} seam will jump. Re-pick take #${from?.n ?? "?"} there, or re-render this shot` });
    }
    const ac = clipFor.get(anchor.sh.id);
    if (link.type === "continuous" && ac && pick && (pick.outputSeconds ?? anchor.sh.spec.durationS) - ac.outS > 0.15) {
      out.push({ code: "seam.trim", severity: "warn", ...at, message: `the timeline ends ${anchor.scene.slug} #${anchor.i + 1} ${((pick.outputSeconds ?? anchor.sh.spec.durationS) - ac.outS).toFixed(2)} s before its last frame, which is where this continuous shot starts: the cut jumps` });
    }
  });
  return out;
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
  const total = view.timeline.clips.reduce((n, c) => n + (Math.max(0, c.outS - c.inS) / (c.speed ?? 1)) * (c.repeat ?? 1), 0);
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
  /* A cut is where the user's asks are settled: say which ones nobody closed. */
  const open = (await repo.listNotes(projectId, "requirement")).filter((n) => n.status === "open");
  if (open.length) warnings.push(`${open.length} requirement(s) from the user are still open: go through them against this cut and set each met or dropped (set_requirement) — ${open.slice(0, 5).map((n) => String(n.body.text)).join("; ")}${open.length > 5 ? " …" : ""}`);
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
      await repo.createAsset({ projectId: job.projectId, url, kind: "video", source: "export", durationS: num(status.output.duration_s), meta: { exportId: job.id, preset: job.preset, cutsS: Array.isArray(status.output.cuts_s) ? status.output.cuts_s : undefined } });
      /* 3 frames each side of every cut, for the film review. */
      const sheet = str(status.output.cut_sheet_url);
      if (sheet) await repo.createAsset({ projectId: job.projectId, url: sheet, kind: "image", source: "export", meta: { exportId: job.id, role: "cut-sheet" }, name: `cut sheet · ${job.preset}` });
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

export async function sweep(): Promise<{ takes: number; exports: number; images: number; gpu?: string; autoStopped?: boolean }> {
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
  /* image jobs (paint, crop, extract) on the pod */
  let images = 0;
  try {
    const { sweepImageJobs } = await import("./imaging");
    images = await sweepImageJobs();
  } catch {
    /* next sweep */
  }
  /* the painter pod: started for queued pictures, stopped when idle */
  try {
    const { sweepPainterPod } = await import("./painter-pod");
    await sweepPainterPod();
  } catch {
    /* next sweep */
  }
  let autoStopped: boolean | undefined;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    /* pictures keep the pod up only while the pod itself is drawing one (painters elsewhere do not need it) */
    const { podIsPainting } = await import("./painter");
    const stillBusy = (await repo.listActiveTakes()).length > 0 || (await repo.listActiveExports()).length > 0 || (await podIsPainting());
    try {
      autoStopped = await gpu.autoStopIfIdle(stillBusy);
    } catch {
      autoStopped = false;
    }
  }
  return { takes: t, exports: e, images, gpu: gpuStatus, autoStopped };
}

/* ---------- helpers ---------- */

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}


/* ---------- the director layer applied to a project ---------- */

/** The project's shotlist in save_shotlist shape (what the lint, the style
    pass and the batch planner take). */
export async function shotlistOf(projectId: string): Promise<{ view: ProjectView; shotlist: ShotlistInput }> {
  const view = await getProjectView(projectId);
  const shotlist = { scenes: view.scenes.map((s) => ({ slug: s.slug, summary: s.summary ?? "", location: s.locationElementId ?? undefined, ...(s.palette ? { palette: s.palette } : {}), shots: s.shots.map((sh) => sh.spec) })) } as ShotlistInput;
  return { view, shotlist };
}

export type LintWarning = { code: string; message: string; scene?: string; shot?: number; severity: "error" | "warn" | "info" };

/** Rhythm and craft lint over the saved shotlist, plus the Tier 2 / Tier 3
    completeness the MCP save path reports. */
export async function lintProject(projectId: string, opts?: { totalSeconds?: number }): Promise<{ warnings: LintWarning[]; counts: { error: number; warn: number; info: number } }> {
  const { view, shotlist } = await shotlistOf(projectId);
  /* the Look's constraints are checked with or without a shotlist: they ride in every prompt */
  const lookWarnings = director.lintConstraints(view.project.look.negative ?? []) as LintWarning[];
  if (shotlist.scenes.length === 0) {
    const counts = { error: 0, warn: 0, info: 0 };
    for (const x of lookWarnings) counts[x.severity]++;
    return { warnings: lookWarnings, counts };
  }
  const elements = view.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, fixedFeatures: e.fixedFeatures }));
  const raw = director.lintShotlist(shotlist as never, { totalSeconds: opts?.totalSeconds ?? view.project.targetSeconds ?? undefined, elements }) as LintWarning[];
  /* The package numbers shots across the film from 0; the Board keys them
     per scene from 1. */
  const where = view.scenes.flatMap((s) => s.shots.map((_sh, i) => ({ scene: s.slug, shot: i + 1 })));
  const warnings: LintWarning[] = raw.map((w) => (w.shot !== undefined && where[w.shot] ? { ...w, ...where[w.shot]! } : w));
  const [w, h] = VIDEO_SIZES[view.project.look.aspectRatio].split("x").map(Number) as [number, number];
  for (const scene of view.scenes) {
    scene.shots.forEach((sh, i) => {
      const at = { scene: scene.slug, shot: i + 1 };
      const c = (sh.spec.cinematography ?? {}) as Record<string, unknown>;
      const missing = ["size", "angle", "lens", "lighting", "grade"].filter((k) => c[k] === undefined || c[k] === null || (Array.isArray(c[k]) && (c[k] as unknown[]).length === 0));
      if (missing.length) warnings.push({ code: "tier3.missing", severity: "warn", ...at, message: `cinematography missing ${missing.join(", ")}` });
      if (!sh.spec.link) warnings.push({ code: "tier2.link", severity: "warn", ...at, message: "no link type (defaults to a hard cut)" });
      warnings.push(...frameWarnings(sh, w, h).map((x) => ({ ...x, ...at })));
    });
  }
  warnings.push(...lookWarnings);
  for (const p of paletteContrastWarnings(view)) warnings.push({ code: "palette.contrast", severity: "warn", scene: p.scene, message: p.message });
  warnings.push(...(await checkSeams(projectId)));
  const open = (await repo.listNotes(projectId, "requirement")).filter((n) => n.status === "open");
  if (open.length) warnings.push({ code: "requirements.open", severity: "info", message: `${open.length} requirement(s) from the user still open: ${open.slice(0, 5).map((n) => String(n.body.text)).join("; ")}${open.length > 5 ? " …" : ""}` });
  const counts = { error: 0, warn: 0, info: 0 };
  for (const x of warnings) counts[x.severity]++;
  return { warnings, counts };
}

/** First / last frame checks that need the assets: same size, the render's
    aspect ratio, and a push-in that has no end frame to push into. */
export function frameWarnings(sh: ShotView, videoW: number, videoH: number): Array<Omit<LintWarning, "scene" | "shot">> {
  const out: Array<Omit<LintWarning, "scene" | "shot">> = [];
  const target = videoW / videoH;
  for (const [label, a] of [["hero frame", sh.hero], ["end frame", sh.end]] as const) {
    if (a?.width && a.height && Math.abs(a.width / a.height - target) / target > 0.02) {
      out.push({ code: "frames.aspect", severity: "warn", message: `${label} is ${a.width}×${a.height} (${(a.width / a.height).toFixed(3)}), the render is ${videoW}×${videoH} (${target.toFixed(3)}); crop it before rendering or the model reframes it` });
    }
  }
  if (sh.hero?.width && sh.end?.width && (sh.hero.width !== sh.end.width || sh.hero.height !== sh.end.height)) {
    out.push({ code: "frames.size", severity: "warn", message: `first frame ${sh.hero.width}×${sh.hero.height} and last frame ${sh.end.width}×${sh.end.height} differ; make them the same size` });
  }
  if (sh.spec.mode === "keyframe" && sh.spec.camera.move === "push_in" && sh.hero && !sh.end) {
    out.push({ code: "frames.pushin", severity: "info", message: "push-in from a hero frame with no end frame: derive_end_frame crops the hero frame into the end frame, so FL2VA has to push" });
  }
  return out;
}

/** Fill every shot's cinematography with a style's defaults and save the
    merged shotlist (takes are kept). */
export async function applyStyleToProject(projectId: string, style: string, opts?: { beatSuffix?: boolean; musicForShotsWithScore?: boolean }): Promise<{ warnings: LintWarning[]; view: ProjectView }> {
  const found = director.findStyle(style);
  if (!found) throw new StudioError("not_found", `no style matches "${style}"`);
  const { shotlist } = await shotlistOf(projectId);
  if (shotlist.scenes.length === 0) throw new StudioError("validation", "the project has no shotlist yet");
  const result = director.applyStyle(found.style, shotlist as never, { beatSuffix: opts?.beatSuffix ?? true, musicForShotsWithScore: opts?.musicForShotsWithScore ?? true });
  const saved = await saveShotlist(projectId, ShotlistInputSchema.parse(result.shotlist));
  const project = await repo.getProject(projectId);
  await repo.setProjectLook(projectId, { ...project.look, style: found.style.slug });
  return { warnings: result.warnings as LintWarning[], view: saved };
}

export type BatchShotView = { shotId: string; label: string; durationS: number; mode: string; link?: string; hasTake: boolean; estimateUsd?: number; fragility: number; fragile: string[]; tier: "turbo" | "careful" };
export type ProjectBatch = ReturnType<typeof director.planBatch> & {
  shots: BatchShotView[];
  /** Render these first, on their own confirmation: the hardest shots tell whether the plan holds before the rest is spent. */
  probe: { shotIds: string[]; estimateUsd: number; why: string };
};

/** Fragility at or above this suggests the careful tier (2 takes, or the base chain). */
export const CAREFUL_FRAGILITY = 3;

/** Order the shots still to render (R2VA first, anchors before linked
    shots) with one estimate against the cap, a probe of the hardest shots to
    render first, and a tier suggestion per shot. Per-shot estimates come from
    the compiler when the shot compiles; otherwise the planner's fallback. */
export async function planProjectBatch(projectId: string, opts?: { takesPerShot?: number; onlyMissing?: boolean }): Promise<ProjectBatch> {
  const view = await getProjectView(projectId);
  const measured = await gpu.measuredForEstimate();
  const elements = view.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, fixedFeatures: e.fixedFeatures }));
  const flat = view.scenes.flatMap((s) => s.shots.map((sh) => ({ scene: s, shot: sh })));
  const shots = [];
  for (let index = 0; index < flat.length; index++) {
    const { scene, shot } = flat[index]!;
    const hasTake = Boolean(shot.selectedTake ?? shot.takes.find((t) => t.status === "completed"));
    let estimateUsd: number | undefined;
    try {
      estimateUsd = (await compileForShot(shot.id)).estimate.usd;
    } catch {
      estimateUsd = undefined;
    }
    const f = director.shotFragility(shot.spec as never, elements);
    shots.push({
      shotId: shot.id, index, durationS: shot.spec.durationS, mode: shot.spec.mode,
      link: shot.spec.link ? { type: shot.spec.link.type, anchor: shot.spec.link.anchor, anchorShotId: shot.spec.link.anchorShotId } : undefined,
      hasTake, estimateUsd, label: `${scene.slug} #${shot.index + 1} · ${shot.spec.intent}`,
      fragility: f.score, fragile: f.reasons.map((r) => r.code), tier: (f.score >= CAREFUL_FRAGILITY ? "careful" : "turbo") as "turbo" | "careful",
    });
  }
  const perSecondUsd = measured.secondsPerOutputSecond && measured.usdPerHr ? (measured.secondsPerOutputSecond * measured.usdPerHr) / 3600 : undefined;
  const plan = director.planBatch(shots as never, { capUsd: view.project.budgetCapUsd, spentUsd: view.project.spentUsd }, { perSecondUsd, takesPerShot: opts?.takesPerShot ?? 1, onlyMissing: opts?.onlyMissing ?? true });
  /* The probe: the one or two most fragile shots still to render that do
     not wait on an anchor. If they come out, the rest of the plan holds. */
  const pending = shots.filter((x) => !x.hasTake && (!x.link || ["cut", "montage", "match_cut", "loop"].includes(x.link.type)) && x.fragility > 0);
  const probe = [...pending].sort((a, b) => b.fragility - a.fragility).slice(0, 2);
  return {
    ...plan,
    shots: shots.map(({ index: _i, link, ...x }) => ({ ...x, link: link?.type })),
    probe: {
      shotIds: probe.map((x) => x.shotId),
      estimateUsd: Math.round(probe.reduce((a, x) => a + (x.estimateUsd ?? 0), 0) * 100) / 100,
      why: probe.length ? `render ${probe.map((x) => x.label.split(" · ")[0]).join(" and ")} first (${probe.map((x) => x.fragile.join(", ")).join(" / ")}); if they hold, confirm the rest` : "no fragile shot to probe",
    },
  };
}
