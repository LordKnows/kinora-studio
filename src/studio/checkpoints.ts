import { StudioError } from "./errors";
import type { Project, Script } from "./types";

/* §3.2: the two human checkpoints. Paid generation is refused until both the
   latest script and the shotlist are approved. Enforced here, on the server,
   never by the agent's goodwill. */

export function assertCanGenerate(project: Project, script: Script | undefined): void {
  if (!script || script.approval !== "approved") {
    throw new StudioError("not_approved", "The latest script is not approved yet. Approve it in the Script page.", { checkpoint: "script" });
  }
  if (project.shotlistApproval !== "approved") {
    throw new StudioError("not_approved", "The shotlist is not approved yet. Approve it on the Board.", { checkpoint: "shotlist" });
  }
}

export function assertBudget(project: Project, estimateUsd: number): void {
  if (project.spentUsd + estimateUsd > project.budgetCapUsd) {
    throw new StudioError("budget_exceeded", `This would exceed the project budget (${project.spentUsd.toFixed(2)} + ${estimateUsd.toFixed(2)} > ${project.budgetCapUsd.toFixed(2)} USD).`, {
      spentUsd: project.spentUsd, capUsd: project.budgetCapUsd, estimateUsd,
      next: "Stop here and show the user what exists: rough_cut assembles the rendered takes in order and lists the shots still missing. Never raise the cap yourself.",
    });
  }
}

export function assertConfirmed(confirm: boolean, estimateUsd: number, what: string): void {
  if (!confirm) {
    throw new StudioError("needs_confirm", `${what} costs about ${estimateUsd.toFixed(2)} USD. Call again with confirm: true.`, { estimateUsd });
  }
}

/** Which shot fields reset the shotlist approval when changed (§3.2). */
export const STRUCTURAL_SHOT_FIELDS = new Set([
  "durationS", "mode", "intent", "beats", "camera", "dialogue", "sound", "characters", "location", "props", "linkToPrev", "sourceTakeId", "editInstruction",
  "blocking", "motion", "composition",
]);

/** True when a structural field actually changed between two specs. The
    camera note is the one sub-field that is free to change. */
export function isStructuralChange(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  for (const key of STRUCTURAL_SHOT_FIELDS) {
    if (key === "camera") {
      const a = { ...(prev.camera as Record<string, unknown> | undefined) };
      const b = { ...(next.camera as Record<string, unknown> | undefined) };
      delete a.note;
      delete b.note;
      if (JSON.stringify(a) !== JSON.stringify(b)) return true;
      continue;
    }
    if (JSON.stringify(prev[key] ?? null) !== JSON.stringify(next[key] ?? null)) return true;
  }
  return false;
}
