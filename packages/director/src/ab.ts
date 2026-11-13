import type { Beat, DialogueLine, Shot } from "./types.js";

/*
 * A/B tests on the self-hosted H3: the things the project does by default
 * without a measurement behind them.
 *
 *   format         the Studio's default serialisation against MiniMax's published prompt format
 *   restate_frame  a first-frame shot that trusts the frame against one that restates it
 *                  (MiniMax's guide says restate; the project's guide says do not)
 *   steps          the 8-step turbo LoRA against the base chain at 20 steps, on prompt following
 *   length         one long shot against the same action as two shots chained with `continuous`
 *
 * A plan holds everything fixed but the one thing under test: the same shot,
 * frames and seeds in both arms. It spends nothing; the Studio's plan_ab adds
 * the cost and the calls. What comes back is read from the takes: the user's
 * pick and tags, blind votes, and what was measured on each file.
 */

export const AB_TESTS = ["format", "restate_frame", "steps", "length"] as const;
export type AbTest = (typeof AB_TESTS)[number];

export interface AbArm {
  /** "A" is always what the project does today. */
  arm: "A" | "B";
  label: string;
  /** What a take of this arm is rendered with, beside the seed. */
  experiments?: Record<string, boolean>;
  /** false = the base chain (no speed LoRA); left out = the shot's own switch. */
  turbo?: boolean;
}

export interface AbPlan {
  test: AbTest;
  question: string;
  arms: AbArm[];
  /** The seeds every arm renders with: one take per arm and seed. */
  seeds: number[];
  /** What stays the same in both arms. */
  hold: string[];
  /** What to read on the takes, most telling first. */
  read: string[];
  /** What the answer will and will not show. */
  limits: string[];
  /** length only: the two-shot variant to add beside the long shot. */
  split?: { first: Shot; second: Shot; atS: number };
}

const DEFAULT_SEEDS = [11, 23];

const READ_COMMON = [
  "the user watches each pair and picks: the pick and the fault tags are the result (the Board, or blind on the eval page)",
  "what was measured on each file (get_take → measured): the movement of each beat against its window, sound where each line should be, the last frame against its end frame",
];

/** Whether a shot can carry a test, and why not when it cannot. */
export function abFits(test: AbTest, shot: Shot): string | undefined {
  if (test === "restate_frame" && shot.mode !== "keyframe") return "restate_frame is about a shot that starts from a first frame: it needs keyframe mode";
  if (test === "format" && shot.promptOverride?.trim()) return "this shot has a promptOverride: the compiler's format does not reach it";
  if (test === "length") {
    const at = splitPoint(shot);
    if (typeof at === "string") return at;
  }
  return undefined;
}

/**
 * Where a long shot can be cut in two: a beat boundary on a whole second
 * that leaves 5 s or more on both sides, the one nearest the middle.
 */
export function splitPoint(shot: Shot): number | string {
  if (shot.durationS < 10) return `the length test compares one long shot with two chained ones: this shot is ${shot.durationS} s, and two shots need 5 s each`;
  if (shot.beats.length < 2) return "the length test cuts at a beat boundary: this shot has one beat. Write the action as two beats first";
  const cuts = [...shot.beats].sort((a, b) => a.from - b.from).slice(1).map((b) => b.from).filter((t) => Number.isInteger(t) && t >= 5 && shot.durationS - t >= 5);
  if (!cuts.length) return `no beat boundary of this shot falls on a whole second with 5 s on both sides (boundaries: ${shot.beats.slice(1).map((b) => b.from).join(", ")} s of ${shot.durationS} s)`;
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

/** The plan for one test on one shot. Throws when the shot cannot carry it (abFits says why). */
export function planAb(test: AbTest, shot: Shot, opts: { seeds?: number[] } = {}): AbPlan {
  const misfit = abFits(test, shot);
  if (misfit) throw new Error(misfit);
  const seeds = opts.seeds?.length ? opts.seeds : DEFAULT_SEEDS;
  const hold = ["the shot, its frames and references", "the seeds: each seed renders once in each arm", "the steps and the LoRAs, unless they are what is tested"];
  const few = `${seeds.length} seed(s) an arm is an anecdote: a clear difference on every pair is a reason to look further, a mixed result is no result. Repeat on two or three shots of different kinds before changing a default`;

  if (test === "format") {
    return {
      test, seeds, hold,
      question: "Does H3 on the 8-step turbo chain follow the shot better when the prompt is written as MiniMax's prompt guides write it than in the Studio's default serialisation?",
      arms: [
        { arm: "A", label: "the Studio's default format" },
        { arm: "B", label: "MiniMax's published format (experiments.officialFormat)", experiments: { officialFormat: true } },
      ],
      read: [...READ_COMMON, "beats and lines above all: the official format writes no time inside a shot, so look at whether the actions come in order and take their share of the take, and whether a line lands in its beat"],
      limits: [few, "the two formats differ in five places at once (instruction line, the first-and-last-frame sentence, the text-to-video header, time inside a shot, the camera as a sentence): a win says the bundle is better, not which part", "what captions the turbo LoRA was distilled with is not published, so neither format is the trained one by definition"],
    };
  }
  if (test === "restate_frame") {
    return {
      test, seeds, hold,
      question: "Does a first-frame take hold small details (a hat, a tattoo, what is in a hand) better when the prompt restates what the frame shows, as MiniMax's guide asks for image-to-video, than when it trusts the frame alone?",
      arms: [
        { arm: "A", label: "the frame is trusted: the prompt says what happens" },
        { arm: "B", label: "the prompt restates the first frame (experiments.restateFrame)", experiments: { restateFrame: true } },
      ],
      read: ["the last frame and the thumbnails of each take against the first frame: is every person, garment, prop and fixed feature still there and unchanged (view_frames; identity_drift, wardrobe_or_prop_lost, object_appears)", ...READ_COMMON, "movement: restating a still picture may hold the take still; compare measures.earlyShare and the motion findings of the two arms"],
      limits: [few, "pick a shot with something to lose: a fixed feature, a prop in hand, two people", "it is a separate question from the format: run it under the format the format test favoured"],
    };
  }
  if (test === "steps") {
    return {
      test, seeds, hold: [...hold.slice(0, 2), "the prompt: both arms compile the same text"],
      question: "Does the 8-step turbo LoRA follow the prompt as well as the base chain at 20 steps: timed beats, cuts, the camera move, spoken lines?",
      arms: [
        { arm: "A", label: "the turbo LoRA, 8 steps (the shot's switch as it is)", turbo: true },
        { arm: "B", label: "the base chain, about 20 steps, no speed LoRA (about 2.5 times the render time)", turbo: false },
      ],
      read: [...READ_COMMON, "the camera move: does the picture do the one move the shot asks for, at its amplitude (the thumbnails in order; the user on the video)", "a shot with a line: is it spoken, in its window, by the right person (the user listens; transcribe_audio for the words)"],
      limits: [few, "MiniMax and ComfyUI say the turbo LoRA costs motion and audio quality and say nothing about prompt following: this test is about following, so pick a shot that asks for something exact (two timed beats, a cut, a line)", "the base chain also changes the sampler and the shift: it is the whole chain against the whole chain"],
    };
  }
  const split = splitShot(shot);
  return {
    test, seeds, split,
    hold: ["the action, the beats' words, the frames and references", "the seeds", "the steps and the LoRAs"],
    question: `Is one ${shot.durationS} s generation better or worse than the same action as ${split.first.durationS} s + ${split.second.durationS} s chained with continuous?`,
    arms: [
      { arm: "A", label: `one shot of ${shot.durationS} s` },
      { arm: "B", label: `two shots, ${split.first.durationS} s then ${split.second.durationS} s continuing from the first's last frame` },
    ],
    read: [
      "the user watches A against B on the timeline (put both on it, one after the other, and export preview-480p): which holds the action, and does B's seam show",
      "identity and props at the end of each variant against its start (view_frames on the last frames)",
      "what was measured: each beat's movement against its window in A, and in B the first shot's last frame against the second's first (check_seams)",
      "cost: the retro and get_take give each take's GPU time; B pays a second generation and waits for its anchor",
    ],
    limits: [few, "B's second shot can only render after a take of the first is picked: its result depends on which take that was", "length and the number of beats change together in A: a failure there may be the length or the two actions in one generation"],
  };
}
