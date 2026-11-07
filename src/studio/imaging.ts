import * as director from "@/director";

import { mapRunPodStatus, signHookUrl } from "./backends/runpod";
import type { BackendStatus } from "./backends/types";
import { renderCinematography } from "./cinematography";
import { effectiveLink, pickRefForViews, preferredViews, VIDEO_SIZES } from "./compiler";
import { config } from "./config";
import { StudioError } from "./errors";
import * as gpu from "./gpu";
import { getProjectView, type ProjectView, type ShotView } from "./orchestrator";
import * as repo from "./repo";
import type { RefView } from "./schemas";
import type { Actor, Asset, Element, Imaging, Job, Project } from "./types";

/*
 * GPT Image in the Studio: character sheets, first and last frames, region
 * edits, style frames and the painted keyframes Viggle Remake reads. One
 * image job type, run on the GPU pod beside the renders (workers/h3-runpod/
 * paint.py): Codex's image_gen on the user's ChatGPT plan, or the images API.
 *
 * Painting is off per project until switched on in Settings (web only) and
 * counts against a quota; crop and frame extraction are not painting and are
 * not gated. Every result is an ordinary asset with what was asked in its
 * meta, attached where it was meant to go, and reviewable as a "frame".
 */

/* ---------- the switch ---------- */

export const DEFAULT_IMAGING: Omit<Imaging, "grantedBy" | "grantedAt"> = { enabled: false, backend: "codex", maxImages: 40, usedImages: 0, quality: "low" };

export async function setImaging(projectId: string, input: { enabled: boolean; backend?: Imaging["backend"]; maxImages?: number; quality?: Imaging["quality"]; clearStop?: boolean }, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "GPT Image is switched on in Settings, on the web only");
  const project = await repo.getProject(projectId);
  const cur = project.imaging ?? { ...DEFAULT_IMAGING, grantedBy: actor.user, grantedAt: Date.now() };
  const next: Imaging = {
    ...cur,
    enabled: input.enabled,
    backend: input.backend ?? cur.backend,
    maxImages: input.maxImages ?? cur.maxImages,
    quality: input.quality ?? cur.quality,
    grantedBy: actor.user,
    grantedAt: input.enabled && !cur.enabled ? Date.now() : cur.grantedAt,
    ...(input.clearStop || (input.enabled && !cur.enabled) ? { stoppedReason: undefined } : {}),
  };
  const updated = await repo.setImaging(projectId, next);
  if (cur.enabled !== next.enabled || cur.backend !== next.backend) {
    await repo.insertNote(projectId, "decision", "standing", { decision: next.enabled ? `GPT Image on (${next.backend}, up to ${next.maxImages} images)` : "GPT Image off", why: "", by: actor.user, confidence: "user" });
  }
  return updated;
}

export function imagingSummary(project: Project) {
  const i = project.imaging;
  const backendReady = !i ? false : i.backend === "api" ? Boolean(process.env.OPENAI_API_KEY) : true;
  return {
    enabled: !!i?.enabled, backend: i?.backend ?? "codex", maxImages: i?.maxImages ?? DEFAULT_IMAGING.maxImages, usedImages: i?.usedImages ?? 0,
    leftImages: Math.max(0, (i?.maxImages ?? DEFAULT_IMAGING.maxImages) - (i?.usedImages ?? 0)), quality: i?.quality ?? "low",
    stoppedReason: i?.stoppedReason, backendReady,
    note: i?.backend === "api" && !backendReady ? "OPENAI_API_KEY is not set on the Worker" : i?.backend === "codex" ? "Codex must be logged in on the pod (Machine page)" : undefined,
  };
}

async function assertCanPaint(project: Project): Promise<void> {
  const i = project.imaging;
  if (!i?.enabled) throw new StudioError("forbidden", "GPT Image is off for this project: the user switches it on in Settings → Director → GPT Image (web only)", { imaging: false });
  if (i.stoppedReason) throw new StudioError("forbidden", `GPT Image stopped: ${i.stoppedReason}. The user clears it in Settings once the quota is back.`, { imaging: "stopped" });
  const active = (await repo.listProjectJobs(project.id, 200)).filter((j) => j.kind === "image" && (j.status === "queued" || j.status === "running") && j.input.op === "paint").length;
  if (i.usedImages + active >= i.maxImages) throw new StudioError("budget_exceeded", `the image quota of this project is used (${i.usedImages} done + ${active} running of ${i.maxImages}); the user raises it in Settings`, { imaging: "quota" });
  if (i.backend === "api" && !process.env.OPENAI_API_KEY) throw new StudioError("backend_error", "GPT Image is set to the API backend but OPENAI_API_KEY is not set on the Worker");
}

/* ---------- jobs ---------- */

export type ImageOp = "paint" | "crop" | "extract";
export type ImagePurpose = "element_sheet" | "shot_first" | "shot_last" | "edit" | "remake_key" | "style_frame" | "crop" | "extract";
export type Attach = { heroOf?: string; endOf?: string; elementRef?: { elementId: string; view?: RefView }; styleFrame?: boolean };
type Box = { x: number; y: number; w: number; h: number };

export type ImageRequest = {
  op: ImageOp;
  purpose: ImagePurpose;
  prompt?: string;
  refUrls?: string[];
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
};

/** Queue an image job on the pod. Painting is gated by the project switch
    and quota; crop and extract are not. Starts the pod when asked. */
export async function submitImage(projectId: string, req: ImageRequest, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; pod: string }> {
  const project = await repo.getProject(projectId);
  if (config.runpodMode() !== "pod") throw new StudioError("backend_error", "image jobs run on the GPU pod (RUNPOD_MODE=pod)");
  if (req.op === "paint") await assertCanPaint(project);
  const backend = project.imaging?.backend ?? "codex";
  const job = await repo.createJob({
    projectId, kind: "image", targetId: req.targetId, backend: req.op === "paint" ? `pod-${backend}` : "pod",
    input: { ...req, backend, quality: req.quality ?? project.imaging?.quality ?? "low", by: actor.via === "mcp" ? "agent" : actor.user },
  });
  let podState = "unknown";
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running") {
    if (opts.startPod) {
      const state = await gpu.startGpu(actor, true);
      podState = state.status;
      if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true });
    } else {
      podState = pod?.status ?? "none";
      return { job, pod: `${podState}: the job waits until the pod runs (start it, or pass startPod)` };
    }
  }
  return { job: await submitImageJob(job), pod: podState === "unknown" ? "running" : podState };
}

/** Hand a queued image job to the pod (again from the sweep when the pod was not up). */
export async function submitImageJob(job: Job): Promise<Job> {
  if (job.status !== "queued" || job.requestId) return job;
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running" || !pod.hostUrl) return job;
  const i = job.input as unknown as ImageRequest & { backend: string; quality: string };
  const input: Record<string, unknown> = {
    op: i.op, size: i.size, output: { key: `projects/${job.projectId}/images/${job.id}.png` }, studio_job_id: job.id,
    ...(i.op === "paint" ? { backend: i.backend, prompt: i.prompt, refs: i.refUrls ?? [], base: i.baseUrl, region: i.region, quality: i.quality } : {}),
    ...(i.op === "crop" ? { base: i.baseUrl, crop: i.crop } : {}),
    ...(i.op === "extract" ? { video: i.videoUrl, frame: i.frame } : {}),
  };
  try {
    const webhook = await signHookUrl(config.publicUrl(), "/api/runpod/hook", config.runpod().webhookSecret, `image:${job.id}`);
    const { requestId } = await gpu.podBackend(pod, "paint").submit(input, { webhook });
    await gpu.touchGpuActivity();
    return await repo.updateJob(job.id, { requestId, status: "running" });
  } catch (caught) {
    const unreachable = caught instanceof StudioError && Boolean((caught.details as { unreachable?: boolean } | undefined)?.unreachable);
    if (unreachable) return job;
    return repo.updateJob(job.id, { status: "failed", error: caught instanceof Error ? caught.message : String(caught), finishedAt: Date.now() });
  }
}

export async function refreshImageJob(jobId: string): Promise<Job> {
  const job = await repo.getJob(jobId);
  if (job.status === "completed" || job.status === "failed") return job;
  if (!job.requestId) return submitImageJob(job);
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running" || !pod.hostUrl) return job;
  try {
    return applyImageStatus(job, await gpu.podBackend(pod, "paint").status(job.requestId));
  } catch {
    return job;
  }
}

/** What the pod answered: an asset, attached where it was meant to go. */
export async function applyImageStatus(job: Job, status: BackendStatus): Promise<Job> {
  if (job.status === "completed" || job.status === "failed") return job;
  const i = job.input as unknown as ImageRequest & { backend?: string; by?: string };
  if (status.state === "queued" || status.state === "running") return job.status === "running" ? job : repo.updateJob(job.id, { status: "running" });
  if (status.state !== "completed") {
    const error = status.state === "failed" ? status.error : status.state;
    if (/^quota:/i.test(error)) {
      const project = await repo.getProject(job.projectId);
      if (project.imaging) await repo.setImaging(project.id, { ...project.imaging, stoppedReason: error.slice(0, 300) });
      await repo.insertNote(job.projectId, "decision", "standing", { decision: "GPT Image stopped: out of image quota", why: error.slice(0, 300), by: "studio", confidence: "system" });
    }
    return repo.updateJob(job.id, { status: "failed", error, finishedAt: Date.now() });
  }
  const out = status.output;
  const url = typeof out.url === "string" ? out.url : undefined;
  if (!url) return repo.updateJob(job.id, { status: "failed", error: "the pod answered without a picture", finishedAt: Date.now() });
  const asset = await repo.createAsset({
    projectId: job.projectId, url, kind: "image", source: i.op === "extract" ? "frame-extract" : "generated",
    width: typeof out.width === "number" ? out.width : undefined, height: typeof out.height === "number" ? out.height : undefined,
    meta: {
      key: `projects/${job.projectId}/images/${job.id}.png`, jobId: job.id, purpose: i.purpose, op: i.op, prompt: i.prompt, backend: i.backend,
      previewUrl: out.preview_url, diffUrl: out.diff_url, baseAssetId: i.baseAssetId, region: i.region, crop: i.crop, takeId: i.takeId, frame: i.frame,
      view: i.attach?.elementRef?.view, label: i.label, review: i.op === "paint" ? "pending" : undefined,
    },
  });
  if (i.op === "paint") await repo.bumpImagesUsed(job.projectId);
  await attach(job.projectId, asset, i.attach);
  return repo.updateJob(job.id, { status: "completed", assetIds: [asset.id], output: out, finishedAt: Date.now() });
}

async function attach(projectId: string, asset: Asset, a?: Attach): Promise<void> {
  if (!a) return;
  if (a.heroOf) await repo.updateShot(a.heroOf, { heroAssetId: asset.id });
  if (a.endOf) await repo.updateShot(a.endOf, { endAssetId: asset.id });
  if (a.elementRef) {
    const el = await repo.getElement(a.elementRef.elementId);
    await repo.updateElement(el.id, { refAssetIds: [...el.refAssetIds.filter((x) => x !== asset.id), asset.id].slice(-6), ...(a.elementRef.view ? { refViews: { [asset.id]: a.elementRef.view } } : {}) });
  }
  if (a.styleFrame) {
    const p = await repo.getProject(projectId);
    await repo.setProjectLook(projectId, { ...p.look, styleFrameAssetId: asset.id });
  }
}

/* ---------- prompts ---------- */

const NO_TEXT = "No text, no lettering, no watermark, no borders, no captions.";
const BACKDROP = "Plain light-grey studio background, soft even lighting, nothing else in the picture.";

export const VIEW_TEXT: Record<RefView, string> = {
  front: "full-body front view, standing straight, arms relaxed at the sides, facing the camera, the whole figure from head to feet",
  three_quarter: "full-body three-quarter view, body turned 45 degrees to frame left, head to feet",
  side: "full-body side view in strict profile, facing frame left, head to feet",
  back: "full-body back view, facing away from the camera, head to feet",
  full_body: "full-body front view in a natural relaxed pose, head to feet",
  expression: "head and shoulders, a 2x2 grid of the same face with four expressions: neutral, happy, surprised, worried",
  detail: "close detail of the most distinctive part: face, hands or the object's key feature",
};

function styleLine(look: Project["look"]): string {
  const s = look.style ? director.findStyle(look.style)?.style : undefined;
  const parts = [look.genre, look.palette, look.lighting, s ? `${s.en}: ${s.line}` : ""].map((x) => x?.trim()).filter(Boolean);
  return parts.length ? `Visual style: ${parts.join(". ")}.` : "";
}

function features(el: Element): string {
  return el.fixedFeatures?.length ? ` Always: ${el.fixedFeatures.map((f) => `${f.feature} on the ${f.where}`).join("; ")} — on exactly that side.` : "";
}

/** One view of an element's sheet. */
export function elementViewPrompt(el: Element, view: RefView, look: Project["look"], opts: { hasIdentityRef: boolean; hasStyleRef: boolean }): string {
  const who = `${el.name}: ${el.description || "(no description yet)"}.${features(el)}`;
  const ident = opts.hasIdentityRef ? " The character is exactly the one in the first reference picture: same face, hair, build, clothes and colours." : "";
  const styled = opts.hasStyleRef ? " Match the rendering of the last reference picture (the film's style frame)." : "";
  if (el.kind === "location") return `A wide establishing view of a place, empty of people, at eye level. ${who}${styled} ${styleLine(look)} ${NO_TEXT}`.trim();
  if (el.kind === "prop") return `A single object, centred, in three-quarter view, life-size detail. ${who}${ident}${styled} ${BACKDROP} ${styleLine(look)} ${NO_TEXT}`.trim();
  return `Character reference sheet, ${VIEW_TEXT[view]}. ${who}${ident}${styled} ${BACKDROP} ${styleLine(look)} ${NO_TEXT}`.trim();
}

const POS_WORD: Record<string, string> = { off_left: "just outside frame left", left: "on the left of the frame", center: "in the centre", right: "on the right of the frame", off_right: "just outside frame right", foreground: "in the foreground", background: "in the background" };
const X_WORD = { left: "on the left third (about 38% from the left)", center: "on the centre line", right: "on the right third (about 62% from the left)" } as const;

/** A first or last frame of a shot, drawn from its structured fields. */
export function shotFramePrompt(sh: ShotView, which: "first" | "last", ctx: { elements: Map<string, Element>; palette?: { colors: string[]; note?: string }; look: Project["look"]; refNames: string[] }): string {
  const spec = sh.spec;
  const name = (id: string) => ctx.elements.get(id)?.name ?? id;
  const describe = which === "first"
    ? spec.frames?.first ?? `The moment the shot begins: ${spec.beats[0]?.action ?? spec.intent}`
    : spec.frames?.last ?? `The moment the shot ends: ${spec.beats[spec.beats.length - 1]?.action ?? spec.intent}`;
  const staging = (spec.blocking ?? []).map((b) => {
    const pos = which === "first" ? b.from : b.to;
    return pos && !pos.startsWith("off_") ? `${name(b.who)} is ${POS_WORD[pos]}` : pos?.startsWith("off_") ? `${name(b.who)} is not in the frame yet (they enter later)` : "";
  }).filter(Boolean);
  const cine = renderCinematography(spec.cinematography).block?.split("\n").slice(1).join(" ") ?? "";
  const comp = spec.composition ? `Composition: the subject's eyes ${X_WORD[spec.composition.subjectX]}${spec.composition.headroom ? `, ${spec.composition.headroom} headroom` : ""}.` : "";
  const pal = ctx.palette ? `Colour palette: ${ctx.palette.colors.join(", ")}${ctx.palette.note ? ` (${ctx.palette.note})` : ""}.` : "";
  const cast = ctx.refNames.length ? `Reference pictures, in order: ${ctx.refNames.map((n, k) => `${k + 1} = ${n}`).join(", ")}. Each person and thing looks exactly as in its reference.` : "";
  const fixed = [...spec.characters, ...spec.props].map((id) => ctx.elements.get(id)).filter((e): e is Element => !!e && !!e.fixedFeatures?.length).map((e) => `${e.name} has ${e.fixedFeatures!.map((f) => `${f.feature} on the ${f.where}`).join(" and ")}.`).join(" ");
  return [`A single still frame from a film: the ${which} frame of the shot "${spec.intent}".`, describe, staging.join(". ") + (staging.length ? "." : ""), cine, comp, pal, fixed, cast, styleLine(ctx.look), "Every person in a different pose; leave room where things will move.", NO_TEXT].filter((x) => x && x.trim()).join(" ");
}

/** Edit an existing frame (the Viggle Remake recipe: change only what is asked). */
export function editPrompt(instruction: string, opts: { refsFirst?: number } = {}): string {
  const lead = opts.refsFirst ? Array.from({ length: opts.refsFirst }, (_, k) => `Image ${k + 1} is a reference picture of what the edit brings into the frame. `).join("") : "";
  return `${lead}The last image is a frame from a film. Edit it: ${instruction.trim()} Change nothing else: every person keeps exactly the same face, hair, body, clothes, pose, hands and position; the same background, lighting, colours, camera framing, composition and image grain. The same picture with only that edit. ${NO_TEXT}`;
}

export function stylePrompt(project: Project): string {
  return `A single still frame that sets the look of a short film. The film: ${project.brief.slice(0, 600) || project.name}. ${styleLine(project.look)} A representative moment with its main setting, at the film's colours, light and rendering. ${NO_TEXT}`;
}

/* ---------- which picture comes from where ---------- */

export type FrameMethod = "none" | "sheets" | "anchor" | "edit_anchor" | "new" | "edit_from_last" | "edit_from_previous" | "crop_from_first" | "crop_from_last";
export type FramePlanRow = { shotId: string; label: string; mode: string; link: string; first: FrameMethod | null; last: FrameMethod | null; have: { first: boolean; last: boolean }; previousShotId?: string; why: string; order: number; paints: number };

const CHEAP: Record<FrameMethod, number> = { none: 0, sheets: 0, anchor: 0, crop_from_first: 0, crop_from_last: 0, edit_anchor: 1, edit_from_previous: 1, edit_from_last: 1, new: 1 };

/**
 * The director's picture plan: for every shot, where its first and last
 * frame come from, cheapest first — reuse a frame the edit already has, crop,
 * edit a related frame, and only then draw a new one.
 */
export function planFrames(view: ProjectView): { shots: FramePlanRow[]; elements: Array<{ elementId: string; name: string; kind: string; views: RefView[]; why: string }> } {
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
      const set = needed.get(id) ?? new Set<RefView>(["front"]);
      for (const v of preferredViews(sh.spec).slice(0, 1)) set.add(v);
      needed.set(id, set);
    }
    for (const id of [...sh.spec.props, ...(sh.spec.location ? [sh.spec.location] : [])]) needed.set(id, needed.get(id) ?? new Set<RefView>(["front"]));
  }
  const elements = [...needed].flatMap(([id, views]) => {
    const el = view.elements.find((e) => e.id === id);
    if (!el) return [];
    const have = new Set(Object.values(el.refViews ?? {}));
    const missing = el.kind === "character" ? [...views].filter((v) => !have.has(v)) : el.refAssetIds.length ? [] : (["front"] as RefView[]);
    return missing.length ? [{ elementId: id, name: el.name, kind: el.kind, views: missing, why: el.refAssetIds.length ? "views the shots need are missing" : "no reference picture yet" }] : [];
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

/** One element view (front first: later views take it as the identity reference). */
export async function generateElementView(elementId: string, view: RefView, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ job: Job; pod: string; prompt: string }> {
  const el = await repo.getElement(elementId);
  if (!el.projectId) throw new StudioError("validation", "library elements are drawn inside a project (import it first)");
  const pv = await getProjectView(el.projectId);
  const identity = el.refAssetIds.length ? pickRefForViews(el, ["front", "three_quarter", "full_body"]) : undefined;
  const refs = [assetUrl(pv, identity), assetUrl(pv, pv.project.look.styleFrameAssetId)].filter((u): u is string => !!u);
  const prompt = elementViewPrompt(el, view, pv.project.look, { hasIdentityRef: !!identity, hasStyleRef: !!pv.project.look.styleFrameAssetId });
  const size = el.kind === "location" ? sizeFor(pv.project.look) : el.kind === "prop" || view === "expression" ? "1024x1024" : "1008x1344";
  const r = await submitImage(el.projectId, { op: "paint", purpose: "element_sheet", prompt, refUrls: refs, size, quality: opts.quality, targetId: el.id, attach: { elementRef: { elementId: el.id, view } }, label: `${el.name} · ${view}` }, actor, opts);
  return { ...r, prompt };
}

/** The views a sheet needs, front first; with no picture yet only the front is queued (the others need it as identity). */
export async function generateElementSheet(elementId: string, views: RefView[], actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ queued: Array<{ view: RefView; jobId: string }>; later: RefView[]; note?: string }> {
  const el = await repo.getElement(elementId);
  const wanted = [...new Set(views.length ? views : (["front", "side", "back", "expression"] as RefView[]))];
  const hasIdentity = el.refAssetIds.length > 0;
  const now = hasIdentity ? wanted : wanted.includes("front") ? (["front"] as RefView[]) : [wanted[0]!];
  const queued: Array<{ view: RefView; jobId: string }> = [];
  for (const v of now) queued.push({ view: v, jobId: (await generateElementView(elementId, v, actor, opts)).job.id });
  const later = wanted.filter((v) => !now.includes(v));
  return { queued, later, ...(later.length ? { note: `queue ${later.join(", ")} once the ${now[0]} view is in: they take it as the identity reference` } : {}) };
}

/** A first or last frame of a shot, by the plan's method unless one is given. */
export async function generateShotFrame(shotId: string, which: "first" | "last", actor: Actor, opts: { method?: FrameMethod; quality?: Imaging["quality"]; startPod?: boolean; zoom?: number; instruction?: string } = {}): Promise<{ job?: Job; pod?: string; method: FrameMethod; prompt?: string; note?: string }> {
  const shot = await repo.getShot(shotId);
  const pv = await getProjectView(shot.projectId);
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
  const refs: Array<{ url: string; name: string }> = [];
  const wanted = preferredViews(sh.spec);
  for (const id of sh.spec.characters) {
    const el = elements.get(id);
    const ref = el ? assetUrl(pv, pickRefForViews(el, wanted)) : undefined;
    if (ref && el) refs.push({ url: ref, name: el.name });
  }
  const loc = elements.get(sh.spec.location ?? scene.locationElementId ?? "");
  const locRef = loc ? assetUrl(pv, loc.refAssetIds[0]) : undefined;
  if (locRef && loc) refs.push({ url: locRef, name: `${loc.name} (the setting)` });
  const style = assetUrl(pv, pv.project.look.styleFrameAssetId);
  if (style) refs.push({ url: style, name: "the film's style frame (match its rendering)" });
  if (method === "new") {
    const use = refs.slice(0, 5);
    const prompt = shotFramePrompt(sh, which, { elements, palette: scene.palette, look: pv.project.look, refNames: use.map((r) => r.name) });
    const r = await submitImage(pv.project.id, { op: "paint", purpose: which === "first" ? "shot_first" : "shot_last", prompt, refUrls: use.map((x) => x.url), size, quality: opts.quality, targetId: shotId, attach, label }, actor, opts);
    return { ...r, method, prompt };
  }
  /* edits of a related frame: the base goes last */
  let base: Asset | undefined;
  let instruction = opts.instruction ?? "";
  if (method === "edit_from_last") {
    base = sh.end;
    instruction ||= `make it the moment the shot begins: ${sh.spec.frames?.first ?? sh.spec.beats[0]?.action ?? sh.spec.intent}. Only positions, poses, expressions and what is in hand change.`;
  } else if (method === "edit_from_previous") {
    base = flat.find((x) => x.id === row.previousShotId)?.hero;
    instruction ||= `make it this shot's ${which} frame: ${which === "first" ? sh.spec.frames?.first ?? sh.spec.beats[0]?.action : sh.spec.frames?.last ?? sh.spec.beats[sh.spec.beats.length - 1]?.action}. Same place, same camera.`;
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
  if (!base) throw new StudioError("validation", `${method}: the frame to edit from does not exist yet (${method === "edit_from_last" ? "draw the last frame first" : method === "edit_anchor" ? "the anchor shot needs a finished take" : "the earlier shot has no first frame"})`);
  const extra = refs.filter((r) => !r.name.startsWith("the film's style")).slice(0, 4);
  const prompt = editPrompt(instruction, { refsFirst: extra.length });
  const r = await submitImage(pv.project.id, { op: "paint", purpose: which === "first" ? "shot_first" : "shot_last", prompt, refUrls: extra.map((x) => x.url), baseUrl: base.url, baseAssetId: base.id || undefined, size, quality: opts.quality, targetId: shotId, attach, label }, actor, opts);
  return { ...r, method, prompt };
}

/** Edit a region of any project picture; only the box changes. */
export async function editFrame(assetId: string, input: { instruction: string; region?: Box; refAssetIds?: string[]; attach?: Attach; purpose?: ImagePurpose; quality?: Imaging["quality"]; startPod?: boolean }, actor: Actor): Promise<{ job: Job; pod: string; prompt: string }> {
  const asset = await repo.getAsset(assetId);
  if (!asset.projectId || asset.kind !== "image") throw new StudioError("validation", "edit a project image");
  const pv = await getProjectView(asset.projectId);
  const refs = (input.refAssetIds ?? []).map((id) => assetUrl(pv, id)).filter((u): u is string => !!u).slice(0, 4);
  const prompt = editPrompt(input.instruction, { refsFirst: refs.length });
  const size = asset.width && asset.height ? `${asset.width}x${asset.height}` : sizeFor(pv.project.look);
  const takeId = typeof asset.meta.takeId === "string" ? asset.meta.takeId : undefined;
  const frame = typeof asset.meta.frame === "number" ? asset.meta.frame : undefined;
  const r = await submitImage(asset.projectId, { op: "paint", purpose: input.purpose ?? "edit", prompt, refUrls: refs, baseUrl: asset.url, baseAssetId: asset.id, region: input.region, size, quality: input.quality, targetId: takeId ?? asset.id, takeId, frame, attach: input.attach, label: `edit · ${input.instruction.slice(0, 40)}` }, actor, input);
  return { ...r, prompt };
}

/** One exact frame of a take, as a project picture (the frame a Remake keyframe repaints). */
export async function extractTakeFrame(takeId: string, frame: number, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; pod: string }> {
  const take = await repo.getTake(takeId);
  if (take.status !== "completed" || !take.resultUrl) throw new StudioError("validation", "extract from a completed take");
  const pv = await getProjectView(take.projectId);
  return submitImage(take.projectId, { op: "extract", purpose: "extract", videoUrl: take.resultUrl, frame, takeId, size: sizeFor(pv.project.look), targetId: take.id, label: `take #${take.n} · f${frame}` }, actor, opts);
}

/** The frame that sets the film's look; once approved it is a reference for every sheet and frame. */
export async function generateStyleFrame(projectId: string, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ job: Job; pod: string; prompt: string }> {
  const project = await repo.getProject(projectId);
  const prompt = stylePrompt(project);
  const r = await submitImage(projectId, { op: "paint", purpose: "style_frame", prompt, size: sizeFor(project.look), quality: opts.quality ?? "medium", targetId: projectId, label: "style frame" }, actor, opts);
  return { ...r, prompt };
}

export async function listImageJobs(projectId: string): Promise<Job[]> {
  return (await repo.listProjectJobs(projectId, 60)).filter((j) => j.kind === "image");
}

/** Sweep: submit image jobs waiting for the pod, refresh the running ones. */
export async function sweepImageJobs(): Promise<number> {
  const jobs = (await repo.listActiveJobs()).filter((j) => j.kind === "image");
  let changed = 0;
  for (const job of jobs.slice(0, 30)) {
    if (Date.now() - job.createdAt > 3 * 60 * 60_000) {
      await repo.updateJob(job.id, { status: "failed", error: "no answer from the pod within 3 hours", finishedAt: Date.now() });
      changed++;
      continue;
    }
    const after = await refreshImageJob(job.id);
    if (after.status !== job.status) changed++;
  }
  return changed;
}

export { mapRunPodStatus };
