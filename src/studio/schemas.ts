import { z } from "zod";

import { CINEMA_KEYS } from "./cinematography";
import { LINK_TYPES } from "./editing";

/* The schemas of §7.3. REST and MCP share them; field descriptions double as
   the rules the agent reads, so the H3 prompt grammar lives here and in the
   compiler, not in the agent's memory. */

export const ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const CAMERA_MOVES = [
  "static", "push_in", "pull_out", "pan", "tilt", "truck", "pedestal",
  "arc", "tracking", "handheld", "pov", "roll", "zoom",
] as const;
export const SHOT_MODES = ["text", "keyframe", "reference", "edit"] as const;
export const ELEMENT_KINDS = ["character", "location", "prop"] as const;
export const EXPORT_PRESETS = ["master-768p", "master-upscaled", "social-9x16", "preview-480p"] as const;

export const LORA_KINDS = ["speed", "style", "effect"] as const;

export const LoraRef = z.object({
  id: z.string().describe("LoRA id from the library"),
  strength: z.number().min(0).max(2).optional().describe("Overrides the library default strength"),
});
export type LoraRef = z.infer<typeof LoraRef>;

export const LoraInput = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(LORA_KINDS).describe("speed = fewer steps (lightx2v…), style/effect = look"),
  filename: z.string().min(1).max(200).describe("File name inside ComfyUI's models/loras, e.g. h3_lightx2v_8step.safetensors"),
  hfUrl: z.string().url().optional().describe("HuggingFace file link; the pod downloads it when the file is missing"),
  triggerWords: z.string().max(300).default("").describe("Appended to the LOOK block when the LoRA is active"),
  defaultStrength: z.number().min(0).max(2).default(1),
  stepsHint: z.number().int().min(1).max(60).optional().describe("speed LoRAs: the step count they are trained for"),
  workflows: z.array(z.enum(["T2VA", "I2VA", "FL2VA", "R2VA"])).default([]).describe("Empty = every workflow"),
  notes: z.string().max(1000).default(""),
});
export type LoraInput = z.infer<typeof LoraInput>;

export const LookSettings = z.object({
  genre: z.string().max(200).describe("Genre and tone, e.g. 'neo-noir thriller'"),
  palette: z.string().max(200).describe("Colour palette, e.g. 'teal and amber, crushed blacks'"),
  camera: z.string().max(200).describe("Camera body / format, e.g. 'Arri Alexa, anamorphic'"),
  lens: z.string().max(200).describe("Lens and depth of field, e.g. '35mm, shallow DOF'"),
  lighting: z.string().max(200).describe("Lighting approach, e.g. 'practical sources, hard key'"),
  aspectRatio: z.enum(ASPECT_RATIOS).default("16:9"),
  resolution: z.literal("768p").default("768p").describe("Self-hosted H3-Base renders 768p only"),
  upscale: z.boolean().default(false).describe("Upscale at export time (master-upscaled preset)"),
  negative: z.array(z.string().max(80)).max(10).default(["no on-screen text", "no logos", "no subtitles"]),
  loras: z.array(LoraRef).max(6).default([]).describe("Project-wide LoRAs (speed LoRA goes here); shots may override"),
});
export type LookSettings = z.infer<typeof LookSettings>;

export const DEFAULT_LOOK: LookSettings = LookSettings.parse({
  genre: "", palette: "", camera: "", lens: "", lighting: "",
});

export const Beat = z.object({
  from: z.number().min(0).describe("Start second"),
  to: z.number().max(15).describe("End second; beats must tile the whole shot"),
  action: z.string().min(5).max(400).describe("Start state → one primary action → end state. One action per beat."),
  cut: z.boolean().optional().describe("true = a hard cut opens this beat (max 3 per shot)"),
});
export type Beat = z.infer<typeof Beat>;

export const Line = z.object({
  speaker: z.string().describe("Element id of the character speaking"),
  text: z.string().min(1).max(300).describe("The exact line, verbatim"),
  language: z.string().max(10).default("en"),
  delivery: z.string().max(80).default("neutral").describe("e.g. 'whispered, exhausted'"),
});
export type Line = z.infer<typeof Line>;

export const Camera = z.object({
  move: z.enum(CAMERA_MOVES).describe(
    "One primary move per shot. 'static' compiles to 'holds a static, locked-off shot' (H3 drifts unless told not to).",
  ),
  amplitude: z.enum(["subtle", "moderate", "strong"]).default("moderate"),
  speed: z.enum(["slow", "medium", "fast"]).default("slow"),
  note: z.string().max(200).optional().describe("Free text refinement, e.g. 'rack focus to the hand at 4s'"),
});
export type Camera = z.infer<typeof Camera>;

export const Sound = z.object({
  sfx: z.array(z.string().max(80)).max(8).default([]).describe("Physical sounds as an event list"),
  ambience: z.string().max(200).default("").describe("Room tone / environment"),
  music: z.string().max(200).default("N/A").describe("Non-diegetic score; 'N/A' suppresses music"),
});
export type Sound = z.infer<typeof Sound>;

export const ShotLink = z.object({
  type: z.enum(LINK_TYPES).describe(
    "cut: stands alone. continuous: starts from the anchor's last frame (long take). bridge: anchor last frame → this shot's end frame (FL2VA). insert_return / reverse: resume an earlier shot (anchor -2 by default). match_cut: anchor last frame as reference image (R2VA). jump_cut: same setup, time has passed. montage: short standalone beat. loop: one period of a periodic motion, hero frame as first and last frame, repeated on the timeline.",
  ),
  anchor: z.number().int().min(-8).max(-1).optional().describe("Which earlier shot feeds this one, as a negative offset (-1 = previous). Defaults per type: insert_return / reverse → -2, others → -1."),
  anchorShotId: z.string().optional().describe("Explicit anchor shot id (overrides the offset)."),
});
export type ShotLink = z.infer<typeof ShotLink>;

const cin = (cat: keyof typeof CINEMA_KEYS) => z.enum(CINEMA_KEYS[cat] as [string, ...string[]]);
export const Cinematography = z.object({
  size: cin("size").optional().describe("Shot size: ecu, cu, mcu, ms, mls, ls, els, twoshot, ots, insert"),
  angle: cin("angle").optional().describe("eye, low, high, overhead, dutch, worm, pov, profile"),
  lens: cin("lens").optional().describe("ultrawide, wide, normal, portrait, tele, macro, anamorphic, fisheye"),
  dof: cin("dof").optional().describe("shallow, medium, deep, rack, tiltshift"),
  lighting: z.array(cin("lighting")).max(4).optional().describe("up to 4 of: threepoint, rembrandt, split, butterfly, highkey, lowkey, chiaroscuro, silhouette, rim, practicals, neon, golden, blue, overcast, harshsun, moonlight, firelight, volumetric, underlight, stage"),
  grade: cin("grade").optional().describe("tealorange, bleach, mono, pastel, kodachrome, crossprocess, muted, vivid, sepia, cyberpunk"),
  texture: cin("texture").optional().describe("35mm, 16mm, 8mm, digital, vhs, cctv, polaroid, halftone"),
  vfx: z.array(cin("vfx")).max(4).optional().describe("up to 4 of: slowmo, speedramp, timelapse, hyperlapse, longexposure, doubleexp, lensflare, fog, particles, rain, glitch, bloom, mirror, splitscreen, freeze, explosion, magic, holo"),
  animation: cin("animation").optional().describe("anime, ghibli, cgi, claymation, stopmotion, flat2d, watercolor, pixel, inkwash, comic, rotoscope, lowpoly"),
  pace: cin("pace").optional().describe("still, slow, steady, brisk, frantic"),
});
export type Cinematography = z.infer<typeof Cinematography>;

export const ShotBase = z.object({
    durationS: z.number().int().min(5).max(15).describe("5–15 seconds; chain shots for longer takes"),
    mode: z.enum(SHOT_MODES).describe(
      "text: prompt only. keyframe: hero frame (+ optional end frame) drives it. reference: element refs lock identity (max 3 images). (edit is disabled with the current H3 graphs — re-render the shot instead.)",
    ),
    intent: z.string().min(5).max(300).describe("One sentence: what this shot is for"),
    beats: z.array(Beat).min(1).max(6),
    camera: Camera,
    dialogue: z.array(Line).max(8).default([]),
    sound: Sound.prefault({}),
    characters: z.array(z.string()).max(3).default([]).describe("Element ids"),
    location: z.string().optional().describe("Element id"),
    props: z.array(z.string()).max(3).default([]).describe("Element ids"),
    linkToPrev: z.enum(["cut", "continuous"]).default("cut").describe("Legacy; prefer link. continuous = first frame is the previous shot's last frame"),
    link: ShotLink.optional().describe("Tier 2: how this shot joins the earlier ones (the edit grammar)"),
    cinematography: Cinematography.optional().describe("Tier 3: framing, lens, light, grade, texture, technique, animation style, pace"),
    sourceTakeId: z.string().optional().describe("edit mode: the take being revised"),
    editInstruction: z.string().max(600).optional().describe("edit mode: only what changes"),
    promptOverride: z.string().max(7000).optional().describe("Replace the compiled prompt entirely"),
    loras: z.array(LoraRef).max(6).optional().describe("Override the project LoRAs for this shot; [] = none"),
});

export const ShotInput = ShotBase.superRefine((shot, ctx) => {
    const sorted = [...shot.beats].sort((a, b) => a.from - b.from);
    let cursor = 0;
    for (const beat of sorted) {
      if (Math.abs(beat.from - cursor) > 0.01) {
        ctx.addIssue({ code: "custom", path: ["beats"], message: `beats must tile the shot without gaps; expected a beat starting at ${cursor}s` });
        break;
      }
      if (beat.to <= beat.from) {
        ctx.addIssue({ code: "custom", path: ["beats"], message: "each beat must end after it starts" });
        break;
      }
      cursor = beat.to;
    }
    if (Math.abs(cursor - shot.durationS) > 0.01) {
      ctx.addIssue({ code: "custom", path: ["beats"], message: `beats end at ${cursor}s but durationS is ${shot.durationS}` });
    }
    if (shot.beats.filter((b) => b.cut).length > 3) {
      ctx.addIssue({ code: "custom", path: ["beats"], message: "at most 3 cuts per shot; split into more shots" });
    }
    if (shot.mode === "edit" && !shot.sourceTakeId) {
      ctx.addIssue({ code: "custom", path: ["sourceTakeId"], message: "edit mode needs sourceTakeId" });
    }
    if (shot.mode === "edit" && !shot.editInstruction) {
      ctx.addIssue({ code: "custom", path: ["editInstruction"], message: "edit mode needs editInstruction" });
    }
  });
export type ShotInput = z.infer<typeof ShotInput>;

export const SceneInput = z.object({
  slug: z.string().min(1).max(60).describe("Short handle, e.g. 'alley-chase'"),
  summary: z.string().max(400).default(""),
  location: z.string().optional().describe("Element id"),
  shots: z.array(ShotInput).min(1),
});

export const ShotlistInput = z.object({ scenes: z.array(SceneInput).min(1) });
export type ShotlistInput = z.infer<typeof ShotlistInput>;

export const ShotPatch = ShotBase.partial().extend({
  promptOverride: z.string().max(7000).nullable().optional().describe("null clears the override"),
});
export type ShotPatch = z.infer<typeof ShotPatch>;

export const ElementInput = z.object({
  kind: z.enum(ELEMENT_KINDS),
  name: z.string().min(1).max(80),
  description: z.string().max(1200).default("").describe("Visual description the compiler and image model use"),
});
export type ElementInput = z.infer<typeof ElementInput>;

export const TakeRequest = z.object({
  n: z.number().int().min(1).max(4).default(1),
  steps: z.number().int().min(4).max(30).optional().describe("Sampling steps; 8 = turbo previz, more = final"),
  seed: z.number().int().optional(),
  confirm: z.boolean().default(false).describe("Must be true to spend budget"),
});
export type TakeRequest = z.infer<typeof TakeRequest>;

export const ReviewInput = z.object({
  score: z.number().int().min(1).max(5),
  notes: z.string().max(500).default(""),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const TimelineClip = z.object({
  shotId: z.string(),
  takeId: z.string(),
  inS: z.number().min(0).default(0),
  outS: z.number().max(15),
  transition: z.enum(["cut", "dissolve"]).default("cut"),
  transitionS: z.number().min(0.2).max(1).optional(),
  repeat: z.number().int().min(1).max(120).default(1).describe("Play the clip this many times back to back (loops)"),
});
export const TimelineInput = z.object({
  clips: z.array(TimelineClip).default([]),
  music: z.string().optional().describe("Asset id of a music track"),
  mix: z.object({ dialogueDb: z.number().default(0), sfxDb: z.number().default(-3), musicDb: z.number().default(-12) }).prefault({}),
});
export type TimelineInput = z.infer<typeof TimelineInput>;

export const ExportRequest = z.object({
  preset: z.enum(EXPORT_PRESETS).default("master-768p"),
  burnInSubtitles: z.boolean().default(false),
  confirm: z.boolean().default(false),
});
export type ExportRequest = z.infer<typeof ExportRequest>;

export const ProjectInput = z.object({
  name: z.string().min(1).max(120),
  look: LookSettings.partial().optional(),
  budgetCapUsd: z.number().min(0).max(100000).optional(),
  brief: z.string().max(8000).default("").describe("Tier 1: the user's own words for the film"),
  targetSeconds: z.number().int().min(5).max(3600).optional().describe("Target running time"),
});

export const ProjectPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  budgetCapUsd: z.number().min(0).max(100000).optional(),
  brief: z.string().max(8000).optional(),
  targetSeconds: z.number().int().min(5).max(3600).nullable().optional(),
});

export const PresignRequest = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]),
  size: z.number().int().min(1).max(500 * 1024 * 1024),
});

export const CommitUploadRequest = z.object({
  key: z.string().min(1),
  kind: z.enum(["image", "video", "audio"]),
  projectId: z.string().optional(),
});

export const EvalVote = z.object({
  takeA: z.string(),
  takeB: z.string(),
  winner: z.enum(["a", "b", "tie"]),
  scores: z.object({
    consistency: z.number().int().min(1).max(5),
    action: z.number().int().min(1).max(5),
    camera: z.number().int().min(1).max(5),
    audio: z.number().int().min(1).max(5),
  }),
});
