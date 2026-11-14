import { assertBudget, assertCanGenerate, assertConfirmed, isStructuralChange } from "./checkpoints";
import { CompileError, compileShot, effectiveLink, VIDEO_SIZES, type CompiledJob } from "./compiler";
import { grammarFor } from "./editing";
import { config } from "./config";
import { actualTakeUsd, estimateExport, estimateTake, podTakeUsd, reservedUsd, type Estimate, estimateUpscale } from "./cost";
import * as director from "@/director";
import { audioInputs, autopilotCovers, consumeAutopilot, identicalTakes, renderHash, retakeChanges, reviewState, type RetakeChange, type RetakeRecord } from "./craft-core";
import { paletteContrastWarnings } from "./sketch";

import { StudioError } from "./errors";
import { realnessOfDrawing } from "./provenance";
import * as repo from "./repo";
import * as trash from "./trash";
import { coverage, openText } from "./coverage";
import { assignedRefs, assignmentState, fitsShot, shotSwitches, shotWorkflows } from "./shot-loras";
import * as styles from "./styles";
import * as treatments from "./treatment";
import { buildAssemblerInput, clipSeconds, exportFindings, type AssemblerInput, type ExportChecks } from "./backends/assembler";
import { RunPodBackend, signHookUrl } from "./backends/runpod";
import * as gpu from "./gpu";
import type { BackendStatus, GenerationBackend } from "./backends/types";
import type { ExportRequest, PromptExperiments, ShotInput, ShotLora, ShotPatch, ShotlistInput, TakeFault, TakeRequest, TimelineInput } from "./schemas";
import { MAX_SHOT_LORAS } from "./schemas";
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

/**
 * The director's LoRA pass, once the board is designed: each listed shot gets
 * the style / effect LoRAs that suit it, each with why, or [] when none does.
 * The user never picks them; the shot shows them under its use-LoRA switch.
 * A speed LoRA is not assigned: the shot's use-turbo switch loads the one for
 * its workflow. Everything is checked before anything is written.
 */
export async function assignLoras(projectId: string, items: Array<{ shotId: string; loras: ShotLora[] }>): Promise<{ shots: Array<{ shotId: string; slate: string; loras: Array<{ id: string; name: string; kind: string; strength: number; why?: string }>; useLoras: boolean; useTurbo: boolean }> }> {
  const library = new Map((await repo.listLoras()).map((l) => [l.id, l]));
  const scenes = await repo.listScenes(projectId);
  const checked: Array<{ shot: Shot; slate: string; loras: ShotLora[] }> = [];
  for (const item of items) {
    const shot = await repo.getShot(item.shotId);
    if (shot.projectId !== projectId) throw new StudioError("validation", `shot ${item.shotId} is not in this project`, { shotId: item.shotId });
    const slate = `${scenes.findIndex((sc) => sc.id === shot.sceneId) + 1}·${shot.index + 1}`;
    if (item.loras.length > MAX_SHOT_LORAS) throw new StudioError("validation", `shot ${slate}: at most ${MAX_SHOT_LORAS} LoRAs (the turbo LoRA makes ${MAX_SHOT_LORAS + 1})`, { shotId: shot.id });
    const seen = new Set<string>();
    for (const r of item.loras) {
      const lora = library.get(r.id);
      if (!lora) throw new StudioError("validation", `shot ${slate}: no LoRA ${r.id} in the library (list_loras)`, { shotId: shot.id });
      if (lora.kind === "speed") throw new StudioError("validation", `shot ${slate}: ${lora.name} is a speed LoRA; the shot's use-turbo switch loads the one for its workflow, it is not assigned`, { shotId: shot.id });
      if (!fitsShot(lora, shot.spec)) throw new StudioError("validation", `shot ${slate}: ${lora.name} is trained for ${(lora.baseModel ?? "minimax-h3") === "minimax-h3" ? lora.workflows.join(", ") : lora.baseModel}, and this ${shot.spec.mode} shot renders ${shotWorkflows(shot.spec).join(" / ")}`, { shotId: shot.id });
      if (seen.has(r.id)) throw new StudioError("validation", `shot ${slate}: ${lora.name} is listed twice`, { shotId: shot.id });
      seen.add(r.id);
    }
    checked.push({ shot, slate, loras: item.loras });
  }
  const out = [];
  for (const { shot, slate, loras } of checked) {
    const saved = await patchShot(shot.id, { loras });
    const on = shotSwitches(saved.spec);
    out.push({
      shotId: shot.id, slate, useLoras: on.loras, useTurbo: on.turbo,
      loras: loras.map((r) => { const l = library.get(r.id)!; return { id: l.id, name: l.name, kind: l.kind, strength: r.strength ?? l.defaultStrength, ...(r.why ? { why: r.why } : {}) }; }),
    });
  }
  return { shots: out };
}

/** What the director reads before assign_loras: per shot, its workflows, the
    switches, what is assigned and which LoRAs could load on it; and what the
    project's style suggests. */
export async function loraPlan(projectId: string) {
  const view = await getProjectView(projectId);
  const library = await repo.listLoras();
  const byId = new Map(library.map((l) => [l.id, l]));
  const style = view.project.look.style ? (await styles.resolveStyle(view.project.look.style))?.style : undefined;
  const candidates = library.filter((l) => l.kind !== "speed" && (l.baseModel ?? "minimax-h3") === "minimax-h3");
  return {
    styleSuggests: (style ? director.styleLoraSuggestions(style) : []).filter((x) => byId.has(x.id)).map((x) => ({ id: x.id, name: byId.get(x.id)!.name, strength: x.strength ?? byId.get(x.id)!.defaultStrength, when: x.when })),
    shots: view.scenes.flatMap((sc, si) => sc.shots.map((sh) => {
      const on = shotSwitches(sh.spec);
      return {
        shotId: sh.id, slate: `${si + 1}·${sh.index + 1}`, scene: sc.slug, intent: sh.spec.intent, mode: sh.spec.mode, workflows: shotWorkflows(sh.spec),
        size: sh.spec.cinematography?.size, vfx: sh.spec.cinematography?.vfx, animation: sh.spec.cinematography?.animation,
        useTurbo: on.turbo, useLoras: on.loras, state: assignmentState(sh.spec),
        assigned: assignedRefs(sh.spec, (id) => byId.get(id)?.kind).map((r) => ({ id: r.id, name: byId.get(r.id)?.name ?? r.id, strength: r.strength ?? byId.get(r.id)?.defaultStrength, why: r.why })),
        canLoad: candidates.filter((l) => fitsShot(l, sh.spec)).map((l) => l.id),
      };
    })),
  };
}

export async function addShot(sceneId: string, spec: ShotInput): Promise<Shot> {
  const scene = await repo.getScene(sceneId);
  const shot = await repo.createShot(scene.projectId, sceneId, spec);
  await repo.setShotlistApproval(scene.projectId, "draft");
  return shot;
}

/* Deletes keep what they remove in the trash first (trash.ts), so the web can
   offer Undo and the project's Settings page (Recently deleted) can put a
   thing back for TRASH_DAYS. */

export async function removeShot(shotId: string, by?: string): Promise<{ trashId: string }> {
  const shot = await repo.getShot(shotId);
  const scenes = await repo.listScenes(shot.projectId);
  const sceneNo = scenes.findIndex((s) => s.id === shot.sceneId) + 1;
  const project = await repo.getProject(shot.projectId);
  const trashId = await trash.put({ projectId: shot.projectId, kind: "shot", label: `shot ${sceneNo}·${shot.index + 1} · ${shot.spec.intent || "untitled"}`, by }, { ...(await trash.snapshot("shot", shotId)), approval: { approval: project.shotlistApproval, approvedAt: project.shotlistApprovedAt } });
  await repo.deleteShot(shotId);
  await repo.setShotlistApproval(shot.projectId, "draft");
  return { trashId };
}

/** Delete a finished take (kept in the trash, so it can be put back). A take still waiting or rendering is not
    deleted (cancel the one that waits; the one that renders runs to its end), nor one the cut uses. If it is the
    shot's pick, the pick is cleared, and put back with it. What it cost stays spent. */
export async function removeTake(takeId: string, by?: string): Promise<{ trashId: string; wasPicked: boolean }> {
  const take = await repo.getTake(takeId);
  if (take.status === "queued" || take.status === "running" || (take.upscale && (take.upscale.status === "queued" || take.upscale.status === "running"))) {
    throw new StudioError("validation", "a take that is waiting or rendering cannot be deleted: cancel it if it waits, or let it finish");
  }
  const timeline = await repo.getTimeline(take.projectId);
  const used = timeline.clips.findIndex((c) => c.takeId === takeId);
  if (used >= 0) throw new StudioError("validation", `this take is in the cut (clip ${used + 1}): take it out of the timeline first`);
  const shot = await repo.getShot(take.shotId);
  const wasPicked = shot.selectedTakeId === takeId;
  const scenes = await repo.listScenes(take.projectId);
  const sceneNo = scenes.findIndex((s) => s.id === shot.sceneId) + 1;
  const trashId = await trash.put(
    { projectId: take.projectId, kind: "take", label: `take ${take.n} · shot ${sceneNo}·${shot.index + 1}${wasPicked ? " (the pick)" : ""}`, by },
    { ...(await trash.snapshot("take", takeId)), ...(wasPicked ? { reattach: [{ kind: "selected_take" as const, shotId: shot.id, takeId }] } : {}) },
  );
  if (wasPicked) await repo.updateShot(shot.id, { selectedTakeId: null });
  await repo.deleteTake(takeId);
  return { trashId, wasPicked };
}

export async function removeScene(sceneId: string, by?: string): Promise<{ trashId: string }> {
  const scene = await repo.getScene(sceneId);
  const shots = (await repo.listSceneShots(sceneId)).length;
  const project = await repo.getProject(scene.projectId);
  const trashId = await trash.put({ projectId: scene.projectId, kind: "scene", label: `scene ${scene.index + 1} · ${scene.slug}${shots ? ` and its ${shots} ${shots === 1 ? "shot" : "shots"}` : ""}`, by }, { ...(await trash.snapshot("scene", sceneId)), approval: { approval: project.shotlistApproval, approvedAt: project.shotlistApprovedAt } });
  await repo.deleteScene(sceneId);
  await repo.setShotlistApproval(scene.projectId, "draft");
  return { trashId };
}

/** The shots that use an element (as a character, a prop, the location, or a speaker), by slate ("2·3"). */
export async function elementUses(elementId: string): Promise<string[]> {
  const el = await repo.getElement(elementId);
  const view = await getProjectView(el.projectId ?? "");
  const out: string[] = [];
  view.scenes.forEach((scene, si) => scene.shots.forEach((sh) => {
    const s = sh.spec;
    if (s.characters.includes(elementId) || s.props.includes(elementId) || s.location === elementId || s.dialogue.some((l) => l.speaker === elementId)) out.push(`${si + 1}·${sh.index + 1}`);
  }));
  return out;
}

export async function removeElement(elementId: string, by?: string): Promise<{ trashId: string }> {
  const el = await repo.getElement(elementId);
  const trashId = await trash.put({ projectId: el.projectId, kind: "element", label: `${el.kind} · ${el.name}`, by }, await trash.snapshot("element", elementId));
  await repo.deleteElement(elementId);
  return { trashId };
}

export async function removeProject(projectId: string, by?: string): Promise<{ trashId: string }> {
  const project = await repo.getProject(projectId);
  const trashId = await trash.put({ projectId, kind: "project", label: project.name, by }, await trash.snapshot("project", projectId));
  await repo.deleteProject(projectId);
  return { trashId };
}

/* ---------- compile ---------- */

async function compileContext(shotId: string, opts?: { steps?: number; seed?: number; experiments?: PromptExperiments; turbo?: boolean }) {
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
  /* what the shot's elements carry in from the shots before it */
  const states = await shotStates(shot.projectId, shot.id);
  /* the shot's two switches (shot-loras.ts): every speed LoRA while use turbo is
     on (the compiler loads the one for the workflow), the assigned LoRAs while
     use LoRA is on */
  const library = await repo.listLoras();
  const byId = new Map(library.map((l) => [l.id, l]));
  /* a take may ask for the other chain than the shot's switch says (TakeRequest.turbo: an A/B on steps) */
  const on = { ...shotSwitches(shot.spec), ...(opts?.turbo !== undefined ? { turbo: opts.turbo } : {}) };
  const loras = [
    ...(on.turbo ? library.filter((l) => l.kind === "speed").map((l) => ({ ...l, strength: l.defaultStrength })) : []),
    ...(on.loras ? assignedRefs(shot.spec, (id) => byId.get(id)?.kind).flatMap((r) => {
      const lora = byId.get(r.id);
      return lora ? [{ ...lora, strength: r.strength ?? lora.defaultStrength }] : [];
    }) : []),
  ];
  return { shot, project, scene, elements, assets, prevLastFrameUrl, anchorFrameUrl, anchorLabel, sourceTake, loras, turbo: on.turbo, steps: opts?.steps, seed: opts?.seed, experiments, states };
}

/** The state every shot of the project starts and ends with, by shot id (story order); or one shot's. */
export async function projectStates(projectId: string): Promise<Map<string, director.ShotStates>> {
  const shots = await repo.listShots(projectId);
  const states = director.carriedStates(shots.map((s) => s.spec));
  return new Map(shots.map((s, i) => [s.id, states[i]!]));
}

async function shotStates(projectId: string, shotId: string): Promise<director.ShotStates | undefined> {
  return (await projectStates(projectId)).get(shotId);
}

export async function compileForShot(shotId: string, opts?: { steps?: number; seed?: number; experiments?: PromptExperiments; turbo?: boolean }): Promise<CompiledJob & { estimate: Estimate }> {
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
  const ctx = await compileContext(shotId, { steps: req.steps, seed: req.seed, experiments: req.experiments, turbo: req.turbo });
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
  /* A retake: what it changes against the take before it, and the faults it follows. */
  const finished = earlier.filter((t) => t.status === "completed").sort((a, b) => b.n - a.n);
  const prev = finished[0];
  const rendering = { workflow: compiled.workflow, prompt: compiled.prompt, input: { ...compiled.input, ...(onExperiments(ctx.experiments) ? { studio_experiments: ctx.experiments } : {}) } as Record<string, unknown> };
  const retake: RetakeRecord | undefined = prev ? { of: prev.n, changed: retakeChanges(prev, rendering), after: [...new Set(finished.flatMap((t) => t.review?.faults ?? []))], ...(req.change ? { change: req.change } : {}) } : undefined;
  const guards = preRenderGuards(review.state, same, earlier, retake);
  compiled.warnings.push(...guards);
  let unreviewed: string | undefined;
  if (actor.via === "mcp" && retake && !req.change) {
    /* The retro can only say which change got past which fault if every retake says what it was for. */
    throw new StudioError("validation", `this shot already has take #${retake.of}: say what this take changes against it and which fault it is after (change). The Studio sees a change of: ${retake.changed.join(", ")}${retake.changed.length === 1 && retake.changed[0] === "seed" ? " only (the same input again)" : ""}.${retake.after.length ? ` The takes before it are tagged ${retake.after.join(", ")}: ${director.fixSummary(retake.after).join("; ")}.` : " No take before it is tagged with a fault: review them first (review_take), or say that this is an alternate."}`, { retake, fixes: director.faultRoutes(retake.after), warnings: guards });
  }
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

  await assertGpuRunning(actor);

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
      input: { ...compiled.input, seed, ...(onExperiments(ctx.experiments) ? { studio_experiments: ctx.experiments } : {}), ...(retake ? { studio_retake: retake } : {}) }, seed,
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
export function preRenderGuards(state: "pass" | "fail" | "stale" | "none", same: { rejected: Take[]; any: Take[] }, earlier: Take[] = [], retake?: { changed: RetakeChange[]; after: string[] }): string[] {
  const out: string[] = [];
  /* A picture fault answered with new words only: the one fix the records never saw work. */
  const picture = retake ? director.pictureFaults(retake.after) : [];
  if (retake && picture.length && retake.changed.every((c) => c === "prompt")) {
    out.push(`the takes before are tagged ${picture.join(", ")} and this render changes only the prompt: on the takes reviewed so far no identity, prop or count fault was fixed by rewording (small sample). ${director.fixSummary(picture).join("; ")}`);
  }
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
    /* Two submitters can meet on one take (the sweep and a page's stream): the one that comes second
       calls its own job off, so a take is rendered, and paid for, once. */
    const now = await repo.getTake(take.id);
    if (now.requestId || now.status !== "queued") {
      await backend.cancel(requestId).catch(() => undefined);
      return now;
    }
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
      /* what the worker measured on the file (take-checks.ts reads it against the shot); kept with the take's input, which needs no new column */
      const checks = out.checks && typeof out.checks === "object" ? { input: { ...take.input, studio_checks: out.checks } } : {};
      const updated = await repo.updateTake(take.id, {
        ...checks,
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

let lastGpuLook = 0;

/** The takes that wait for the GPU, handed over as soon as it is up: the pod is asked where it stands
    (not more than once in 8 s) and each take goes to it. Called from a project's event stream, so a take
    does not wait for the minute-by-minute sweep once the pod answers. */
export async function handOverWaitingTakes(takeIds: string[]): Promise<void> {
  if (takeIds.length === 0) return;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured() && Date.now() - lastGpuLook > 8_000) {
    lastGpuLook = Date.now();
    await gpu.refreshGpu().catch(() => undefined);
  }
  for (const id of takeIds) await refreshTake(id).catch(() => undefined);
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
  if (up.status === "running") throw new StudioError("validation", RENDERING_CANNOT_BE_CANCELLED);
  if (up.requestId) {
    const backend = await videoBackend();
    if (backend) {
      /* the pod's queue may have reached it since the last look: then it is rendering, and is left to finish */
      const now = await backend.status(up.requestId).catch(() => undefined);
      if (now?.state === "running") {
        await applyUpscaleStatus(take, now);
        throw new StudioError("validation", RENDERING_CANNOT_BE_CANCELLED);
      }
      await backend.cancel(up.requestId);
    }
  }
  return repo.updateTake(take.id, { upscale: { ...up, status: "canceled", finishedAt: Date.now(), progress: undefined } });
}

const RENDERING_CANNOT_BE_CANCELLED = "a take that is rendering cannot be cancelled; only a queued one can be";

/** Call off a take that is still waiting. One that is rendering is not: it runs to its end (its cost is
    spent either way), so the answer is an error, and its status is brought up to date so the page shows it. */
export async function cancelTake(takeId: string): Promise<Take> {
  const take = await repo.getTake(takeId);
  if (take.status === "running") throw new StudioError("validation", RENDERING_CANNOT_BE_CANCELLED);
  if (take.status === "queued" && !take.requestId) return repo.updateTake(takeId, { status: "canceled", finishedAt: Date.now() });
  if (take.requestId && take.status === "queued") {
    const backend = await videoBackend();
    if (backend) {
      /* the pod's queue may have reached it since the last look */
      const now = await backend.status(take.requestId).catch(() => undefined);
      if (now?.state === "running") {
        await applyTakeStatus(take, now);
        throw new StudioError("validation", RENDERING_CANNOT_BE_CANCELLED);
      }
      await backend.cancel(take.requestId);
    }
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
 * The Cut page's default (and its Reset) is plainer: `selectedOnly` joins
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
  const total = view.timeline.clips.reduce((n, c) => n + clipSeconds(c), 0);
  const estimateUsd = estimateExport(total, req.preset === "master-upscaled");
  assertBudget(view.project, estimateUsd);
  if (actor.via === "mcp") assertConfirmed(req.confirm, estimateUsd, `exporting ${req.preset}`);
  const music = view.timeline.music ? view.assets.find((a) => a.id === view.timeline.music) : undefined;
  const audioUrls = new Map<string, string>();
  const audioTexts = new Map<string, string>();
  for (const line of view.timeline.narration ?? []) {
    const asset = view.assets.find((a) => a.id === line.assetId);
    if (!asset || asset.kind !== "audio") throw new StudioError("validation", `narration at ${line.atS} s points at ${line.assetId}, which is not an audio asset of this project`, { assetId: line.assetId });
    audioUrls.set(asset.id, asset.url);
    if (typeof asset.meta.text === "string" && asset.meta.text.trim()) audioTexts.set(asset.id, asset.meta.text);
  }
  const exportRow = await repo.createExport(projectId, req.preset, {});
  const input = buildAssemblerInput({
    exportId: exportRow.id, projectId, preset: req.preset, look: view.project.look, timeline: view.timeline, shots, takes,
    elementNames: new Map(view.elements.map((e) => [e.id, e.name])), musicUrl: music?.url, audioUrls, audioTexts, burnIn: req.burnInSubtitles,
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
  /* The sound that was planned and never reached the timeline. */
  warnings.push(...treatments.soundPlanFindings(view.scenes, view.timeline, await treatments.currentTreatment(projectId)));
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
      /* What the assembler measured on the file, read against what the timeline asked for. */
      const cutsS = Array.isArray(status.output.cuts_s) ? (status.output.cuts_s as number[]) : undefined;
      const checks = status.output.checks && typeof status.output.checks === "object" ? (status.output.checks as ExportChecks) : undefined;
      const workerWarnings = Array.isArray(status.output.warnings) ? (status.output.warnings as unknown[]).map(String) : [];
      const subtitles = Array.isArray(status.output.subtitles) ? (status.output.subtitles as Array<{ start_s: number; end_s: number; text: string }>) : undefined;
      const findings = exportFindings(job.input as unknown as AssemblerInput, { duration_s: num(status.output.duration_s), cuts_s: cutsS, checks, warnings: workerWarnings, subtitles });
      await repo.createAsset({ projectId: job.projectId, url, kind: "video", source: "export", durationS: num(status.output.duration_s), meta: { exportId: job.id, preset: job.preset, cutsS, ...(checks ? { checks } : {}), findings } });
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

/** An export with what was measured on its file: loudness, and the black
    picture and missing sound that nothing on the timeline explains. */
export async function exportReport(exportId: string): Promise<{ export: ExportJob; checks?: ExportChecks; findings?: string[] }> {
  const job = await refreshExport(exportId);
  if (job.status !== "completed") return { export: job };
  const asset = (await repo.listAssets(job.projectId)).find((a) => a.source === "export" && a.kind === "video" && a.meta.exportId === job.id);
  if (!asset) return { export: job };
  return { export: job, ...(asset.meta.checks ? { checks: asset.meta.checks as ExportChecks } : {}), findings: Array.isArray(asset.meta.findings) ? (asset.meta.findings as string[]) : [] };
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

/** The pod stops once it has been asked to ("stop when done") and nothing is left for it, in any project:
    takes (also 2K regenerations), exports, voice jobs, and a picture the pod itself is drawing. Called by the
    sweep and by a project's event stream. Nothing is stopped that is rendering. */
export async function stopGpuIfDone(): Promise<boolean> {
  if (config.runpodMode() !== "pod" || !gpu.gpuConfigured()) return false;
  const pod = await repo.currentGpuPod();
  if (!pod?.stopWhenDone || pod.status !== "running") return false;
  const { podIsPainting } = await import("./painter");
  const busy = (await repo.listActiveTakes()).length > 0 || (await repo.listActiveUpscales()).length > 0 || (await repo.listActiveExports()).length > 0 || (await repo.listActiveVoiceJobs()).length > 0 || (await podIsPainting());
  if (busy) return false;
  await gpu.stopGpu();
  await repo.updateGpuPod(pod.id, { message: "stopped: everything that was queued has rendered" });
  return true;
}

export async function sweep(): Promise<{ takes: number; exports: number; images: number; gpu?: string; autoStopped?: boolean }> {
  let gpuStatus: string | undefined;
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    try {
      gpuStatus = (await gpu.refreshGpu())?.status;
    } catch (caught) {
      gpuStatus = `refresh failed: ${caught instanceof Error ? caught.message : caught}`;
    }
  }
  /* what was deleted more than TRASH_DAYS ago goes for good, with its picture files */
  await trash.purgeExpired().catch(() => undefined);
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
  /* voice jobs on the pod (the webhook normally answers first) */
  try {
    const { sweepVoiceJobs } = await import("./voice-pod");
    await sweepVoiceJobs();
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
    const stillBusy = (await repo.listActiveTakes()).length > 0 || (await repo.listActiveExports()).length > 0 || (await repo.listActiveVoiceJobs()).length > 0 || (await podIsPainting());
    try {
      autoStopped = (await stopGpuIfDone()) || (await gpu.autoStopIfIdle(stillBusy));
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
  const shotlist = { scenes: view.scenes.map((s) => ({ slug: s.slug, summary: s.summary ?? "", location: s.locationElementId ?? undefined, ...(s.palette ? { palette: s.palette } : {}), ...(s.sound ? { sound: s.sound } : {}), shots: s.shots.map((sh) => sh.spec) })) } as ShotlistInput;
  return { view, shotlist };
}

export type LintWarning = { code: string; message: string; scene?: string; shot?: number; severity: "error" | "warn" | "info" };

/** Rhythm and craft lint over the saved shotlist, plus the Tier 2 / Tier 3
    completeness the MCP save path reports. */
/* The script against the board: a line written and shot by nobody, a quote
   the current script no longer has (coverage.ts). Asked for only once some
   shot names its lines; until then one note says how. */
function coverageLint(view: ProjectView): LintWarning[] {
  if (!view.script) return [];
  const shots = view.scenes.flatMap((sc, si) => sc.shots.map((sh, i) => ({ id: sh.id, slate: `${si + 1}·${i + 1}`, scriptLines: sh.spec.scriptLines, scene: sc.slug, shot: i + 1 })));
  if (!shots.length) return [];
  const c = coverage(view.script.text, shots);
  if (!c.inUse) return [{ code: "script.lines.missing", severity: "info", message: "no shot says which script lines it shows (scriptLines, quoted from the script): without them nothing checks that every line of the script is shot" }];
  const out: LintWarning[] = [];
  for (const s of c.stale) {
    const at = shots.find((x) => x.id === s.shotId)!;
    out.push({ code: "script.quote.stale", severity: "warn", scene: at.scene, shot: at.shot, message: `quotes "${s.quote.slice(0, 80)}", which script v${view.script.version} no longer has: quote it as it reads now, or drop it` });
  }
  const open = c.lines.filter((l) => l.open);
  if (open.length) out.push({ code: "script.uncovered", severity: "warn", message: `${open.length} ${open.length === 1 ? "line" : "lines"} of the script ${open.length === 1 ? "is" : "are"} on no shot, in whole or in part: ${open.slice(0, 3).map((l) => `"${openText(l).slice(0, 60)}"`).join(", ")}${open.length > 3 ? " …" : ""}. Add a shot, quote the line on the shot that shows it, or cut it from the script` });
  return out;
}

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
  /* The plan the film is held to: the treatment, the sound design table, and the timeline against both. */
  const treatment = await treatments.currentTreatment(projectId);
  warnings.push(...treatments.treatmentLint(treatment, view.script?.version));
  warnings.push(...coverageLint(view));
  const unplanned = view.scenes.filter((s) => !s.sound);
  if (unplanned.length) warnings.push({ code: "sound.table", severity: "info", message: `${unplanned.length} scene(s) have no row in the sound design table (${unplanned.slice(0, 4).map((s) => s.slug).join(", ")}): set the ambience, the foley and the state of the music with set_scene_sound or save_shotlist` });
  for (const finding of treatments.soundPlanFindings(view.scenes, view.timeline, treatment)) warnings.push({ code: "sound.plan", severity: "warn", message: finding });
  warnings.push(...(await loraHints(view)));
  warnings.push(...(await checkSeams(projectId)));
  const open = (await repo.listNotes(projectId, "requirement")).filter((n) => n.status === "open");
  if (open.length) warnings.push({ code: "requirements.open", severity: "info", message: `${open.length} requirement(s) from the user still open: ${open.slice(0, 5).map((n) => String(n.body.text)).join("; ")}${open.length > 5 ? " …" : ""}` });
  const counts = { error: 0, warn: 0, info: 0 };
  for (const x of warnings) counts[x.severity]++;
  return { warnings, counts };
}

/**
 * LoRAs are the director's to assign, per shot, once the board is designed
 * (assign_loras). The lint asks for that pass while shots have no decision
 * and the library has a style / effect LoRA that could load on them (naming
 * what the project's style suggests), and flags an assigned LoRA the shot can
 * no longer load (its mode changed since).
 */
export async function loraHints(view: ProjectView): Promise<LintWarning[]> {
  const shots = view.scenes.flatMap((sc) => sc.shots.map((sh) => ({ sc, sh })));
  if (shots.length === 0) return [];
  const library = await repo.listLoras();
  const byId = new Map(library.map((l) => [l.id, l]));
  const out: LintWarning[] = [];
  for (const { sc, sh } of shots) {
    for (const r of assignedRefs(sh.spec, (id) => byId.get(id)?.kind)) {
      const lora = byId.get(r.id);
      if (!lora) out.push({ code: "lora.missing", severity: "warn", scene: sc.slug, shot: sh.index + 1, message: `the LoRA ${r.id} assigned to this shot is not in the library any more; assign_loras again` });
      else if (!fitsShot(lora, sh.spec)) out.push({ code: "lora.workflow", severity: "warn", scene: sc.slug, shot: sh.index + 1, message: `the LoRA ${lora.name} assigned to this shot is not trained for its workflow (${lora.workflows.join(", ") || lora.baseModel}, the shot renders ${shotWorkflowsLabel(sh.spec)}): it will not load. assign_loras again for this shot` });
    }
  }
  const candidates = library.filter((l) => l.kind !== "speed");
  const open = shots.filter(({ sh }) => assignmentState(sh.spec) === "unassigned" && candidates.some((l) => fitsShot(l, sh.spec)));
  if (open.length) {
    const style = view.project.look.style ? (await styles.resolveStyle(view.project.look.style))?.style : undefined;
    const suggests = (style ? director.styleLoraSuggestions(style) : []).filter((x) => byId.has(x.id)).map((x) => `The ${style!.en} style suggests ${byId.get(x.id)!.name} (${x.id}) at ${x.strength ?? byId.get(x.id)!.defaultStrength}, for ${x.when}`);
    const where = open.slice(0, 8).map(({ sc, sh }) => `${sc.slug} ${sh.index + 1}`).join(", ") + (open.length > 8 ? " …" : "");
    out.push({
      code: "lora.unassigned", severity: "info",
      message: `${open.length} of the film's ${shots.length} shot(s) have no LoRA decision yet (${where}). Once the board is designed, assign_loras: give each shot the LoRAs from list_loras whose notes suit its style, size, effect or motion, each with why; an empty list records that none suits. They load while the shot's use-LoRA switch is on.${suggests.length ? ` ${suggests.join(" ")}` : ""}`,
    });
  }
  return out;
}

function shotWorkflowsLabel(spec: { mode: string; link?: { type: string } }): string {
  return shotWorkflows(spec).join(" / ");
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
  const found = await styles.mustResolveStyle(style);
  const { shotlist } = await shotlistOf(projectId);
  if (shotlist.scenes.length === 0) throw new StudioError("validation", "the project has no shotlist yet");
  const result = director.applyStyle(found.style, shotlist as never, { beatSuffix: opts?.beatSuffix ?? true, musicForShotsWithScore: opts?.musicForShotsWithScore ?? true });
  const saved = await saveShotlist(projectId, ShotlistInputSchema.parse(result.shotlist));
  const project = await repo.getProject(projectId);
  await repo.setProjectLook(projectId, { ...project.look, style: found.style.slug });
  return { warnings: result.warnings as LintWarning[], view: saved };
}

/* ---- one confirmation for a batch of takes ---- */

export type TakeBatchRow = { shotId: string; label: string; estimateUsd: number; review: string };
export type TakeBatchResult = {
  queued: Array<{ shotId: string; label: string; takeIds: string[]; estimateUsd: number; warnings: string[] }>;
  refused: Array<{ shotId: string; label: string; code: string; why: string }>;
  /** Shots that cannot render yet, and what each waits for. */
  waiting: Array<{ shotId: string; label: string; why: string }>;
  estimateUsd: number;
  next: string;
};

/** What one shot would cost and whether its review lets it render: the head of createTakes, without spending. */
async function takeReadiness(shotId: string, n: number, steps?: number): Promise<{ estimateUsd: number; review: string }> {
  const ctx = await compileContext(shotId, { steps });
  const compiled = compileShot({ ...ctx, look: ctx.project.look });
  const estimate = estimateTake(ctx.shot.spec.durationS, compiled.input.steps, n, await gpu.measuredForEstimate());
  const subject = renderHash(compiled.workflow, compiled.prompt, compiled.input.images, audioInputs(compiled.input));
  return { estimateUsd: estimate.usd, review: (await reviewState(ctx.project.id, "shot", subject, shotId)).state };
}

/**
 * Render a batch on one confirmation. Without `confirm` nothing is spent: the
 * answer is the list with one total, which the director puts to the user
 * once. With it, every shot that can render now is queued in the plan's
 * order (R2VA first); a shot waiting for its anchor's take, or with no
 * passing shot review, is named and left for the next call. The review gate
 * is the one generate_take has: a confirmation accepts the price, not an
 * unread shot.
 */
/** A render waits for the GPU to be running: a person starts it on purpose (the pod bills per hour), never as a
    side effect of a click or of the director's call. Serverless has no pod to wait for. */
export async function assertGpuRunning(actor: Actor): Promise<void> {
  if (config.runpodMode() !== "pod" || !gpu.gpuConfigured()) return;
  await gpu.refreshGpu().catch(() => undefined);
  if ((await repo.currentGpuPod())?.status !== "running") {
    throw new StudioError(actor.via === "mcp" ? "forbidden" : "validation", actor.via === "mcp" ? gpu.DIRECTOR_CANNOT_START_GPU : "The GPU is not running. Start it first (GPU, in the top bar), then render again.", { gpuNotRunning: true });
  }
}

export async function createTakeBatch(projectId: string, req: { shotIds?: string[]; sceneId?: string; n: number; steps?: number; confirm: boolean; skipReview?: string; change?: string }, actor: Actor): Promise<TakeBatchResult> {
  /* The two checkpoints first: without them no take renders, whatever its review says. */
  assertCanGenerate(await repo.getProject(projectId), await repo.latestScript(projectId));
  /* and the GPU: there is no point asking the user to confirm a spend that cannot start */
  await assertGpuRunning(actor);
  const plan = await planProjectBatch(projectId, { takesPerShot: req.n, onlyMissing: !req.shotIds?.length, ...(req.sceneId ? { sceneId: req.sceneId } : {}) });
  const label = new Map(plan.shots.map((x) => [x.shotId, x.label]));
  const now = new Set(plan.passes[0] ?? []);
  /* Every shot the plan holds, or the ones asked for; those that cannot render now are reported as waiting. */
  const asked = req.shotIds?.length ? plan.order.filter((id) => req.shotIds!.includes(id)) : [...plan.order, ...plan.deferred.map((d) => d.shotId)];
  const unknown = (req.shotIds ?? []).filter((id) => !label.has(id));
  if (unknown.length) throw new StudioError("validation", `not shots of this ${req.sceneId ? "scene" : "project"}: ${unknown.join(", ")}`);
  if (asked.length === 0) throw new StudioError("validation", "nothing to render: every shot has a take, or the ones without wait for an anchor's take (plan_project_batch shows which)");

  const ready: TakeBatchRow[] = [];
  const refused: TakeBatchResult["refused"] = [];
  const waiting: TakeBatchResult["waiting"] = [];
  for (const shotId of asked) {
    const name = label.get(shotId) ?? shotId;
    if (!now.has(shotId)) {
      const d = plan.deferred.find((x) => x.shotId === shotId);
      waiting.push({ shotId, label: name, why: `starts from another shot's last frame${d ? ` (${label.get(d.waitingFor) ?? d.waitingFor})` : ""}: render and select that take first` });
      continue;
    }
    try {
      const r = await takeReadiness(shotId, req.n, req.steps);
      if (r.review !== "pass" && !req.skipReview) {
        refused.push({ shotId, label: name, code: "not_reviewed", why: r.review === "none" ? "no shot review" : r.review === "stale" ? "only a review of an earlier prompt or frame" : "a failed shot review" });
      } else {
        ready.push({ shotId, label: name, estimateUsd: r.estimateUsd, review: r.review });
      }
    } catch (caught) {
      refused.push({ shotId, label: name, code: caught instanceof StudioError ? caught.code : "error", why: caught instanceof Error ? caught.message : String(caught) });
    }
  }
  const total = Math.round(ready.reduce((a, x) => a + x.estimateUsd, 0) * 1000) / 1000;
  const view = await getProjectView(projectId);
  if (ready.length === 0) {
    return { queued: [], refused, waiting, estimateUsd: 0, next: "No shot can render yet. A shot needs a passing shot review of its exact prompt and frames (review_packet stage shot → fresh reviewer → record_review); a linked shot needs its anchor's take." };
  }
  /* The whole batch against the cap before any of it is spent, so it never stops half way for money. */
  assertBudget(view.project, total + reservedUsd(await repo.listProjectActiveTakes(projectId)));
  if (!req.confirm) {
    throw new StudioError("needs_confirm", `${ready.length} shot(s), ${req.n} take(s) each, cost about ${total.toFixed(2)} USD in all. Tell the user that one figure; call again with confirm: true to render them all.`, {
      estimateUsd: total, remainingUsd: Math.round((view.project.budgetCapUsd - view.project.spentUsd) * 1000) / 1000, shots: ready, refused, waiting,
    });
  }
  const queued: TakeBatchResult["queued"] = [];
  for (const row of ready) {
    try {
      const r = await createTakes(row.shotId, { n: req.n, steps: req.steps, confirm: true, ...(req.change ? { change: req.change } : {}), ...(row.review !== "pass" && req.skipReview ? { skipReview: req.skipReview } : {}) }, actor);
      queued.push({ shotId: row.shotId, label: row.label, takeIds: r.takes.map((t) => t.id), estimateUsd: r.estimate.usd, warnings: r.warnings });
    } catch (caught) {
      refused.push({ shotId: row.shotId, label: row.label, code: caught instanceof StudioError ? caught.code : "error", why: caught instanceof Error ? caught.message : String(caught) });
      /* Out of money or no GPU: the rest would fail the same way. */
      if (caught instanceof StudioError && (caught.code === "budget_exceeded" || caught.code === "backend_error")) break;
    }
  }
  const left = ready.length - queued.length - refused.filter((x) => ready.some((y) => y.shotId === x.shotId)).length;
  return {
    queued, refused, waiting, estimateUsd: Math.round(queued.reduce((a, x) => a + x.estimateUsd, 0) * 1000) / 1000,
    next: `${queued.length} shot(s) queued${left > 0 ? `, ${left} not started` : ""}. ${waiting.length ? `${waiting.length} wait for an anchor's take: once the user has picked those takes, call this again. ` : ""}${refused.length ? `${refused.length} were refused; each says why. ` : ""}The user reviews and picks takes on the Board.`,
  };
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
/* `sceneId`: the plan for that scene's shots alone. The other scenes are still read: a shot linked to
   an anchor in another scene renders once that anchor has a take, and is listed as waiting until then. */
export async function planProjectBatch(projectId: string, opts?: { takesPerShot?: number; onlyMissing?: boolean; sceneId?: string }): Promise<ProjectBatch> {
  const view = await getProjectView(projectId);
  const scene = opts?.sceneId ? view.scenes.find((s) => s.id === opts.sceneId) : undefined;
  if (opts?.sceneId && !scene) throw new StudioError("not_found", "no such scene in this project");
  const mine = scene ? new Set(scene.shots.map((s) => s.id)) : undefined;
  const measured = await gpu.measuredForEstimate();
  const elements = view.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, fixedFeatures: e.fixedFeatures }));
  const flat = view.scenes.flatMap((s) => s.shots.map((sh) => ({ scene: s, shot: sh })));
  const shots = [];
  for (let index = 0; index < flat.length; index++) {
    const { scene, shot } = flat[index]!;
    const hasTake = Boolean(shot.selectedTake ?? shot.takes.find((t) => t.status === "completed"));
    let estimateUsd: number | undefined;
    /* only the shots being planned are compiled for their price */
    if (!mine || mine.has(shot.id)) {
      try {
        estimateUsd = (await compileForShot(shot.id)).estimate.usd;
      } catch {
        estimateUsd = undefined;
      }
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
  const plan = director.planBatch(shots as never, { capUsd: view.project.budgetCapUsd, spentUsd: view.project.spentUsd }, { perSecondUsd, takesPerShot: opts?.takesPerShot ?? 1, onlyMissing: opts?.onlyMissing ?? true, ...(mine ? { only: [...mine] } : {}) });
  /* The probe: the one or two most fragile shots still to render that do
     not wait on an anchor. If they come out, the rest of the plan holds. */
  const pending = shots.filter((x) => (!mine || mine.has(x.shotId)) && !x.hasTake && (!x.link || ["cut", "montage", "match_cut", "loop"].includes(x.link.type)) && x.fragility > 0);
  const probe = [...pending].sort((a, b) => b.fragility - a.fragility).slice(0, 2);
  return {
    ...plan,
    shots: shots.filter((x) => !mine || mine.has(x.shotId)).map(({ index: _i, link, ...x }) => ({ ...x, link: link?.type })),
    probe: {
      shotIds: probe.map((x) => x.shotId),
      estimateUsd: Math.round(probe.reduce((a, x) => a + (x.estimateUsd ?? 0), 0) * 100) / 100,
      why: probe.length ? `render ${probe.map((x) => x.label.split(" · ")[0]).join(" and ")} first (${probe.map((x) => x.fragile.join(", ")).join(" / ")}); if they hold, confirm the rest` : "no fragile shot to probe",
    },
  };
}
