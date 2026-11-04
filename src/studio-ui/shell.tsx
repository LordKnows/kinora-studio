"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { Lamp, Skeleton } from "./common";
import { GpuRailCard } from "./gpu-panel";
import { useProject } from "./use-project";

/* The project shell: a left rail with the six pages, the budget and the two
   checkpoint lamps. Pages read the shared view through ProjectContext so one
   SSE subscription serves the whole project. */

type Ctx = { projectId: string; view: ProjectView | null; error: string | null; loading: boolean; reload: () => Promise<void> };

const ProjectContext = createContext<Ctx | null>(null);

export function useProjectContext(): Ctx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext outside ProjectShell");
  return ctx;
}

const NAV: Array<{ slug: string; label: string }> = [
  { slug: "look", label: "Look" },
  { slug: "script", label: "Script" },
  { slug: "elements", label: "Elements" },
  { slug: "board", label: "Board" },
  { slug: "timeline", label: "Timeline" },
  { slug: "settings", label: "Settings" },
];

export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { view, error, loading, reload } = useProject(projectId);
  const pathname = usePathname();
  const spent = view?.project.spentUsd ?? 0;
  const cap = view?.project.budgetCapUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const target = view?.project.targetSeconds;
  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  return (
    <ProjectContext.Provider value={{ projectId, view, error, loading, reload }}>
      <div className="st-shell">
        <nav className="st-rail" aria-label="Project">
          <div className="st-rail-head">
            <Link className="st-rail-brand" href="/">
              ← Projects
            </Link>
            <div className="st-rail-name" title={view?.project.name}>
              {view?.project.name ?? (loading ? "…" : "Project")}
            </div>
            <div className="st-rail-budget">
              {usd(spent)} of {usd(cap)}
            </div>
            <div className="st-rail-bar" data-over={spent > cap ? "true" : "false"}>
              <span style={{ width: `${pct}%` }} />
            </div>
            {target !== undefined && (
              <div className="st-rail-target st-num" data-match={boardSeconds === target ? "true" : "false"}>
                target {target} s · board {boardSeconds} s
              </div>
            )}
          </div>
          <div className="st-rail-nav">
            {NAV.map((item) => {
              const href = `/p/${projectId}/${item.slug}`;
              const current = pathname === href || pathname?.startsWith(`${href}/`);
              const lamp = item.slug === "script" ? view?.script?.approval ?? "none" : item.slug === "board" ? view?.project.shotlistApproval : null;
              return (
                <Link key={item.slug} href={href} aria-current={current ? "page" : undefined}>
                  <span>{item.label}</span>
                  {lamp && <Lamp state={lamp} label={lamp === "approved" ? "approved" : lamp === "none" ? "empty" : "draft"} />}
                </Link>
              );
            })}
          </div>
          <GpuRailCard />
          <div className="st-rail-foot">
            {view && (view.canGenerate ? <Lamp state="approved" label="Ready to render" /> : <span>{view.blockers.join(" · ")}</span>)}
            <Link href="/playground">Playground</Link>
          </div>
        </nav>
        <main>
          {error && !view ? (
            <div className="st-page">
              <div className="st-alert" role="alert">
                <span>{error}</span>
              </div>
            </div>
          ) : !view && loading ? (
            <div className="st-page st-stack">
              <Skeleton height={28} />
              <Skeleton height={180} />
              <Skeleton height={180} />
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </ProjectContext.Provider>
  );
}
