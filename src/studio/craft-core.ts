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
