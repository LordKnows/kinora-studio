import type {
  CameraMove, Cinematography, LinkType, ShotMode,
} from "./catalog.js";

/** Project Look as `start_film` / `update_look` take it. */
export interface Look {
  genre?: string;
  palette?: string;
  camera?: string;
  lens?: string;
  lighting?: string;
  aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
  resolution?: "768p";
  upscale?: boolean;
  negative?: string[];
}

export interface Beat {
  from: number;
  to: number;
  action: string;
  cut?: boolean;
}

export interface Camera {
  move: CameraMove;
  amplitude?: "subtle" | "moderate" | "strong";
  speed?: "slow" | "medium" | "fast";
  note?: string;
}

export interface DialogueLine {
  speaker: string;
  text: string;
  language?: string;
  delivery?: string;
  /** onscreen (default), offscreen or inner */
  kind?: "onscreen" | "offscreen" | "inner";
  startS?: number;
  endS?: number;
}

export interface Sound {
  sfx?: string[];
  ambience?: string;
  music?: string;
}

export interface Link {
  type: LinkType;
  anchor?: number;
  anchorShotId?: string;
}

export type ScreenPosition = "off_left" | "left" | "center" | "right" | "off_right" | "foreground" | "background";

export interface Blocking {
  who: string;
  from?: ScreenPosition;
  to?: ScreenPosition;
  note?: string;
}

export type MotionSource = "camera" | "subject" | "focus" | "light" | "foreground" | "background" | "weather" | "prop";

export interface Composition {
  subjectX: "left" | "center" | "right";
  headroom?: "tight" | "normal" | "generous";
  note?: string;
}

/** An element as the lint needs it (names to find in beats, fixed features). */
export interface LintElement {
  id: string;
  name: string;
  kind: "character" | "location" | "prop";
  fixedFeatures?: { feature: string; where: string }[];
}

/** The slots of an element's state: text, each a phrase that follows "wearing", "holding", or stands alone. */
export interface StateSlots {
  wardrobe?: string;
  holding?: string;
  condition?: string;
}

/** How an element is when a shot ends, where it differs from its sheet (state.ts). */
export interface ElementState extends StateSlots {
  who: string;
  /** Back to the sheet: the element carries no state from here on. */
  reset?: boolean;
}

/** A shot as `save_shotlist` takes it. */
export interface Shot {
  id?: string;
  durationS: number;
  mode: ShotMode;
  intent: string;
  beats: Beat[];
  camera: Camera;
  dialogue?: DialogueLine[];
  sound?: Sound;
  characters?: string[];
  location?: string;
  props?: string[];
  link?: Link;
  linkToPrev?: "cut" | "continuous";
  cinematography?: Cinematography;
  /** Style / effect LoRAs assigned to the shot once the board is designed (the Studio's assign_loras), each with why. */
  loras?: { id: string; strength?: number; why?: string }[];
  promptOverride?: string;
  blocking?: Blocking[];
  motion?: MotionSource[];
  composition?: Composition;
  frames?: { first?: string; last?: string };
  screenS?: number;
  /** How elements are when the shot ends, where that differs from their sheets; carried into later shots. */
  state?: ElementState[];
}

export interface Scene {
  id?: string;
  slug: string;
  summary?: string;
  location?: string;
  palette?: { colors: string[]; note?: string };
  shots: Shot[];
}

export interface Shotlist {
  scenes: Scene[];
}

/** Timeline as `save_timeline` takes it. */
export interface StudioClip {
  shotId: string;
  takeId: string;
  inS?: number;
  outS: number;
  repeat?: number;
  transition?: "cut" | "dissolve" | "fade_black" | "fade_white" | "iris" | "wipe";
  transitionS?: number;
  speed?: number;
  muteOwnAudio?: boolean;
  audioLeadS?: number;
  audioTrailS?: number;
  freezeS?: number;
}

export interface StudioTitle {
  text: string;
  atS: number;
  durationS: number;
  kind: "card" | "overlay" | "caption";
  position?: "center" | "top" | "bottom" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
  color?: string;
  background?: string;
  size?: number;
}

export interface StudioTimeline {
  clips: StudioClip[];
  music?: string;
  mix?: { dialogueDb?: number; musicDb?: number; sfxDb?: number };
  fadeInS?: number;
  fadeOutS?: number;
  titles?: StudioTitle[];
  narration?: { assetId: string; atS: number; gainDb?: number }[];
  silences?: { atS: number; durationS: number }[];
  loudnessLufs?: number | null;
}

export interface Warning {
  code: string;
  message: string;
  scene?: string;
  shot?: number;
  severity: "error" | "warn" | "info";
}

export function flatShots(list: Shotlist): { scene: Scene; shot: Shot; index: number; sceneIndex: number }[] {
  const out: { scene: Scene; shot: Shot; index: number; sceneIndex: number }[] = [];
  let index = 0;
  list.scenes.forEach((scene, sceneIndex) => {
    for (const shot of scene.shots) out.push({ scene, shot, index: index++, sceneIndex });
  });
  return out;
}
