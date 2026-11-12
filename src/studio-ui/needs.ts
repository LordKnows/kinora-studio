import type { ProjectView } from "@/studio/orchestrator";

import { filmShots } from "./film";
import { plural, translate, type T } from "./i18n";

/* What waits for the person: approvals, spends and choices. The director (an
   agent over MCP) does the rest, so this list is the web's main job. It is
   computed from the project view and the lint, the same data every page
   already has; nothing here is stored. */

export type LintWarning = { code: string; message: string; scene?: string; shot?: number; severity: "error" | "warn" | "info" };
export type LintReport = { warnings: LintWarning[]; counts: { error: number; warn: number; info: number } };

export type Need = {
  key: string;
  /** the big numeral: how many, or 0 for something that is missing */
  count: number;
  title: string;
  detail: string;
  action: { label: string; href: string };
  note?: string;
};

const EN = translate("en");

export function needsOf(view: ProjectView, lint: LintReport | null, base: string, t: T = EN): Need[] {
  const out: Need[] = [];
  const shots = filmShots(view);
  const warnings = lint?.warnings ?? [];

  if (!view.script) {
    out.push({ key: "script", count: 0, title: t("script"), detail: t("Nothing can be planned or rendered before there is a script."), action: { label: t("Write the script"), href: `${base}/script` } });
  } else if (view.script.approval !== "approved") {
    out.push({ key: "script", count: 1, title: t("script to approve"), detail: t("Version {v} is a draft. The shotlist is held to an approved script.", { v: view.script.version }), action: { label: t("Read and approve"), href: `${base}/script` } });
  }
  if (shots.length > 0 && view.project.shotlistApproval !== "approved") {
    out.push({ key: "shotlist", count: 1, title: t("shotlist to approve"), detail: t("{n} shots are planned and none can render until you approve them.", { n: shots.length }), action: { label: t("Open the Board"), href: `${base}/board` } });
  }
  if ((lint?.counts.error ?? 0) > 0) {
    out.push({ key: "errors", count: lint!.counts.error, title: plural(t, lint!.counts.error, "error in the shotlist", "errors in the shotlist"), detail: warnings.find((w) => w.severity === "error")?.message ?? "", action: { label: t("See the problems"), href: `${base}/director#problems` } });
  }

  const seams = warnings.filter((w) => w.code.startsWith("seam."));
  if (seams.length > 0) {
    out.push({
      key: "seams", count: seams.length, title: plural(t, seams.length, "seam jumps", "seams jump"),
      detail: t("A continuous shot starts on its anchor's last frame, and the cut leaves the anchor before it."),
      action: { label: t("Open the cut"), href: `${base}/timeline#seams` },
    });
  }

  const failed = shots.filter((s) => {
    const newest = s.shot.takes[0];
    return newest && (newest.status === "failed" || newest.status === "timeout") && !s.picked;
  });
  if (failed.length > 0) {
    out.push({ key: "failed", count: failed.length, title: plural(t, failed.length, "shot whose last roll failed", "shots whose last roll failed"), detail: t("{list}: no take is in the cut.", { list: failed.map((s) => s.slate).join(", ") }), action: { label: t("Open {s}", { s: failed[0]!.slate }), href: `${base}/board?shot=${failed[0]!.shot.id}` } });
  }

  const unpicked = shots.filter((s) => !s.picked && s.shot.takes.some((x) => x.status === "completed"));
  if (unpicked.length > 0) {
    out.push({ key: "unpicked", count: unpicked.length, title: plural(t, unpicked.length, "shot with takes, none circled", "shots with takes, none circled"), detail: t("{list}: choose the take that goes into the cut.", { list: unpicked.map((s) => s.slate).join(", ") }), action: { label: t("Screen them"), href: `${base}/screening?shot=${unpicked[0]!.shot.id}` } });
  }

  const picked = shots.filter((s) => s.picked);
  const unreviewed = picked.filter((s) => !s.picked!.review);
  if (unreviewed.length > 0) {
    const reviewed = picked.length - unreviewed.length;
    out.push({
      key: "unreviewed", count: unreviewed.length, title: plural(t, unreviewed.length, "circled take unreviewed", "circled takes unreviewed"),
      detail: reviewed === 0 ? t("No take in the cut has a score yet.") : t(reviewed === 1 ? "{p} takes are in the cut; {r} has a score." : "{p} takes are in the cut; {r} have a score.", { p: picked.length, r: reviewed }),
      action: { label: t("Screen them in order"), href: `${base}/screening?shot=${unreviewed[0]!.shot.id}` }, note: t("starts at {s}", { s: unreviewed[0]!.slate }),
    });
  }

  const pending = view.assets.filter((a) => a.kind === "image" && a.meta.review === "pending");
  if (pending.length > 0) {
    const handles = pending.map((a) => a.seq ?? 0).filter(Boolean).sort((a, b) => a - b);
    out.push({
      key: "pictures", count: pending.length, title: plural(t, pending.length, "picture awaits review", "pictures await review"),
      detail: handles.length ? t("{range}: pass each one or have it redrawn.", { range: `IMG-${handles[0]}${handles.length > 1 ? `–IMG-${handles[handles.length - 1]}` : ""}` }) : t("Pass each one or have it redrawn."),
      action: { label: t("Review them"), href: `${base}/pictures?show=review` },
    });
  }

  if (view.script && warnings.some((w) => w.code === "treatment.missing")) {
    out.push({ key: "treatment", count: 0, title: t("treatment with the script"), detail: t("No logline, arc or sound design is written down, so nothing holds the cut to them."), action: { label: t("Open the script"), href: `${base}/script` } });
  }

  if (view.project.budgetCapUsd > 0 && view.project.spentUsd > view.project.budgetCapUsd) {
    out.push({ key: "budget", count: 1, title: t("budget cap passed"), detail: t("No new take will render until the cap is raised."), action: { label: t("Project settings"), href: `${base}/settings` } });
  }
  return out;
}

/** The one next step of a project, for the red button. */
export function nextStep(view: ProjectView, base: string, t: T = EN): { label: string; href: string } {
  const shots = filmShots(view);
  if (!view.script) return { label: t("Write the script"), href: `${base}/script` };
  if (view.script.approval !== "approved") return { label: t("Approve the script"), href: `${base}/script` };
  if (shots.length === 0) return { label: t("Plan the shots"), href: `${base}/board` };
  if (view.project.shotlistApproval !== "approved") return { label: t("Approve the shotlist"), href: `${base}/board` };
  const bare = shots.filter((s) => !s.shot.takes.some((x) => x.status === "completed" || x.status === "queued" || x.status === "running"));
  if (bare.length > 0) return { label: plural(t, bare.length, "Render 1 shot", "Render {n} shots"), href: `${base}/board` };
  const open = shots.find((s) => !s.picked || !s.picked.review);
  if (open) return { label: t("Screen the takes"), href: `${base}/screening?shot=${open.shot.id}` };
  return { label: t("Cut and export"), href: `${base}/timeline` };
}

/** Lint entries of one shot (the Board keys them by scene slug and the shot's place in it, from 1). */
export function lintOfShot(lint: LintReport | null, sceneSlug: string, shotIndex: number): LintWarning[] {
  return (lint?.warnings ?? []).filter((w) => w.scene === sceneSlug && w.shot === shotIndex + 1);
}
