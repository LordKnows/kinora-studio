import { CAMERA_MOVES, type LookSettings, type ShotInput } from "./schemas";
import type { Asset, Element, Shot, Take } from "./types";

/* §4.2 — the deterministic half of the director. Structured shot fields become
   an H3 prompt in the community-documented format, with the project Look and
   a constraints block on every shot. Templates differ by mode so the text
   never repeats what a frame or a reference image already carries. */

export type Workflow = "T2VA" | "I2VA" | "FL2VA" | "R2VA";

export type WorkerImage = { url: string; role: "first_frame" | "last_frame" | "reference"; label?: string };

export type WorkerInput = {
  workflow: Workflow;
  prompt: string;
  seconds: number;
  video_size: string;
  images: WorkerImage[];
  video?: string;
  enhance: boolean;
  steps: number;
  seed?: number;
  negative: string;
  studio_take_id?: string;
  output?: { key: string };
};

export type CompiledJob = { workflow: Workflow; prompt: string; input: WorkerInput; warnings: string[] };

export type CompileContext = {
  shot: Shot;
  look: LookSettings;
  elements: Map<string, Element>;
  assets: Map<string, Asset>;
  /** Last frame of the previous shot's selected take, for linkToPrev = continuous. */
  prevLastFrameUrl?: string;
  sourceTake?: Take;
  steps?: number;
  seed?: number;
};

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

export function compileShot(ctx: CompileContext): CompiledJob {
  const { shot, look } = ctx;
  const spec = shot.spec;
  const warnings: string[] = [];
  const images: WorkerImage[] = [];
  let workflow: Workflow;
  let video: string | undefined;

  const hero = shot.heroAssetId ? ctx.assets.get(shot.heroAssetId) : undefined;
  const end = shot.endAssetId ? ctx.assets.get(shot.endAssetId) : undefined;

  if (spec.mode === "keyframe") {
    const first = spec.linkToPrev === "continuous" && ctx.prevLastFrameUrl ? ctx.prevLastFrameUrl : hero?.url;
    if (!first) throw new CompileError("keyframe mode needs a hero frame (or a previous shot's last frame when linkToPrev is continuous)");
    if (spec.linkToPrev === "continuous" && !ctx.prevLastFrameUrl) warnings.push("linkToPrev is continuous but the previous shot has no finished take; using the hero frame");
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
  } else if (spec.mode === "edit") {
    if (!ctx.sourceTake?.resultUrl) throw new CompileError("edit mode needs a completed source take");
    video = ctx.sourceTake.resultUrl;
    workflow = "R2VA";
    const refs = pickReferences(ctx, warnings, MAX_REFERENCE_IMAGES - 1);
    images.push(...refs);
  } else {
    workflow = "T2VA";
  }

  const prompt = shot.promptOverride?.trim() || buildPrompt(ctx, images, workflow);
  if (prompt.length > MAX_PROMPT_CHARS) warnings.push(`prompt is ${prompt.length} chars; H3 caps around ${MAX_PROMPT_CHARS}`);

  const input: WorkerInput = {
    workflow,
    prompt,
    seconds: spec.durationS,
    video_size: VIDEO_SIZES[look.aspectRatio],
    images,
    ...(video ? { video } : {}),
    enhance: spec.mode === "text",
    steps: ctx.steps ?? 8,
    ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    negative: look.negative.join(", "),
  };
  return { workflow, prompt, input, warnings };
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

function buildPrompt(ctx: CompileContext, images: WorkerImage[], workflow: Workflow): string {
  const { shot, look } = ctx;
  const spec = shot.spec;
  const blocks: string[] = [];
  const name = (id: string) => ctx.elements.get(id)?.name ?? id;
  const describe = (id: string) => {
    const el = ctx.elements.get(id);
    return el ? `${el.name}: ${el.description}`.trim() : id;
  };

  /* REFERENCES — only when there are reference images or a source video. */
  const refLines: string[] = [];
  images.filter((i) => i.role === "reference").forEach((img, i) => {
    const el = [...ctx.elements.values()].find((e) => e.name === img.label);
    const purpose = img.label === "hero frame"
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

  /* LOOK — always. */
  const lookParts = [look.genre, look.palette, [look.camera, look.lens].filter(Boolean).join(", "), look.lighting].filter((s) => s && s.trim());
  if (lookParts.length) blocks.push(`LOOK\n${lookParts.join(". ")}.`);

  if (spec.mode === "edit") {
    blocks.push(`EDIT\n${spec.editInstruction ?? ""}`);
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

    const beatLines = spec.beats.map((b) => `${fmt(b.from)}–${fmt(b.to)}s: ${b.cut ? "Hard cut. " : ""}${b.action}`);
    if (workflow === "FL2VA") beatLines.push(`The shot ends on the final frame provided.`);
    blocks.push(`TIMELINE (${spec.durationS}s)\n${beatLines.join("\n")}`);
  }

  /* CAMERA */
  const cam = spec.camera;
  const camLine = cam.move === "static"
    ? `The camera ${CAMERA_PHRASE.static}.`
    : `The camera ${CAMERA_PHRASE[cam.move]} — ${cam.amplitude} amplitude, ${cam.speed} speed. One continuous move, no other camera motion.`;
  blocks.push(`CAMERA\n${camLine}${cam.note ? ` ${cam.note}` : ""}`);

  /* DIALOGUE */
  if (spec.dialogue.length) {
    blocks.push(`DIALOGUE\n${spec.dialogue.map((l) => `${name(l.speaker)} (${l.language}, ${l.delivery}): "${l.text}"`).join("\n")}`);
  }

  /* SOUND */
  const sfx = spec.sound.sfx.length ? spec.sound.sfx.join("; ") : "only what the action makes";
  blocks.push(`SOUND\nSFX: ${sfx}\nAmbience: ${spec.sound.ambience || "natural room tone"}\nMusic: ${spec.sound.music || "N/A"}`);

  /* CONSTRAINTS */
  const seen = new Set<string>();
  const constraints = [...look.negative, spec.dialogue.length ? "No extra dialogue beyond the lines above" : "No dialogue", "No subtitles"].filter((c) => {
    const key = c.trim().toLowerCase().replace(/[.\s]+$/, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  blocks.push(`CONSTRAINTS\n${constraints.join(". ")}.`);

  return blocks.join("\n\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ---------- stills (hero frames, element refs) via the image models ---------- */

export function compileStillPrompt(shot: Shot, look: LookSettings, elements: Map<string, Element>): string {
  const spec = shot.spec;
  const describe = (id: string) => {
    const el = elements.get(id);
    return el ? `${el.name}: ${el.description}` : id;
  };
  const first = spec.beats[0]?.action ?? spec.intent;
  const parts = [
    `Cinematic still frame. ${spec.intent}.`,
    `Opening moment: ${first}.`,
    ...spec.characters.map(describe),
    spec.location ? `Setting: ${describe(spec.location)}.` : "",
    [look.genre, look.palette, look.camera, look.lens, look.lighting].filter(Boolean).join(", "),
    spec.camera.move === "static" ? "" : `Framed for a ${spec.camera.move.replace("_", " ")}.`,
    look.negative.join(", "),
  ].filter((s) => s && s.trim());
  return parts.join(" ");
}

export function compileElementPrompt(element: Element, look: LookSettings, view: "front" | "three-quarter" | "full-body" | "wide" = "front"): string {
  if (element.kind === "character") {
    const framing = view === "front" ? "front-facing portrait, neutral expression" : view === "three-quarter" ? "three-quarter view portrait" : "full body, standing";
    return `Character reference sheet, ${framing}, plain mid-grey backdrop, even soft light. ${element.name}: ${element.description}. ${look.genre ? `Styled for ${look.genre}.` : ""} ${look.negative.join(", ")}`.trim();
  }
  if (element.kind === "location") {
    return `Location reference, ${view === "wide" ? "wide establishing view" : "establishing view"}. ${element.name}: ${element.description}. ${[look.palette, look.lighting].filter(Boolean).join(", ")}. ${look.negative.join(", ")}`.trim();
  }
  return `Product reference photo, plain backdrop, even light, ${view === "three-quarter" ? "three-quarter angle" : "front view"}. ${element.name}: ${element.description}. ${look.negative.join(", ")}`.trim();
}

export function shotSummary(spec: ShotInput): string {
  return `${spec.durationS}s · ${spec.mode} · ${spec.camera.move.replace("_", " ")}`;
}
