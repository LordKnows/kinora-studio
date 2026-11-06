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
  loras?: { id: string; strength?: number }[];
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
  loras?: { id: string; strength?: number }[];
  promptOverride?: string;
  blocking?: Blocking[];
  motion?: MotionSource[];
  composition?: Composition;
  frames?: { first?: string; last?: string };
  screenS?: number;
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
  transition?: "cut" | "dissolve";
  transitionS?: number;
  speed?: number;
  muteOwnAudio?: boolean;
}

export interface StudioTimeline {
  clips: StudioClip[];
  music?: string;
  mix?: { dialogueDb?: number; musicDb?: number; sfxDb?: number };
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
