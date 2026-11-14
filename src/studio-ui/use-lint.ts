"use client";

import { useEffect, useState } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { get } from "./api";
import type { LintReport } from "./needs";

/* The project's lint, refetched when something it depends on changes (the
   shotlist, the picks, the cut) and not on every progress tick of a take.
   `loading` is true until the first answer, or the first failure, arrives. */
export function useLintState(projectId: string, view: ProjectView | null): { lint: LintReport | null; loading: boolean } {
  const [lint, setLint] = useState<LintReport | null>(null);
  const [loading, setLoading] = useState(true);
  const sig = view
    ? [
        view.project.shotlistApproval, view.script?.version, view.project.updatedAt,
        view.scenes.map((s) => s.shots.map((x) => `${x.id}:${x.updatedAt}:${x.selectedTakeId ?? ""}`).join(",")).join("|"),
        JSON.stringify(view.timeline.clips.map((c) => [c.shotId, c.inS, c.outS])),
      ].join("#")
    : "";
  useEffect(() => {
    if (!sig) return;
    let alive = true;
    get<LintReport>(`/api/projects/${projectId}/lint`)
      .then((r) => alive && setLint(r))
      .catch(() => alive && setLint(null))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [projectId, sig]);
  return { lint, loading };
}

export function useLint(projectId: string, view: ProjectView | null): LintReport | null {
  return useLintState(projectId, view).lint;
}
