import * as director from "@/director";

import type { BackendStatus } from "./backends/types";
import { renderCinematography } from "./cinematography";
import { effectiveLink, pickRefForViews, preferredViews, VIDEO_SIZES } from "./compiler";
import { config } from "./config";
import { StudioError } from "./errors";
import * as gpu from "./gpu";
import { getProjectView, type ProjectView, type ShotView } from "./orchestrator";
import * as painter from "./painter";
import * as repo from "./repo";
import type { RefView } from "./schemas";
import type { InferenceParams } from "./models";
import type { Actor, Asset, Element, Imaging, Job, Project } from "./types";

/*
 * GPT Image in the Studio: character sheets, first and last frames, region
 * edits, style frames and the painted keyframes Viggle Remake reads. One
 * image job type, queued here and drawn by a painter away from the GPU
 * (painter.ts, workers/painter): Codex's image_gen on the user's ChatGPT
 * plan, or the images API. Pictures are ready before the GPU pod starts.
 *
 * Painting is off per project until switched on in Settings (web only) and
 * counts against a quota; crop and frame extraction are not painting and are
 * not gated. Every result is an ordinary asset with what was asked in its
 * meta, attached where it was meant to go, and reviewable as a "frame".
 */

/* ---------- the switch ---------- */

export const DEFAULT_IMAGING: Omit<Imaging, "grantedBy" | "grantedAt"> = { enabled: false, backend: "codex", maxImages: 100, usedImages: 0, quality: "low", selfCheck: true, autoRedraws: 1 };

export async function setImaging(projectId: string, input: { enabled: boolean; backend?: Imaging["backend"]; maxImages?: number; quality?: Imaging["quality"]; selfCheck?: boolean; autoRedraws?: number; clearStop?: boolean }, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "GPT Image is switched on in Settings, on the web only");
  const project = await repo.getProject(projectId);
  const cur = project.imaging ?? { ...DEFAULT_IMAGING, grantedBy: actor.user, grantedAt: Date.now() };
  const next: Imaging = {
    ...cur,
    enabled: input.enabled,
    backend: input.backend ?? cur.backend,
    maxImages: input.maxImages ?? cur.maxImages,
    quality: input.quality ?? cur.quality,
    selfCheck: input.selfCheck ?? cur.selfCheck ?? true,
    autoRedraws: Math.max(0, Math.min(2, input.autoRedraws ?? cur.autoRedraws ?? 1)),
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
  /* whether a painter can serve the backend right now is in runnerSummary (image_status, the button answers) */
  const backendReady = !!i;
  return {
    enabled: !!i?.enabled, backend: i?.backend ?? "codex", maxImages: i?.maxImages ?? DEFAULT_IMAGING.maxImages, usedImages: i?.usedImages ?? 0,
    leftImages: Math.max(0, (i?.maxImages ?? DEFAULT_IMAGING.maxImages) - (i?.usedImages ?? 0)), quality: i?.quality ?? "low",
    selfCheck: i?.selfCheck ?? true, autoRedraws: i?.autoRedraws ?? 1,
    stoppedReason: i?.stoppedReason, backendReady,
    note: i?.backend === "api" ? "the painter needs OPENAI_API_KEY (paid per picture)" : i?.backend === "codex" ? "Codex must be logged in on a painter (Machine page → Painters)" : undefined,
  };
}

/** Throws unless the project may paint; answers how many pictures are left after the running ones. */
async function assertCanPaint(project: Project): Promise<number> {
  const i = project.imaging;
  if (!i?.enabled) throw new StudioError("forbidden", "GPT Image is off for this project: the user switches it on in Settings → Director → GPT Image (web only)", { imaging: false });
  if (i.stoppedReason) throw new StudioError("forbidden", `GPT Image stopped: ${i.stoppedReason}. The user clears it in Settings once the quota is back.`, { imaging: "stopped" });
  const active = (await repo.listProjectJobs(project.id, 200)).filter((j) => j.kind === "image" && (j.status === "queued" || j.status === "running") && j.input.op === "paint").length;
  if (i.usedImages + active >= i.maxImages) throw new StudioError("budget_exceeded", `the image quota of this project is used (${i.usedImages} done + ${active} running of ${i.maxImages}); the user raises it in Settings`, { imaging: "quota" });
  return i.maxImages - i.usedImages - active;
}

/* ---------- jobs ---------- */

export type ImageOp = "paint" | "crop" | "extract";
export type ImagePurpose = "element_sheet" | "shot_first" | "shot_last" | "edit" | "remake_key" | "style_frame" | "canvas" | "crop" | "extract";
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
  /** Canvas pictures: the recipe they were composed from (references, style), kept on the asset. */
  canvas?: Record<string, unknown>;
  /** A model other than the project's GPT Image backend (models.ts): its painter backend and settings. */
  model?: string;
  backend?: string;
  params?: InferenceParams;
};

/** Queue an image job for the painters. Painting is gated by the project
    switch and quota; crop and extract are not. Nothing here needs the GPU:
    with no painter online and startPod, the GPU pod is started as the
    fallback painter. */
export async function submitImage(projectId: string, req: ImageRequest, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary }> {
  const project = await repo.getProject(projectId);
  const left = req.op === "paint" ? await assertCanPaint(project) : 0;
  const backend = req.backend ?? project.imaging?.backend ?? "codex";
  const podModel = backend.startsWith("comfy:");
  /* the painter checks its own picture (a fresh Codex session, rubric as JSON) and may redraw a blocker, inside the quota;
     not a pod model's picture: the review would send it to OpenAI, whose moderation the model was picked to avoid */
  const check = req.op === "paint" ? { review: podModel ? false : project.imaging?.selfCheck ?? true, redraws: Math.max(0, Math.min(project.imaging?.autoRedraws ?? 1, left - 1)), kind: req.purpose } : undefined;
  const job = await repo.createJob({
    projectId, kind: "image", targetId: req.targetId, backend: req.op === "paint" ? `painter-${backend}` : "painter",
    input: { ...req, backend, quality: req.quality ?? project.imaging?.quality ?? "low", by: actor.via === "mcp" ? "agent" : actor.user, ...(check ? { check } : {}) },
  });
  const summary = await painter.runnerSummary(req.op, backend);
  if (summary.ready) return { job, runner: `queued; ${summary.drawers.join(" / ")} draws it`, painters: summary };
  if (podModel) {
    /* only the GPU pod draws it: start the pod when asked to, else say so */
    if (opts.startPod && gpu.gpuConfigured()) {
      const state = await gpu.startGpu(actor, true);
      if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true, job: job.id });
      return { job, runner: `queued; the GPU pod is ${state.status}, it draws once its model is loaded (it bills per hour)`, painters: summary };
    }
    return { job, runner: `queued; ${summary.note ?? "waiting for the GPU pod"}`, painters: summary };
  }
  /* nobody can draw it now: wake the painter pod, if the Studio manages one */
  const { wakeForWork } = await import("./painter-pod");
  const woke = await wakeForWork();
  if (woke) return { job, runner: `queued; ${woke}`, painters: { ...summary, note: woke } };
  if (opts.startPod && config.painterOnPod() && gpu.gpuConfigured()) {
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
  if (!url) return repo.updateJob(job.id, { status: "failed", error: "the painter answered without a picture", finishedAt: Date.now() });
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
    const el = await repo.getElement(a.elementRef.elementId);
    await repo.updateElement(el.id, { refAssetIds: [...el.refAssetIds.filter((x) => x !== asset.id), asset.id].slice(-6), ...(a.elementRef.view ? { refViews: { [asset.id]: a.elementRef.view } } : {}) });
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
  front: "full-body front view, standing straight, arms relaxed at the sides, facing the camera, the whole figure from the top of the head to below the feet with a little space around it",
  three_quarter: "full-body three-quarter view, body turned 45 degrees toward frame left, the whole figure from head to feet",
  side: "full-body side view in strict profile, facing frame left, the whole figure from head to feet",
  back: "full-body back view, facing away from the camera, the whole figure from head to feet",
  full_body: "full-body front view in a natural relaxed pose, the whole figure from head to feet",
  expression: "head and shoulders only, a 2x2 grid of the same face with four expressions: neutral, happy, surprised, worried — the same person, light and angle in all four",
  detail: "close detail of the most distinctive part: the face, the hands or the object's key feature, filling the frame",
};

function styleLine(look: Project["look"]): string {
  const s = look.style ? director.findStyle(look.style)?.style : undefined;
  const parts = [look.genre, look.palette, look.lighting, s ? `${s.en}: ${s.line}` : ""].map((x) => x?.trim()).filter(Boolean);
  return parts.length ? parts.join(". ") + "." : "";
}

const section = (label: string, text?: string) => (text && text.trim() ? `${label}: ${text.trim()}` : "");
const join = (parts: string[]) => parts.filter((x) => x && x.trim()).join("\n");

/** "a scar on her LEFT cheek" said so it cannot be mirrored: the person's own side, and where that lands in the picture. */
export function sidedFeature(f: { feature: string; where: string }, facing: "camera" | "away" | "unknown" = "camera"): string {
  const where = f.where.trim();
  const side = /\bleft\b/i.test(where) ? "left" : /\bright\b/i.test(where) ? "right" : undefined;
  if (!side) return `${f.feature} on the ${where}`;
  const lands = facing === "camera" ? ` (the ${side === "left" ? "right" : "left"} side of the picture when they face the camera)` : facing === "away" ? ` (the ${side} side of the picture, as they face away)` : "";
  return `${f.feature} on the ${where} — their OWN ${side}${lands}; never mirrored`;
}

function features(el: Element, facing: "camera" | "away" | "unknown" = "camera"): string {
  return el.fixedFeatures?.length ? `Always: ${el.fixedFeatures.map((f) => sidedFeature(f, facing)).join("; ")}.` : "";
}

const FACING: Partial<Record<RefView, "camera" | "away" | "unknown">> = { front: "camera", full_body: "camera", expression: "camera", back: "away", side: "unknown", three_quarter: "camera", detail: "unknown" };

/** One view of an element's sheet. */
export function elementViewPrompt(el: Element, view: RefView, look: Project["look"], opts: { hasIdentityRef: boolean; hasStyleRef: boolean }): string {
  const refs: string[] = [];
  if (opts.hasIdentityRef) refs.push(`Picture 1 is ${el.name}: copy exactly the face, hair, build, age, clothes, colours and props. Ignore its pose, framing and background.`);
  if (opts.hasStyleRef) refs.push(`Picture ${opts.hasIdentityRef ? 2 : 1} is the film's style frame: copy only its rendering, colour and texture, none of its content.`);
  const who = `${el.name}: ${el.description || "(no description yet)"}`;
  if (el.kind === "location") {
    return join([
      "A single wide establishing picture of a place, at eye level, with no people in it.",
      section("PLACE", who),
      section("REFERENCES", refs.join(" ")),
      section("STYLE", styleLine(look)),
      section("RULES", `The whole place in view, nothing cropped that defines it. ${NO_TEXT}`),
    ]);
  }
  if (el.kind === "prop") {
    return join([
      "A single picture of one object, centred, in three-quarter view, the whole object in frame with space around it.",
      section("OBJECT", `${who} ${features(el, "unknown")}`),
      section("REFERENCES", refs.join(" ")),
      section("BACKDROP", BACKDROP),
      section("STYLE", styleLine(look)),
      section("RULES", `Exactly one object. ${NO_TEXT}`),
    ]);
  }
  return join([
    `A single character picture for a film's casting file: ONE figure, ONE view — ${VIEW_TEXT[view]}.`,
    section("CHARACTER", `${who} ${features(el, FACING[view] ?? "unknown")}`),
    section("REFERENCES", refs.join(" ")),
    section("BACKDROP", BACKDROP),
    section("STYLE", styleLine(look)),
    section("RULES", `Exactly one person${view === "expression" ? " (four times, the same face)" : ""}; not a turnaround, not a multi-view sheet, no second figure. ${ANATOMY} ${NO_TEXT}`),
  ]);
}

const POS_WORD: Record<string, string> = { off_left: "just outside frame left", left: "on the left of the frame", center: "in the centre", right: "on the right of the frame", off_right: "just outside frame right", foreground: "in the foreground", background: "in the background" };
const X_WORD = { left: "on the left third (about 38% from the left)", center: "on the centre line", right: "on the right third (about 62% from the left)" } as const;

export type FrameRef = { name: string; role: "character" | "location" | "style" | "other" };

/** How a reference picture is to be used: copy what it is for, ignore the rest. */
export function refRole(r: FrameRef, n: number): string {
  if (r.role === "character") return `Picture ${n} is ${r.name}: copy exactly their face, hair, build, age, clothes and colours; ignore that picture's pose, framing, plain backdrop and light.`;
  if (r.role === "location") return `Picture ${n} is ${r.name}: the same place — architecture, materials, layout and props — seen from this shot's camera; ignore any people in it.`;
  if (r.role === "style") return `Picture ${n} is the film's style frame: match its rendering, colour grade and texture only, none of its content.`;
  return `Picture ${n} is ${r.name}.`;
}

/** A first or last frame of a shot, drawn from its structured fields. */
export function shotFramePrompt(sh: ShotView, which: "first" | "last", ctx: { elements: Map<string, Element>; palette?: { colors: string[]; note?: string }; look: Project["look"]; refNames?: string[]; refs?: FrameRef[] }): string {
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
  return join([
    `A single still frame from a film: the ${which} frame of the shot "${spec.intent}". Photographed as one moment of the scene, not a poster, not a collage.`,
    section("SCENE", describe),
    section("PEOPLE", count),
    section("STAGING", staging.length ? staging.join(". ") + "." : ""),
    section("CAMERA", cine),
    section("COMPOSITION", comp),
    section("COLOUR", pal),
    section("CONTINUITY", fixed),
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
export async function generateElementView(elementId: string, view: RefView, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
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
export async function generateElementSheet(elementId: string, views: RefView[], actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ queued: Array<{ view: RefView; jobId: string }>; later: RefView[]; note?: string; painters?: painter.RunnerSummary }> {
  const el = await repo.getElement(elementId);
  const wanted = [...new Set(views.length ? views : (["front", "side", "back", "expression"] as RefView[]))];
  const hasIdentity = el.refAssetIds.length > 0;
  const now = hasIdentity ? wanted : wanted.includes("front") ? (["front"] as RefView[]) : [wanted[0]!];
  const queued: Array<{ view: RefView; jobId: string }> = [];
  let painters: painter.RunnerSummary | undefined;
  for (const v of now) {
    const r = await generateElementView(elementId, v, actor, opts);
    queued.push({ view: v, jobId: r.job.id });
    painters = r.painters;
  }
  const later = wanted.filter((v) => !now.includes(v));
  return { queued, later, painters, ...(later.length ? { note: `queue ${later.join(", ")} once the ${now[0]} view is in: they take it as the identity reference` } : {}) };
}

/** A first or last frame of a shot, by the plan's method unless one is given. */
export async function generateShotFrame(shotId: string, which: "first" | "last", actor: Actor, opts: { method?: FrameMethod; quality?: Imaging["quality"]; startPod?: boolean; zoom?: number; instruction?: string; baseAssetId?: string } = {}): Promise<{ job?: Job; runner?: string; painters?: painter.RunnerSummary; method: FrameMethod; prompt?: string; note?: string }> {
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
  const refs: Array<{ url: string; name: string; role: FrameRef["role"] }> = [];
  const wanted = preferredViews(sh.spec);
  for (const id of sh.spec.characters) {
    const el = elements.get(id);
    const ref = el ? assetUrl(pv, pickRefForViews(el, wanted)) : undefined;
    if (ref && el) refs.push({ url: ref, name: el.name, role: "character" });
  }
  const loc = elements.get(sh.spec.location ?? scene.locationElementId ?? "");
  const locRef = loc ? assetUrl(pv, loc.refAssetIds[0]) : undefined;
  if (locRef && loc) refs.push({ url: locRef, name: loc.name, role: "location" });
  const style = assetUrl(pv, pv.project.look.styleFrameAssetId);
  if (style) refs.push({ url: style, name: "the film's style frame", role: "style" });
  if (method === "new") {
    /* at most five pictures: characters first, then the place, the style frame last (dropped first) */
    const use = refs.slice(0, 5);
    const prompt = shotFramePrompt(sh, which, { elements, palette: scene.palette, look: pv.project.look, refs: use });
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
  if (!base) throw new StudioError("validation", `${method}: the frame to edit from does not exist yet (${method === "edit_from_last" ? "draw the last frame first" : method === "edit_anchor" ? "the anchor shot needs a finished take" : "the earlier shot has no first frame"})`);
  const extra = refs.filter((r) => r.role !== "style").slice(0, 4);
  const prompt = editPrompt(instruction, { refsFirst: extra.length });
  const r = await submitImage(pv.project.id, { op: "paint", purpose: which === "first" ? "shot_first" : "shot_last", prompt, refUrls: extra.map((x) => x.url), baseUrl: base.url, baseAssetId: base.id || undefined, size, quality: opts.quality, targetId: shotId, attach, label }, actor, opts);
  return { ...r, method, prompt };
}

/** Edit a region of any project picture; only the box changes. */
export async function editFrame(assetId: string, input: { instruction: string; region?: Box; refAssetIds?: string[]; attach?: Attach; purpose?: ImagePurpose; quality?: Imaging["quality"]; startPod?: boolean }, actor: Actor): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
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
export async function extractTakeFrame(takeId: string, frame: number, actor: Actor, opts: { startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary }> {
  const take = await repo.getTake(takeId);
  if (take.status !== "completed" || !take.resultUrl) throw new StudioError("validation", "extract from a completed take");
  const pv = await getProjectView(take.projectId);
  return submitImage(take.projectId, { op: "extract", purpose: "extract", videoUrl: take.resultUrl, frame, takeId, size: sizeFor(pv.project.look), targetId: take.id, label: `take #${take.n} · f${frame}` }, actor, opts);
}

/** The frame that sets the film's look; once approved it is a reference for every sheet and frame. */
export async function generateStyleFrame(projectId: string, actor: Actor, opts: { quality?: Imaging["quality"]; startPod?: boolean } = {}): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string }> {
  const project = await repo.getProject(projectId);
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
