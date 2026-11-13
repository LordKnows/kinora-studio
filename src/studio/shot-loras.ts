import type { LoraRef, ShotLora } from "./schemas";

/* LoRAs are per shot. The user does not pick them: the director assigns the
   style / effect LoRAs that suit each shot once the board is designed
   (assign_loras, each with why), and the shot carries two switches the user
   sees on it — use turbo (the speed LoRA for the shot's workflow) and use
   LoRA (the assigned ones). Both are on unless the shot turns them off; the
   settings follow whatever loads (models.ts resolveParams).

   Pure functions: the compiler, the lint, the migration of the old
   project-wide Look LoRAs and the shot editor share them. */

export const H3_FAMILY = "minimax-h3";

type LoraShape = { id: string; name: string; kind: string; workflows: string[]; baseModel?: string };
type SpecShape = { mode: string; link?: { type: string }; loras?: ShotLora[]; useTurbo?: boolean; useLoras?: boolean };

/** The H3 workflows a shot can render on (a keyframe shot is I2VA with one frame, FL2VA with two). */
export function shotWorkflows(spec: { mode: string; link?: { type: string } }): string[] {
  if (spec.link?.type === "match_cut" || spec.mode === "reference") return ["R2VA"];
  if (spec.mode === "keyframe") return ["I2VA", "FL2VA"];
  if (spec.mode === "edit") return ["R2VA"];
  return ["T2VA"];
}

/** Trained for H3 and for this workflow (a LoRA that names no workflow fits them all). */
export function trainedFor(l: Pick<LoraShape, "workflows" | "baseModel">, workflow: string): boolean {
  return (l.baseModel ?? H3_FAMILY) === H3_FAMILY && (l.workflows.length === 0 || l.workflows.includes(workflow));
}

/** Fits at least one of the workflows the shot can render on. */
export function fitsShot(l: Pick<LoraShape, "workflows" | "baseModel">, spec: { mode: string; link?: { type: string } }): boolean {
  return shotWorkflows(spec).some((w) => trainedFor(l, w));
}

/** The turbo LoRA for a workflow: the speed LoRA trained for H3 that names it, else one that names none. One, never two. */
export function turboFor<L extends LoraShape>(library: L[], workflow: string): L | undefined {
  const speed = library.filter((l) => l.kind === "speed" && trainedFor(l, workflow));
  return speed.find((l) => l.workflows.includes(workflow)) ?? speed[0];
}

/** The shot's two switches, with their defaults: both on unless the shot turns one off. */
export function shotSwitches(spec: { useTurbo?: boolean; useLoras?: boolean }): { turbo: boolean; loras: boolean } {
  return { turbo: spec.useTurbo !== false, loras: spec.useLoras !== false };
}

/** The style / effect LoRAs assigned to the shot. A speed LoRA left in an older list is the turbo switch's business, not an assignment. */
export function assignedRefs(spec: { loras?: ShotLora[] }, kindOf: (id: string) => string | undefined): ShotLora[] {
  return (spec.loras ?? []).filter((r) => kindOf(r.id) !== "speed");
}

/** Where the shot stands: assigned (with names), none suits, or not considered yet. */
export function assignmentState(spec: Pick<SpecShape, "loras">): "assigned" | "none" | "unassigned" {
  return spec.loras === undefined ? "unassigned" : spec.loras.length ? "assigned" : "none";
}

/* ---------- the move from project-wide LoRAs ---------- */

export const CARRIED_FROM_LOOK = "was in the project's Look for every shot";
export const CARRIED_FROM_SHOT = "was set on this shot before LoRAs were assigned per shot";

/**
 * One shot's spec under the old model (the Look's LoRAs, which a shot could
 * override) rewritten for the new one: use turbo is on where a speed LoRA
 * loaded, the style / effect LoRAs that loaded become the shot's assignment.
 * Returns null for a shot already moved (it carries useTurbo). Idempotent.
 */
export function carryLookLoras(spec: Record<string, unknown>, lookLoras: LoraRef[], kindOf: (id: string) => string | undefined): Record<string, unknown> | null {
  if (typeof spec.useTurbo === "boolean") return null;
  const own = Array.isArray(spec.loras) ? (spec.loras as LoraRef[]) : undefined;
  const refs = own ?? lookLoras;
  const turbo = refs.some((r) => kindOf(r.id) === "speed");
  const why = own ? CARRIED_FROM_SHOT : CARRIED_FROM_LOOK;
  const others = refs.filter((r) => { const k = kindOf(r.id); return k !== undefined && k !== "speed"; }).slice(0, 3).map((r) => ({ id: r.id, ...(r.strength !== undefined ? { strength: r.strength } : {}), why }));
  const next: Record<string, unknown> = { ...spec, useTurbo: turbo };
  if (own !== undefined) next.loras = others;
  else if (others.length) next.loras = others;
  else delete next.loras;
  return next;
}

/**
 * save_shotlist rewrites a matched shot's spec: the user's switches and the
 * director's assignment stay unless the new spec sets them (the lint flags
 * an assignment the shot can no longer load).
 */
export function keepShotLoras<S extends { loras?: ShotLora[]; useTurbo?: boolean; useLoras?: boolean }>(prev: S, next: S): S {
  const out = { ...next };
  if (out.loras === undefined && prev.loras !== undefined) out.loras = prev.loras;
  if (out.useTurbo === undefined && prev.useTurbo !== undefined) out.useTurbo = prev.useTurbo;
  if (out.useLoras === undefined && prev.useLoras !== undefined) out.useLoras = prev.useLoras;
  return out;
}
