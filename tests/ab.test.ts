import { beforeAll, describe, expect, it } from "vitest";

import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import { abReport, armOf, planAb } from "@/studio/ab";
import { mapRunPodStatus } from "@/studio/backends/runpod";
import * as director from "@/director";
import * as craft from "@/studio/craft";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotInput, ShotlistInput } from "@/studio/schemas";
import type { Actor } from "@/studio/types";

/* A/B tests on a shot of a project: the plan with its cost and calls, a take
   on the other chain, a review of an arm's own prompt, and the report by arm. */

const web: Actor = { user: "tester@local", via: "web" };
const mcp: Actor = { user: "agent", via: "mcp" };

async function memoryDb(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db: Db = {
    async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
    async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
    async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
    async exec(sql: string) { sqlite.exec(sql); },
  };
  await migrate(db);
  return db;
}

let calls = 0;
let projectId = "";
let shotId = "";
let longId = "";

const shot = (over: Partial<ShotInput> = {}): ShotInput =>
  ShotInput.parse({
    durationS: 5, mode: "text", intent: "The courier crosses the square",
    beats: [{ from: 0, to: 2.5, action: "The courier walks toward frame right across the wet square" }, { from: 2.5, to: 5, action: "The courier stops at the fountain" }],
    camera: { move: "static" }, motion: ["subject"], link: { type: "cut" }, ...over,
  });

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.RUNPOD_MODE = "serverless";
  process.env.RUNPOD_API_KEY = "k";
  process.env.RUNPOD_ENDPOINT_ID = "ep";
  process.env.RUNPOD_WEBHOOK_SECRET = "s3cret";
  process.env.STUDIO_PUBLIC_URL = "https://studio.example";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    if (String(input).endsWith("/run")) return new Response(JSON.stringify({ id: `job-${calls}`, status: "IN_QUEUE" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const project = await repo.createProject({ name: "AB", budgetCapUsd: 50 });
  projectId = project.id;
  const sc = await repo.createScript(projectId, "EXT. SQUARE - DAY\nThe courier crosses and stops at the fountain.");
  await repo.approveScript(sc.id);
  const view = await orch.saveShotlist(projectId, ShotlistInput.parse({ scenes: [{ slug: "square", shots: [
    shot(),
    shot({ durationS: 12, intent: "The courier crosses the square and drinks", beats: [{ from: 0, to: 6, action: "The courier crosses the wet square toward frame right" }, { from: 6, to: 12, action: "The courier bends to the fountain and drinks" }] }),
  ] }] }));
  shotId = view.scenes[0]!.shots[0]!.id;
  longId = view.scenes[0]!.shots[1]!.id;
  await repo.setShotlistApproval(projectId, "approved");
});

const finish = async (takeId: string, checks?: Record<string, unknown>) => {
  const take = await repo.getTake(takeId);
  return orch.applyTakeStatus(take, mapRunPodStatus({ id: take.requestId!, status: "COMPLETED", executionTime: 10_000, output: { url: `https://r2/${takeId}.mp4`, last_frame_url: `https://r2/${takeId}.png`, thumb_urls: [], execution_ms: 10_000, duration_s: 5.17, ...(checks ? { checks } : {}) } }));
};
/** 5.17 s of motion at 8 fps: `early` puts all of it in the first half second. */
const motion = (early: boolean) => ({ version: 1, motion: { fps: 8, values: Array.from({ length: 41 }, (_x, i) => (early ? (i < 4 ? 0.03 : 0.0002) : 0.01)) } });

describe("plan_ab", () => {
  it("lays out two arms with the same seeds, what each costs, and the calls; nothing is rendered", async () => {
    const plan = await planAb(shotId, "format", { seeds: [7, 8] });
    expect(plan.shot).toBe("square #1 (1·1)");
    expect(plan.arms.map((a) => a.arm)).toEqual(["A", "B"]);
    expect(plan.calls.map((c) => [c.args.seed, c.args.experiments, c.args.change])).toEqual([
      [7, undefined, "A/B format: arm A (the Studio's default format), seed 7"],
      [7, { officialFormat: true }, "A/B format: arm B (MiniMax's published format (experiments.officialFormat)), seed 7"],
      [8, undefined, "A/B format: arm A (the Studio's default format), seed 8"],
      [8, { officialFormat: true }, "A/B format: arm B (MiniMax's published format (experiments.officialFormat)), seed 8"],
    ]);
    expect(plan.estimate.takes).toBe(4);
    expect(plan.estimate.perTakeUsd.A).toBeGreaterThan(0);
    expect(plan.estimate.totalUsd).toBeCloseTo(2 * (plan.estimate.perTakeUsd.A! + plan.estimate.perTakeUsd.B!), 3);
    expect(await repo.listShotTakes(shotId)).toHaveLength(0);
  });

  it("steps: only the base-chain arm overrides the shot's switch, and it costs more", async () => {
    const plan = await planAb(shotId, "steps", { seeds: [7] });
    expect(plan.calls.map((c) => c.args.turbo)).toEqual([undefined, false]);
    expect(plan.estimate.perTakeUsd.B!).toBeGreaterThan(plan.estimate.perTakeUsd.A!);
    const base = await orch.compileForShot(shotId, { turbo: false });
    expect(base.input.loras.some((l) => l.kind === "speed")).toBe(false);
    expect((await orch.compileForShot(shotId)).input.loras.some((l) => l.kind === "speed")).toBe(true);
  });

  it("refuses a shot that cannot carry the test, and says why", async () => {
    await expect(planAb(shotId, "restate_frame")).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("keyframe mode") });
    /* shot length is not a test: long action as two chained shots is the user's decision, and the lint asks for it */
    expect([...director.AB_TESTS]).toEqual(["format", "restate_frame", "steps"]);
    const { first, second } = director.splitShot((await repo.getShot(longId)).spec as never);
    expect([first.durationS, second.durationS, second.link?.type]).toEqual([6, 6, "continuous"]);
    const lint = await orch.lintProject(projectId);
    expect(lint.warnings.find((w) => w.code === "duration.complex")).toMatchObject({ severity: "warn", scene: "square", shot: 2, message: expect.stringContaining("Split_shot cuts it at 6 s into 6 s + 6 s") });
  });
});

describe("an arm's own prompt has its own review", () => {
  it("a review of the default prompt does not cover the official format, and one made with the switch does", async () => {
    const plain = await craft.reviewPacket(projectId, "shot", shotId);
    const official = await craft.reviewPacket(projectId, "shot", shotId, { experiments: { officialFormat: true } });
    expect(official.subjectHash).not.toBe(plain.subjectHash);
    expect((official.materials as { prompt: string }).prompt).toContain("Early in the shot, the courier walks toward frame right");
    await craft.recordReview(projectId, { stage: "shot", shotId, verdict: "pass", reviewer: "fresh_agent", basis: "the default prompt", findings: [] });
    await expect(orch.createTakes(shotId, { n: 1, confirm: true, seed: 7, experiments: { officialFormat: true } }, mcp)).rejects.toMatchObject({ code: "not_approved" });
    await craft.recordReview(projectId, { stage: "shot", shotId, verdict: "pass", reviewer: "fresh_agent", basis: "the official-format prompt", findings: [], experiments: { officialFormat: true } });
  });
});

describe("ab_report", () => {
  it("sets the arms side by side from the takes: picks, tags, what was measured, paired seeds", async () => {
    expect((await abReport(projectId)).shots).toEqual([]);
    /* seed 7 in both arms; the default arm's action is over early, the official arm's runs through */
    const a = (await orch.createTakes(shotId, { n: 1, confirm: true, seed: 7 }, mcp)).takes[0]!;
    await finish(a.id, motion(true));
    const b = (await orch.createTakes(shotId, { n: 1, confirm: true, seed: 7, experiments: { officialFormat: true }, change: "A/B format: arm B (officialFormat), seed 7" }, mcp)).takes[0]!;
    const doneB = await finish(b.id, motion(false));
    expect(armOf(doneB)).toBe("officialFormat · turbo, 8 steps");
    expect(doneB.input.studio_retake).toMatchObject({ of: 1, changed: ["experiments", "prompt"] });
    await orch.reviewTake(a.id, 2, "the walk is over at once", web, { faults: ["action_timing"] });
    await orch.selectTake(shotId, b.id);
    await repo.insertEvalVote({ projectId, takeA: a.id, takeB: b.id, winner: "b", scores: { consistency: 4, action: 4, camera: 3, audio: 3 }, voter: "tester@local" });

    const report = await abReport(projectId);
    expect(report.shots).toHaveLength(1);
    const [def, off] = report.shots[0]!.arms;
    expect([def!.arm, off!.arm]).toEqual(["default format · turbo, 8 steps", "officialFormat · turbo, 8 steps"]);
    expect(report.shots[0]!.pairedSeeds).toEqual([7]);
    expect(def).toMatchObject({ takes: 1, picked: 0, rejected: 1, faults: { action_timing: 1 }, votes: { won: 0, lost: 1, tied: 0 } });
    expect(off).toMatchObject({ takes: 1, picked: 1, rejected: 0, faults: {}, votes: { won: 1, lost: 0, tied: 0 } });
    /* measured on the files: nearly all of arm A's movement is in its first 30 %, and its second beat is idle */
    expect(def!.measured.earlyShare).toBeGreaterThan(0.9);
    expect(def!.measured.idleBeatShare).toBe(0.5);
    expect(off!.measured.earlyShare).toBeCloseTo(0.32, 1);
    expect(off!.measured.idleBeatShare).toBe(0);
    expect(report.shots[0]!.note).toBe("1 seed(s) rendered in every arm; 1 take(s) have no review: tag them on the Board first");
    expect(report.markdown).toContain("| default format · turbo, 8 steps | 1 | 0 | 1 | action_timing 1 |");
    expect(report.caution).toContain("anecdotes, not rates");
    /* and the retro counts the pair: the fault did not come back after the format changed (nobody tagged the second take: it was picked) */
    expect(await craft.buildRetro(projectId)).toContain("| action_timing | experiments + prompt | 1 | 0 | 0 |");
  });

  it("an agent's take on the base chain is recorded as a change of steps and LoRAs", async () => {
    const t = (await orch.createTakes(shotId, { n: 1, confirm: true, seed: 7, turbo: false, change: "A/B steps: arm B (base chain), seed 7" }, mcp)).takes[0]!;
    expect((t.input.loras as Array<{ kind: string }>).some((l) => l.kind === "speed")).toBe(false);
    expect(t.input.studio_retake).toMatchObject({ changed: expect.arrayContaining(["steps", "loras"]) });
    const done = await finish(t.id);
    expect(armOf(done)).toMatch(/^default format · base chain, \d+ steps$/);
  });
});
