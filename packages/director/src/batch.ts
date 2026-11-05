import { baseModelFor, type LinkType, type ShotMode } from "./catalog.js";

/**
 * Batch planning: order renders by base model (R2VA first, then the fl2va
 * family), respect anchor dependencies (a linked shot renders only after its
 * anchor has a take), and sum the estimate so one confirmation covers the batch
 * within the project's budget cap.
 */
export interface BatchShot {
  shotId: string;
  /** Position in the flat shotlist order. */
  index: number;
  durationS: number;
  mode: ShotMode;
  link?: { type: LinkType; anchor?: number; anchorShotId?: string };
  /** Whether a finished (selected or latest completed) take already exists. */
  hasTake?: boolean;
  /** Estimated USD per take from `compile_prompt`, if known. */
  estimateUsd?: number;
}

export interface BatchPlan {
  groups: { baseModel: "ref2va" | "fl2va"; shotIds: string[] }[];
  /** Shots that cannot render in this batch because their anchor has no take yet. */
  deferred: { shotId: string; waitingFor: string }[];
  order: string[];
  totalEstimateUsd: number;
  withinCap: boolean;
  remainingCapUsd: number;
  /** Passes needed: each pass renders what is unblocked; linked shots wait for their anchors. */
  passes: string[][];
}

const FRAME_LINKS = new Set<LinkType>(["continuous", "bridge", "insert_return", "reverse", "jump_cut", "match_cut"]);

export function planBatch(shots: BatchShot[], budget: { capUsd: number; spentUsd: number }, opts: { perSecondUsd?: number; takesPerShot?: number; onlyMissing?: boolean } = {}): BatchPlan {
  const perSec = opts.perSecondUsd ?? 0.02;
  const takes = opts.takesPerShot ?? 1;
  const byIndex = [...shots].sort((a, b) => a.index - b.index);
  const idAt = (i: number) => byIndex.find((s) => s.index === i)?.shotId;
  const anchorOf = (s: BatchShot): string | undefined => {
    if (!s.link || !FRAME_LINKS.has(s.link.type)) return undefined;
    if (s.link.anchorShotId) return s.link.anchorShotId;
    const off = s.link.anchor ?? (s.link.type === "insert_return" || s.link.type === "reverse" ? -2 : -1);
    return idAt(s.index + off);
  };
  const wanted = byIndex.filter((s) => !(opts.onlyMissing ?? true) || !s.hasTake);
  const has = new Set(byIndex.filter((s) => s.hasTake).map((s) => s.shotId));
  const passes: string[][] = [];
  const deferred: { shotId: string; waitingFor: string }[] = [];
  let pending = [...wanted];
  // Simulate passes: a shot is unblocked when its anchor has a take or renders in an earlier pass.
  while (pending.length) {
    const ready = pending.filter((s) => { const a = anchorOf(s); return !a || has.has(a); });
    if (!ready.length) { for (const s of pending) deferred.push({ shotId: s.shotId, waitingFor: anchorOf(s) ?? "?" }); break; }
    // Within a pass: R2VA first, then fl2va; keep shotlist order inside each group.
    const ref = ready.filter((s) => baseModelFor(s.mode, s.link?.type) === "ref2va").map((s) => s.shotId);
    const fl = ready.filter((s) => baseModelFor(s.mode, s.link?.type) === "fl2va").map((s) => s.shotId);
    passes.push([...ref, ...fl]);
    for (const s of ready) has.add(s.shotId);
    pending = pending.filter((s) => !ready.includes(s));
  }
  const order = passes.flat();
  const groups: BatchPlan["groups"] = [];
  for (const id of order) {
    const s = byIndex.find((x) => x.shotId === id)!;
    const bm = baseModelFor(s.mode, s.link?.type);
    const last = groups[groups.length - 1];
    if (last && last.baseModel === bm) last.shotIds.push(id); else groups.push({ baseModel: bm, shotIds: [id] });
  }
  const total = order.reduce((a, id) => { const s = byIndex.find((x) => x.shotId === id)!; return a + (s.estimateUsd ?? s.durationS * perSec) * takes; }, 0);
  const remaining = budget.capUsd - budget.spentUsd;
  return { groups, deferred, order, totalEstimateUsd: +total.toFixed(3), withinCap: total <= remaining, remainingCapUsd: +remaining.toFixed(3), passes };
}
