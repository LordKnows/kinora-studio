"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, Suspense, useContext, useMemo, type ReactNode } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { Lamp, Skeleton, usePopover } from "./common";
import { filmSeconds, filmShots, tc, type FilmShot } from "./film";
import { GpuMenu } from "./gpu-panel";
import { setLang, useLang, useT } from "./i18n";
import { MenuIcon } from "./icons";
import { NoticeProvider, useTakeNotices } from "./notices";
import { useProject } from "./use-project";

/* Two shells. TopBar is on every surface: brand, where you are, the GPU
   pill, the global pages (folded into a menu on phones). ProjectShell adds
   the project bar under it: the stages of a film as one row of words, the
   budget, and the line — the whole film to scale, one segment a shot, which
   is how you move through a project (there is no side rail). GlobalShell is
   the plain frame for the home, Canvas, Library, Machine and Connect pages.
   Pages read the shared project view through ProjectContext so one SSE
   subscription serves the whole project. The Screening page is lights down:
   the shell turns dark around it and leaves the bar out, since that page
   carries its own strip of the film. */

type Ctx = { projectId: string; view: ProjectView | null; error: string | null; loading: boolean; reload: () => Promise<void> };

const ProjectContext = createContext<Ctx | null>(null);

export function useProjectContext(): Ctx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext outside ProjectShell");
  return ctx;
}

/** The stages of a film in working order. An empty slug is the Score, the project's home. */
export const PROJECT_NAV: Array<{ slug: string; label: string }> = [
  { slug: "", label: "Score" },
  { slug: "look", label: "Brief & style" },
  { slug: "script", label: "Script" },
  { slug: "elements", label: "Elements" },
  { slug: "board", label: "Board" },
  { slug: "pictures", label: "Pictures" },
  { slug: "timeline", label: "Cut" },
  { slug: "director", label: "Director" },
];

const GLOBAL_NAV: Array<{ href: string; label: string }> = [
  { href: "/", label: "Projects" },
  { href: "/canvas", label: "Canvas" },
  { href: "/library", label: "Library" },
  { href: "/machine", label: "Machine" },
  { href: "/connect", label: "Connect" },
];

function isCurrent(href: string, pathname: string | null): boolean {
  return href === "/" ? pathname === "/" : !!pathname?.startsWith(href);
}

/* EN / 中: the interface language, for this browser */
function LangSwitch() {
  const lang = useLang();
  const t = useT();
  return (
    <div className="st-lang" role="group" aria-label={t("Language")}>
      <button type="button" aria-pressed={lang === "en"} lang="en" onClick={() => setLang("en")}>EN</button>
      <button type="button" aria-pressed={lang === "zh"} lang="zh-Hans" onClick={() => setLang("zh")}>中</button>
    </div>
  );
}

export function TopBar({ crumb, menuHead }: { crumb?: ReactNode; menuHead?: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  return (
    <header className="st-topbar">
      <Link className="st-brand" href="/">
        <span className="st-brand-mark">H3</span>
        <span className="st-brand-name">Cinema Studio</span>
      </Link>
      {crumb && <div className="st-topbar-crumb">{crumb}</div>}
      <div className="st-topbar-spacer" />
      <GpuMenu />
      <LangSwitch />
      <nav className="st-topbar-nav" aria-label="Studio">
        {GLOBAL_NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={isCurrent(item.href, pathname) ? "page" : undefined}>
            {t(item.label)}
          </Link>
        ))}
      </nav>
      <NavMenu pathname={pathname} head={menuHead} />
    </header>
  );
}

/* Phones: the global pages do not fit beside the GPU pill, so the bar shows
   this button in their place (studio.css hides it on wider screens). Inside
   a project the rail is hidden too, so `head` carries what only the rail
   had: the budget, readiness and the way to Project settings. */
function NavMenu({ pathname, head }: { pathname: string | null; head?: ReactNode }) {
  const { open, setOpen, ref } = usePopover();
  const t = useT();
  return (
    <div className="st-nav-menu-anchor" ref={ref}>
      <button type="button" className="st-iconbtn" aria-label={head ? "Project and studio pages" : "Studio pages"} aria-expanded={open} aria-controls="st-nav-menu" onClick={() => setOpen((o) => !o)}>
        <MenuIcon size={16} />
      </button>
      {open && (
        /* following any link in it closes the menu */
        <div id="st-nav-menu" className="st-nav-menu" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          {head}
          <nav aria-label="Studio">
            {GLOBAL_NAV.map((item) => (
              <Link key={item.href} href={item.href} aria-current={isCurrent(item.href, pathname) ? "page" : undefined}>
                {t(item.label)}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </div>
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
  const t = useT();
  const base = `/p/${projectId}`;
  const lightsDown = pathname === `${base}/screening`;
  const spent = view?.project.spentUsd ?? 0;
  const cap = view?.project.budgetCapUsd ?? 0;
  const target = view?.project.targetSeconds;
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  const boardSeconds = filmSeconds(shots);
  const lampFor = (slug: string): { state: string; label: string } | null => {
    if (!view) return null;
    if (slug === "script") {
      const a = view.script?.approval ?? "none";
      return a === "approved" ? { state: "ok", label: t("approved") } : a === "none" ? { state: "draft", label: t("empty") } : { state: "warn", label: t("draft") };
    }
    if (slug === "board") {
      const a = view.project.shotlistApproval;
      return a === "approved" ? { state: "ok", label: t("approved") } : { state: "warn", label: t("draft") };
    }
    return null;
  };
  const settingsHref = `${base}/settings`;
  const name = view?.project.name ?? (loading ? "…" : "Project");
  const meter = (
    <>
      <span className="st-num" data-over={cap > 0 && spent > cap ? "true" : undefined}>{usd(spent)} / {usd(cap)}</span>
      {target !== undefined && <span className="st-num" data-match={boardSeconds === target ? "true" : "false"}>{t("board {b} s · target {t} s", { b: boardSeconds, t: target })}</span>}
    </>
  );
  const readiness = view && (view.canGenerate ? <Lamp state="ok" label={t("Ready to render")} /> : <Lamp state="warn" label={view.blockers.join(" · ")} />);
  /* phones: the bar's meter and the way to Project settings head the menu */
  const menuHead = (
    <nav className="st-nav-menu-project" aria-label="Project">
      <div className="st-nav-menu-meter">
        <div className="st-rail-name" title={view?.project.name}>{name}</div>
        <div className="sc-meter">{meter}</div>
        {readiness && <div className="st-nav-menu-ready">{readiness}</div>}
      </div>
      <Link href={settingsHref} aria-current={pathname === settingsHref ? "page" : undefined}>{t("Project settings")}</Link>
    </nav>
  );
  const items = PROJECT_NAV.map((item) => {
    const href = item.slug ? `${base}/${item.slug}` : base;
    const current = item.slug ? pathname === href || pathname?.startsWith(`${href}/`) : pathname === base;
    return { ...item, href, current, lamp: lampFor(item.slug) };
  });
  const body = (
    <>
      <TopBar crumb={<><span>/</span><strong title={view?.project.name}>{name}</strong></>} menuHead={menuHead} />
      {!lightsDown && (
        <div className="sc-bar">
          <div className="sc-bar-row">
            <nav className="sc-stages" aria-label="Project">
              {items.map((item) => (
                <Link key={item.slug} href={item.href} aria-current={item.current ? "page" : undefined}>
                  {t(item.label)}
                  {item.lamp && <span className="st-lamp" data-state={item.lamp.state} title={item.lamp.label} aria-label={item.lamp.label} />}
                </Link>
              ))}
            </nav>
            <div className="sc-meter">
              {meter}
              {readiness}
              <Link href={settingsHref} aria-current={pathname === settingsHref ? "page" : undefined}>{t("Settings")}</Link>
            </div>
          </div>
          {shots.length > 0 && (
            <Suspense fallback={<div className="sc-line" />}>
              <FilmLine projectId={projectId} shots={shots} />
            </Suspense>
          )}
        </div>
      )}
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
    </>
  );
  return (
    <ProjectContext.Provider value={{ projectId, view, error, loading, reload }}>
      <NoticeProvider>
        <TakeWatch view={view} base={base} />
        {lightsDown ? <div className="st-lightsdown sc-room">{body}</div> : body}
      </NoticeProvider>
    </ProjectContext.Provider>
  );
}

function TakeWatch({ view, base }: { view: ProjectView | null; base: string }) {
  useTakeNotices(view, base);
  return null;
}

/* The line: the film to scale. A gap before a segment is a cut, none is a
   continuous join; a heavier edge starts a scene. The shot in the address
   (?shot=) is where you are, and is the red one. */
export function FilmLine({ projectId, shots }: { projectId: string; shots: FilmShot[] }) {
  const here = useSearchParams().get("shot");
  const total = filmSeconds(shots);
  return (
    <nav className="sc-line" aria-label="Film">
      <div className="sc-line-track">
        {shots.map((s) => {
          const rolling = s.shot.takes.some((t) => t.status === "queued" || t.status === "running");
          const state = s.shot.id === here ? "here" : rolling ? "rolling" : s.picked ? "picked" : s.shot.takes.some((t) => t.status === "completed") ? "taken" : "planned";
          return (
            <Link key={s.shot.id} href={`/p/${projectId}/board?shot=${s.shot.id}`} className="sc-seg" style={{ flexGrow: s.durationS }} data-state={state} data-scene={s.firstOfScene ? "true" : undefined}
              data-join={s.linkIn === "continuous" ? "true" : undefined} aria-current={s.shot.id === here ? "true" : undefined}
              title={`${s.slate} · ${tc(s.startS)}–${tc(s.startS + s.durationS)} · ${s.shot.spec.intent || "Untitled shot"}`}>
              {s.slate}
            </Link>
          );
        })}
      </div>
      <span className="sc-line-end st-num">{tc(total)}</span>
    </nav>
  );
}
