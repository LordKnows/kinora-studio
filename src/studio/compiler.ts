import { renderCinematography } from "./cinematography";
import { grammarFor, type LinkType } from "./editing";
import { findModel, isGraphDefault, resolveParams, type InferenceParams, type ModelEntry } from "./models";
import { CAMERA_MOVES, type Blocking, type Line, type LookSettings, type PromptExperiments, type RefView, type ScreenPosition, type ShotInput, type ShotLink, type VoiceState } from "./schemas";
import type { Asset, Element, Lora, Scene, Shot, Take } from "./types";

/* §4.2 — the deterministic half of the director. Structured shot fields become
   an H3 prompt in the community-documented format, with the project Look and
   a constraints block on every shot. Templates differ by mode so the text
   never repeats what a frame or a reference image already carries. */

export type Workflow = "T2VA" | "I2VA" | "FL2VA" | "R2VA";

export type WorkerImage = { url: string; role: "first_frame" | "last_frame" | "reference"; label?: string };

export type WorkerLora = { name: string; file: string; strength: number; hf_url?: string; kind: Lora["kind"] };

/** A reference audio for R2VA (`<Audio j>`): the worker trims it to `seconds`
    from its start and feeds it to MiniMaxH3ReferenceToVideo.ref_audios. */
export type WorkerAudio = { url: string; role: "reference"; label?: string; seconds?: number; speaker?: number };

export type WorkerInput = {
  workflow: Workflow;
  prompt: string;
  seconds: number;
  video_size: string;
  images: WorkerImage[];
  /** R2VA voice references (experiments.voiceRefs), at most 3. */
  audios?: WorkerAudio[];
  /** I2VA audio-first (experiments.audioFirst): a prepared line anchored at a frame. */
  guide_audio?: { url: string; frame: number };
  video?: string;
  enhance: boolean;
  steps: number;
  /** Set when no speed LoRA is active: the base chain the handoff measured
      (res_multistep, simple or beta, no sigma shift) instead of the turbo
      chain baked into the graphs (euler/simple, shift 6/3). */
  sampling?: { sampler: string; scheduler: string; shift_video: number; shift_audio: number };
  seed?: number;
  negative: string;
  loras: WorkerLora[];
  studio_take_id?: string;
  output?: { key: string };
};

export type ActiveLora = Lora & { strength: number };

const H3_MODEL = findModel("minimax-h3") as ModelEntry;

export type CompiledJob = { workflow: Workflow; prompt: string; input: WorkerInput; warnings: string[]; effectiveSeconds: number; params: InferenceParams; paramSources: string[] };

/* H3 renders 17k+5 frames at 24 fps (handoff): 5 s → 124 frames (5.17 s),
   10 s → 243 (10.1 s), 15 s → 362 (15.1 s). The worker does the same rounding. */
export function h3Frames(seconds: number): number {
  const k = Math.max(0, Math.round((seconds * 24 - 5) / 17));
  return Math.max(124, Math.min(362, 17 * k + 5));
}
export function h3EffectiveSeconds(seconds: number): number {
  return Math.round((h3Frames(seconds) / 24) * 100) / 100;
}

/** The handoff graphs have no video input wired (ref_videos is unused), so
    edit mode is off until a graph with it is verified. */
export function editModeSupported(): boolean {
  return process.env.H3_EDIT_MODE === "on";
}

export type CompileContext = {
  shot: Shot;
  look: LookSettings;
  elements: Map<string, Element>;
  assets: Map<string, Asset>;
  /** Last frame of the previous shot's selected take (legacy linkToPrev). */
  prevLastFrameUrl?: string;
  /** Last frame of the shot the link anchors to, resolved by the orchestrator. */
  anchorFrameUrl?: string;
  anchorLabel?: string;
  sourceTake?: Take;
  /** Resolved LoRAs (shot override or project default) with final strengths. */
  loras?: ActiveLora[];
  steps?: number;
  seed?: number;
  /** How the sections are serialised for the model; defaults to H3_PROMPT_FORMAT. */
  format?: PromptFormat;
  /** The shot's scene: its colour script compiles into the LOOK line. */
  scene?: Scene;
  /** Prompt A/B switches (take request over project default); all off by default. */
  experiments?: PromptExperiments;
};

/* lightx2v trained the turbo LoRAs on a structured caption: fixed field names,
   <Picture 1> / <Picture 2> for the first / last frame and <Subject N> for
   reference images (handoff §1). "blocks" is the plain sectioned text used
   before the handoff; keep it for A/B tests. */
export type PromptFormat = "lightx2v-json" | "lightx2v-lines" | "blocks";

export function promptFormat(): PromptFormat {
  const v = process.env.H3_PROMPT_FORMAT;
  return v === "blocks" || v === "lightx2v-json" ? v : "lightx2v-lines";
}

export const MAX_REFERENCE_IMAGES = 3;
export const MAX_PROMPT_CHARS = 7000;

/** H3-Base presets per aspect ratio (768p class). */
export const VIDEO_SIZES: Record<LookSettings["aspectRatio"], string> = {
  "16:9": "1344x768",
  "9:16": "768x1344",
  "4:3": "1184x864",
  "3:4": "864x1184",
  "1:1": "1024x1024",
  "21:9": "1536x640",
};

const CAMERA_PHRASE: Record<(typeof CAMERA_MOVES)[number], string> = {
  static: "holds a static, locked-off shot for the entire duration",
  push_in: "pushes in toward the subject",
  pull_out: "pulls out away from the subject",
  pan: "pans across the scene",
  tilt: "tilts",
  truck: "trucks sideways alongside the subject",
  pedestal: "rises on a pedestal move",
  arc: "arcs around the subject",
  tracking: "tracks with the subject",
  handheld: "is handheld with natural micro-movement",
  pov: "is a point-of-view shot",
  roll: "rolls",
  zoom: "zooms",
};

/** The effective link: the explicit Tier-2 link, or the legacy linkToPrev. */
export function effectiveLink(spec: ShotInput): ShotLink {
  if (spec.link) return spec.link;
  return { type: spec.linkToPrev === "continuous" ? "continuous" : "cut" };
}

export function compileShot(ctx: CompileContext): CompiledJob {
  const { shot, look } = ctx;
  const spec = shot.spec;
  const warnings: string[] = [];
  const images: WorkerImage[] = [];
  let workflow: Workflow | undefined;
  let video: string | undefined;

  const hero = shot.heroAssetId ? ctx.assets.get(shot.heroAssetId) : undefined;
  const end = shot.endAssetId ? ctx.assets.get(shot.endAssetId) : undefined;
  const link = effectiveLink(spec);
  const grammar = grammarFor(link.type);
  const anchorFrame = ctx.anchorFrameUrl ?? (link.type === "continuous" ? ctx.prevLastFrameUrl : undefined);

  if (spec.mode === "edit") {
    if (!editModeSupported()) throw new CompileError("edit mode is not available with the current H3 graphs (no video input wired); re-render the shot instead, or set H3_EDIT_MODE=on once a graph with ref_videos is verified");
  } else if (grammar.mechanism === "anchor_first_frame") {
    /* Tier 2 decides the inputs: the anchor's last frame is the first frame. */
    const first = anchorFrame ?? hero?.url;
    if (!first) throw new CompileError(`${grammar.label} needs the anchor shot's finished take (its last frame) or a hero frame as fallback`);
    if (!anchorFrame) warnings.push(`${grammar.label}: the anchor shot has no finished take yet; using this shot's hero frame instead`);
    if (spec.mode === "reference") warnings.push(`${grammar.label} drives the first frame; reference images are not used (H3 cannot combine them)`);
    images.push({ url: first, role: "first_frame" });
    if (link.type === "bridge" && !end) throw new CompileError("bridge needs an end frame on this shot (select-end-frame)");
    if (end) {
      images.push({ url: end.url, role: "last_frame" });
      workflow = "FL2VA";
    } else {
      workflow = "I2VA";
    }
  } else if (grammar.mechanism === "self_loop") {
    /* One period that closes on itself: the hero frame opens and ends the shot. */
    if (!hero) throw new CompileError("loop needs a hero frame: it is both the first and the last frame");
    images.push({ url: hero.url, role: "first_frame" }, { url: hero.url, role: "last_frame" });
    workflow = "FL2VA";
  } else if (grammar.mechanism === "anchor_reference") {
    if (anchorFrame) images.push({ url: anchorFrame, role: "reference", label: "match frame" });
    else warnings.push(`${grammar.label}: the anchor shot has no finished take yet; compiling without the match frame`);
    const refs = pickReferences(ctx, warnings, MAX_REFERENCE_IMAGES - images.length);
    images.push(...refs);
    if (images.length === 0) throw new CompileError("match cut needs the anchor's last frame or at least one reference image");
    workflow = "R2VA";
  } else if (spec.mode === "keyframe") {
    const first = hero?.url;
    if (!first) throw new CompileError("keyframe mode needs a hero frame");
    images.push({ url: first, role: "first_frame" });
    if (end) {
      images.push({ url: end.url, role: "last_frame" });
      workflow = "FL2VA";
    } else {
      workflow = "I2VA";
    }
  } else if (spec.mode === "reference") {
    const refs = pickReferences(ctx, warnings);
    if (refs.length === 0) throw new CompileError("reference mode needs at least one reference image (hero frame or element refs)");
    images.push(...refs);
    workflow = "R2VA";
  }
  if (spec.mode === "edit") {
    if (!ctx.sourceTake?.resultUrl) throw new CompileError("edit mode needs a completed source take");
    video = ctx.sourceTake.resultUrl;
    workflow = "R2VA";
    const refs = pickReferences(ctx, warnings, MAX_REFERENCE_IMAGES - 1);
    images.push(...refs);
  }
  workflow ??= "T2VA";

  const audios = voiceReferences(ctx, workflow, warnings);
  const guide = audioGuide(ctx, workflow, warnings);
  dialogueWarnings(spec, warnings);

  /* only LoRAs trained for H3 load into its graphs (an image model's LoRA in the library is skipped) */
  const loras = (ctx.loras ?? []).filter((l) => (l.baseModel ?? "minimax-h3") === H3_MODEL.family && (l.workflows.length === 0 || l.workflows.includes(workflow)));
  const speed = loras.find((l) => l.kind === "speed");
  const prompt = shot.promptOverride?.trim() || buildPrompt(ctx, images, workflow, loras, link.type, audios);
  if (prompt.length > MAX_PROMPT_CHARS) warnings.push(`prompt is ${prompt.length} chars; H3 caps around ${MAX_PROMPT_CHARS}`);
  /* The settings follow the model and its speed LoRA (models.ts): the turbo
     LoRA's chain is the one the graphs carry (euler/simple, shift 6/3, 8
     steps), so nothing more is sent; without one, the base chain the
     handoff measured (res_multistep, simple or beta, no shift, 20 steps). */
  const h3 = { ...H3_MODEL, params: { ...H3_MODEL.params, steps: Number(process.env.H3_BASE_STEPS ?? H3_MODEL.params.steps) } };
  const resolved = resolveParams(h3, { workflow, loras, steps: ctx.steps });
  warnings.push(...resolved.warnings.map((w) => w.replace(/^MiniMax H3 wants about (\d+) steps/, "no speed LoRA: the base model wants about $1 steps")));
  const p = resolved.params;
  const steps = p.steps ?? 8;
  const sampling = isGraphDefault(h3, p) ? undefined : { sampler: p.sampler ?? "euler", scheduler: p.scheduler ?? "simple", shift_video: p.shiftVideo ?? 1, shift_audio: p.shiftAudio ?? 1 };
  if (!speed && sampling) warnings.push(`no speed LoRA: base sampling chain (${sampling.sampler}/${sampling.scheduler}, no sigma shift), ${steps} steps — about ${Math.round((steps / 8) * 10) / 10}× the turbo render time`);

  const input: WorkerInput = {
    workflow,
    prompt,
    seconds: spec.durationS,
    video_size: VIDEO_SIZES[look.aspectRatio],
    images,
    ...(audios.length ? { audios } : {}),
    ...(guide ? { guide_audio: guide } : {}),
    ...(video ? { video } : {}),
    enhance: spec.mode === "text",
    steps,
    ...(sampling ? { sampling } : {}),
    ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    negative: look.negative.join(", "),
    loras: loras.map((l) => ({ name: l.name, file: l.filename, strength: l.strength, ...(l.hfUrl ? { hf_url: l.hfUrl } : {}), kind: l.kind })),
  };
  const effectiveSeconds = h3EffectiveSeconds(spec.durationS);
  if (Math.abs(effectiveSeconds - spec.durationS) > 0.5) warnings.push(`H3 renders ${effectiveSeconds} s for a ${spec.durationS} s shot (frame grid of 17k+5)`);
  return { workflow, prompt, input, warnings, effectiveSeconds, params: p, paramSources: resolved.sources };
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/* ---------- dialogue and voice ---------- */

/* The H3 prompting guide writes every spoken line as
   `<speaker phrase> (S1) says: <d>[Language] verbatim words</d>`, with a
   stable speaker id and the voice described where the speaker first speaks.
   Only on-screen lines go in: an off-screen or inner line in the prompt makes
   whoever is in frame lip-sync it, so those are synthesised separately. */

const LANGUAGE_TAGS: Record<string, string> = {
  zh: "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", cmn: "Chinese", yue: "Cantonese",
  en: "English", ja: "Japanese", ko: "Korean", fr: "French", de: "German", es: "Spanish", ru: "Russian",
};

/** `[Chinese]`-style tag for a language code; unknown codes are capitalised as given. */
export function languageTag(code: string | undefined): string {
  const k = (code ?? "").trim().toLowerCase();
  if (!k) return "Chinese";
  return LANGUAGE_TAGS[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
}

export function lineLanguage(line: Line, look: LookSettings): string {
  return line.language ?? look.dialogueLanguage ?? "zh";
}

/** The lines H3 voices: on-screen ones (the default kind). */
export function onscreenLines(spec: ShotInput): Line[] {
  return spec.dialogue.filter((l) => (l.kind ?? "onscreen") === "onscreen");
}

/** On-screen speakers in order of their first line: index + 1 is the speaker id (S1, S2…). */
export function onscreenSpeakers(spec: ShotInput): string[] {
  const out: string[] = [];
  for (const l of onscreenLines(spec)) if (!out.includes(l.speaker)) out.push(l.speaker);
  return out;
}

/** The voice-card state a line uses: the named state, else the card's default, else its first. */
export function voiceStateFor(el: Element | undefined, stateId?: string): VoiceState | undefined {
  const v = el?.voice;
  if (!v?.states.length) return undefined;
  return (stateId ? v.states.find((s) => s.id === stateId) : undefined)
    ?? v.states.find((s) => s.id === v.defaultState)
    ?? v.states[0];
}

/* Mandarin runs about 4 characters a second; weak, hoarse or slow delivery about 3. */
const SLOW_DELIVERY = /whisper|weak|hoarse|rasp|slow|faint|breath|嘶哑|气弱|极轻|低声|哭|颤/i;

/** How long a line takes: its time window when given, else an estimate from its length. */
export function lineSeconds(line: Line): number {
  if (line.startS !== undefined && line.endS !== undefined && line.endS > line.startS) return line.endS - line.startS;
  const chars = line.text.replace(/[\s\p{P}]/gu, "").length;
  const latin = /^[\x00-\x7F]*$/.test(line.text);
  const perSecond = latin ? 2.5 /* words */ : SLOW_DELIVERY.test(line.delivery) ? 3 : 4;
  const units = latin ? line.text.trim().split(/\s+/).length : chars;
  return Math.round((units / perSecond) * 10) / 10;
}

/* The [Shot k] segment a moment falls in: one more for every hard cut at or before it. */
function segmentAt(spec: ShotInput, t: number): number {
  return spec.beats.filter((b) => b.cut && b.from <= t + 1e-6).length;
}

function dialogueWarnings(spec: ShotInput, warnings: string[]): void {
  for (const l of spec.dialogue) {
    const quote = l.text.length > 12 ? `${l.text.slice(0, 12)}…` : l.text;
    if (l.startS !== undefined && l.startS >= spec.durationS) warnings.push(`line "${quote}" starts at ${l.startS} s, after the ${spec.durationS} s shot ends`);
    if (l.startS !== undefined && l.endS !== undefined) {
      if (l.endS <= l.startS) warnings.push(`line "${quote}": endS must come after startS`);
      if (segmentAt(spec, l.startS) !== segmentAt(spec, Math.max(l.startS, l.endS - 0.01))) warnings.push(`line "${quote}" runs across a hard cut; a line stays inside one beat (split it at a full stop)`);
      if (l.endS > spec.durationS) warnings.push(`line "${quote}" ends at ${l.endS} s, after the ${spec.durationS} s shot ends`);
    }
  }
  const spoken = onscreenLines(spec).reduce((t, l) => t + lineSeconds(l), 0);
  if (spoken > 0 && spoken + 1 > spec.durationS) warnings.push(`the on-screen lines need about ${Math.round(spoken * 10) / 10} s; with 0.5 s either side they do not fit a ${spec.durationS} s shot`);
}

/** R2VA voice references: one per on-screen speaker (at most 3), cut to about the length of their lines. */
function voiceReferences(ctx: CompileContext, workflow: Workflow, warnings: string[]): WorkerAudio[] {
  const spec = ctx.shot.spec;
  if (!ctx.experiments?.voiceRefs) return [];
  const speakers = onscreenSpeakers(spec);
  if (!speakers.length) return [];
  if (workflow !== "R2VA") {
    warnings.push(`voice references need R2VA (reference mode); this shot renders ${workflow}, so they are left out`);
    return [];
  }
  const out: WorkerAudio[] = [];
  speakers.forEach((id, i) => {
    const el = ctx.elements.get(id);
    const lines = onscreenLines(spec).filter((l) => l.speaker === id);
    const state = voiceStateFor(el, lines[0]?.voiceState);
    const assetId = state?.refAssetIds[0] ?? el?.voiceAssetId;
    const asset = assetId ? ctx.assets.get(assetId) : undefined;
    if (!asset?.url) {
      warnings.push(`${el?.name ?? id} has no reference audio${state ? ` for voice state "${state.id}"` : ""}; the line is voiced from the text alone`);
      return;
    }
    if (out.length >= 3) {
      warnings.push(`${el?.name ?? id}: H3 takes at most 3 reference audios; this speaker gets none`);
      return;
    }
    const need = lines.reduce((t, l) => t + lineSeconds(l), 0) + 1;
    out.push({ url: asset.url, role: "reference", label: el?.name ?? id, seconds: Math.max(2, Math.min(15, Math.round(need * 10) / 10)), speaker: i + 1 });
  });
  const total = out.reduce((t, a) => t + (a.seconds ?? 15), 0);
  if (total > 15) warnings.push(`reference audio totals ${total} s; H3 takes at most 15 s in all, the worker shortens the last ones`);
  return out;
}

/** Audio-first (I2VA): the first on-screen line with prepared audio is anchored at its start frame. */
function audioGuide(ctx: CompileContext, workflow: Workflow, warnings: string[]): { url: string; frame: number } | undefined {
  if (!ctx.experiments?.audioFirst) return undefined;
  const lines = onscreenLines(ctx.shot.spec).filter((l) => l.audioAssetId);
  if (!lines.length) {
    warnings.push("audioFirst is on but no on-screen line has prepared audio (audioAssetId)");
    return undefined;
  }
  if (workflow !== "I2VA") {
    warnings.push(`audioFirst needs I2VA (a first frame, no end frame); this shot renders ${workflow}, so the line's audio is not anchored`);
    return undefined;
  }
  if (lines.length > 1) warnings.push("audioFirst anchors only the first prepared line; the others are voiced by the model");
  const line = lines[0]!;
  const asset = ctx.assets.get(line.audioAssetId!);
  if (!asset?.url) {
    warnings.push(`the prepared audio of "${line.text.slice(0, 12)}" is not in the project's assets`);
    return undefined;
  }
  return { url: asset.url, frame: Math.round((line.startS ?? 0.5) * 24) };
}

/* Reference budget is tight (≈3 images): the hero frame first, then one ref
   per character, then the location, then props. Dropped refs become warnings. */
function pickReferences(ctx: CompileContext, warnings: string[], max = MAX_REFERENCE_IMAGES): WorkerImage[] {
  const { shot } = ctx;
  const out: WorkerImage[] = [];
  const seen = new Set<string>();
  const push = (url: string | undefined, label: string) => {
    if (!url || seen.has(url)) return;
    if (out.length >= max) {
      warnings.push(`reference "${label}" dropped: at most ${max} reference images`);
      return;
    }
    seen.add(url);
    out.push({ url, role: "reference", label });
  };
  const hero = shot.heroAssetId ? ctx.assets.get(shot.heroAssetId) : undefined;
  push(hero?.url, "hero frame");
  const wanted = preferredViews(shot.spec);
  for (const id of shot.spec.characters) {
    const el = ctx.elements.get(id);
    const refId = el ? pickRefForViews(el, wanted) : undefined;
    const ref = refId ? ctx.assets.get(refId) : undefined;
    push(ref?.url, el?.name ?? id);
  }
  if (shot.spec.location) {
    const el = ctx.elements.get(shot.spec.location);
    const ref = el?.refAssetIds[0] ? ctx.assets.get(el.refAssetIds[0]) : undefined;
    push(ref?.url, el?.name ?? shot.spec.location);
  }
  for (const id of shot.spec.props) {
    const el = ctx.elements.get(id);
    const ref = el?.refAssetIds[0] ? ctx.assets.get(el.refAssetIds[0]) : undefined;
    push(ref?.url, el?.name ?? id);
  }
  return out;
}

/* A character's reference images are tagged with the view they show; the
   shot's angle and size decide which one R2VA gets (a profile shot gets the
   side view, a close-up the front or an expression sheet). */
export function preferredViews(spec: ShotInput): RefView[] {
  const c = spec.cinematography ?? {};
  if (c.angle === "profile") return ["side", "three_quarter", "front"];
  const backs = (spec.blocking ?? []).some((b) => /\b(back to (the )?camera|from behind|walks away)\b/i.test(b.note ?? ""));
  if (backs) return ["back", "three_quarter", "full_body"];
  if (c.size === "ecu" || c.size === "cu") return ["expression", "front", "three_quarter"];
  if (c.size === "mcu" || c.size === "ms" || c.size === "ots" || c.size === "twoshot") return ["front", "three_quarter", "full_body"];
  if (c.size === "ls" || c.size === "els" || c.size === "mls") return ["full_body", "front", "three_quarter"];
  return ["front", "three_quarter", "full_body"];
}

export function pickRefForViews(el: Element, wanted: RefView[]): string | undefined {
  const views = el.refViews ?? {};
  for (const v of wanted) {
    const hit = el.refAssetIds.find((a) => views[a] === v);
    if (hit) return hit;
  }
  return el.refAssetIds[0];
}

const SCREEN_WORDS: Record<ScreenPosition, string> = {
  off_left: "outside frame left", left: "frame left", center: "frame centre", right: "frame right",
  off_right: "outside frame right", foreground: "the foreground", background: "the background",
};

/** Blocking in screen terms: "Mia enters from frame left and crosses to frame right." */
export function blockingLine(b: Blocking, name: (id: string) => string): string {
  const side = (p?: ScreenPosition) => (p === "off_left" ? "frame left" : "frame right");
  const parts: string[] = [];
  if (b.from === "off_left" || b.from === "off_right") parts.push(`enters from ${side(b.from)}`);
  else if (b.from) parts.push(`starts at ${SCREEN_WORDS[b.from]}`);
  if (b.to === "off_left" || b.to === "off_right") parts.push(`exits ${side(b.to)}`);
  else if (b.to) parts.push(`${parts.length ? "moves to" : "ends at"} ${SCREEN_WORDS[b.to]}`);
  return `${name(b.who)} ${parts.join(", then ") || "holds position"}${b.note ? ` (${b.note})` : ""}.`;
}

const COMPOSITION_X = { left: "on the left third, about 38% from the left edge", center: "on the centre line, deliberately symmetrical", right: "on the right third, about 62% from the left edge" } as const;

const LINK_LINES: Partial<Record<LinkType, string>> = {
  loop: "Seamless loop: exactly one period of the motion; the last frame is identical to the first so the clip can repeat without a visible seam.",
  continuous: "Continue the previous shot's action and camera from the first frame without a cut.",
  bridge: "One continuous camera move carries the first frame into the final frame.",
  insert_return: "Resume the action exactly where the first frame leaves it, as if no time has passed.",
  reverse: "The reverse angle of the conversation; keep screen direction and eyelines consistent with the first frame.",
  jump_cut: "Jump cut: time has passed since the first frame. Same place and framing; what changed is stated in the beats.",
  match_cut: "Match cut: keep the composition, shapes and motion of Image 1 while the subject and place become what the beats describe.",
};

type Sections = {
  references: string[];
  look: string[];
  intent: string;
  who: string[];
  timeline: string[];
  camera: string;
  cinematography: string[];
  dialogue: string[];
  /** On-screen lines in the official format, each with the [Shot k] segment it belongs to (-1 = the last). */
  spoken: { segment: number; text: string }[];
  /** `<Audio j>` bindings for R2VA: subject_definitions and retention_analysis lines. */
  voiceRefs: { definition: string; retention: string }[];
  sound: { sfx: string; ambience: string; music: string };
  constraints: string[];
  edit?: string;
};

function buildPrompt(ctx: CompileContext, images: WorkerImage[], workflow: Workflow, loras: ActiveLora[] = [], linkType: LinkType = "cut", audios: WorkerAudio[] = []): string {
  const sections = buildSections(ctx, images, workflow, loras, linkType, audios);
  return serializePrompt(sections, workflow, images, ctx.format ?? promptFormat());
}

function buildSections(ctx: CompileContext, images: WorkerImage[], workflow: Workflow, loras: ActiveLora[], linkType: LinkType, audios: WorkerAudio[] = []): Sections {
  const { shot, look } = ctx;
  const spec = shot.spec;
  const blocks: string[] = [];
  const cinema = renderCinematography(spec.cinematography);
  const name = (id: string) => ctx.elements.get(id)?.name ?? id;
  const describe = (id: string) => {
    const el = ctx.elements.get(id);
    return el ? `${el.name}: ${el.description}`.trim() : id;
  };

  /* REFERENCES — only when there are reference images or a source video. */
  const refLines: string[] = [];
  images.filter((i) => i.role === "reference").forEach((img, i) => {
    const el = [...ctx.elements.values()].find((e) => e.name === img.label);
    const purpose = img.label === "match frame"
      ? "the previous shot's last frame: match its composition and motion, then transform the subject"
      : img.label === "hero frame"
      ? "the look of this shot: composition, light and wardrobe"
      : el?.kind === "character"
        ? `${el.name}, the character. Keep face, hair and wardrobe exactly.`
        : el?.kind === "location"
          ? `${el.name}, the setting. Keep layout and light direction.`
          : `${img.label ?? "reference"}. Keep its shape and materials.`;
    refLines.push(`Image ${i + 1}: ${purpose}`);
  });
  if (spec.mode === "edit") refLines.unshift("Video 1: the source take. Keep its framing, camera motion, timing and everything not listed under EDIT.");
  if (refLines.length) blocks.push(`REFERENCES\n${refLines.join("\n")}`);
  const out: Sections = { references: refLines, look: [], intent: spec.intent, who: [], timeline: [], camera: "", cinematography: [], dialogue: [], spoken: [], voiceRefs: [], sound: { sfx: "", ambience: "", music: "" }, constraints: [] };

  /* LOOK — always; style LoRAs contribute their trigger words here, the
     scene's colour script its palette. */
  const lookParts = [look.genre, look.palette, [look.camera, look.lens].filter(Boolean).join(", "), look.lighting].filter((s) => s && s.trim());
  const triggers = loras.map((l) => l.triggerWords.trim()).filter(Boolean);
  const pal = ctx.scene?.palette;
  const paletteLine = pal ? `Scene palette ${pal.colors.join(", ")}${pal.note ? ` — ${pal.note}` : ""}` : undefined;
  const lookLines = [...lookParts, ...(paletteLine ? [paletteLine] : []), ...(cinema.lookLine ? [cinema.lookLine] : []), ...triggers];
  if (lookLines.length) blocks.push(`LOOK\n${lookLines.join(". ")}.`);
  out.look = lookLines;

  if (spec.mode === "edit") {
    blocks.push(`EDIT\n${spec.editInstruction ?? ""}`);
    out.edit = spec.editInstruction ?? "";
  } else {
    /* SHOT INTENT + who/where, trimmed by mode. */
    const who: string[] = [];
    if (spec.mode === "text") {
      /* Text mode carries everything: full descriptions of people and place. */
      for (const id of spec.characters) who.push(describe(id));
      if (spec.location) who.push(`Setting — ${describe(spec.location)}`);
      for (const id of spec.props) who.push(describe(id));
    } else if (spec.mode === "reference") {
      for (const id of spec.characters) who.push(`${name(id)} looks exactly as in the reference image.`);
    } else if (spec.mode === "keyframe" && ctx.experiments?.restateFrame) {
      /* A/B: restate what the first frame shows, so small details hold. */
      if (spec.frames?.first) who.push(`The first frame shows: ${spec.frames.first}`);
      for (const id of spec.characters) who.push(describe(id));
      for (const id of spec.props) who.push(describe(id));
    }
    /* keyframe (default): the frame already shows who and where — say nothing
       but the details that must never move or vanish. */
    for (const id of [...spec.characters, ...spec.props]) {
      const el = ctx.elements.get(id);
      if (el?.fixedFeatures?.length) who.push(`${el.name} always has ${el.fixedFeatures.map((f) => `${f.feature} on the ${f.where}`).join("; ")}, in every frame.`);
    }
    for (const b of spec.blocking ?? []) who.push(blockingLine(b, name));
    blocks.push(`SHOT INTENT\n${spec.intent}${who.length ? `\n${who.join("\n")}` : ""}`);
    out.who = who;

    const hasFirstFrame = images.some((i) => i.role === "first_frame");
    const beatLines = spec.beats.map((b) => `${fmt(b.from)}–${fmt(b.to)}s: ${b.cut ? "Hard cut. " : ""}${b.action}`);
    const linkLine = LINK_LINES[linkType];
    if (linkLine && images.some((i) => i.role === "first_frame" || i.label === "match frame")) beatLines.unshift(linkLine);
    if (ctx.experiments?.frameHolds && hasFirstFrame) beatLines.unshift("0–0.2s: the picture holds perfectly still, identical to the first frame.");
    if (workflow === "FL2VA") beatLines.push(ctx.experiments?.frameHolds ? `Last 0.3s: everyone stops; the picture settles exactly on the final frame provided.` : `The shot ends on the final frame provided.`);
    blocks.push(`TIMELINE (${spec.durationS}s)\n${beatLines.join("\n")}`);
    out.timeline = beatLines;
  }

  /* CAMERA */
  const cam = spec.camera;
  const camLine = cam.move === "static"
    ? `The camera ${CAMERA_PHRASE.static}.`
    : `The camera ${CAMERA_PHRASE[cam.move]} — ${cam.amplitude} amplitude, ${cam.speed} speed. One continuous move, no other camera motion.`;
  blocks.push(`CAMERA\n${camLine}${cam.note ? ` ${cam.note}` : ""}`);
  out.camera = `${camLine}${cam.note ? ` ${cam.note}` : ""}`;

  /* CINEMATOGRAPHY — Tier 3 keys rendered as prose, plus the composition. */
  const comp = spec.composition;
  const compLine = comp ? `Composition: the subject's eyes sit ${COMPOSITION_X[comp.subjectX]}${comp.headroom ? `, ${comp.headroom} headroom` : ""}${comp.note ? `; ${comp.note}` : ""}` : undefined;
  if (cinema.block || compLine) blocks.push([cinema.block || "CINEMATOGRAPHY", ...(compLine ? [compLine] : [])].join("\n"));
  out.cinematography = [...(cinema.block ? cinema.block.split("\n").slice(1) : []), ...(compLine ? [compLine] : [])];

  /* DIALOGUE — on-screen lines only, in the H3 guide's format. In R2VA a
     speaker shown by a reference image is called by its <Subject N>. */
  const onscreen = onscreenLines(spec);
  const speakers = onscreenSpeakers(spec);
  const refImages = images.filter((i) => i.role === "reference");
  const who = (id: string) => {
    if (workflow !== "R2VA" || (ctx.format ?? promptFormat()) === "blocks") return name(id);
    const k = refImages.findIndex((img) => img.label === ctx.elements.get(id)?.name);
    return k >= 0 ? `<Subject ${k + 1}>` : name(id);
  };
  const introduced = new Set<string>();
  for (const l of onscreen) {
    const sid = speakers.indexOf(l.speaker) + 1;
    const voice = introduced.has(l.speaker) ? undefined : voiceStateFor(ctx.elements.get(l.speaker), l.voiceState)?.description;
    introduced.add(l.speaker);
    const delivery = l.delivery && l.delivery !== "neutral" ? ` (${l.delivery})` : "";
    const at = l.startS !== undefined ? `At ${fmt(l.startS)}s, ` : "";
    const text = `${at}${who(l.speaker)} (S${sid})${voice ? `, ${voice},` : ""} says${delivery}: <d>[${languageTag(lineLanguage(l, look))}] ${l.text}</d>`;
    out.dialogue.push(text);
    out.spoken.push({ segment: l.startS !== undefined ? segmentAt(spec, l.startS) : -1, text });
  }
  if (out.dialogue.length) blocks.push(`DIALOGUE\n${out.dialogue.join("\n")}`);
  for (const [j, a] of audios.entries()) {
    const sid = a.speaker ?? j + 1;
    const speakerId = speakers[sid - 1];
    const target = speakerId ? who(speakerId) : a.label ?? "the speaker";
    out.voiceRefs.push({
      definition: `<Audio ${j + 1}> is the voice-timbre reference for ${target} (S${sid}).`,
      retention: `<Audio ${j + 1}>: reference - the target speaker (S${sid}) follows <Audio ${j + 1}>'s voice timbre without copying the original signal.`,
    });
  }

  /* SOUND */
  const sfx = spec.sound.sfx.length ? spec.sound.sfx.join("; ") : "only what the action makes";
  blocks.push(`SOUND\nSFX: ${sfx}\nAmbience: ${spec.sound.ambience || "natural room tone"}\nMusic: ${spec.sound.music || "N/A"}`);
  out.sound = { sfx, ambience: spec.sound.ambience || "natural room tone", music: spec.sound.music || "N/A" };

  /* CONSTRAINTS */
  const seen = new Set<string>();
  const castLine = ctx.experiments?.positiveCast && images.some((i) => i.role === "first_frame") && !(spec.blocking ?? []).some((b) => b.from === "off_left" || b.from === "off_right")
    ? ["Only the people and objects already in the first frame appear, throughout"] : [];
  const unvoiced = spec.dialogue.length > onscreen.length;
  const speechRule = onscreen.length ? "No extra dialogue beyond the lines above" : unvoiced ? "No one in the frame speaks; every mouth stays closed" : "No dialogue";
  const constraints = [...castLine, ...look.negative, speechRule, "No subtitles"].filter((c) => {
    const key = c.trim().toLowerCase().replace(/[.\s]+$/, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  blocks.push(`CONSTRAINTS\n${constraints.join(". ")}.`);
  out.constraints = constraints;
  out.references = refLines;
  (out as Sections & { blocks: string }).blocks = blocks.join("\n\n");
  return out;
}

/* ---------- serialisation ---------- */

/* Mirrors the prompts that rendered in the handoff (workflows/*.json and
   verify_handoff.py): "field: value" paragraphs separated by blank lines,
   [Shot k] segment markers, <Picture 1>/<Picture 2> for the first/last frame,
   <Subject N> for reference image N, and "N/A" for no music. */
function serializePrompt(sec: Sections, workflow: Workflow, images: WorkerImage[], format: PromptFormat): string {
  if (format === "blocks") return (sec as Sections & { blocks?: string }).blocks ?? "";
  const refs = images.filter((i) => i.role === "reference");
  const hasFirst = images.some((i) => i.role === "first_frame");
  const hasLast = images.some((i) => i.role === "last_frame");
  const sentence = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).map((p) => (/[.!?"]$/.test(p) ? p : `${p}.`)).join(" ");
  const music = sec.sound.music && sec.sound.music.toUpperCase() !== "N/A" ? sec.sound.music : "N/A";
  const soundscape = sentence([sec.sound.sfx !== "only what the action makes" ? sec.sound.sfx : "", sec.sound.ambience]) || "Natural room tone.";

  /* Beats become [Shot k] segments: a new segment opens at every hard cut. */
  const segments: string[][] = [[]];
  for (const line of sec.timeline) {
    if (/^Hard cut\. /.test(line) || /: Hard cut\. /.test(line)) segments.push([]);
    segments[segments.length - 1]!.push(line.replace(": Hard cut. ", ": "));
  }
  const look = sentence(sec.look);
  const camera = `Camera: ${sec.camera}`;
  const tail = sentence([...sec.cinematography, ...sec.constraints]);
  const last = segments.length - 1;
  const spokenIn = (k: number) => (sec.spoken ?? []).filter((d) => Math.min(d.segment < 0 ? last : d.segment, last) === k).map((d) => d.text);
  const shotBlocks = segments.map((lines, k) => {
    const first = k === 0 ? (hasFirst && hasLast ? "One single continuous take with no cuts that starts exactly on <Picture 1> and ends exactly on <Picture 2>." : hasFirst ? "One single continuous take with no cuts, continuing directly from <Picture 1>." : "") : "";
    return `[Shot ${k + 1}] ${sentence([k === 0 ? look : "", first, sec.edit !== undefined ? `Edit the source video: ${sec.edit}` : k === 0 ? sec.intent : "", ...(k === 0 ? sec.who : []), ...lines, ...spokenIn(k), camera, k === last ? tail : ""])}`;
  });

  let fields: Array<[string, string, "inline" | "block"]>;
  if (workflow === "R2VA") {
    const ordinal = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
    const subjects = refs.map((img, i) => {
      const line = sec.references[i]?.replace(/^Image \d+: /, "") ?? img.label ?? "reference";
      return `<Subject ${i + 1}> is ${line.replace(/, the character\. /, " in the " + ordinal[i] + " reference image, the character. ")}`;
    });
    const retention = refs.map((_img, i) => {
      const line = sec.references[i] ?? "";
      const keep = /Keep ([^.]+)\./.exec(line)?.[1] ?? "identity, proportions and materials";
      return `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${keep} are retained.`;
    });
    const voiceRefs = sec.voiceRefs ?? [];
    const audioNote = voiceRefs.length ? [`${voiceRefs.map((_v, j) => `<Audio ${j + 1}>`).join(" and ")} give the speakers' voice timbre`] : [];
    fields = [
      ["subject_definitions", [...subjects, ...voiceRefs.map((v) => v.definition)].join("\n"), "block"],
      ["summary", `[reference generation${voiceRefs.length ? " + audio reference" : ""}] ${sentence([sec.intent, `${refs.map((_r, i) => `<Subject ${i + 1}>`).join(" and ")} guide character identity and wardrobe throughout`, ...audioNote])}`, "block"],
      ["retention_analysis", [...retention, ...voiceRefs.map((v) => v.retention)].join("\n"), "block"],
      ["detailed_description", `${look ? `The target video uses this look: ${look}\n` : ""}${shotBlocks.join("\n")}`, "block"],
      ["overall_soundscape", soundscape, "block"],
      ["non_diegetic_music", music, "inline"],
    ];
  } else {
    const header = hasFirst
      ? `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced${hasLast ? ", and the target video ends on <Picture 2>" : ""}.`
      : `For the target video, ${segments.length} shot${segments.length > 1 ? "s with clean hard cuts" : ""}.`;
    fields = [
      ["integrated_multimodal_description", `${header}\n\n${shotBlocks.join("\n\n")}`, "inline"],
      ["overall_soundscape", soundscape, "inline"],
      ["non_diegetic_music", music, "inline"],
    ];
  }
  if (format === "lightx2v-json") return JSON.stringify(Object.fromEntries(fields.map(([k, v]) => [k, v])));
  return fields.map(([k, v, mode]) => (mode === "block" ? `${k}:\n${v}` : `${k}: ${v}`)).join("\n\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function shotSummary(spec: ShotInput): string {
  return `${spec.durationS}s · ${spec.mode} · ${spec.camera.move.replace("_", " ")}`;
}
