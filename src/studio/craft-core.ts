import * as repo from "./repo";
import type { Autopilot, Project, ReviewStage, StageReview, Take } from "./types";

/* The pieces of the director's craft layer that the orchestrator needs while
   it spends money: a stable hash of what is about to render, the state of the
   cold-reader review for that exact subject, and the spend envelope the user
   granted on the web. No import of the orchestrator here (it imports us). */

/** FNV-1a, 64-bit, hex. A change detector, not a security primitive. */
export function hashOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

type Img = { url: string; role: string };

/** What a take renders: the workflow, the prompt and the input frames. Two
    takes with the same hash differ only by seed. */
/** Audio inputs (voice references, an anchored line) join the hash only when
    present, so every hash computed before they existed stays the same. */
export function renderHash(workflow: string, prompt: string, images: Img[], audio: string[] = []): string {
  return hashOf({ workflow, prompt, images: images.map((i) => `${i.role}:${i.url}`), ...(audio.length ? { audio } : {}) });
}

/** The audio inputs of a worker input, as renderHash takes them. */
export function audioInputs(input: Record<string, unknown>): string[] {
  const refs = Array.isArray(input.audios) ? (input.audios as { url: string; seconds?: number }[]).map((a) => `reference:${a.url}:${a.seconds ?? ""}`) : [];
  const guide = input.guide_audio as { url?: string; frame?: number } | undefined;
  return guide?.url ? [...refs, `guide:${guide.url}@${guide.frame ?? 0}`] : refs;
}

export function takeRenderHash(take: Take): string {
  const images = Array.isArray(take.input.images) ? (take.input.images as Img[]) : [];
  return renderHash(take.workflow, take.prompt, images, audioInputs(take.input as Record<string, unknown>));
}

export type ReviewState = { state: "pass" | "fail" | "stale" | "none"; review?: StageReview };

/** The latest review of a stage, and whether it still covers what would be
    sent now (a revised prompt or a new frame makes it stale). */
export async function reviewState(projectId: string, stage: ReviewStage, subjectHash: string, shotId?: string): Promise<ReviewState> {
  const all = await repo.listReviews(projectId, { stage, shotId });
  const latest = all[0];
  if (!latest) return { state: "none" };
  const current = all.find((r) => r.subjectHash === subjectHash);
  if (!current) return { state: "stale", review: latest };
  return { state: current.verdict, review: current };
}

/** A take the user turned down: low score or tagged faults. */
export function isRejected(take: Take): boolean {
  return !!take.review && (take.review.score <= 2 || (take.review.faults?.length ?? 0) > 0);
}

/** Earlier takes of this shot that would render exactly the same thing. */
export function identicalTakes(takes: Take[], hash: string): { rejected: Take[]; any: Take[] } {
  const same = takes.filter((t) => (t.status === "completed" || t.status === "failed") && takeRenderHash(t) === hash);
  return { rejected: same.filter(isRejected), any: same };
}

export function autopilotActive(a: Autopilot | undefined, now = Date.now()): a is Autopilot {
  return !!a && a.envelopeUsd > 0 && (!a.expiresAt || a.expiresAt > now);
}

/** Whether the envelope still covers this spend. */
export function autopilotCovers(project: Project, usd: number): boolean {
  const a = project.autopilot;
  return autopilotActive(a) && a.usedUsd + usd <= a.envelopeUsd + 1e-9;
}

/** Charge the envelope and write the decision to the log the user reviews. */
export async function consumeAutopilot(project: Project, usd: number, what: string, why: string, shotId?: string): Promise<void> {
  const a = project.autopilot!;
  await repo.setAutopilot(project.id, { ...a, usedUsd: Math.round((a.usedUsd + usd) * 10000) / 10000 });
  await repo.insertNote(project.id, "decision", "standing", {
    decision: `auto-confirmed: ${what}`, why, confidence: "envelope", spendUsd: usd, shotId, by: "autopilot",
    envelope: { usedUsd: a.usedUsd + usd, envelopeUsd: a.envelopeUsd },
  });
}

/* ---- what a retake changed, and which change got past which fault ---- */

/** What differs between two renders of one shot. "seed" alone means the same input again. */
export type RetakeChange = "prompt" | "frames" | "mode" | "steps" | "length" | "loras" | "experiments" | "remake" | "seed";

type RenderInput = { workflow: string; prompt: string; input: Record<string, unknown> };

const images = (x: RenderInput) => JSON.stringify(Array.isArray(x.input.images) ? (x.input.images as Img[]).map((i) => `${i.role}:${i.url}`) : []);
const loraNames = (x: RenderInput) => JSON.stringify(Array.isArray(x.input.loras) ? (x.input.loras as Array<{ name?: string; strength?: number }>).map((l) => `${l.name}@${l.strength ?? ""}`).sort() : []);
const switches = (x: RenderInput) => JSON.stringify(Object.entries((x.input.studio_experiments ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k).sort());

/** What a render changes against an earlier take of the same shot. */
export function retakeChanges(prev: RenderInput, next: RenderInput): RetakeChange[] {
  if (next.workflow === "REMAKE") return ["remake"];
  const out: RetakeChange[] = [];
  if (prev.workflow !== next.workflow) out.push("mode");
  if (images(prev) !== images(next)) out.push("frames");
  if (Number(prev.input.seconds) !== Number(next.input.seconds)) out.push("length");
  if (Number(prev.input.steps) !== Number(next.input.steps)) out.push("steps");
  if (loraNames(prev) !== loraNames(next)) out.push("loras");
  if (switches(prev) !== switches(next)) out.push("experiments");
  /* the prompt follows from all of the above; it counts on its own only when the words changed and the length, mode and switches did not explain it */
  if (prev.prompt !== next.prompt) out.push("prompt");
  return out.length ? out : ["seed"];
}

/** The record a retake carries (take.input.studio_retake). */
export type RetakeRecord = {
  /** The take it follows: the latest finished one of the shot. */
  of: number;
  changed: RetakeChange[];
  /** The faults tagged on the takes before it. */
  after: string[];
  /** What the director said this take changes and why. */
  change?: string;
};

export function retakeRecord(take: Take): RetakeRecord | undefined {
  const r = take.input.studio_retake as RetakeRecord | undefined;
  return r && typeof r.of === "number" && Array.isArray(r.changed) ? r : undefined;
}

export type FixOutcome = "held" | "came_back" | "unjudged";
export type FixRow = { shotId: string; fault: string; from: number; to: number; changed: RetakeChange[]; outcome: FixOutcome; note?: string };

/**
 * Every faulted take and the take after it: what changed between the two,
 * and whether the fault was gone. "held": the next take was picked, or
 * reviewed without that fault. "came_back": it carries the fault again.
 * "unjudged": nobody reviewed it, so the pair teaches nothing.
 */
export function fixLedger(shots: Array<{ id: string; selectedTakeId?: string; takes: Take[] }>): FixRow[] {
  const rows: FixRow[] = [];
  for (const sh of shots) {
    const ts = sh.takes.filter((t) => t.status === "completed").sort((a, b) => a.n - b.n);
    for (let i = 0; i + 1 < ts.length; i++) {
      const bad = ts[i]!, next = ts[i + 1]!;
      const faults = bad.review?.faults ?? [];
      if (!faults.length) continue;
      const changed = retakeRecord(next)?.changed ?? retakeChanges(bad, next);
      for (const fault of faults) {
        const outcome: FixOutcome = next.review?.faults?.includes(fault as never) ? "came_back" : next.id === sh.selectedTakeId || next.review ? "held" : "unjudged";
        rows.push({ shotId: sh.id, fault, from: bad.n, to: next.n, changed, outcome, ...(retakeRecord(next)?.change ? { note: retakeRecord(next)!.change } : {}) });
      }
    }
  }
  return rows;
}

/** fault → change → how often it held, came back, or went unjudged. */
export function fixTally(rows: FixRow[]): Array<{ fault: string; change: string; held: number; cameBack: number; unjudged: number }> {
  const m = new Map<string, { fault: string; change: string; held: number; cameBack: number; unjudged: number }>();
  for (const r of rows) {
    const change = r.changed.join(" + ");
    const key = `${r.fault}|${change}`;
    const row = m.get(key) ?? { fault: r.fault, change, held: 0, cameBack: 0, unjudged: 0 };
    if (r.outcome === "held") row.held++;
    else if (r.outcome === "came_back") row.cameBack++;
    else row.unjudged++;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => a.fault.localeCompare(b.fault) || b.held - a.held);
}
