
import type { BackendStatus } from "./backends/types";
import { carriedStates, hasState, stateText, type ShotStates } from "@director/state";

import { renderCinematography } from "./cinematography";
import { effectiveLink, faceRef, pickRefForViews, placedFeature, preferredViews, VIDEO_SIZES } from "./compiler";
import { config } from "./config";
import { StudioError } from "./errors";
import * as gpu from "./gpu";
import { getProjectView, type ProjectView, type ShotView } from "./orchestrator";
import * as painter from "./painter";
import * as repo from "./repo";
import * as styles from "./styles";
import { FIGURE_VIEWS, MAX_DETAILS, type FixedFeature, type RefView } from "./schemas";
import { ON_BACK, STAGE_NEXT, detailRefs, detailTargets, missingDetails, sheetStage, type SheetStage, type SheetStep } from "./sheet";
import { AGENT_IMAGE_MODELS, defaultImageParams, describeParams, editSizeFor, findModel, imageModelOfBackend, namePicturesFor, projectImageModel, resolveParams, type InferenceParams, type ModelEntry } from "./models";
import { firstRealIn, inputsOf, realnessOfDrawing } from "./provenance";
import { adultAllowed } from "./references";
import type { Actor, Asset, Element, Imaging, Job, Lora, Project } from "./types";

/*
 * Pictures in the Studio: character sheets, first and last frames, region
 * edits, style frames and the painted keyframes Viggle Remake reads. One
 * image job type, queued here and drawn by a painter (painter.ts,
 * workers/painter) with the image model the user chose for the project
 * (the project's Settings page, models.ts AGENT_IMAGE_MODELS): GPT Image (Codex's
 * image_gen on the ChatGPT plan, or the images API) or Qwen-Image 3.0 Pro
 * away from the GPU, or an image model on the GPU pod (MiniMax-H3-Image),
 * which draws while the pod runs.
 *
 * Painting is off per project until switched on on the project's Settings page (web only) and
 * counts against a quota; crop and frame extraction are not painting and are
 * not gated. Every result is an ordinary asset with what was asked in its
 * meta, attached where it was meant to go, and reviewable as a "frame".
 */

/* ---------- the switch ---------- */

export const DEFAULT_IMAGING: Omit<Imaging, "grantedBy" | "grantedAt"> = { enabled: false, model: "gpt-image-codex", backend: "codex", maxImages: 100, usedImages: 0, quality: "low", selfCheck: true, autoRedraws: 1 };

export async function setImaging(projectId: string, input: { enabled: boolean; model?: string; backend?: "codex" | "api"; loras?: Array<{ id: string; strength?: number }>; agentCanvas?: boolean; maxImages?: number; quality?: Imaging["quality"]; selfCheck?: boolean; autoRedraws?: number; clearStop?: boolean }, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "image generation is switched on on the project's Settings page, on the web only");
  const project = await repo.getProject(projectId);
  const cur = project.imaging ?? { ...DEFAULT_IMAGING, grantedBy: actor.user, grantedAt: Date.now() };
  /* the model: the one asked for, else the GPT Image backend asked for (older clients), else the current one */
  const model = input.model ? AGENT_IMAGE_MODELS.find((m) => m.id === input.model) : input.backend ? imageModelOfBackend(input.backend) : projectImageModel(cur);
  if (!model) throw new StudioError("validation", `${input.model} is not an image model the director can draw with (${AGENT_IMAGE_MODELS.map((m) => m.id).join(", ")})`);
  /* LoRAs: the ones asked for, else the current ones that still fit the model (a new model drops the others) */
  const wanted = input.loras ?? cur.loras ?? [];
  const library = wanted.length ? await repo.getLoras(wanted.map((l) => l.id)) : new Map<string, Lora>();
  const loras: Array<{ id: string; strength?: number }> = [];
  for (const ref of wanted) {
    const l = library.get(ref.id);
    const fits = !!l && model.runtime === "pod" && l.baseModel === model.family;
    if (!input.loras) {
      if (fits) loras.push(ref);
      continue;
    }
    if (!l) throw new StudioError("not_found", `no LoRA ${ref.id} in the library`);
    if (model.runtime !== "pod") throw new StudioError("validation", `${model.label} takes no LoRAs; pick a model on the GPU pod`);
    if (!fits) throw new StudioError("validation", `${l.name} is trained for ${l.baseModel}, not ${model.label} (${model.family})`);
    /* an 18+ LoRA: only for a user who unlocked 18+ (Canvas → 18+, web only) */
    if (l.adult && !(await adultAllowed(actor))) throw new StudioError("forbidden", `${l.name} is 18+: show 18+ on the Canvas page first (web only)`, { adult: false });
    loras.push({ id: ref.id, ...(ref.strength !== undefined ? { strength: ref.strength } : {}) });
  }
  if (loras.length > 4) throw new StudioError("validation", "at most four LoRAs");
  const next: Imaging = {
    ...cur,
    enabled: input.enabled,
    model: model.id,
    loras,
    agentCanvas: input.agentCanvas ?? cur.agentCanvas ?? false,
    backend: model.backend!,
    maxImages: input.maxImages ?? cur.maxImages,
    quality: input.quality ?? cur.quality,
    selfCheck: input.selfCheck ?? cur.selfCheck ?? true,
    autoRedraws: Math.max(0, Math.min(2, input.autoRedraws ?? cur.autoRedraws ?? 1)),
    grantedBy: actor.user,
    grantedAt: input.enabled && !cur.enabled ? Date.now() : cur.grantedAt,
    ...(input.clearStop || (input.enabled && !cur.enabled) ? { stoppedReason: undefined } : {}),
  };
  const updated = await repo.setImaging(projectId, next);
  if (cur.enabled !== next.enabled || projectImageModel(cur).id !== model.id) {
    await repo.insertNote(projectId, "decision", "standing", { decision: next.enabled ? `Image generation on: ${model.label}, up to ${next.maxImages} images` : "Image generation off", why: "", by: actor.user, confidence: "user" });
  }
  if (!!cur.agentCanvas !== !!next.agentCanvas) {
    await repo.insertNote(projectId, "decision", "standing", { decision: next.agentCanvas ? `Agent use Canvas on: the director may compose characters from the Canvas library with ${model.label}` : "Agent use Canvas off", why: "", by: actor.user, confidence: "user" });
  }
  return updated;
}

/** What the model needs before it can draw, said where the user picks it. */
function modelNote(model: ModelEntry): string | undefined {
  if (model.backend === "codex") return "Codex must be logged in on a painter (Machine page → Painters)";
  if (model.backend === "api") return "the painter needs OPENAI_API_KEY (paid per picture)";
  if (model.backend === "qwen") return "the CPU painter pod needs TOKENSAIL_API_KEY (or DASHSCOPE_API_KEY) as a Worker secret; paid per picture";
  if (model.runtime === "pod") return "draws on the GPU pod, only while it runs (it bills per hour); no Codex self-check — the review would send the picture to OpenAI";
  return undefined;
}

export function imagingSummary(project: Project) {
  const i = project.imaging;
  const model = projectImageModel(i);
  /* whether a painter can serve the backend right now is in runnerSummary (image_status, the button answers) */
  const backendReady = !!i;
  return {
    enabled: !!i?.enabled, model: model.id, modelLabel: model.label, runtime: model.runtime, backend: model.backend ?? "codex",
    maxRefs: model.maxRefs, moderation: model.moderation, ...(model.commercial === false ? { license: model.license } : {}),
    maxImages: i?.maxImages ?? DEFAULT_IMAGING.maxImages, usedImages: i?.usedImages ?? 0,
    leftImages: Math.max(0, (i?.maxImages ?? DEFAULT_IMAGING.maxImages) - (i?.usedImages ?? 0)), quality: i?.quality ?? "low",
    selfCheck: i?.selfCheck ?? true, autoRedraws: i?.autoRedraws ?? 1,
    agentCanvas: !!i?.agentCanvas,
    stoppedReason: i?.stoppedReason, backendReady,
    note: modelNote(model),
  };
}

/** The project's LoRAs that load with its model (trained for its family, on the GPU pod), at their strength. */
async function projectLoras(imaging: Imaging | undefined, model: ModelEntry): Promise<Array<Lora & { strength: number }>> {
  const refs = model.runtime === "pod" ? imaging?.loras ?? [] : [];
  if (!refs.length) return [];
  const library = await repo.getLoras(refs.map((r) => r.id));
  return refs.flatMap((r) => {
    const l = library.get(r.id);
    return l && l.baseModel === model.family ? [{ ...l, strength: r.strength ?? l.recommended.strength ?? l.defaultStrength }] : [];
  });
}

/** imagingSummary with the LoRAs named and the settings the pictures are drawn at (and where they come from). */
export async function imagingStatus(project: Project) {
  const summary = imagingSummary(project);
  const model = projectImageModel(project.imaging);
  const loras = await projectLoras(project.imaging, model);
  const resolved = model.runtime === "pod" ? resolveParams(model, { loras }) : undefined;
  return {
    ...summary,
    loras: loras.map((l) => ({ id: l.id, name: l.name, strength: l.strength, adult: l.adult })),
    ...(resolved ? { settings: describeParams(resolved.params), settingsFrom: resolved.sources.slice(1), warnings: resolved.warnings } : {}),
  };
}

/** How many pictures a call may send with the project's model (a picture being edited counts). */
export function refCap(project: Project, hasBase: boolean): number {
  return Math.max(0, (projectImageModel(project.imaging).maxRefs ?? 5) - (hasBase ? 1 : 0));
}

/** Throws unless the project may paint; answers how many pictures are left after the running ones. */
async function assertCanPaint(project: Project): Promise<number> {
  const i = project.imaging;
  if (!i?.enabled) throw new StudioError("forbidden", "image generation is off for this project: the user switches it on on the project's Settings page → Allow image generation by agent (web only)", { imaging: false });
  if (i.stoppedReason) throw new StudioError("forbidden", `image generation stopped: ${i.stoppedReason}. The user clears it on the project's Settings page once the quota is back.`, { imaging: "stopped" });
  const active = (await repo.listProjectJobs(project.id, 200)).filter((j) => j.kind === "image" && (j.status === "queued" || j.status === "running") && j.input.op === "paint").length;
  if (i.usedImages + active >= i.maxImages) throw new StudioError("budget_exceeded", `the image quota of this project is used (${i.usedImages} done + ${active} running of ${i.maxImages}); the user raises it on the project's Settings page`, { imaging: "quota" });
  return i.maxImages - i.usedImages - active;
}

/* ---------- jobs ---------- */

export type ImageOp = "paint" | "crop" | "extract";
export type RefRole = "face" | "outfit" | "pose" | "scene" | "style";
export type ImagePurpose = "element_sheet" | "shot_first" | "shot_last" | "edit" | "remake_key" | "style_frame" | "canvas" | "crop" | "extract";
export type Attach = { heroOf?: string; endOf?: string; elementRef?: { elementId: string; view?: RefView; feature?: string }; styleFrame?: boolean };
type Box = { x: number; y: number; w: number; h: number };

export type ImageRequest = {
  op: ImageOp;
  purpose: ImagePurpose;
  /** What the painter's checks hold the picture to, when it is not what the purpose implies (a sheet's detail is not a whole figure on an empty backdrop). */
  checkKind?: string;
  prompt?: string;
  refUrls?: string[];
  /** What each of refUrls is to the picture (provenance.ts): a face it keeps, or an outfit, pose, place or look it
      only borrows. Unset (older jobs, free references) counts as a face. */
  refRoles?: RefRole[];
  baseUrl?: string;
  baseAssetId?: string;
  region?: Box;
  crop?: Box;
  videoUrl?: string;
  frame?: number;
  takeId?: string;
  size: string;
  quality?: Imaging["quality"];
  attach?: Attach;
  targetId: string;
  label?: string;
  /** Canvas pictures: the recipe they were composed from (references, style), kept on the asset. */
  canvas?: Record<string, unknown>;
  /** A model other than the project's GPT Image backend (models.ts): its painter backend and settings. */
  model?: string;
  backend?: string;
  params?: PodParams;
  /** Indexes into refUrls the painter flips left to right before drawing (a pose turned the other way). */
  mirrorRefs?: number[];
};

/** What a pod model's job carries: the resolved settings, a seed, and its LoRAs (fetched by the pod when missing). */
export type PodParams = InferenceParams & {
  seed?: number;
  loras?: Array<{ file: string; strength: number; name?: string; hf_url?: string }>;
  /** API models (Qwen-Image 3.0 Pro): the vendor's model name and the pose gallery's 百炼 options. */
  api_model?: string;
  prompt_extend?: boolean;
  negative_prompt?: string;
};

/** Queue an image job for the painters. Painting is gated by the project
    switch and quota; crop and extract are not. A picture is drawn with the
    project's image model (the project's Settings page) unless the caller names one
    (Canvas): its painter backend, its recommended settings, at most its
    number of pictures, and its way of naming them. A model on the GPU pod
    draws while the pod runs (startPod starts it); otherwise, with no painter
    online and startPod, the GPU pod is started as the fallback painter. */
export async function submitImage(projectId: string, req: ImageRequest, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary }> {
  /* the director never starts the GPU: its startPod is ignored, and the picture waits for the user to start it */
  const startPod = Boolean(opts.startPod) && actor.via !== "mcp";
  const project = await repo.getProject(projectId);
  const left = req.op === "paint" ? await assertCanPaint(project) : 0;
  if (req.op === "paint" && !req.model) {
    const model = projectImageModel(project.imaging);
    const cap = Math.max(0, (model.maxRefs ?? 5) - (req.baseUrl ? 1 : 0));
    const refUrls = req.refUrls && req.refUrls.length > cap ? req.refUrls.slice(0, cap) : req.refUrls;
    const refRoles = req.refRoles?.slice(0, refUrls?.length ?? 0);
    /* the project's LoRAs: their cards' settings, and the files the pod fetches */
    const loras = await projectLoras(project.imaging, model);
    const params = loras.length
      ? { ...resolveParams(model, { loras }).params, loras: loras.map((l) => ({ file: l.filename, strength: l.strength, name: l.name, ...(l.hfUrl ? { hf_url: l.hfUrl } : {}) })) }
      : req.params ?? defaultImageParams(model);
    let prompt = req.prompt ? namePicturesFor(model, req.prompt) : req.prompt;
    const adultLora = loras.find((l) => l.adult);
    if (adultLora) {
      /* as in Canvas: the user who chose it still has 18+ on, and every picture it is drawn from is 模拟 (provenance.ts) */
      if (!(await adultAllowed({ user: project.imaging?.grantedBy ?? "anonymous", via: "web" }))) {
        throw new StudioError("forbidden", `${adultLora.name} is 18+ and 18+ is off for ${project.imaging?.grantedBy ?? "the user who chose it"}: show 18+ on the Canvas page, or take the LoRA out on the project's Settings page`, { adult: false });
      }
      const upload = await firstRealIn(projectId, inputsOf({ refUrls, baseUrl: req.baseUrl }), { takeId: req.takeId });
      if (upload) {
        throw new StudioError("validation", `${adultLora.name} is 18+: R18 pictures are drawn only from 模拟 pictures, and ${upload} — it may show a real person. 模拟 are the library's pictures, uploads whose face check found a 3D render, an illustration or no face, and Studio pictures drawn only from those. Leave it out, or take the LoRA out on the project's Settings page.`, { upload });
      }
      if (prompt && !/everyone in the picture is an adult/i.test(prompt)) prompt = `${prompt}\n\nEveryone in the picture is an adult.`;
    }
    req = {
      ...req, model: model.id, backend: model.backend,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(params ? { params } : {}),
      ...(refUrls ? { refUrls } : {}),
      ...(refRoles ? { refRoles } : {}),
    };
  }
  /* crop and extract are not drawn by a model: any painter takes them */
  const backend = req.op === "paint" ? req.backend ?? findModel(req.model ?? "")?.backend ?? "codex" : "codex";
  const podModel = backend.startsWith("comfy:");
  /* a model on the GPU pod: not while the pod downloads models, nor before this model's files are there whole */
  if (podModel) {
    const m = findModel(req.model ?? "") ?? { id: backend.slice("comfy:".length), label: backend.slice("comfy:".length) };
    await gpu.assertPodCanWork("a picture", { id: m.id, label: m.label });
  }
  /* an API model whose key nobody has: the CPU painter pod would start for a picture it cannot draw */
  if (backend === "qwen" && !painter.qwenApiKeyOnWorker() && !(await painter.runnerSummary("paint", "qwen")).ready) {
    throw new StudioError("validation", `${findModel(req.model ?? "")?.label ?? "Qwen-Image 3.0 Pro"} needs TOKENSAIL_API_KEY (or DASHSCOPE_API_KEY) as a Worker secret (Cloudflare → Workers → Settings → Variables and Secrets); the CPU painter pod gets it when it starts`);
  }
  /* the painter checks its own picture (a fresh Codex session, rubric as JSON) and may redraw a blocker, inside the quota;
     not a pod model's picture: the review would send it to OpenAI, whose moderation the model was picked to avoid */
  const check = req.op === "paint" ? { review: podModel ? false : project.imaging?.selfCheck ?? true, redraws: Math.max(0, Math.min(project.imaging?.autoRedraws ?? 1, left - 1)), kind: req.checkKind ?? req.purpose } : undefined;
  const job = await repo.createJob({
    projectId, kind: "image", targetId: req.targetId, backend: req.op === "paint" ? `painter-${backend}` : "painter",
    input: { ...req, backend, quality: req.quality ?? project.imaging?.quality ?? "low", by: actor.via === "mcp" ? "agent" : actor.user, ...(check ? { check } : {}) },
  });
  const summary = await painter.runnerSummary(req.op, backend);
  if (summary.ready) return { job, runner: `queued; ${summary.drawers.join(" / ")} draws it`, painters: summary };
  if (podModel) {
    /* only the GPU pod draws it: start the pod when asked to, else say so */
    if (startPod && gpu.gpuConfigured()) {
      const state = await gpu.startGpu(actor, true);
      if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true, job: job.id });
      return { job, runner: `queued; the GPU pod is ${state.status}, it draws once its model is loaded (it bills per hour)`, painters: summary };
    }
    return { job, runner: `queued; ${summary.note ?? "waiting for the GPU pod"}${actor.via === "mcp" ? " — only the user can start the GPU: ask them to (the GPU menu in the top bar)" : ""}`, painters: summary };
  }
  /* nobody can draw it now: wake the painter pod, if the Studio manages one */
  const { wakeForWork } = await import("./painter-pod");
  const woke = await wakeForWork();
  if (woke) return { job, runner: `queued; ${woke}`, painters: { ...summary, note: woke } };
  /* Qwen-Image 3.0 Pro is drawn by the CPU painter pod only (the GPU pod does not carry its key) */
  if (startPod && backend !== "qwen" && config.painterOnPod() && gpu.gpuConfigured()) {
    const pod = await repo.currentGpuPod();
    if (!pod || pod.status !== "running") {
      const state = await gpu.startGpu(actor, true);
      if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true, job: job.id });
      return { job, runner: `queued; no painter online, so the GPU pod is ${state.status} to draw it (it bills per hour)`, painters: summary };
    }
  }
  return { job, runner: `queued; ${summary.note ?? "waiting for a painter"}`, painters: summary };
}

/** An image job as it stands (painters report back by themselves). */
export async function refreshImageJob(jobId: string): Promise<Job> {
  return repo.getJob(jobId);
}

/** What the painter answered: an asset, attached where it was meant to go. */
export async function applyImageStatus(job: Job, status: BackendStatus): Promise<Job> {
  if (job.status === "completed" || job.status === "failed") return job;
  const i = job.input as unknown as ImageRequest & { backend?: string; by?: string };
  if (status.state === "queued" || status.state === "running") return job.status === "running" ? job : repo.updateJob(job.id, { status: "running" });
  /* the job is over: references re-hosted for an API (Qwen-Image 3.0 Pro) go */
  await painter.removeRehosted(job);
  if (status.state !== "completed") {
    const error = status.state === "failed" ? status.error : status.state;
    if (/^quota:/i.test(error)) {
      const project = await repo.getProject(job.projectId);
      if (project.imaging) await repo.setImaging(project.id, { ...project.imaging, stoppedReason: error.slice(0, 300) });
      await repo.insertNote(job.projectId, "decision", "standing", { decision: "Image generation stopped: out of image quota", why: error.slice(0, 300), by: "studio", confidence: "system" });
    }
    return repo.updateJob(job.id, { status: "failed", error, finishedAt: Date.now() });
  }
  const out = status.output;
  const url = typeof out.url === "string" ? out.url : undefined;
  if (!url) return repo.updateJob(job.id, { status: "failed", error: "the painter answered without a picture", finishedAt: Date.now() });
  /* 模拟 or 真实, from the pictures it was drawn from (provenance.ts) — no model looks at a drawing */
  const realness = await realnessOfDrawing(job.projectId, { refUrls: i.refUrls, baseUrl: i.baseUrl, videoUrl: i.videoUrl, takeId: i.takeId });
  const asset = await repo.createAsset({
    projectId: job.projectId, url, kind: "image", source: i.op === "extract" ? "frame-extract" : "generated",
    width: typeof out.width === "number" ? out.width : undefined, height: typeof out.height === "number" ? out.height : undefined,
    meta: {
      key: `projects/${job.projectId}/images/${job.id}.png`, jobId: job.id, purpose: i.purpose, op: i.op, prompt: i.prompt, backend: i.backend,
      previewUrl: out.preview_url, diffUrl: out.diff_url, baseAssetId: i.baseAssetId, region: i.region, crop: i.crop, takeId: i.takeId, frame: i.frame,
      view: i.attach?.elementRef?.view, label: i.label, review: i.op === "paint" ? "pending" : undefined,
      checks: out.checks, autoReview: out.review, painter: painter.painterOfJob(job), drawn: out.drawn,
      ...(i.canvas ? { canvas: i.canvas } : {}),
      ...(i.model ? { model: i.model, params: i.params } : {}),
      realness,
    },
    name: i.label,
  });
  if (i.op === "paint") await repo.bumpImagesUsed(job.projectId, typeof out.drawn === "number" ? out.drawn : 1);
  await attach(job.projectId, asset, i.attach);
  return repo.updateJob(job.id, { status: "completed", assetIds: [asset.id], output: out, finishedAt: Date.now() });
}

async function attach(projectId: string, asset: Asset, a?: Attach): Promise<void> {
  if (!a) return;
  if (a.heroOf) await repo.updateShot(a.heroOf, { heroAssetId: asset.id });
  if (a.endOf) await repo.updateShot(a.endOf, { endAssetId: asset.id });
  if (a.elementRef) {
    await repo.attachElementRef(a.elementRef.elementId, asset.id, { view: a.elementRef.view, feature: a.elementRef.feature });
  }
  if (a.styleFrame) {
    const p = await repo.getProject(projectId);
    await repo.setProjectLook(projectId, { ...p.look, styleFrameAssetId: asset.id });
  }
}

/* ---------- prompts ---------- */

/*
 * How these prompts are written, and why (each line answers a fault seen in
 * GPT Image pictures):
 *  - sections with a label each (SCENE, STAGING, CAMERA…): the model weighs a
 *    labelled list better than one run-on paragraph, and nothing drowns;
 *  - every reference picture gets a ROLE (copy the identity, ignore its pose,
 *    backdrop and light), or a grey sheet backdrop leaks into the frame;
 *  - the people are COUNTED and named, or extras appear;
 *  - a one-sided feature is said as the person's OWN side and where it lands
 *    in the picture, or it comes back mirrored;
 *  - a sheet is "one figure, one view", never "reference sheet", which draws a
 *    labelled multi-view turnaround with text on it;
 *  - the rules (no text, anatomy, full canvas) go last, where they hold.
 */
const NO_TEXT = "No text, no lettering, no captions, no labels, no watermark, no logo, no signature, no border, no frame, no panel grid.";
const ANATOMY = "Natural anatomy: two hands with five fingers each, two arms, two legs; faces symmetric and undistorted.";
const BACKDROP = "Plain, evenly lit light-grey studio backdrop with a soft floor shadow; nothing else in the picture.";

export const VIEW_TEXT: Record<RefView, string> = {
  face: "a head-and-shoulders portrait, facing the camera straight on, head level, a neutral relaxed expression with the mouth closed, eyes open and looking into the lens; the whole head and all of the hair inside the frame with a little space above, the face large and sharp, in even soft light with no hard shadow across it",
  front: "full-body front view, standing straight, arms relaxed at the sides, facing the camera, the whole figure from the top of the head to below the feet with a little space around it",
  three_quarter: "full-body three-quarter view, body turned 45 degrees toward frame left, the whole figure from head to feet",
  side: "full-body side view in strict profile, facing frame left, the whole figure from head to feet",
  back: "full-body back view, facing away from the camera, the whole figure from head to feet",
  full_body: "full-body front view in a natural relaxed pose, the whole figure from head to feet",
  expression: "head and shoulders only, a 2x2 grid of the same face with four expressions: neutral, happy, surprised, worried — the same person, light and angle in all four",
  detail: "close detail of the most distinctive part: the face, the hands or the object's key feature, filling the frame",
};

function styleLine(look: Project["look"]): string {
  const s = styles.knownStyle(look.style)?.style;
  const parts = [look.genre, look.palette, look.lighting, s ? `${s.en}: ${s.line}` : ""].map((x) => x?.trim()).filter(Boolean);
  return parts.length ? parts.join(". ") + "." : "";
}

const section = (label: string, text?: string) => (text && text.trim() ? `${label}: ${text.trim()}` : "");
const join = (parts: string[]) => parts.filter((x) => x && x.trim()).join("\n");

/** "a scar on her LEFT cheek" said so it cannot be mirrored: the person's own side, and where that lands in the picture. */
export function sidedFeature(f: { feature: string; where: string }, facing: "camera" | "away" | "unknown" = "camera"): string {
  const where = f.where.trim();
  const side = /\bleft\b/i.test(where) ? "left" : /\bright\b/i.test(where) ? "right" : undefined;
  if (!side) return placedFeature(f);
  const lands = facing === "camera" ? ` (the ${side === "left" ? "right" : "left"} side of the picture when they face the camera)` : facing === "away" ? ` (the ${side} side of the picture, as they face away)` : "";
  return `${placedFeature(f)} — their OWN ${side}${lands}; never mirrored`;
}

function features(el: Element, facing: "camera" | "away" | "unknown" = "camera", headOnly = false): string {
  if (!el.fixedFeatures?.length) return "";
  /* a portrait shows the head and shoulders: a patch on an arm is named so it is not moved up into the frame */
  return `${headOnly ? "Always, where it falls inside this head-and-shoulders frame (what sits lower on the body stays out of the picture)" : "Always"}: ${el.fixedFeatures.map((f) => sidedFeature(f, facing)).join("; ")}.`;
}

const FACING: Partial<Record<RefView, "camera" | "away" | "unknown">> = { face: "camera", front: "camera", full_body: "camera", expression: "camera", back: "away", side: "unknown", three_quarter: "camera", detail: "unknown" };

/* ---- a character's sheet, in the order identity is built (the stages are in sheet.ts) ----
   1. face        the portrait: uploaded or drawn; everything else copies it
   2. expression  from the portrait alone — the test that the face holds when it moves
   3. detail      up to three close pictures of fixed features that are not on the face
   4. figures     front first, from the portrait and the details; then the other views from all of those
   Every picture copies the portrait itself, never a picture drawn from it: a
   copy of a copy drifts. The expression grid is never an identity reference. */

/** What a reference picture is to the sheet picture being drawn. */
export type SheetRef = { kind: "face" | "tone" | "figure" | "detail" | "same" | "style"; label?: string };

function sheetRefLine(el: Element, r: SheetRef, n: number, all: SheetRef[]): string {
  const faceAt = all.findIndex((x) => x.kind === "face") + 1;
  if (r.kind === "face") return `Picture ${n} is ${el.name}'s face, large: copy exactly the face — its shape, the eyes and eyelids, brows, nose, mouth, skin and hairline — and the hair. It shows the head only: its framing, expression and light are not this picture's.`;
  if (r.kind === "tone") return `Picture ${n} is ${el.name}'s face: take only the skin tone, the hair colour and the rendering from it. The face itself is not in this picture.`;
  if (r.kind === "figure") return faceAt
    ? `Picture ${n} is ${el.name}, whole: copy exactly the build, age, clothes, colours and props; the face is the one in Picture ${faceAt}. Ignore its pose, framing and background.`
    : `Picture ${n} is ${el.name}: copy exactly the face, hair, build, age, clothes, colours and props. Ignore its pose, framing and background.`;
  if (r.kind === "detail") return `Picture ${n} is a close detail of ${el.name}: ${r.label}. Where this picture shows that part, copy its design exactly — shape, colours, size and place on the body; ignore its framing.`;
  if (r.kind === "same") return `Picture ${n} is ${el.name}: the same ${el.kind === "location" ? "place" : "object"} — copy its shapes, materials and colours. Ignore its framing.`;
  return `Picture ${n} is the film's style frame: copy only its rendering, colour and texture, none of its content.`;
}

/** One view of an element's sheet. `refs` are the pictures sent with it, in order; `feature` is the fixed feature a detail shows. */
export function elementViewPrompt(el: Element, view: RefView, look: Project["look"], opts: { refs?: SheetRef[]; feature?: FixedFeature } = {}): string {
  const all = opts.refs ?? [];
  const refs = all.map((r, k) => sheetRefLine(el, r, k + 1, all)).join(" ");
  const who = `${el.name}: ${el.description || "(no description yet)"}`;
  if (el.kind === "location") {
    return join([
      "A single wide establishing picture of a place, at eye level, with no people in it.",
      section("PLACE", who),
      section("REFERENCES", refs),
      section("STYLE", styleLine(look)),
      section("RULES", `The whole place in view, nothing cropped that defines it. ${NO_TEXT}`),
    ]);
  }
  if (el.kind === "prop") {
    return join([
      "A single picture of one object, centred, in three-quarter view, the whole object in frame with space around it.",
      section("OBJECT", `${who} ${features(el, "unknown")}`),
      section("REFERENCES", refs),
      section("BACKDROP", BACKDROP),
      section("STYLE", styleLine(look)),
      section("RULES", `Exactly one object. ${NO_TEXT}`),
    ]);
  }
  if (view === "detail" && opts.feature) {
    return join([
      "A single close picture of one detail of a film character, for the casting file: the detail fills most of the frame, with just enough of the body or the garment around it to show where it sits. The face is not in this picture.",
      section("CHARACTER", who),
      section("DETAIL", `${sidedFeature(opts.feature, "unknown")}. Draw its design exactly and clearly: shape, colours, materials, and any lettering it is made of.`),
      section("REFERENCES", refs),
      section("BACKDROP", "Plain, evenly lit light-grey studio backdrop behind what is shown."),
      section("STYLE", styleLine(look)),
      section("RULES", "One detail, one view: not a grid, not a turnaround, no second picture of it. No captions, labels, watermark, logo, border or panel grid; lettering only where the detail itself is lettering."),
    ]);
  }
  return join([
    `A single character picture for a film's casting file: ONE figure, ONE view — ${VIEW_TEXT[view]}.`,
    section("CHARACTER", `${who} ${features(el, FACING[view] ?? "unknown", view === "face" || view === "expression")}`),
    section("REFERENCES", refs),
    section("BACKDROP", BACKDROP),
    section("STYLE", styleLine(look)),
    section("RULES", `Exactly one person${view === "expression" ? " (four times, the same face — the same identity in all four, only the expression changes)" : ""}; not a turnaround, not a multi-view sheet, no second figure. ${ANATOMY} ${NO_TEXT}`),
  ]);
}

const POS_WORD: Record<string, string> = { off_left: "just outside frame left", left: "on the left of the frame", center: "in the centre", right: "on the right of the frame", off_right: "just outside frame right", foreground: "in the foreground", background: "in the background" };
const X_WORD = { left: "on the left third (about 38% from the left)", center: "on the centre line", right: "on the right third (about 62% from the left)" } as const;

export type FrameRef = { name: string; role: "character" | "face" | "expression" | "location" | "style" | "other" };
/** A shot frame's reference as provenance reads it: a character's face, or a place or look it borrows. */
const frameRefRole = (r: FrameRef["role"]): RefRole => (r === "location" ? "scene" : r === "style" ? "style" : "face");

/** How a reference picture is to be used: copy what it is for, ignore the rest. */
export function refRole(r: FrameRef, n: number): string {
  if (r.role === "character") return `Picture ${n} is ${r.name}: copy exactly their face, hair, build, age, clothes and colours; ignore that picture's pose, framing, plain backdrop and light.`;
  if (r.role === "face") return `Picture ${n} is ${r.name}'s face, large: the same person — copy exactly the face (its shape, the eyes and eyelids, brows, nose, mouth, skin, hairline). It shows the head only: take nothing else from it, not its framing, its neutral expression or its light.`;
  if (r.role === "expression") return `Picture ${n} shows ${r.name}'s face four times with four expressions: use it only to see how this one face looks when its expression changes. Draw ${r.name} once; copy none of its framing or its grid.`;
  if (r.role === "location") return `Picture ${n} is ${r.name}: the same place — architecture, materials, layout and props — seen from this shot's camera; ignore any people in it.`;
  if (r.role === "style") return `Picture ${n} is the film's style frame: match its rendering, colour grade and texture only, none of its content.`;
  return `Picture ${n} is ${r.name}.`;
}

/** A first or last frame of a shot, drawn from its structured fields. */
/** What the shot's elements carry into its first frame, or out of its last: "Mia: wearing …; holding …". */
export function frameStateLines(sh: ShotView, which: "first" | "last", states: ShotStates | undefined, name: (id: string) => string): string[] {
  if (!states) return [];
  const at = which === "first" ? states.before : states.after;
  return [...sh.spec.characters, ...sh.spec.props, ...(sh.spec.location ? [sh.spec.location] : [])].filter((id) => hasState(at[id])).map((id) => `${name(id)}: ${stateText(at[id]!)}.`);
}

export function shotFramePrompt(sh: ShotView, which: "first" | "last", ctx: { elements: Map<string, Element>; palette?: { colors: string[]; note?: string }; look: Project["look"]; refNames?: string[]; refs?: FrameRef[]; states?: ShotStates }): string {
  const spec = sh.spec;
  const name = (id: string) => ctx.elements.get(id)?.name ?? id;
  const describe = which === "first"
    ? spec.frames?.first ?? `The moment the shot begins: ${spec.beats[0]?.action ?? spec.intent}`
    : spec.frames?.last ?? `The moment the shot ends: ${spec.beats[spec.beats.length - 1]?.action ?? spec.intent}`;
  const offscreen = new Set((spec.blocking ?? []).filter((b) => (which === "first" ? b.from : b.to)?.startsWith("off_")).map((b) => b.who));
  const staging = (spec.blocking ?? []).map((b) => {
    const pos = which === "first" ? b.from : b.to;
    return pos && !pos.startsWith("off_") ? `${name(b.who)} is ${POS_WORD[pos]}` : pos?.startsWith("off_") ? `${name(b.who)} is not in the frame yet (they enter later)` : "";
  }).filter(Boolean);
  const inFrame = spec.characters.filter((id) => !offscreen.has(id)).map(name);
  const count = inFrame.length ? `Exactly ${inFrame.length} ${inFrame.length === 1 ? "person" : "people"} in the frame: ${inFrame.join(", ")}. No one else, no extras, no one twice.` : spec.characters.length ? "No people in the frame." : "";
  const cine = renderCinematography(spec.cinematography).block?.split("\n").slice(1).join(" ") ?? "";
  const comp = spec.composition ? `The subject's eyes ${X_WORD[spec.composition.subjectX]}${spec.composition.headroom ? `, ${spec.composition.headroom} headroom` : ""}.` : "";
  const pal = ctx.palette ? `Palette ${ctx.palette.colors.join(", ")}${ctx.palette.note ? ` (${ctx.palette.note})` : ""}.` : "";
  const fixed = [...spec.characters, ...spec.props].map((id) => ctx.elements.get(id)).filter((e): e is Element => !!e && !!e.fixedFeatures?.length).map((e) => `${e.name} has ${e.fixedFeatures!.map((f) => sidedFeature(f, "unknown")).join(" and ")}.`).join(" ");
  const refs = ctx.refs ?? (ctx.refNames ?? []).map((n) => ({ name: n, role: "other" as const }));
  /* what the shots before left: the sheets show the designed look, the frame must show this one */
  const carried = frameStateLines(sh, which, ctx.states, name);
  return join([
    `A single still frame from a film: the ${which} frame of the shot "${spec.intent}". Photographed as one moment of the scene, not a poster, not a collage.`,
    section("SCENE", describe),
    section("PEOPLE", count),
    section("STAGING", staging.length ? staging.join(". ") + "." : ""),
    section("CAMERA", cine),
    section("COMPOSITION", comp),
    section("COLOUR", pal),
    section("CONTINUITY", [fixed, carried.length ? `At this moment, unlike the reference sheets: ${carried.join(" ")}` : ""].filter(Boolean).join(" ")),
    section("REFERENCES", refs.map((r, k) => refRole(r, k + 1)).join(" ")),
    section("STYLE", styleLine(ctx.look)),
    section("RULES", `Every person in a different pose; leave room where things will move. ${ANATOMY} ${NO_TEXT}`),
  ]);
}

/** Edit an existing frame (the Viggle Remake recipe: change only what is asked). */
export function editPrompt(instruction: string, opts: { refsFirst?: number } = {}): string {
  const lead = opts.refsFirst ? Array.from({ length: opts.refsFirst }, (_, k) => `Picture ${k + 1} is a reference of what the edit brings into the frame: copy its look exactly.`).join(" ") : "";
  return join([
    `The last picture is a frame from a film. Edit it — change only this: ${instruction.trim()}`,
    section("REFERENCES", lead),
    section("KEEP", "Everything else exactly as it is: every person's face, hair, body, clothes, pose, hands and position; the background, lighting, colours, camera framing, composition and grain. Same aspect, no crop, no zoom, no re-framing."),
    section("RULES", `${ANATOMY} ${NO_TEXT}`),
  ]);
}

export function stylePrompt(project: Project): string {
  return join([
    "A single still frame that sets the look of a short film: a representative moment in its main setting, at the film's colours, light and rendering.",
    section("THE FILM", project.brief.slice(0, 600) || project.name),
    section("STYLE", styleLine(project.look)),
    section("RULES", `One frame, edge to edge — not a poster, not a collage. ${ANATOMY} ${NO_TEXT}`),
  ]);
}

/* ---------- which picture comes from where ---------- */

export type FrameMethod = "none" | "sheets" | "anchor" | "edit_anchor" | "new" | "edit_from_last" | "edit_from_previous" | "edit_picture" | "crop_from_first" | "crop_from_last";
export type FramePlanRow = { shotId: string; label: string; mode: string; link: string; first: FrameMethod | null; last: FrameMethod | null; have: { first: boolean; last: boolean }; previousShotId?: string; why: string; order: number; paints: number };

const CHEAP: Record<FrameMethod, number> = { none: 0, sheets: 0, anchor: 0, crop_from_first: 0, crop_from_last: 0, edit_anchor: 1, edit_from_previous: 1, edit_from_last: 1, edit_picture: 1, new: 1 };

/**
 * The director's picture plan: for every shot, where its first and last
 * frame come from, cheapest first — reuse a frame the edit already has, crop,
 * edit a related frame, and only then draw a new one.
 */
export function planFrames(view: ProjectView): { shots: FramePlanRow[]; elements: Array<{ elementId: string; name: string; kind: string; views: RefView[]; details?: string[]; stage?: SheetStage; why: string }> } {
  const flat = view.scenes.flatMap((s) => s.shots.map((sh) => ({ scene: s, sh })));
  const rows: FramePlanRow[] = [];
  flat.forEach(({ scene, sh }, k) => {
    const spec = sh.spec;
    const link = effectiveLink(spec).type;
    const have = { first: !!sh.heroAssetId, last: !!sh.endAssetId };
    const label = `${scene.slug} #${sh.index + 1}`;
    let first: FrameMethod | null = null;
    let last: FrameMethod | null = null;
    let why = "";
    let previousShotId: string | undefined;
    if (spec.mode === "text" && !["continuous", "bridge", "insert_return", "reverse", "jump_cut", "loop"].includes(link)) {
      first = "none"; why = "text mode: H3 draws it from the prompt; no picture needed";
    } else if (["continuous", "insert_return", "reverse"].includes(link)) {
      first = "anchor"; why = `${link}: the first frame is the anchor take's last frame`;
    } else if (link === "bridge") {
      first = "anchor"; last = "new"; why = "bridge: starts on the anchor's last frame, ends on a drawn end frame";
    } else if (link === "jump_cut") {
      first = "edit_anchor"; why = "jump cut: the anchor's last frame, edited for the time that passed (same camera)";
    } else if (spec.mode === "reference" || link === "match_cut") {
      first = "sheets"; why = "reference mode: R2VA reads the element sheets, not a first frame";
    } else {
      const prev = [...flat.slice(0, k)].reverse().find((x) => x.sh.heroAssetId && x.sh.spec.mode === "keyframe" && (x.sh.spec.location ?? x.scene.locationElementId) === (spec.location ?? scene.locationElementId) && (spec.location ?? scene.locationElementId) && x.sh.spec.cinematography?.angle === spec.cinematography?.angle && x.sh.spec.cinematography?.size === spec.cinematography?.size);
      const fresh: FrameMethod = prev ? "edit_from_previous" : "new";
      if (prev) previousShotId = prev.sh.id;
      if (link === "loop") { first = fresh; why = "loop: one frame opens and closes the period"; }
      else if (spec.camera.move === "push_in") { first = fresh; last = "crop_from_first"; why = "push-in: the end frame is a crop of the first, so the push is guaranteed"; }
      else if (spec.camera.move === "pull_out") { last = fresh; first = "crop_from_last"; why = "pull-out: draw the wide end, crop the first from it"; }
      else if (spec.frames?.last) { last = fresh; first = "edit_from_last"; why = "first and last frame: draw the richer last frame, edit the first from it (same camera)"; }
      else { first = fresh; why = prev ? "same place and angle as an earlier shot: edit its frame instead of drawing a new one" : "keyframe shot: draw its first frame"; }
    }
    /* order: sheets 0, drawn frames 1, frames edited/cropped from a drawn one 2, anchor-based after their anchors 3 */
    const order = first === "sheets" ? 0 : first === "crop_from_last" || first === "edit_from_last" || last === "crop_from_first" ? 2 : first === "anchor" || first === "edit_anchor" ? 3 : 1;
    const paints = (first && !have.first ? CHEAP[first] : 0) + (last && !have.last ? CHEAP[last] : 0);
    rows.push({ shotId: sh.id, label, mode: spec.mode, link, first, last, have, previousShotId, why, order, paints });
  });
  /* elements that need sheets: characters of reference shots and of drawn frames */
  const needed = new Map<string, Set<RefView>>();
  for (const { sh } of flat) {
    const row = rows.find((r) => r.shotId === sh.id)!;
    if (row.first === "none" || row.first === "anchor") continue;
    for (const id of sh.spec.characters) {
      const set = needed.get(id) ?? new Set<RefView>(["face", "expression", "front"]);
      for (const v of preferredViews(sh.spec).slice(0, 1)) set.add(v);
      needed.set(id, set);
    }
    for (const id of [...sh.spec.props, ...(sh.spec.location ? [sh.spec.location] : [])]) needed.set(id, needed.get(id) ?? new Set<RefView>(["front"]));
  }
  type Need = { elementId: string; name: string; kind: string; views: RefView[]; details?: string[]; stage?: SheetStage; why: string };
  const elements = [...needed].flatMap(([id, views]): Need[] => {
    const el = view.elements.find((e) => e.id === id);
    if (!el) return [];
    const have = new Set(Object.values(el.refViews ?? {}));
    if (el.kind !== "character") return el.refAssetIds.length ? [] : [{ elementId: id, name: el.name, kind: el.kind, views: ["front"] as RefView[], why: "no reference picture yet" }];
    /* a character: in the sheet's order — portrait, expressions, details, then the figures the shots want */
    const order = (v: RefView) => (v === "face" ? 0 : v === "expression" ? 1 : v === "detail" ? 2 : v === "front" ? 3 : 4);
    const details = missingDetails(el).map((f) => f.feature);
    const missing = [...views, ...(details.length ? (["detail"] as RefView[]) : [])].filter((v) => v === "detail" || !have.has(v)).sort((a, b) => order(a) - order(b));
    return missing.length ? [{ elementId: id, name: el.name, kind: el.kind, views: missing, ...(details.length ? { details } : {}), stage: sheetStage(el).stage, why: el.refAssetIds.length ? "the sheet is not complete: generate_element_sheet draws its next stage" : "no reference picture yet: the sheet starts with the face portrait" }] : [];
  });
  return { shots: rows.sort((a, b) => a.order - b.order), elements };
}

/* ---------- actions (web buttons and MCP tools call these) ---------- */

function sizeFor(look: Project["look"]): string {
  return VIDEO_SIZES[look.aspectRatio];
}

function assetUrl(view: ProjectView, id?: string): string | undefined {
  return id ? view.assets.find((a) => a.id === id)?.url : undefined;
}

/** The pictures one sheet view is drawn from, most important first (the model's picture limit cuts from the end). */
export function sheetRefsFor(el: Element, view: RefView): Array<SheetRef & { assetId: string }> {
  if (el.kind !== "character") {
    const same = el.refAssetIds[0];
    return same ? [{ kind: "same", assetId: same }] : [];
  }
  const face = faceRef(el);
  const figures = el.refAssetIds.filter((a) => !el.refViews?.[a] || (FIGURE_VIEWS as readonly string[]).includes(el.refViews[a]!));
  const figure = figures.length ? pickRefForViews({ ...el, refAssetIds: figures }, ["front", "three_quarter", "full_body"]) : undefined;
  const out: Array<SheetRef & { assetId: string }> = [];
  if (view === "face") {
    /* the portrait is the root; only a character that has figures and no portrait (older projects) draws it from one */
    if (figure) out.push({ kind: "figure", assetId: figure });
    return out;
  }
  if (view === "expression") {
    /* the head only: the portrait alone, so nothing else pulls the face */
    if (face) out.push({ kind: "face", assetId: face });
    else if (figure) out.push({ kind: "figure", assetId: figure });
    return out;
  }
  if (view === "detail") {
    if (face) out.push({ kind: "tone", assetId: face });
    if (figure) out.push({ kind: "figure", assetId: figure });
    return out;
  }
  /* a whole figure: the portrait (a back view shows no face), the figure already drawn, then the details this view can show */
  if (face && view !== "back") out.push({ kind: "face", assetId: face });
  const self = el.refAssetIds.find((a) => el.refViews?.[a] === view);
  if (figure && !(face && figure === self)) out.push({ kind: "figure", assetId: figure });
  const details = detailRefs(el).sort((x, y) => Number(ON_BACK.test(y.feature?.where ?? "") === (view === "back")) - Number(ON_BACK.test(x.feature?.where ?? "") === (view === "back")));
  for (const d of details) out.push({ kind: "detail", assetId: d.assetId, label: d.label });
  return out;
}

/** One element view. A detail names the fixed feature it shows (`feature`, its text); without one, the first that has no picture. */
export async function generateElementView(elementId: string, view: RefView, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean; feature?: string } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
  const el = await repo.getElement(elementId);
  if (!el.projectId) throw new StudioError("validation", "library elements are drawn inside a project (import it first)");
  const pv = await getProjectView(el.projectId);
  await styles.warm(pv.project.look.style);
  if ((view === "face" || view === "expression" || view === "detail") && el.kind !== "character") throw new StudioError("validation", `the ${view} view is a character's; ${el.name} is a ${el.kind}`);
  let feature: FixedFeature | undefined;
  if (view === "detail") {
    feature = opts.feature ? el.fixedFeatures?.find((f) => f.feature === opts.feature) : missingDetails(el)[0] ?? detailTargets(el)[0];
    if (!feature) throw new StudioError("validation", opts.feature ? `${el.name} has no fixed feature "${opts.feature}" (its features: ${(el.fixedFeatures ?? []).map((f) => f.feature).join("; ") || "none"})` : `a detail picture shows one of the character's fixed features, and ${el.name} has none off the face: add them with update_element (fixedFeatures), up to ${MAX_DETAILS} with detail: true`);
  }
  const style = pv.project.look.styleFrameAssetId;
  const wanted: Array<SheetRef & { assetId: string }> = [...sheetRefsFor(el, view), ...(style ? [{ kind: "style" as const, assetId: style }] : [])];
  /* only the pictures the model will take are named in the prompt */
  const refs = wanted.flatMap((r) => { const url = assetUrl(pv, r.assetId); return url ? [{ ...r, url }] : []; }).slice(0, refCap(pv.project, false));
  const role = (k: SheetRef["kind"]): RefRole => (k === "style" ? "style" : k === "same" ? "scene" : k === "detail" ? "outfit" : "face");
  const prompt = elementViewPrompt(el, view, pv.project.look, { refs, feature });
  const size = el.kind === "location" ? sizeFor(pv.project.look) : el.kind === "prop" || view === "expression" || view === "face" || view === "detail" ? "1024x1024" : "1008x1344";
  const label = `${el.name} · ${view}${feature ? ` · ${feature.feature}` : ""}`.slice(0, 80);
  const r = await submitImage(el.projectId, { op: "paint", purpose: "element_sheet", ...(view === "detail" ? { checkKind: "element_detail" } : {}), prompt, refUrls: refs.map((x) => x.url), refRoles: refs.map((x) => role(x.kind)), size, quality: opts.quality, targetId: el.id, attach: { elementRef: { elementId: el.id, view, ...(feature ? { feature: feature.feature } : {}) } }, label }, actor, opts);
  return { ...r, prompt };
}

/** A sheet, one stage per call: the portrait; the expressions and details from it; the front figure; the other views. Named views are drawn as asked. */
export async function generateElementSheet(elementId: string, views: RefView[], actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ queued: Array<{ view: RefView; jobId: string; feature?: string }>; later: RefView[]; stage?: SheetStage; next?: string; note?: string; painters?: painter.RunnerSummary }> {
  const el = await repo.getElement(elementId);
  let stage: SheetStage | undefined;
  let now: SheetStep[];
  let later: SheetStep[];
  if (el.kind !== "character") {
    if (!views.length && el.refAssetIds.length) return { queued: [], later: [], note: `${el.name} already has a reference picture: name the view to redraw it` };
    now = [{ view: views[0] ?? "front" }];
    later = [];
  } else if (!views.length) {
    ({ stage, now, later } = sheetStage(el));
    if (!now.length) return { queued: [], later: [], stage, next: STAGE_NEXT.complete, note: `${el.name} has every view of the usual sheet: name the views to redraw` };
  } else {
    /* named views: those, in the sheet's order; a detail means every detail still missing (or the first target, to redraw it) */
    const order = (v: RefView) => (v === "face" ? 0 : v === "expression" ? 1 : v === "detail" ? 2 : v === "front" ? 3 : 4);
    const steps: SheetStep[] = [...new Set(views)].sort((a, b) => order(a) - order(b)).flatMap((v): SheetStep[] => {
      if (v !== "detail") return [{ view: v }];
      const targets = missingDetails(el).length ? missingDetails(el) : detailTargets(el).slice(0, 1);
      return targets.map((f) => ({ view: v, feature: f.feature }));
    });
    if (views.includes("detail") && !steps.some((x) => x.view === "detail")) throw new StudioError("validation", `a detail picture shows one of the character's fixed features, and ${el.name} has none off the face: add them with update_element (fixedFeatures), up to ${MAX_DETAILS} with detail: true`);
    /* nothing drawn yet: one picture first, the others copy it */
    now = el.refAssetIds.length ? steps : steps.slice(0, 1);
    later = steps.filter((x) => !now.includes(x));
  }
  const queued: Array<{ view: RefView; jobId: string; feature?: string }> = [];
  let painters: painter.RunnerSummary | undefined;
  for (const step of now) {
    const r = await generateElementView(elementId, step.view, actor, { ...opts, feature: step.feature });
    queued.push({ view: step.view, jobId: r.job.id, ...(step.feature ? { feature: step.feature } : {}) });
    painters = r.painters;
  }
  const laterViews = [...new Set(later.map((x) => x.view))];
  const first = now[0]!;
  return {
    queued, later: laterViews, painters, ...(stage ? { stage, next: STAGE_NEXT[stage] } : {}),
    ...(laterViews.length ? { note: `${laterViews.join(", ")} wait for ${stage ? `this stage (${stage})` : `the ${first.view} view`}: they are drawn from it — call again once it is in and reviewed` } : {}),
  };
}

/** A first or last frame of a shot, by the plan's method unless one is given. */
export async function generateShotFrame(shotId: string, which: "first" | "last", actor: Actor, opts: { method?: FrameMethod; quality?: Imaging["quality"]; startPod?: boolean; zoom?: number; instruction?: string; baseAssetId?: string } = {}): Promise<{ job?: Job; runner?: string; painters?: painter.RunnerSummary; method: FrameMethod; prompt?: string; note?: string }> {
  const shot = await repo.getShot(shotId);
  const pv = await getProjectView(shot.projectId);
  await styles.warm(pv.project.look.style);
  const flat = pv.scenes.flatMap((s) => s.shots);
  const sh = flat.find((x) => x.id === shotId)!;
  const scene = pv.scenes.find((s) => s.id === sh.sceneId)!;
  const row = planFrames(pv).shots.find((r) => r.shotId === shotId)!;
  const method = opts.method ?? (which === "first" ? row.first : row.last) ?? "new";
  const size = sizeFor(pv.project.look);
  const attach: Attach = which === "first" ? { heroOf: shotId } : { endOf: shotId };
  const label = `${scene.slug} #${sh.index + 1} · ${which}`;
  const zoom = Math.min(1.6, Math.max(1.05, opts.zoom ?? 1.2));
  const fx = sh.spec.composition?.subjectX === "left" ? 0.38 : sh.spec.composition?.subjectX === "right" ? 0.62 : 0.5;
  const cropBox = { w: 1 / zoom, h: 1 / zoom, x: Math.min(1 - 1 / zoom, Math.max(0, fx - 0.5 / zoom)), y: Math.min(1 - 1 / zoom, Math.max(0, 0.45 - 0.5 / zoom)) };
  if (method === "none" || method === "sheets" || method === "anchor") return { method, note: method === "anchor" ? "nothing to draw: the anchor take's last frame is the first frame" : method === "sheets" ? "nothing to draw: this shot reads the element sheets (generate_element_sheet)" : "nothing to draw: text mode" };
  if (method === "crop_from_first" || method === "crop_from_last") {
    const src = method === "crop_from_first" ? sh.hero : sh.end;
    if (!src) throw new StudioError("validation", `${method}: draw the ${method === "crop_from_first" ? "first" : "last"} frame first`);
    const r = await submitImage(pv.project.id, { op: "crop", purpose: "crop", baseUrl: src.url, baseAssetId: src.id, crop: cropBox, size, targetId: shotId, attach, label }, actor, opts);
    return { ...r, method };
  }
  /* references: the characters by the view this shot wants, the location, the style frame */
  const elements = new Map(pv.elements.map((e) => [e.id, e]));
  const states = carriedStates(flat.map((x) => x.spec))[flat.findIndex((x) => x.id === shotId)];
  const carried = frameStateLines(sh, which, states, (id) => elements.get(id)?.name ?? id);
  const refs: Array<{ url: string; name: string; role: FrameRef["role"] }> = [];
  const wanted = preferredViews(sh.spec);
  /* each character by the figure this shot's size and angle want, then their
     portrait: the figure gives the clothes and the build, the portrait the face
     at a size it can be copied from */
  const faces: typeof refs = [];
  const moods: typeof refs = [];
  for (const id of sh.spec.characters) {
    const el = elements.get(id);
    if (!el) continue;
    /* the figure is a whole figure: never the expression grid or a detail, whatever the shot's size */
    const figure = pickRefForViews(el, [...wanted.filter((v) => (FIGURE_VIEWS as readonly string[]).includes(v)), "front", "three_quarter", "full_body"]);
    const face = faceRef(el);
    const ref = assetUrl(pv, figure);
    if (ref) refs.push({ url: ref, name: el.name, role: figure === face ? "face" : "character" });
    const faceUrl = face && face !== figure ? assetUrl(pv, face) : undefined;
    if (faceUrl) faces.push({ url: faceUrl, name: el.name, role: "face" });
    /* a close-up acts with the face: the expression grid shows how this face moves */
    const grid = wanted[0] === "face" ? assetUrl(pv, el.refAssetIds.find((a) => el.refViews?.[a] === "expression")) : undefined;
    if (grid) moods.push({ url: grid, name: el.name, role: "expression" });
  }
  refs.push(...faces);
  const loc = elements.get(sh.spec.location ?? scene.locationElementId ?? "");
  const locRef = loc ? assetUrl(pv, loc.refAssetIds[0]) : undefined;
  if (locRef && loc) refs.push({ url: locRef, name: loc.name, role: "location" });
  refs.push(...moods);
  const style = assetUrl(pv, pv.project.look.styleFrameAssetId);
  if (style) refs.push({ url: style, name: "the film's style frame", role: "style" });
  if (method === "new") {
    /* at most five pictures, or fewer when the project's model takes fewer: the characters' figures first, then their portraits, then the place, a close-up's expression grids, the style frame last (dropped first) */
    const use = refs.slice(0, Math.min(5, refCap(pv.project, false)));
    const prompt = shotFramePrompt(sh, which, { elements, palette: scene.palette, look: pv.project.look, refs: use, states });
    const r = await submitImage(pv.project.id, { op: "paint", purpose: which === "first" ? "shot_first" : "shot_last", prompt, refUrls: use.map((x) => x.url), refRoles: use.map((x) => frameRefRole(x.role)), size, quality: opts.quality, targetId: shotId, attach, label }, actor, opts);
    return { ...r, method, prompt };
  }
  /* edits of a related frame: the base goes last */
  let base: Asset | undefined;
  let instruction = opts.instruction ?? "";
  const own = !instruction;
  if (method === "edit_from_last") {
    base = sh.end;
    instruction ||= `make it the moment the shot begins: ${sh.spec.frames?.first ?? sh.spec.beats[0]?.action ?? sh.spec.intent}. Only positions, poses, expressions and what is in hand change.`;
  } else if (method === "edit_from_previous") {
    base = flat.find((x) => x.id === row.previousShotId)?.hero;
    instruction ||= `make it this shot's ${which} frame: ${which === "first" ? sh.spec.frames?.first ?? sh.spec.beats[0]?.action : sh.spec.frames?.last ?? sh.spec.beats[sh.spec.beats.length - 1]?.action}. Same place, same camera.`;
  } else if (method === "edit_picture") {
    /* any picture the user (or the director) chose as the starting point */
    if (!opts.baseAssetId) throw new StudioError("validation", "edit_picture: choose the picture to start from (baseAssetId)");
    base = pv.assets.find((a) => a.id === opts.baseAssetId && a.kind === "image");
    if (!base) throw new StudioError("validation", `edit_picture: ${opts.baseAssetId} is not a picture of this project`);
    instruction ||= `make it this shot's ${which} frame: ${which === "first" ? sh.spec.frames?.first ?? sh.spec.beats[0]?.action ?? sh.spec.intent : sh.spec.frames?.last ?? sh.spec.beats[sh.spec.beats.length - 1]?.action ?? sh.spec.intent}. Keep the people, the place, the light and the style of this picture.`;
  } else if (method === "edit_anchor") {
    const link = effectiveLink(sh.spec);
    const idx = flat.findIndex((x) => x.id === shotId);
    const anchor = link.anchorShotId ? flat.find((x) => x.id === link.anchorShotId) : flat[idx + (link.anchor ?? -1)];
    const take = anchor?.selectedTake ?? anchor?.takes.find((t) => t.status === "completed");
    const frameAsset = take?.lastFrameUrl ? pv.assets.find((a) => a.url === take.lastFrameUrl) : undefined;
    base = frameAsset;
    if (!base && take?.lastFrameUrl) base = { id: "", projectId: pv.project.id, url: take.lastFrameUrl, kind: "image", source: "frame-extract", meta: {}, createdAt: 0 };
    instruction ||= `time has passed: ${sh.spec.frames?.first ?? sh.spec.beats[0]?.action}. Same place, same camera, same framing.`;
  }
  /* the default instruction carries the state the shots before left; one the caller wrote is theirs */
  if (own && carried.length) instruction += ` At this moment: ${carried.join(" ")}`;
  if (!base) throw new StudioError("validation", `${method}: the frame to edit from does not exist yet (${method === "edit_from_last" ? "draw the last frame first" : method === "edit_anchor" ? "the anchor shot needs a finished take" : "the earlier shot has no first frame"})`);
  const extra = refs.filter((r) => r.role !== "style").slice(0, Math.min(4, refCap(pv.project, true)));
  const prompt = editPrompt(instruction, { refsFirst: extra.length });
  const r = await submitImage(pv.project.id, { op: "paint", purpose: which === "first" ? "shot_first" : "shot_last", prompt, refUrls: extra.map((x) => x.url), refRoles: extra.map((x) => frameRefRole(x.role)), baseUrl: base.url, baseAssetId: base.id || undefined, size, quality: opts.quality, targetId: shotId, attach, label }, actor, opts);
  return { ...r, method, prompt };
}

/** Edit a region of any project picture; only the box changes. */
export async function editFrame(assetId: string, input: { instruction: string; region?: Box; refAssetIds?: string[]; attach?: Attach; purpose?: ImagePurpose; quality?: Imaging["quality"]; startPod?: boolean }, actor: Actor): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
  const asset = await repo.getAsset(assetId);
  if (!asset.projectId || asset.kind !== "image") throw new StudioError("validation", "edit a project image");
  const pv = await getProjectView(asset.projectId);
  const refs = (input.refAssetIds ?? []).map((id) => assetUrl(pv, id)).filter((u): u is string => !!u).slice(0, Math.min(4, refCap(pv.project, true)));
  const prompt = editPrompt(input.instruction, { refsFirst: refs.length });
  /* the picture's own size, within what the project's model draws (a 16 MP picture edited by a model that draws 1 MP is reduced) */
  const size = asset.width && asset.height ? editSizeFor(projectImageModel(pv.project.imaging), asset.width, asset.height).size : sizeFor(pv.project.look);
  const takeId = typeof asset.meta.takeId === "string" ? asset.meta.takeId : undefined;
  const frame = typeof asset.meta.frame === "number" ? asset.meta.frame : undefined;
  const r = await submitImage(asset.projectId, { op: "paint", purpose: input.purpose ?? "edit", prompt, refUrls: refs, baseUrl: asset.url, baseAssetId: asset.id, region: input.region, size, quality: input.quality, targetId: takeId ?? asset.id, takeId, frame, attach: input.attach, label: `edit · ${input.instruction.slice(0, 40)}` }, actor, input);
  return { ...r, prompt };
}

/** One exact frame of a take, as a project picture (the frame a Remake keyframe repaints). */
export async function extractTakeFrame(takeId: string, frame: number, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary }> {
  const take = await repo.getTake(takeId);
  if (take.status !== "completed" || !take.resultUrl) throw new StudioError("validation", "extract from a completed take");
  const pv = await getProjectView(take.projectId);
  return submitImage(take.projectId, { op: "extract", purpose: "extract", videoUrl: take.resultUrl, frame, takeId, size: sizeFor(pv.project.look), targetId: take.id, label: `take #${take.n} · f${frame}` }, actor, opts);
}

/** The frame that sets the film's look; once approved it is a reference for every sheet and frame. */
export async function generateStyleFrame(projectId: string, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
  const project = await repo.getProject(projectId);
  await styles.warm(project.look.style);
  const prompt = stylePrompt(project);
  const r = await submitImage(projectId, { op: "paint", purpose: "style_frame", prompt, size: sizeFor(project.look), quality: opts.quality ?? "medium", targetId: projectId, label: "style frame" }, actor, opts);
  return { ...r, prompt };
}

/** Withdraw a picture that is no longer wanted. A painter already drawing it finishes, but its answer is
    refused and nothing is attached or counted. */
export async function cancelImageJob(jobId: string, actor: Actor): Promise<Job> {
  const job = await repo.getJob(jobId);
  if (job.kind !== "image") throw new StudioError("validation", "not an image job");
  if (job.status !== "queued" && job.status !== "running") return job;
  return repo.updateJob(job.id, { status: "failed", error: `cancelled by ${actor.via === "mcp" ? "the director" : actor.user}`, finishedAt: Date.now() });
}

export async function listImageJobs(projectId: string): Promise<Job[]> {
  return (await repo.listProjectJobs(projectId, 60)).filter((j) => j.kind === "image");
}

/** Sweep: jobs whose painter went silent go back to the queue. */
export async function sweepImageJobs(): Promise<number> {
  return painter.sweepImageLeases();
}
