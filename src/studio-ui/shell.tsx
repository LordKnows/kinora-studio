"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { Lamp, Skeleton } from "./common";
import { GpuMenu } from "./gpu-panel";
import { useProject } from "./use-project";

/* Two shells. TopBar is on every surface: brand, where you are, the GPU
   pill, the global pages. ProjectShell adds the left rail with the six
   steps of a film in working order and the budget; GlobalShell is the plain
   frame for the home, Library, Machine and Connect pages. Pages read the
   shared project view through ProjectContext so one SSE subscription serves
   the whole project. */

type Ctx = { projectId: string; view: ProjectView | null; error: string | null; loading: boolean; reload: () => Promise<void> };

const ProjectContext = createContext<Ctx | null>(null);

export function useProjectContext(): Ctx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext outside ProjectShell");
  return ctx;
}

export const PROJECT_NAV: Array<{ slug: string; label: string; step: string }> = [
  { slug: "look", label: "Brief & style", step: "1" },
  { slug: "script", label: "Script", step: "2" },
  { slug: "elements", label: "Elements", step: "3" },
  { slug: "board", label: "Board", step: "4" },
  { slug: "pictures", label: "Pictures", step: "·" },
  { slug: "finals", label: "Finals", step: "5" },
  { slug: "timeline", label: "Timeline", step: "6" },
];

const GLOBAL_NAV: Array<{ href: string; label: string }> = [
  { href: "/", label: "Projects" },
  { href: "/library", label: "Library" },
  { href: "/machine", label: "Machine" },
  { href: "/connect", label: "Connect" },
];

export function TopBar({ crumb }: { crumb?: ReactNode }) {
  const pathname = usePathname();
  return (
    <header className="st-topbar">
      <Link className="st-brand" href="/">
        <span className="st-brand-mark">H3</span>
        Cinema Studio
      </Link>
      {crumb && <div className="st-topbar-crumb">{crumb}</div>}
      <div className="st-topbar-spacer" />
      <GpuMenu />
      <nav className="st-topbar-nav" aria-label="Studio">
        {GLOBAL_NAV.map((item) => {
          const current = item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

export function GlobalShell({ children, crumb }: { children: ReactNode; crumb?: ReactNode }) {
  return (
    <>
      <TopBar crumb={crumb} />
      <main className="st-main">{children}</main>
    </>
  );
}

export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { view, error, loading, reload } = useProject(projectId);
  const pathname = usePathname();
  const spent = view?.project.spentUsd ?? 0;
  const cap = view?.project.budgetCapUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const target = view?.project.targetSeconds;
  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  const lampFor = (slug: string): { state: string; label: string } | null => {
    if (!view) return null;
    if (slug === "script") {
      const a = view.script?.approval ?? "none";
      return a === "approved" ? { state: "ok", label: "approved" } : a === "none" ? { state: "draft", label: "empty" } : { state: "warn", label: "draft" };
    }
    if (slug === "board") {
      const a = view.project.shotlistApproval;
      return a === "approved" ? { state: "ok", label: "approved" } : { state: "warn", label: "draft" };
    }
    return null;
  };
  const items = PROJECT_NAV.map((item) => {
    const href = `/p/${projectId}/${item.slug}`;
    return { ...item, href, current: pathname === href || pathname?.startsWith(`${href}/`), lamp: lampFor(item.slug) };
  });
  return (
    <ProjectContext.Provider value={{ projectId, view, error, loading, reload }}>
      <TopBar crumb={<><span>/</span><strong title={view?.project.name}>{view?.project.name ?? (loading ? "…" : "Project")}</strong></>} />
      <div className="st-shell">
        <nav className="st-rail" aria-label="Project">
          <div className="st-rail-head">
            <Link className="st-rail-brand" href="/">← All projects</Link>
            <div className="st-rail-name" title={view?.project.name}>{view?.project.name ?? (loading ? "…" : "Project")}</div>
            <div className="st-rail-budget">
              <span>Spent</span>
              <span className="st-num">{usd(spent)} / {usd(cap)}</span>
            </div>
            <div className="st-rail-bar" data-over={spent > cap ? "true" : "false"}>
              <span style={{ width: `${pct}%` }} />
            </div>
            {target !== undefined && (
              <div className="st-rail-target st-num" data-match={boardSeconds === target ? "true" : "false"}>
                board {boardSeconds} s · target {target} s
              </div>
            )}
          </div>
          <div className="st-rail-nav">
            {items.map((item) => (
              <Link key={item.slug} href={item.href} aria-current={item.current ? "page" : undefined}>
                <span className="st-row" style={{ gap: 10, flexWrap: "nowrap" }}>
                  <span className="st-step">{item.step}</span>
                  <span>{item.label}</span>
                </span>
                {item.lamp && <Lamp state={item.lamp.state} label={item.lamp.label} />}
              </Link>
            ))}
          </div>
          <div className="st-rail-foot">
            {view && (view.canGenerate ? <Lamp state="ok" label="Ready to render" /> : <span>{view.blockers.join(" · ")}</span>)}
            <Link href={`/p/${projectId}/settings`}>Project settings</Link>
          </div>
        </nav>
        <main className="st-main">
          {error && !view ? (
            <div className="st-page">
              <div className="st-alert" role="alert">
                <span>{error}</span>
              </div>
            </div>
          ) : !view && loading ? (
            <div className="st-page st-stack">
              <Skeleton height={28} />
              <Skeleton height={220} />
              <Skeleton height={220} />
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      <nav className="st-tabsbar" aria-label="Project pages">
        {items.map((item) => (
          <Link key={item.slug} href={item.href} aria-current={item.current ? "page" : undefined}>
            <span className="st-step">{item.step}</span>
            <span>{item.label.split(" ")[0]}</span>
          </Link>
        ))}
      </nav>
    </ProjectContext.Provider>
  );
}
