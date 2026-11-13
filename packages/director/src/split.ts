import type { Beat, DialogueLine, Shot } from "./types.js";

/*
 * Long action is chained shots, not one long generation.
 *
 * The project's rule, by the user's choice (2026-11-13: "6 + 6" over one 12 s
 * shot): an action that needs more than a shot's usual length is written as
 * two shots, the second continuing from the first's last frame (`continuous`).
 * It is a decision, not a measurement: nobody rendered the two against each
 * other on H3. What it buys is known: each half is one action in one
 * generation, a retake costs half, and the user picks the first half before
 * the second is rendered from it. What it costs is known too: a seam the
 * model can miss, and an anchor to wait for.
 *
 * splitShot does the division at a beat boundary; nothing is rewritten.
 */

/**
 * Where a long shot can be cut in two: a beat boundary on a whole second
 * that leaves 5 s or more on both sides, the one nearest the middle.
 */
export function splitPoint(shot: Shot): number | string {
  if (shot.durationS < 10) return `this shot is ${shot.durationS} s, and two chained shots need 5 s each: keep it at 8 s or less, or give the action 10 s or more and split it`;
  if (shot.beats.length < 2) return "a shot is split at a beat boundary and this one has one beat: write the action as two beats, one for each half";
  const cuts = [...shot.beats].sort((a, b) => a.from - b.from).slice(1).map((b) => b.from).filter((t) => Number.isInteger(t) && t >= 5 && shot.durationS - t >= 5);
  if (!cuts.length) return `no beat boundary of this shot falls on a whole second with 5 s on both sides (boundaries: ${shot.beats.slice(1).map((b) => b.from).join(", ")} s of ${shot.durationS} s): move one there`;
  const mid = shot.durationS / 2;
  return cuts.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0]!;
}

type Timed = DialogueLine & { startS?: number; endS?: number };

/**
 * One shot as two, the second continuing from the first's last frame: the
 * beats, lines, frames and state are divided at `atS`, nothing is rewritten.
 */
export function splitShot(shot: Shot, atS?: number): { first: Shot; second: Shot; atS: number } {
  const at = atS ?? splitPoint(shot);
  if (typeof at === "string") throw new Error(at);
  if (!shot.beats.some((b) => Math.abs(b.from - at) < 0.01)) throw new Error(`${at} s is not a beat boundary of this shot`);
  const head = shot.beats.filter((b) => b.to <= at + 0.01);
  const tail: Beat[] = shot.beats.filter((b) => b.from >= at - 0.01).map((b) => ({ ...b, from: round(b.from - at), to: round(b.to - at), ...(Math.abs(b.from - at) < 0.01 ? { cut: undefined } : {}) }));
  const lines = (shot.dialogue ?? []) as Timed[];
  /* a line with no time stays where its place in the list puts it: with the first half */
  const early = lines.filter((l) => l.startS === undefined || l.startS < at);
  const late = lines.filter((l) => l.startS !== undefined && l.startS >= at).map((l) => ({ ...l, startS: round(l.startS! - at), ...(l.endS !== undefined ? { endS: round(l.endS - at) } : {}) }));
  const { state, frames, screenS: _screenS, promptOverride: _override, id: _id, ...rest } = shot;
  const first: Shot = { ...rest, durationS: at, beats: head, dialogue: early, ...(frames?.first ? { frames: { first: frames.first } } : {}) };
  const second: Shot = {
    ...rest, durationS: shot.durationS - at, beats: tail, dialogue: late, mode: "keyframe", link: { type: "continuous" }, linkToPrev: "continuous",
    ...(frames?.last ? { frames: { last: frames.last } } : {}), ...(state ? { state } : {}),
  };
  return { first, second, atS: at };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
