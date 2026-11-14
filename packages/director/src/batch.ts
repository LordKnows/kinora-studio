import { baseModelFor, effectiveSeconds, type LinkType, type ShotMode } from "./catalog.js";

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

/**
 * Rough cost when `compile_prompt` has not been called. The Studio's cost
 * model is linear: GPU-seconds per output second (an average per GPU type,
 * from finished takes) times the pod's price, times the length H3 really
 * renders on its frame grid. There is no length surcharge.
 */
export function fallbackEstimateUsd(durationS: number, perSecondUsd: number): number {
  return effectiveSeconds(durationS) * perSecondUsd;
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
  estimates: { shotId: string; usd: number; source: "compile_prompt" | "fallback" }[];
  warnings: string[];
}

const FRAME_LINKS = new Set<LinkType>(["continuous", "bridge", "insert_return", "reverse", "jump_cut", "match_cut"]);

/* `only`: plan these shots and no others (one scene of a film). The rest are still read for what they
   are: an anchor outside the list that has a take unblocks its shot, one that has none defers it. */
export function planBatch(shots: BatchShot[], budget: { capUsd: number; spentUsd: number }, opts: { perSecondUsd?: number; takesPerShot?: number; onlyMissing?: boolean; only?: string[] } = {}): BatchPlan {
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
  const only = opts.only ? new Set(opts.only) : undefined;
  const wanted = byIndex.filter((s) => (!only || only.has(s.shotId)) && (!(opts.onlyMissing ?? true) || !s.hasTake));
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
  const estimates = order.map((id) => {
    const s = byIndex.find((x) => x.shotId === id)!;
    const usd = (s.estimateUsd ?? fallbackEstimateUsd(s.durationS, perSec)) * takes;
    return { shotId: id, usd: +usd.toFixed(3), source: s.estimateUsd != null ? "compile_prompt" as const : "fallback" as const };
  });
  const total = estimates.reduce((a, e) => a + e.usd, 0);
  const remaining = budget.capUsd - budget.spentUsd;
  const fallbacks = estimates.filter((e) => e.source === "fallback").length;
  const warnings: string[] = [];
  if (fallbacks) warnings.push(`${fallbacks} shot(s) estimated from the per-second average; pass estimateUsd from compile_prompt for the compiler's own number before confirming`);
  return { groups, deferred, order, totalEstimateUsd: +total.toFixed(3), withinCap: total <= remaining, remainingCapUsd: +remaining.toFixed(3), passes, estimates, warnings };
}
