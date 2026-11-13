import type { Shot } from "./types.js";

/*
 * A/B tests on the self-hosted H3: the things the project does by default
 * without a measurement behind them.
 *
 *   format         the Studio's default serialisation against MiniMax's published prompt format
 *   restate_frame  a first-frame shot that trusts the frame against one that restates it
 *                  (MiniMax's guide says restate; the project's guide says do not)
 *   steps          the 8-step turbo LoRA against the base chain at 20 steps, on prompt following
 *
 * Shot length is not among them: long action as chained shots is the user's
 * decision (split.ts), not a question left open.
 *
 * A plan holds everything fixed but the one thing under test: the same shot,
 * frames and seeds in both arms. It spends nothing; the Studio's plan_ab adds
 * the cost and the calls. What comes back is read from the takes: the user's
 * pick and tags, blind votes, and what was measured on each file.
 */

export const AB_TESTS = ["format", "restate_frame", "steps"] as const;
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
  return undefined;
}

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
