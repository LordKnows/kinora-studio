import { CORE_CINEMATOGRAPHY_KEYS, baseModelFor } from "../catalog.js";
import type { LintElement, Shot, Shotlist, Warning } from "../types.js";
import { lintCraft } from "./craft.js";
import { lintState } from "../state.js";
import { flatShots } from "../types.js";
import { readingTimeS } from "../narration/srt.js";

export interface LintOptions {
  /** Target running time, to check the shots tile it. */
  totalSeconds?: number;
  /** Treat `info` as noise and drop it. */
  errorsAndWarningsOnly?: boolean;
  /** Project elements: names found in beats are checked against each shot's lists. */
  elements?: LintElement[];
  /** Animated film; defaults to true when any shot sets cinematography.animation. */
  animated?: boolean;
}

/**
 * Deterministic rhythm and craft lint on a shotlist in `save_shotlist` shape.
 * These are the viewer-facing rules the Studio does not check: pace variety,
 * framing variety, a breath, static use, runs of the same link, dialogue
 * density, link/anchor sanity and render-order dependencies.
 */
export function lintShotlist(list: Shotlist, opts: LintOptions = {}): Warning[] {
  const W: Warning[] = [];
  const shots = flatShots(list);
  const n = shots.length;
  if (n === 0) return [{ code: "empty", severity: "error", message: "no shots" }];

  // Tiling
  const total = shots.reduce((a, s) => a + s.shot.durationS, 0);
  if (opts.totalSeconds && Math.abs(total - opts.totalSeconds) > Math.max(2, opts.totalSeconds * 0.05)) {
    W.push({ code: "duration.tile", severity: "warn", message: `shots add up to ${total}s, target is ${opts.totalSeconds}s` });
  }

  // Per-shot checks
  for (const { scene, shot, index } of shots) {
    const where = { scene: scene.slug, shot: index };
    if (shot.durationS < 5 || shot.durationS > 15) W.push({ code: "duration.range", severity: "error", ...where, message: `durationS ${shot.durationS} is outside 5–15` });
    const beatsEnd = Math.max(...shot.beats.map((b) => b.to));
    const beatsStart = Math.min(...shot.beats.map((b) => b.from));
    if (beatsStart !== 0 || Math.abs(beatsEnd - shot.durationS) > 0.01) W.push({ code: "beats.tile", severity: "error", ...where, message: `beats run ${beatsStart}–${beatsEnd}s but the shot is ${shot.durationS}s` });
    const sorted = [...shot.beats].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i].from - sorted[i - 1].to) > 0.01) { W.push({ code: "beats.gap", severity: "error", ...where, message: `beats leave a gap or overlap at ${sorted[i].from}s` }); break; }
    const cuts = shot.beats.filter((b) => b.cut).length;
    if (cuts > 3) W.push({ code: "beats.cuts", severity: "error", ...where, message: `${cuts} cuts inside one shot; split it` });
    if (!shot.link) W.push({ code: "link.missing", severity: "warn", ...where, message: "no link; the Studio will warn too" });
    const c = shot.cinematography ?? {};
    const missing = CORE_CINEMATOGRAPHY_KEYS.filter((k) => (k === "lighting" ? !(c.lighting && c.lighting.length) : !c[k]));
    if (missing.length) W.push({ code: "cinematography.missing", severity: "warn", ...where, message: `missing ${missing.join(", ")}` });

    // Dialogue density: ~2.5 words/s English, 4 chars/s Chinese is the ceiling the ear accepts; a 10 s shot holds about two lines.
    if (shot.dialogue?.length) {
      const need = shot.dialogue.reduce((a, d) => a + readingTimeS(d.text, d.language ?? "en"), 0);
      if (need > shot.durationS) W.push({ code: "dialogue.dense", severity: "warn", ...where, message: `dialogue needs ~${need.toFixed(1)}s of reading time in a ${shot.durationS}s shot` });
      if (shot.dialogue.length > 2 && shot.durationS <= 10) W.push({ code: "dialogue.lines", severity: "info", ...where, message: `${shot.dialogue.length} lines in ${shot.durationS}s; a 10 s shot holds about two` });
    }

    // Links and anchors
    if (shot.link) {
      const off = shot.link.anchor ?? (shot.link.type === "insert_return" || shot.link.type === "reverse" ? -2 : -1);
      const needsAnchor = shot.link.type !== "cut" && shot.link.type !== "montage" && shot.link.type !== "loop";
      if (needsAnchor && !shot.link.anchorShotId && index + off < 0) W.push({ code: "link.anchor", severity: "error", ...where, message: `link ${shot.link.type} anchors ${off} but there is no earlier shot` });
      if (shot.link.type === "match_cut" && shot.mode !== "reference") W.push({ code: "link.mode", severity: "info", ...where, message: "match_cut renders as R2VA; set mode reference to keep the editor honest" });
      if ((shot.link.type === "continuous" || shot.link.type === "bridge" || shot.link.type === "jump_cut" || shot.link.type === "insert_return" || shot.link.type === "reverse") && shot.mode === "text") W.push({ code: "link.mode", severity: "warn", ...where, message: `${shot.link.type} starts from a frame; mode text ignores it, use keyframe` });
      if (shot.link.type === "loop" && shot.mode !== "keyframe") W.push({ code: "link.mode", severity: "warn", ...where, message: "loop needs a hero frame as first and last frame (mode keyframe)" });
      if (shot.link.type === "montage" && shot.durationS > 5) W.push({ code: "montage.long", severity: "info", ...where, message: "montage beats are strongest at the minimum length (5 s)" });
    }
    if (shot.camera.move !== "static" && (c.pace === "still")) W.push({ code: "pace.still", severity: "info", ...where, message: "pace still with a moving camera; consider static" });

    // Length vs. complexity: a default from cost (a short shot is cheaper to retake, and a second of
    // video cost about 1.4× the GPU time in takes over 7 s), not a measured quality rule. Hence a hint.
    const complex = shot.beats.length > 1 || c.pace === "brisk" || c.pace === "frantic" || (shot.characters?.length ?? 0) > 0 || (shot.dialogue?.length ?? 0) > 0;
    if (shot.durationS > MAX_ACTION_S && complex && shot.link?.type !== "loop") {
      W.push({ code: "duration.complex", severity: "info", ...where, message: `${shot.durationS}s with ${shot.beats.length > 1 ? `${shot.beats.length} beats` : "action, characters or dialogue"}: the default is 5 s per action and at most ${MAX_ACTION_S} s (cheaper to retake); split into 5 s shots chained with continuous, or keep it if the action needs the time` });
    }
    if (shot.durationS >= 15 && shot.link?.type !== "loop") W.push({ code: "duration.15", severity: "info", ...where, message: "15 s is the most expensive take to redo; prefer 10 s or a continuous chain unless the frame only holds" });
  }

  // Film-level rhythm
  const paces = shots.map((s) => s.shot.cinematography?.pace).filter(Boolean);
  if (n >= 4 && new Set(paces).size <= 1) W.push({ code: "rhythm.pace", severity: "warn", message: "every shot has the same pace; alternate fast and slow and include one clear acceleration or deceleration" });
  const sizes = new Set(shots.map((s) => s.shot.cinematography?.size).filter(Boolean));
  if (n >= 6 && sizes.size < 4) W.push({ code: "rhythm.sizes", severity: "warn", message: `only ${sizes.size} shot sizes; real changes of framing need at least four` });
  const moves = new Set(shots.map((s) => s.shot.camera.move));
  if (n >= 6 && moves.size < 4) W.push({ code: "rhythm.moves", severity: "warn", message: `only ${moves.size} camera moves; use at least four different ones` });
  if (n >= 4 && !moves.has("static")) W.push({ code: "rhythm.static", severity: "info", message: "no static shot; a locked frame is the cheapest breath and H3 drifts least on it" });
  if (n >= 6 && !hasBreath(shots.map((s) => s.shot))) W.push({ code: "rhythm.breath", severity: "warn", message: "no breath: give the audience one held moment, a calm one-beat shot of ≥ 10 s at pace still/slow, or a continuous chain of still/slow shots adding up to ≥ 10 s" });
  const durations = new Set(shots.map((s) => s.shot.durationS));
  if (n >= 6 && durations.size === 1) W.push({ code: "rhythm.durations", severity: "warn", message: `every shot is ${[...durations][0]}s; vary the length, never start from N × 5 s` });
  // Runs of the same link
  let run = 1;
  for (let i = 1; i < n; i++) {
    const a = shots[i - 1].shot.link?.type, b = shots[i].shot.link?.type;
    run = a && a === b ? run + 1 : 1;
    if (run === 5 && b !== "continuous") { W.push({ code: "rhythm.linkrun", severity: "info", shot: i, message: `five "${b}" links in a row` }); }
  }
  // Sequences: >1 scene for films over 40 s
  if (opts.totalSeconds && opts.totalSeconds > 40 && list.scenes.length < 3) W.push({ code: "structure.sequences", severity: "warn", message: `${list.scenes.length} scene(s) for ${opts.totalSeconds}s; split the brief into 3–6 sequences before cutting shots` });
  // Each scene opens with reference when it has characters
  for (const scene of list.scenes) {
    const first = scene.shots[0];
    if (first && first.characters?.length && first.mode !== "reference") W.push({ code: "identity.open", severity: "info", scene: scene.slug, shot: 0, message: "a sequence with characters should open in reference mode (R2VA) so identity is set by the character sheets" });
  }
  // Render-order dependency hint
  const switches = countBaseSwitches(shots.map((s) => baseModelFor(s.shot.mode, s.shot.link?.type)));
  if (switches > 2) W.push({ code: "render.switches", severity: "info", message: `${switches} base-model switches in shotlist order; plan_batch groups R2VA shots first (~2 min per switch)` });

  // Staging, wording and the pictures video models get wrong (lint/craft.ts)
  const animated = opts.animated ?? shots.some((s) => !!s.shot.cinematography?.animation);
  W.push(...lintCraft(list, { elements: opts.elements, animated }));
  // What each element carries from shot to shot, and the shots that cannot show it (state.ts)
  W.push(...lintState(list, { elements: opts.elements }));

  return opts.errorsAndWarningsOnly ? W.filter((w) => w.severity !== "info") : W;
}

/** The default ceiling for a shot that carries an action; longer shots are for held frames and loops. A default from cost, not a measured limit. */
export const MAX_ACTION_S = 8;

function isCalm(sh: Shot): boolean {
  const p = sh.cinematography?.pace;
  return p === "still" || p === "slow";
}

/** A breath: one calm one-beat shot ≥ 10 s, or a continuous chain of calm shots adding up to ≥ 10 s. */
export function hasBreath(shots: Shot[]): boolean {
  if (shots.some((sh) => sh.durationS >= 10 && isCalm(sh) && sh.beats.length === 1)) return true;
  let run = 0;
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const continues = i > 0 && sh.link?.type === "continuous" && isCalm(shots[i - 1]) && run > 0;
    run = isCalm(sh) ? (continues ? run + sh.durationS : sh.durationS) : 0;
    if (continues && run >= 10) return true;
  }
  return false;
}

function countBaseSwitches(models: string[]): number {
  let c = 0;
  for (let i = 1; i < models.length; i++) if (models[i] !== models[i - 1]) c++;
  return c;
}
