/**
 * The Studio's vocabulary, mirrored as data so the director layer can validate
 * and fill shots without talking to the MCP. Keep in sync with
 * `cinematography_catalog` / `save_shotlist` of the Studio.
 */

export const CAMERA_MOVES = [
  "static", "push_in", "pull_out", "pan", "tilt", "truck", "pedestal",
  "arc", "tracking", "handheld", "pov", "roll", "zoom",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const LINK_TYPES = [
  "cut", "continuous", "bridge", "insert_return", "reverse",
  "match_cut", "jump_cut", "montage", "loop",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** Which H3 base model a link / mode renders on. R2VA is its own model. */
export function baseModelFor(mode: ShotMode, link?: LinkType): "ref2va" | "fl2va" {
  if (link === "match_cut") return "ref2va";
  if (mode === "reference") return "ref2va";
  return "fl2va";
}

export const SHOT_MODES = ["text", "keyframe", "reference", "edit"] as const;
export type ShotMode = (typeof SHOT_MODES)[number];

export const SIZE = ["ecu", "cu", "mcu", "ms", "mls", "ls", "els", "twoshot", "ots", "insert"] as const;
export const ANGLE = ["eye", "low", "high", "overhead", "dutch", "worm", "pov", "profile"] as const;
export const LENS = ["ultrawide", "wide", "normal", "portrait", "tele", "macro", "anamorphic", "fisheye"] as const;
export const DOF = ["shallow", "medium", "deep", "rack", "tiltshift"] as const;
export const LIGHTING = [
  "threepoint", "rembrandt", "split", "butterfly", "highkey", "lowkey", "chiaroscuro",
  "silhouette", "rim", "practicals", "neon", "golden", "blue", "overcast", "harshsun",
  "moonlight", "firelight", "volumetric", "underlight", "stage",
] as const;
export const GRADE = ["tealorange", "bleach", "mono", "pastel", "kodachrome", "crossprocess", "muted", "vivid", "sepia", "cyberpunk"] as const;
export const TEXTURE = ["35mm", "16mm", "8mm", "digital", "vhs", "cctv", "polaroid", "halftone"] as const;
export const VFX = [
  "slowmo", "speedramp", "timelapse", "hyperlapse", "longexposure", "doubleexp", "lensflare",
  "fog", "particles", "rain", "glitch", "bloom", "mirror", "splitscreen", "freeze",
  "explosion", "magic", "holo",
] as const;
export const ANIMATION = ["anime", "ghibli", "cgi", "claymation", "stopmotion", "flat2d", "watercolor", "pixel", "inkwash", "comic", "rotoscope", "lowpoly"] as const;
export const PACE = ["still", "slow", "steady", "brisk", "frantic"] as const;

export type Size = (typeof SIZE)[number];
export type Angle = (typeof ANGLE)[number];
export type Lens = (typeof LENS)[number];
export type Dof = (typeof DOF)[number];
export type Lighting = (typeof LIGHTING)[number];
export type Grade = (typeof GRADE)[number];
export type Texture = (typeof TEXTURE)[number];
export type Vfx = (typeof VFX)[number];
export type Animation = (typeof ANIMATION)[number];
export type Pace = (typeof PACE)[number];

export interface Cinematography {
  size?: Size;
  angle?: Angle;
  lens?: Lens;
  dof?: Dof;
  lighting?: Lighting[];
  grade?: Grade;
  texture?: Texture;
  vfx?: Vfx[];
  animation?: Animation;
  pace?: Pace;
}

/** The keys the Studio warns about when missing. */
export const CORE_CINEMATOGRAPHY_KEYS = ["size", "angle", "lens", "lighting", "grade"] as const;

/** Transitions the Studio's assembler supports today, and the ones the local assembler adds. */
export const STUDIO_TRANSITIONS = ["cut", "dissolve"] as const;
export const LOCAL_TRANSITIONS = ["cut", "dissolve", "fade_black", "fade_white", "flash_white", "iris", "wipe"] as const;
export type LocalTransition = (typeof LOCAL_TRANSITIONS)[number];

/**
 * The H3 frame grid. The node takes a frame count of the form 17k+5 at 24 fps,
 * 124 to 362 frames, and the worker rounds a shot's seconds to the nearest
 * one. So a take is not exactly as long as the shot asks: 5 s → 124 frames
 * (5.17 s), 6 s → 141 (5.88 s), 10 s → 243 (10.13 s), 15 s → 362 (15.08 s).
 * This is the Studio compiler's formula; the compiler imports it from here.
 */
export const H3_FPS = 24;
export const H3_FRAME_MIN = 124;
export const H3_FRAME_MAX = 362;

export function h3Frames(seconds: number): number {
  const k = Math.max(0, Math.round((seconds * H3_FPS - 5) / 17));
  return Math.max(H3_FRAME_MIN, Math.min(H3_FRAME_MAX, 17 * k + 5));
}

/** The exact length of the take H3 renders for a shot of `durationS` seconds. */
export function effectiveSeconds(durationS: number): number {
  return h3Frames(durationS) / H3_FPS;
}
