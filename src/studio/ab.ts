import * as director from "@/director";

import { isRejected } from "./craft-core";
import { StudioError } from "./errors";
import { compileForShot, getProjectView, type ProjectView, type ShotView } from "./orchestrator";
import * as repo from "./repo";
import type { PromptExperiments, ShotInput } from "./schemas";
import { readTake, type TakeMeasures } from "./take-checks";
import type { Take } from "./types";

/*
 * A/B tests on the self-hosted H3, on a shot of a project: the plan with what
 * each arm costs and the calls that render it, and the report that sets the
 * arms side by side from what the takes carry (the user's picks and tags,
 * blind votes, what was measured on each file). The planning itself is the
 * director package's (packages/director/src/ab.ts); nothing here renders.
 */

export type AbCall = { tool: "generate_take"; args: { shotId: string; n: 1; seed: number; experiments?: PromptExperiments; turbo?: boolean; change: string } };

export type StudioAbPlan = director.AbPlan & {
  shotId: string;
  shot: string;
  /** What one take of each arm is estimated to cost, and the test in all. */
  estimate: { perTakeUsd: Record<string, number | undefined>; totalUsd: number; takes: number };
  /** One call per arm and seed, A before B for each seed. Every one asks for its own confirmation. */
  calls: AbCall[];
  next: string;
};

function slate(view: ProjectView, shotId: string): string {
  for (const [si, sc] of view.scenes.entries()) {
    const i = sc.shots.findIndex((s) => s.id === shotId);
    if (i >= 0) return `${sc.slug} #${i + 1} (${si + 1}·${i + 1})`;
  }
  return shotId;
}

export async function planAb(shotId: string, test: director.AbTest, opts: { seeds?: number[] } = {}): Promise<StudioAbPlan> {
  const shot = await repo.getShot(shotId);
  const view = await getProjectView(shot.projectId);
  let plan: director.AbPlan;
  try {
    plan = director.planAb(test, shot.spec as never, opts);
  } catch (caught) {
    throw new StudioError("validation", caught instanceof Error ? caught.message : String(caught), { shotId, test });
  }
  const perTakeUsd: Record<string, number | undefined> = {};
  const calls: AbCall[] = [];
  if (test !== "length") {
    for (const arm of plan.arms) {
      /* arm A of the steps test is the shot's own switch: only the base-chain arm overrides it */
      const turbo = arm.turbo === false ? false : undefined;
      perTakeUsd[arm.arm] = await compileForShot(shotId, { experiments: arm.experiments, turbo }).then((c) => c.estimate.usd).catch(() => undefined);
    }
    for (const seed of plan.seeds) for (const arm of plan.arms) {
      calls.push({ tool: "generate_take", args: {
        shotId, n: 1, seed, ...(arm.experiments ? { experiments: arm.experiments } : {}), ...(arm.turbo === false ? { turbo: false } : {}),
        change: `A/B ${test}: arm ${arm.arm} (${arm.label}), seed ${seed}`,
      } });
    }
  } else {
    perTakeUsd.A = await compileForShot(shotId).then((c) => c.estimate.usd).catch(() => undefined);
    /* B's two shots add up to A's length, and the estimate is linear in length */
    perTakeUsd.B = perTakeUsd.A;
  }
  const takes = plan.seeds.length * plan.arms.length;
  const totalUsd = Math.round(plan.seeds.length * plan.arms.reduce((a, arm) => a + (perTakeUsd[arm.arm] ?? 0), 0) * 1000) / 1000;
  const next = test === "length"
    ? `Nothing is rendered or saved. Variant A is this shot as it is. For variant B add the two shots in split (first, then second, which continues from the first's last frame) to a scene of their own, slug starting "ab-length" — best in a copy of the project, since saving a shotlist puts the approval back to draft. Render A and B's first shot with the same seeds, let the user pick a take of B's first shot, then render B's second. Tell the user what it costs first (about ${totalUsd.toFixed(2)} USD for ${plan.seeds.length} seed(s)). ab_report reads scenes whose slug starts with "ab-length".`
    : `Nothing is rendered. Tell the user what the test is for and what it costs (about ${totalUsd.toFixed(2)} USD for ${takes} takes), then run the calls in order, each with confirm: true once they agree; the shot needs its passing review as for any take (an arm's prompt is its own review subject: review_packet with the arm's switches, or skipReview with the user's word). When the takes are in, the user watches and picks; then ab_report.`;
  return { ...plan, shotId, shot: slate(view, shotId), estimate: { perTakeUsd, totalUsd, takes }, calls, next };
}

/* ---------- the report ---------- */

type ArmStats = {
  arm: string;
  takes: number;
  seeds: number[];
  picked: number;
  reviewed: number;
  rejected: number;
  faults: Record<string, number>;
  /** Means over the arm's takes that carry measurements. */
  measured: { takes: number; earlyShare?: number; idleBeatShare?: number; quietLineShare?: number; endDiff?: number; findingsPerTake?: number };
  usdPerTake?: number;
  /** Blind votes on pairs across the arms: won, lost, tied. */
  votes: { won: number; lost: number; tied: number };
};

export type AbShotReport = { shotId: string; shot: string; arms: ArmStats[]; pairedSeeds: number[]; note: string };
export type AbLengthReport = { scene: string; variants: Array<{ variant: "A" | "B"; shots: string[]; seconds: number; arms: ArmStats[] }>; note: string };
export type AbReport = { shots: AbShotReport[]; length: AbLengthReport[]; caution: string; markdown: string };

/** The arm a take belongs to: its prompt switches and its chain. */
export function armOf(take: Take): string {
  const switches = Object.entries((take.input.studio_experiments ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k).sort();
  const loras = Array.isArray(take.input.loras) ? (take.input.loras as Array<{ kind?: string }>) : [];
  const chain = loras.some((l) => l.kind === "speed") ? "turbo" : "base chain";
  return `${switches.join(" + ") || "default format"} · ${chain}, ${String(take.input.steps ?? "?")} steps`;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : undefined);

function armStats(arm: string, takes: Take[], spec: ShotInput, selectedTakeId: string | undefined, votes: Array<{ takeA: string; takeB: string; winner: string }>, others: Set<string>): ArmStats {
  const ids = new Set(takes.map((t) => t.id));
  const faults: Record<string, number> = {};
  for (const t of takes) for (const f of t.review?.faults ?? []) faults[f] = (faults[f] ?? 0) + 1;
  const measures: TakeMeasures[] = takes.filter((t) => t.input.studio_checks).map((t) => readTake(t, spec).measures);
  const share = (num: (m: TakeMeasures) => number, den: (m: TakeMeasures) => number) => {
    const d = measures.reduce((a, m) => a + den(m), 0);
    return d ? Math.round((measures.reduce((a, m) => a + num(m), 0) / d) * 100) / 100 : undefined;
  };
  const tally = { won: 0, lost: 0, tied: 0 };
  for (const v of votes) {
    const aIn = ids.has(v.takeA), bIn = ids.has(v.takeB);
    if (!(aIn && others.has(v.takeB)) && !(bIn && others.has(v.takeA))) continue;
    if (v.winner === "tie") tally.tied++;
    else if ((v.winner === "a") === aIn) tally.won++;
    else tally.lost++;
  }
  return {
    arm, takes: takes.length, seeds: takes.map((t) => t.seed).filter((s): s is number => s !== undefined).sort((a, b) => a - b),
    picked: takes.filter((t) => t.id === selectedTakeId).length, reviewed: takes.filter((t) => t.review).length, rejected: takes.filter(isRejected).length, faults,
    measured: {
      takes: measures.length,
      earlyShare: avg(measures.map((m) => m.earlyShare).filter((x): x is number => x !== undefined)),
      idleBeatShare: share((m) => m.idleBeats, (m) => m.beats),
      quietLineShare: share((m) => m.quietLines, (m) => m.timedLines),
      endDiff: avg(measures.map((m) => m.endDiff).filter((x): x is number => x !== undefined)),
      findingsPerTake: avg(measures.map((m) => m.findings)),
    },
    usdPerTake: avg(takes.map((t) => t.costUsd).filter((x): x is number => x !== undefined)),
    votes: tally,
  };
}

function armsOfShot(sh: ShotView, votes: Array<{ takeA: string; takeB: string; winner: string }>): ArmStats[] {
  const done = sh.takes.filter((t) => t.status === "completed" && t.workflow !== "REMAKE" && t.workflow !== "REGEN");
  const groups = new Map<string, Take[]>();
  for (const t of done) groups.set(armOf(t), [...(groups.get(armOf(t)) ?? []), t]);
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([arm, ts]) => armStats(arm, ts, sh.spec, sh.selectedTakeId, votes, new Set(done.filter((t) => !ts.includes(t)).map((t) => t.id))));
}

const CAUTION = "Counts this small are anecdotes, not rates. Read an arm as better only when it wins on every paired seed and the user's pick agrees; a mixed result is no result. Measured columns are leads from the files (movement, sound level, the ends against their frames), not a viewing: the user's picks and tags are the result.";

function table(arms: ArmStats[]): string[] {
  const f = (x: number | undefined, d = 2) => (x === undefined ? "—" : x.toFixed(d));
  return [
    "| Arm | Takes | Picked | Rejected | Faults | Early share | Idle beats | Quiet lines | End-frame diff | Findings/take | USD/take | Votes W-L-T |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...arms.map((a) => `| ${a.arm} | ${a.takes} | ${a.picked} | ${a.rejected} | ${Object.entries(a.faults).map(([k, n]) => `${k} ${n}`).join(", ") || "—"} | ${f(a.measured.earlyShare)} | ${f(a.measured.idleBeatShare)} | ${f(a.measured.quietLineShare)} | ${f(a.measured.endDiff, 3)} | ${f(a.measured.findingsPerTake, 1)} | ${f(a.usdPerTake, 3)} | ${a.votes.won}-${a.votes.lost}-${a.votes.tied} |`),
  ];
}

/** Every shot rendered in more than one arm, and every length test, side by side. */
export async function abReport(projectId: string): Promise<AbReport> {
  const view = await getProjectView(projectId);
  const votes = await repo.listEvalVotes(projectId);
  const shots: AbShotReport[] = [];
  for (const sc of view.scenes) for (const sh of sc.shots) {
    if (sc.slug.startsWith("ab-length")) continue;
    const arms = armsOfShot(sh, votes);
    if (arms.length < 2) continue;
    const paired = arms.map((a) => new Set(a.seeds)).reduce((a, b) => new Set([...a].filter((s) => b.has(s))));
    const unjudged = arms.reduce((a, x) => a + x.takes - x.reviewed, 0);
    shots.push({
      shotId: sh.id, shot: slate(view, sh.id), arms, pairedSeeds: [...paired].sort((a, b) => a - b),
      note: [paired.size ? `${paired.size} seed(s) rendered in every arm` : "no seed was rendered in every arm: the arms differ by chance as well as by what was tested", unjudged ? `${unjudged} take(s) have no review: tag them on the Board first` : ""].filter(Boolean).join("; "),
    });
  }
  const length: AbLengthReport[] = [];
  for (const sc of view.scenes.filter((s) => s.slug.startsWith("ab-length"))) {
    if (sc.shots.length < 3) continue;
    const [a, ...b] = sc.shots;
    const row = (variant: "A" | "B", list: ShotView[]) => ({
      variant, shots: list.map((s) => slate(view, s.id)), seconds: list.reduce((n, s) => n + s.spec.durationS, 0),
      arms: list.flatMap((s) => armsOfShot(s, votes).map((x) => ({ ...x, arm: `${list.length > 1 ? `${slate(view, s.id).split(" ")[1]} · ` : ""}${x.arm}` }))),
    });
    length.push({ scene: sc.slug, variants: [row("A", [a!]), row("B", b.slice(0, 2))], note: "A is one generation; B is two, the second from the first's picked take. Put both on the timeline and let the user watch them one after the other: the seam of B and the hold of the action in A are what the test is for." });
  }
  const L: string[] = ["# A/B report", "", CAUTION, ""];
  if (!shots.length && !length.length) L.push("No shot has finished takes in more than one arm yet, and no scene named ab-length… holds a length test. plan_ab lays one out.");
  for (const s of shots) L.push(`## ${s.shot}`, "", s.note, "", ...table(s.arms), "");
  for (const l of length) {
    L.push(`## Length: ${l.scene}`, "", l.note, "");
    for (const v of l.variants) L.push(`Variant ${v.variant}: ${v.shots.join(" + ")} (${v.seconds} s)`, "", ...table(v.arms), "");
  }
  return { shots, length, caution: CAUTION, markdown: L.join("\n") };
}
