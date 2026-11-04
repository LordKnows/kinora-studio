import { renderCinematography } from "./cinematography";
import { grammarFor, type LinkType } from "./editing";
import { CAMERA_MOVES, type LookSettings, type ShotInput, type ShotLink } from "./schemas";
import type { Asset, Element, Lora, Shot, Take } from "./types";

/* §4.2 — the deterministic half of the director. Structured shot fields become
   an H3 prompt in the community-documented format, with the project Look and
   a constraints block on every shot. Templates differ by mode so the text
   never repeats what a frame or a reference image already carries. */

export type Workflow = "T2VA" | "I2VA" | "FL2VA" | "R2VA";

export type WorkerImage = { url: string; role: "first_frame" | "last_frame" | "reference"; label?: string };

export type WorkerLora = { name: string; file: string; strength: number; hf_url?: string; kind: Lora["kind"] };

export type WorkerInput = {
  workflow: Workflow;
  prompt: string;
  seconds: number;
  video_size: string;
  images: WorkerImage[];
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

export type CompiledJob = { workflow: Workflow; prompt: string; input: WorkerInput; warnings: string[]; effectiveSeconds: number };

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

  const loras = (ctx.loras ?? []).filter((l) => l.workflows.length === 0 || l.workflows.includes(workflow));
  const speed = loras.find((l) => l.kind === "speed");
  const prompt = shot.promptOverride?.trim() || buildPrompt(ctx, images, workflow, loras, link.type);
  if (prompt.length > MAX_PROMPT_CHARS) warnings.push(`prompt is ${prompt.length} chars; H3 caps around ${MAX_PROMPT_CHARS}`);
  if (ctx.steps !== undefined && speed?.stepsHint && ctx.steps !== speed.stepsHint) warnings.push(`${speed.name} is tuned for ${speed.stepsHint} steps; you asked for ${ctx.steps}`);
  /* Without a speed LoRA the graphs' turbo sampling chain is wrong: switch
     to the base chain and the base step count (HANDOFF §3). */
  const baseSteps = Number(process.env.H3_BASE_STEPS ?? "20");
  const steps = ctx.steps ?? speed?.stepsHint ?? (speed ? 8 : baseSteps);
  const sampling = speed ? undefined : { sampler: "res_multistep", scheduler: workflow === "R2VA" ? "beta" : "simple", shift_video: 1.0, shift_audio: 1.0 };
  if (!speed && steps < 12) warnings.push(`no speed LoRA: the base model wants about ${baseSteps} steps, not ${steps}`);
  if (!speed) warnings.push(`no speed LoRA: base sampling chain (${sampling!.sampler}/${sampling!.scheduler}, no sigma shift), ${steps} steps — about ${Math.round((steps / 8) * 10) / 10}× the turbo render time`);

  const input: WorkerInput = {
    workflow,
    prompt,
    seconds: spec.durationS,
    video_size: VIDEO_SIZES[look.aspectRatio],
    images,
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
  return { workflow, prompt, input, warnings, effectiveSeconds };
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
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
  for (const id of shot.spec.characters) {
    const el = ctx.elements.get(id);
    const ref = el?.refAssetIds[0] ? ctx.assets.get(el.refAssetIds[0]) : undefined;
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
  sound: { sfx: string; ambience: string; music: string };
  constraints: string[];
  edit?: string;
};

function buildPrompt(ctx: CompileContext, images: WorkerImage[], workflow: Workflow, loras: ActiveLora[] = [], linkType: LinkType = "cut"): string {
  const sections = buildSections(ctx, images, workflow, loras, linkType);
  return serializePrompt(sections, workflow, images, ctx.format ?? promptFormat());
}

function buildSections(ctx: CompileContext, images: WorkerImage[], workflow: Workflow, loras: ActiveLora[], linkType: LinkType): Sections {
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
  const out: Sections = { references: refLines, look: [], intent: spec.intent, who: [], timeline: [], camera: "", cinematography: [], dialogue: [], sound: { sfx: "", ambience: "", music: "" }, constraints: [] };

  /* LOOK — always; style LoRAs contribute their trigger words here. */
  const lookParts = [look.genre, look.palette, [look.camera, look.lens].filter(Boolean).join(", "), look.lighting].filter((s) => s && s.trim());
  const triggers = loras.map((l) => l.triggerWords.trim()).filter(Boolean);
  const lookLines = [...lookParts, ...(cinema.lookLine ? [cinema.lookLine] : []), ...triggers];
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
    }
    /* keyframe: the frame already shows who and where — say nothing. */
    blocks.push(`SHOT INTENT\n${spec.intent}${who.length ? `\n${who.join("\n")}` : ""}`);
    out.who = who;

    const beatLines = spec.beats.map((b) => `${fmt(b.from)}–${fmt(b.to)}s: ${b.cut ? "Hard cut. " : ""}${b.action}`);
    const linkLine = LINK_LINES[linkType];
    if (linkLine && images.some((i) => i.role === "first_frame" || i.label === "match frame")) beatLines.unshift(linkLine);
    if (workflow === "FL2VA") beatLines.push(`The shot ends on the final frame provided.`);
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

  /* CINEMATOGRAPHY — Tier 3 keys rendered as prose. */
  if (cinema.block) blocks.push(cinema.block);
  out.cinematography = cinema.block ? cinema.block.split("\n").slice(1) : [];

  /* DIALOGUE */
  if (spec.dialogue.length) {
    out.dialogue = spec.dialogue.map((l) => `${name(l.speaker)} (${l.language}, ${l.delivery}): "${l.text}"`);
    blocks.push(`DIALOGUE\n${out.dialogue.join("\n")}`);
  }

  /* SOUND */
  const sfx = spec.sound.sfx.length ? spec.sound.sfx.join("; ") : "only what the action makes";
  blocks.push(`SOUND\nSFX: ${sfx}\nAmbience: ${spec.sound.ambience || "natural room tone"}\nMusic: ${spec.sound.music || "N/A"}`);
  out.sound = { sfx, ambience: spec.sound.ambience || "natural room tone", music: spec.sound.music || "N/A" };

  /* CONSTRAINTS */
  const seen = new Set<string>();
  const constraints = [...look.negative, spec.dialogue.length ? "No extra dialogue beyond the lines above" : "No dialogue", "No subtitles"].filter((c) => {
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
  const tail = sentence([...sec.cinematography, ...(sec.dialogue.length ? [`Dialogue — ${sec.dialogue.join(" ")}`] : []), ...sec.constraints]);
  const shotBlocks = segments.map((lines, k) => {
    const first = k === 0 ? (hasFirst && hasLast ? "One single continuous take with no cuts that starts exactly on <Picture 1> and ends exactly on <Picture 2>." : hasFirst ? "One single continuous take with no cuts, continuing directly from <Picture 1>." : "") : "";
    return `[Shot ${k + 1}] ${sentence([k === 0 ? look : "", first, sec.edit !== undefined ? `Edit the source video: ${sec.edit}` : k === 0 ? sec.intent : "", ...(k === 0 ? sec.who : []), ...lines, camera, k === segments.length - 1 ? tail : ""])}`;
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
    fields = [
      ["subject_definitions", subjects.join("\n"), "block"],
      ["summary", `[reference generation] ${sentence([sec.intent, `${refs.map((_r, i) => `<Subject ${i + 1}>`).join(" and ")} guide character identity and wardrobe throughout`])}`, "block"],
      ["retention_analysis", retention.join("\n"), "block"],
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
