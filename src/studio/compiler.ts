import { h3Frames } from "@director/catalog";
import { promptConstraints } from "@director/lint/constraints";

import { renderCinematography } from "./cinematography";
import { grammarFor, type LinkType } from "./editing";
import { findModel, isGraphDefault, resolveParams, type InferenceParams, type ModelEntry } from "./models";
import { CAMERA_MOVES, FIGURE_VIEWS, type Beat, type Blocking, type Camera, type Line, type LookSettings, type PromptExperiments, type RefView, type ScreenPosition, type ShotInput, type ShotLink, type VoiceState } from "./schemas";
import { H3_FAMILY, trainedFor, turboFor } from "./shot-loras";
import type { Asset, Element, Lora, Scene, Shot, Take } from "./types";

/* §4.2 — the deterministic half of the director. Structured shot fields become
   an H3 prompt in MiniMax's caption fields (the H3 prompt guides), with the
   project Look and a constraints block on every shot. Templates differ by mode
   so the text never repeats what a frame or a reference image already carries.
   The default serialisation is the one the handoff graphs rendered with; it
   departs from MiniMax's published format in five places, and
   experiments.officialFormat writes that format instead (serializeOfficial). */

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
      (res_multistep, simple or beta, the model's own shift 12/3) instead of the turbo
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
   10 s → 243 (10.1 s), 15 s → 362 (15.1 s). The worker does the same rounding.
   One formula, in the director package, so the cue map and the batch planner
   count the same frames as the compiler. */
export { h3Frames };
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
  /** The LoRAs on offer with final strengths: the library's speed LoRAs while the
      shot's use-turbo switch is on (the compiler loads the one for the workflow)
      and the LoRAs assigned to the shot while use LoRA is on. */
  loras?: ActiveLora[];
  /** The shot asked for the turbo LoRA (use turbo): say so when none fits the workflow. */
  turbo?: boolean;
  steps?: number;
  seed?: number;
  /** How the sections are serialised for the model; defaults to H3_PROMPT_FORMAT. */
  format?: PromptFormat;
  /** The shot's scene: its colour script compiles into the LOOK line. */
  scene?: Scene;
  /** Prompt A/B switches (take request over project default); all off by default. */
  experiments?: PromptExperiments;
};

/* MiniMax's caption format (the H3 prompt guides; lightx2v's notes for its
   turbo LoRAs use the same fields): fixed field names, <Picture 1> /
   <Picture 2> for the first / last frame and <Subject N> for reference images
   (handoff §1). What captions the turbo LoRAs were distilled with is not
   published. "blocks" is the plain sectioned text used before the handoff;
   keep it for A/B tests. */
export type PromptFormat = "lightx2v-json" | "lightx2v-lines" | "blocks";

export function promptFormat(): PromptFormat {
  const v = process.env.H3_PROMPT_FORMAT;
  return v === "blocks" || v === "lightx2v-json" ? v : "lightx2v-lines";
}

export const MAX_REFERENCE_IMAGES = 3;
/** LoRAs one take can load: the speed LoRA and up to three style / effect LoRAs. */
export const MAX_TAKE_LORAS = 4;
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

/* A voice that is not speech: a cast that laughs, sighs or purrs is not told to stay silent. */
const VOCAL_SOUND = /\b(laugh|giggl|chuckl|snicker|sigh|gasp|sob|weep|cr(y|ies|ying)|scream|shout|yell|cheer|moan|groan|grunt|hum(s|med|ming)?\b|sing(s|ing)?\b|whisper|murmur|mutter|pant|cough|sneez|yawn|snor|whistl|purr|meow|mew|bark|growl|howl|whimper|chirp|neigh|roar)|笑|哭|叹|喊|叫|唱|喘|呻吟|低语|咳|呼噜|喵|吠|吼/i;

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

  /* One turbo LoRA, the one trained for this workflow, and the shot's assigned
     LoRAs that are trained for H3 and for it (shot-loras.ts). */
  const offered = ctx.loras ?? [];
  const speed = turboFor(offered.filter((l) => l.kind === "speed"), workflow);
  const assigned = offered.filter((l) => l.kind !== "speed");
  const fitting = assigned.filter((l) => trainedFor(l, workflow));
  for (const l of assigned.filter((x) => !fitting.includes(x))) {
    warnings.push(`LoRA ${l.name} is not trained for ${(l.baseModel ?? H3_FAMILY) === H3_FAMILY ? `${workflow} (only ${l.workflows.join(", ")})` : `H3 (${l.baseModel})`}: left out of this take`);
  }
  if (ctx.turbo && !speed) warnings.push(`use turbo is on, but the library has no speed LoRA for ${workflow}`);
  const loras = [...(speed ? [speed] : []), ...fitting];
  /* the pod chains them behind the graph's one slot, up to MAX_TAKE_LORAS (workers/h3-runpod/handler.py MAX_LORAS) */
  if (loras.length > MAX_TAKE_LORAS) throw new CompileError(`this shot would load ${loras.length} LoRAs (${loras.map((l) => l.name).join(", ")}); a take takes at most ${MAX_TAKE_LORAS} — assign fewer to the shot (assign_loras)`);
  const prompt = shot.promptOverride?.trim() || buildPrompt(ctx, images, workflow, loras, link.type, audios);
  if (!shot.promptOverride?.trim()) {
    const left = promptConstraints(look.negative).dropped;
    if (left.length) warnings.push(`Look constraints left out of the prompt (H3 has no negative prompt, the words would be drawn): ${left.map((v) => `"${v.text.trim()}"`).join(", ")} — lint_project says what to write instead`);
  }
  if (prompt.length > MAX_PROMPT_CHARS) warnings.push(`prompt is ${prompt.length} chars; H3 caps around ${MAX_PROMPT_CHARS}`);
  /* The settings follow the model and its speed LoRA (models.ts): the turbo
     LoRA's chain is the one the graphs carry (euler/simple, shift 6/3, 8
     steps), so nothing more is sent; without one, the base chain the
     handoff measured (res_multistep, simple or beta, the model's own shift
     12/3, 20 steps). */
  const h3 = { ...H3_MODEL, params: { ...H3_MODEL.params, steps: Number(process.env.H3_BASE_STEPS ?? H3_MODEL.params.steps) } };
  const resolved = resolveParams(h3, { workflow, loras, steps: ctx.steps });
  warnings.push(...resolved.warnings.map((w) => w.replace(/^MiniMax H3 wants about (\d+) steps/, "no speed LoRA: the base model wants about $1 steps")));
  const p = resolved.params;
  const steps = p.steps ?? 8;
  const sampling = isGraphDefault(h3, p) ? undefined : { sampler: p.sampler ?? "euler", scheduler: p.scheduler ?? "simple", shift_video: p.shiftVideo ?? H3_MODEL.params.shiftVideo ?? 12, shift_audio: p.shiftAudio ?? H3_MODEL.params.shiftAudio ?? 3 };
  if (!speed && sampling) warnings.push(`no speed LoRA: base sampling chain (${sampling.sampler}/${sampling.scheduler}, shift ${sampling.shift_video}/${sampling.shift_audio}), ${steps} steps — about ${Math.round((steps / 8) * 10) / 10}× the turbo render time`);

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
    /* H3 has no negative input (mapping.json: negative null); the Look's constraints are in the prompt */
    negative: "",
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
   side view, a close-up the face portrait). The portrait is offered only to
   close-ups: with one reference per character, a wider shot needs the picture
   that also shows the clothes and the build. */
export function preferredViews(spec: ShotInput): RefView[] {
  const c = spec.cinematography ?? {};
  if (c.angle === "profile") return ["side", "three_quarter", "front"];
  const backs = (spec.blocking ?? []).some((b) => /\b(back to (the )?camera|from behind|walks away)\b/i.test(b.note ?? ""));
  if (backs) return ["back", "three_quarter", "full_body"];
  /* a close-up is the face: the portrait first (one face, large), the expression grid only without one */
  if (c.size === "ecu" || c.size === "cu") return ["face", "expression", "front", "three_quarter"];
  if (c.size === "mcu" || c.size === "ms" || c.size === "ots" || c.size === "twoshot") return ["front", "three_quarter", "full_body"];
  if (c.size === "ls" || c.size === "els" || c.size === "mls") return ["full_body", "front", "three_quarter"];
  return ["front", "three_quarter", "full_body"];
}

/** The view a reference picture of this element was tagged with, found by its url. */
export function viewOfRef(el: Element, url: string, assets: Map<string, Asset>): RefView | undefined {
  const id = el.refAssetIds.find((a) => assets.get(a)?.url === url);
  return id ? el.refViews?.[id] : undefined;
}

/** The element's face portrait, when it has one. */
export function faceRef(el: Element): string | undefined {
  return el.refAssetIds.find((a) => el.refViews?.[a] === "face");
}

export function pickRefForViews(el: Element, wanted: RefView[]): string | undefined {
  const views = el.refViews ?? {};
  for (const v of wanted) {
    const hit = el.refAssetIds.find((a) => views[a] === v);
    if (hit) return hit;
  }
  /* no tagged match: a whole figure or an untagged picture first (a head, a grid
     of expressions or a close detail carries no clothes), then the portrait, then whatever there is */
  const figure = (a: string) => !views[a] || (FIGURE_VIEWS as readonly string[]).includes(views[a]!);
  return el.refAssetIds.find(figure) ?? el.refAssetIds.find((a) => views[a] === "face") ?? el.refAssetIds[0];
}

/** "a scar" + where it sits, as one phrase. The place is written by hand, so it
    may already open with its own preposition ("on his face") or determiner
    ("his own right upper arm"); a fixed "on the" in front of those read
    "on the on his face" in every prompt. */
export function placedFeature(f: { feature: string; where: string }): string {
  const where = f.where.trim();
  if (/^(on|in|at|over|under|around|across|behind|above|below|along|between|inside|near|through|down|up)\b/i.test(where)) return `${f.feature} ${where}`;
  if (/^(the|a|an|his|her|their|its|both|each|own)\b/i.test(where)) return `${f.feature} on ${where}`;
  return `${f.feature} on the ${where}`;
}

/** Whether a phrase already ends a sentence, in Latin or CJK punctuation. */
const ENDS_SENTENCE = /[.!?"。！？…”」』]$/;

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
  /** The same shot as data, for the official serialisation (serializeOfficial). */
  official: {
    beats: Beat[];
    camera: Camera;
    linkLine?: string;
    frameHolds: boolean;
    spoken: { startS?: number; text: string }[];
    effectiveS: number;
  };
};

function buildPrompt(ctx: CompileContext, images: WorkerImage[], workflow: Workflow, loras: ActiveLora[] = [], linkType: LinkType = "cut", audios: WorkerAudio[] = []): string {
  const sections = buildSections(ctx, images, workflow, loras, linkType, audios);
  if (ctx.experiments?.officialFormat) return serializeOfficial(sections, workflow, images);
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
        ? viewOfRef(el, img.url, ctx.assets) === "face"
          ? `${el.name}, the character. Keep face and hair exactly. The reference is a portrait: it gives the identity only, not this shot's framing, expression or light.`
          : `${el.name}, the character. Keep face, hair and wardrobe exactly.`
        : el?.kind === "location"
          ? `${el.name}, the setting. Keep layout and light direction.`
          : `${img.label ?? "reference"}. Keep its shape and materials.`;
    refLines.push(`Image ${i + 1}: ${purpose}`);
  });
  if (spec.mode === "edit") refLines.unshift("Video 1: the source take. Keep its framing, camera motion, timing and everything not listed under EDIT.");
  if (refLines.length) blocks.push(`REFERENCES\n${refLines.join("\n")}`);
  const out: Sections = {
    references: refLines, look: [], intent: spec.intent, who: [], timeline: [], camera: "", cinematography: [], dialogue: [], spoken: [], voiceRefs: [], sound: { sfx: "", ambience: "", music: "" }, constraints: [],
    official: { beats: spec.mode === "edit" ? [] : spec.beats, camera: spec.camera, frameHolds: false, spoken: [], effectiveS: h3EffectiveSeconds(spec.durationS) },
  };

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
      if (el?.fixedFeatures?.length) who.push(`${el.name} always has ${el.fixedFeatures.map(placedFeature).join("; ")}, in every frame.`);
    }
    for (const b of spec.blocking ?? []) who.push(blockingLine(b, name));
    blocks.push(`SHOT INTENT\n${spec.intent}${who.length ? `\n${who.join("\n")}` : ""}`);
    out.who = who;

    const hasFirstFrame = images.some((i) => i.role === "first_frame");
    const beatLines = spec.beats.map((b) => `${fmt(b.from)}–${fmt(b.to)}s: ${b.cut ? "Hard cut. " : ""}${b.action}`);
    const linkLine = LINK_LINES[linkType];
    if (linkLine && images.some((i) => i.role === "first_frame" || i.label === "match frame")) {
      beatLines.unshift(linkLine);
      out.official.linkLine = linkLine;
    }
    out.official.frameHolds = !!ctx.experiments?.frameHolds && hasFirstFrame;
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
    if (workflow !== "R2VA" || (!ctx.experiments?.officialFormat && (ctx.format ?? promptFormat()) === "blocks")) return name(id);
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
    const said = `${who(l.speaker)} (S${sid})${voice ? `, ${voice},` : ""} says${delivery}: <d>[${languageTag(lineLanguage(l, look))}] ${l.text}</d>`;
    const text = `${at}${said}`;
    out.dialogue.push(text);
    out.spoken.push({ segment: l.startS !== undefined ? segmentAt(spec, l.startS) : -1, text });
    /* the official format ties a line to the beat it falls in, not to a timecode */
    out.official.spoken.push({ startS: l.startS, text: said });
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
  /* A shot with no ambience of its own takes its scene's row of the sound design table. */
  const ambience = spec.sound.ambience || ctx.scene?.sound?.ambience || "natural room tone";
  blocks.push(`SOUND\nSFX: ${sfx}\nAmbience: ${ambience}\nMusic: ${spec.sound.music || "N/A"}`);
  out.sound = { sfx, ambience, music: spec.sound.music || "N/A" };

  /* CONSTRAINTS */
  const seen = new Set<string>();
  const castLine = ctx.experiments?.positiveCast && images.some((i) => i.role === "first_frame") && !(spec.blocking ?? []).some((b) => b.from === "off_left" || b.from === "off_right")
    ? ["Only the people and objects already in the first frame appear, throughout"] : [];
  const unvoiced = spec.dialogue.length > onscreen.length;
  /* Who speaks, said as what happens (MiniMax's guide: "the on-screen character's lips remain closed"),
     and by name: "everyone" in a shot of a cat or a landscape would ask for people. A shot with lines
     says they are all there is; one with only off-screen or inner lines closes the mouths in frame;
     one with no lines keeps its cast silent unless the action or the sound gives them a voice. */
  const cast = spec.characters.filter((id) => ctx.elements.has(id)).map(who);
  const castStays = cast.length > 1 ? `${cast.slice(0, -1).join(", ")} and ${cast.at(-1)} stay` : cast.length === 1 ? `${cast[0]} stays` : "";
  const voiced = VOCAL_SOUND.test([...spec.beats.map((b) => b.action), ...spec.sound.sfx, spec.sound.ambience ?? ""].join(" "));
  const speechRule = onscreen.length ? "The lines above are the only words spoken"
    : unvoiced ? `${castStays || "Everyone in the frame stays"} silent, lips closed`
    : castStays && !voiced ? `${castStays} silent` : "";
  /* H3 has no negative prompt (cfg 1, no negative branch): whatever stands here is drawn. The Look's
     constraints go in as statements; a bare negative-prompt word and a ban on text are left out
     (lint/constraints.ts), and the compiler adds no ban of its own. */
  const constraints = [...castLine, ...promptConstraints(look.negative).keep, speechRule].filter((c) => {
    const key = c.trim().toLowerCase().replace(/[.\s]+$/, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (constraints.length) blocks.push(`CONSTRAINTS\n${constraints.join(". ")}.`);
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
  const sentence = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).map((p) => (ENDS_SENTENCE.test(p) ? p : `${p}.`)).join(" ");
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

/* ---------- MiniMax's published format (experiments.officialFormat) ---------- */

/* The H3 prompt guides (VIDEO_PROMPT_WRITING_GUIDE_base_en / _ref_en in
   MiniMaxAI/MiniMax-H3) and the default serialisation above differ in five
   places. This one follows the guides:
   1. the instruction line is the first line of the prompt, a blank line before the fields;
   2. first-and-last-frame takes use the guide's own sentence ("How the reference pictures align …");
   3. text-to-video has no instruction line;
   4. time is written only where the shot cuts ("[Shot 2] At 00:03.500, the camera cuts to …");
      inside a shot the beats follow each other in prose, and a line is tied to its beat;
   5. the camera move is a sentence of the shot ("The camera pushes in with small amplitude at
      slow speed."), not a `Camera:` label, and the cinematography terms lose their labels too.
   Whether any of this renders better on the 8-step turbo chain is not measured: it is an A/B
   switch, recorded on the take, off by default. */

const CAMERA_OFFICIAL: Record<(typeof CAMERA_MOVES)[number], string> = {
  static: "holds a static shot",
  push_in: "pushes in",
  pull_out: "pulls out",
  pan: "pans",
  tilt: "tilts",
  truck: "trucks sideways",
  pedestal: "moves on a pedestal",
  arc: "arcs around the subject",
  tracking: "tracks with the subject",
  handheld: "shakes slightly",
  pov: "shows the subject's point of view",
  roll: "rolls",
  zoom: "zooms",
};

/** The camera move in the guide's words: type, then amplitude and speed where they are not the middle value. */
export function officialCameraSentence(cam: Camera): string {
  const note = cam.note ? ` ${cam.note}` : "";
  if (cam.move === "static") return `The camera holds a static shot for the whole duration.${note}`;
  if (cam.move === "handheld") return `The camera ${cam.amplitude === "strong" ? "shakes strongly" : "shakes slightly"}, handheld.${note}`;
  if (cam.move === "pov") return `The shot is the subject's POV.${note}`;
  const amplitude = cam.amplitude === "subtle" ? " with small amplitude" : cam.amplitude === "strong" ? " with large amplitude" : "";
  const speed = cam.speed === "slow" ? " at slow speed" : cam.speed === "fast" ? " at fast speed" : "";
  return `The camera ${CAMERA_OFFICIAL[cam.move]}${amplitude}${speed}.${note}`;
}

/** 3.5 → "00:03.500": the guide's cut time. */
export function cutTimecode(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
}

/* "The wind lifts the bag." after "Early in the shot, " reads "…, the wind lifts the bag."; a name keeps its capital. */
const LOWER_AFTER_MARKER = /^(The|A|An|His|Her|Their|Its|She|He|They|It|Both|Each|One|Two|Three|Someone|Something|Everyone|Nothing|Behind|Beside|In|On|At|From|With|As|While)\b/;
function afterMarker(marker: string, action: string): string {
  const a = action.trim();
  if (!marker) return a;
  return `${marker}${LOWER_AFTER_MARKER.test(a) ? a.charAt(0).toLowerCase() + a.slice(1) : a}`;
}

/** Where a beat sits among the beats of its segment, in words. */
function beatMarker(i: number, n: number): string {
  if (n <= 1) return "";
  if (i === 0) return "Early in the shot, ";
  if (i === n - 1) return "Through the rest of the shot, ";
  return i === 1 ? "As the shot continues, " : "Then, ";
}

const unlabel = (line: string) => {
  const t = line.replace(/^[A-Z][A-Za-z]+: /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function serializeOfficial(sec: Sections, workflow: Workflow, images: WorkerImage[]): string {
  const refs = images.filter((i) => i.role === "reference");
  const hasFirst = images.some((i) => i.role === "first_frame");
  const hasLast = images.some((i) => i.role === "last_frame");
  /* a spoken line ends with its </d>, as in the guide's examples: no full stop after it */
  const sentence = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).map((p) => (ENDS_SENTENCE.test(p) || p.endsWith("</d>") ? p : `${p}.`)).join(" ");
  const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const music = sec.sound.music && sec.sound.music.toUpperCase() !== "N/A" ? sec.sound.music : "N/A";
  const soundscape = sentence([sec.sound.sfx !== "only what the action makes" ? sec.sound.sfx : "", sec.sound.ambience]) || "Natural room tone.";
  const o = sec.official;

  /* A new [Shot k] opens at every hard cut after the first frame. */
  const segments: Beat[][] = [[]];
  for (const b of o.beats) {
    if (b.cut && b.from > 0 && segments[segments.length - 1]!.length) segments.push([]);
    segments[segments.length - 1]!.push(b);
  }
  const last = segments.length - 1;
  /* a line belongs to the beat it starts in; one with no time closes the last shot */
  const linesAfter = (b: Beat, isLastBeat: boolean) => o.spoken.filter((d) => (d.startS === undefined ? isLastBeat : d.startS >= b.from - 1e-6 && (d.startS < b.to - 1e-6 || (isLastBeat && d.startS >= b.to - 1e-6)))).map((d) => d.text);

  const look = sentence(sec.look);
  /* the guide opens [Shot 1] with the style and the initial composition */
  const framing = sec.cinematography.filter((l) => /^(Framing|Lens): /.test(l)).map(unlabel);
  const finish = sec.cinematography.filter((l) => !/^(Framing|Lens): /.test(l)).map(unlabel);
  const camera = officialCameraSentence(o.camera);
  const single = segments.length === 1;
  const anchor = hasFirst && hasLast
    ? "The shot begins in the position and framing established by Picture 1."
    : hasFirst ? `The shot opens exactly on <Picture 1>${single ? " and continues from it in one take" : ""}, preserving the appearance, clothing, positions and layout it shows.` : "";
  const landing = hasFirst && hasLast
    ? (o.frameHolds ? "In the last moments everyone stops, and the picture settles exactly into the pose, spacing and composition established by Picture 2." : "By the end of the shot everything settles into the pose, spacing and composition established by Picture 2.")
    : "";
  const lastBeat = o.beats[o.beats.length - 1];
  const untimed = o.beats.length === 0 ? o.spoken.map((d) => d.text) : [];

  const shotBlocks = segments.map((beats, k) => {
    const head = k === 0
      ? [workflow === "R2VA" ? "" : look, ...framing, anchor, sec.edit !== undefined ? `Edit the source video: ${sec.edit}` : sec.intent, ...sec.who, o.linkLine ?? "", o.frameHolds ? "The picture first holds still for a moment, identical to the first frame." : ""]
      : [`At ${cutTimecode(beats[0]!.from)}, the camera cuts to a new view.`];
    const body = beats.flatMap((b, i) => [afterMarker(beatMarker(i, beats.length), b.action), ...linesAfter(b, b === lastBeat)]);
    const tail = k === last ? [...untimed, landing, ...finish, ...sec.constraints.map(capital)] : [];
    return `[Shot ${k + 1}] ${sentence([...head, camera, ...body, ...tail])}`;
  });

  if (workflow === "R2VA") {
    const subjects = refs.map((img, i) => {
      const line = sec.references[i]?.replace(/^Image \d+: /, "") ?? img.label ?? "reference";
      /* the guide cites the source picture inside the subject's definition */
      return `<Subject ${i + 1}> is ${line.replace(/, the character\. /, `, the character shown in <Picture ${i + 1}>. `).replace(/, the setting\. /, `, the setting shown in <Picture ${i + 1}>. `)}`;
    });
    const retention = refs.map((_img, i) => {
      const keep = /Keep ([^.]+)\./.exec(sec.references[i] ?? "")?.[1] ?? "identity, proportions and materials";
      return `<Subject ${i + 1}> (appears in [Shot 1]): fully_preserved - ${keep} are retained.`;
    });
    const voiceRefs = sec.voiceRefs ?? [];
    const audioNote = voiceRefs.length ? [`${voiceRefs.map((_v, j) => `<Audio ${j + 1}>`).join(" and ")} give the speakers' voice timbre`] : [];
    return [
      `subject_definitions:\n${[...subjects, ...voiceRefs.map((v) => v.definition)].join("\n")}`,
      `summary:\n[reference generation${voiceRefs.length ? " + audio reference" : ""}] ${sentence([sec.intent, `${refs.map((_r, i) => `<Subject ${i + 1}>`).join(" and ")} guide character identity and wardrobe throughout`, ...audioNote])}`,
      `retention_analysis:\n${[...retention, ...voiceRefs.map((v) => v.retention)].join("\n")}`,
      /* reference mode: the style opens the description, before [Shot 1] */
      `detailed_description:\n${look ? `${look} ` : ""}${shotBlocks.join(" ")}`,
      `overall_soundscape:\n${soundscape}`,
      `non_diegetic_music: ${music}`,
    ].join("\n\n");
  }

  const seconds = o.effectiveS.toFixed(2);
  const instruction = hasFirst && hasLast
    ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${segments.length}) aligns with the ${seconds}-second mark of the target video.`
    : hasFirst ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced." : "";
  const fields = [`integrated_multimodal_description: ${shotBlocks.join(" ")}`, `overall_soundscape: ${soundscape}`, `non_diegetic_music: ${music}`].join("\n\n");
  return instruction ? `${instruction}\n\n${fields}` : fields;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function shotSummary(spec: ShotInput): string {
  return `${spec.durationS}s · ${spec.mode} · ${spec.camera.move.replace("_", " ")}`;
}
