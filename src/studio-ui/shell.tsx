"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";

import { BRAND } from "@/brand";
import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { BrandMark, BrandWord } from "./brand-mark";
import { Lamp, Skeleton, usePopover, whenT } from "./common";
import { DirectorPanel } from "./director-panel";
import { filmSeconds, filmShots, tc, type FilmShot } from "./film";
import { GpuMenu } from "./gpu-panel";
import { plural, setLang, useLang, useT } from "./i18n";
import { MenuIcon } from "./icons";
import { NavIcon, type NavIconName } from "./nav-icons";
import { NoticeProvider, useTakeNotices } from "./notices";
import { useProject } from "./use-project";

/* Two shells. TopBar is on every surface: brand, where you are, the GPU
   pill, the global pages (folded into a menu on phones). ProjectShell adds
   the project bar under it: the five pages of a film (Reel, Story, Design,
   Board, Cut), each with its icon, the budget, the three tools (Screening,
   the Director panel, Settings), and the line — the whole film to scale, one
   segment a shot, which is how you move through a project. On phones the
   five pages sit in a bar at the bottom. The Director panel opens beside any
   page (?panel=director): what you asked for, what it decided, the reviews. GlobalShell is
   the plain frame for the home, Canvas, Library, Machine and Connect pages.
   Pages read the shared project view through ProjectContext so one SSE
   subscription serves the whole project. The Screening page is lights down:
   the shell turns dark around it and leaves the bar out, since that page
   carries its own strip of the film. */

type Ctx = {
  projectId: string; view: ProjectView | null; error: string | null; loading: boolean; reload: () => Promise<void>;
  /** The last address in this project outside the Screening room, query and all: where its Back button goes. Null when the room was opened directly. */
  cameFrom: () => string | null;
};

const ProjectContext = createContext<Ctx | null>(null);

export function useProjectContext(): Ctx {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext outside ProjectShell");
  return ctx;
}

/** The pages of a film in working order. An empty slug is the Reel, the project's home. */
export const PROJECT_NAV: Array<{ slug: string; label: string; icon: NavIconName }> = [
  { slug: "", label: "Reel", icon: "reel" },
  { slug: "story", label: "Story", icon: "story" },
  { slug: "design", label: "Design", icon: "design" },
  { slug: "board", label: "Board", icon: "board" },
  { slug: "cut", label: "Cut", icon: "cut" },
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
      <Link className="st-brand" href="/" aria-label={`${BRAND.name} ${BRAND.zh}`}>
        {/* the ink plate on the grey card; in the dark room (.st-lightsdown) the plate raised one step, with its edge */}
        <BrandMark className="st-brand-mark st-brand-mark--ink" size={22} />
        <BrandMark className="st-brand-mark st-brand-mark--night" size={22} ground="night" />
        <BrandWord className="st-brand-name" />
        <span className="st-brand-zh" lang="zh-Hans" aria-hidden="true">{BRAND.zh}</span>
      </Link>
      {crumb && <div className="st-topbar-crumb">{crumb}</div>}
      <div className="st-topbar-spacer" />
      <GpuMenu />
      <LangSwitch />
      <nav className="st-topbar-nav" aria-label={t("Studio pages")}>
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
      <button type="button" className="st-iconbtn" aria-label={head ? t("Project and studio pages") : t("Studio pages")} aria-expanded={open} aria-controls="st-nav-menu" onClick={() => setOpen((o) => !o)}>
        <MenuIcon size={16} />
      </button>
      {open && (
        /* following any link in it closes the menu */
        <div id="st-nav-menu" className="st-nav-menu" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          {head}
          <nav aria-label={t("Studio pages")}>
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
    <NoticeProvider>
      <TopBar crumb={crumb} />
      <main className="st-main">{children}</main>
    </NoticeProvider>
  );
}

export function ProjectShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { view, error, loading, reload } = useProject(projectId);
  const pathname = usePathname();
  const t = useT();
  const base = `/p/${projectId}`;
  const lightsDown = pathname === `${base}/screening`;
  const lastPage = useRef<string | null>(null);
  const cameFrom = useCallback(() => lastPage.current, []);
  const spent = view?.project.spentUsd ?? 0;
  const cap = view?.project.budgetCapUsd ?? 0;
  const target = view?.project.targetSeconds;
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  const boardSeconds = filmSeconds(shots);
  const lampFor = (slug: string): { state: string; label: string } | null => {
    if (!view) return null;
    if (slug === "story") {
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
  /* the director is at work while takes are rolling: its chair's back turns red */
  const rolling = shots.reduce((n, s) => n + s.shot.takes.filter((x) => x.status === "queued" || x.status === "running").length, 0);
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
    <nav className="st-nav-menu-project" aria-label={t("Project")}>
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
            <nav className="sc-stages" aria-label={t("Project")}>
              {items.map((item) => (
                <Link key={item.slug} href={item.href} aria-current={item.current ? "page" : undefined}>
                  <NavIcon name={item.icon} on={item.current} />
                  <span className="sc-stage-label">{t(item.label)}</span>
                  {item.lamp && <span className="st-lamp" data-state={item.lamp.state} title={item.lamp.label} aria-label={item.lamp.label} />}
                </Link>
              ))}
            </nav>
            <div className="sc-bar-end">
              <div className="sc-meter">
                {meter}
                {readiness}
              </div>
              <div className="sc-tools">
                <Link className="sc-tool" href={`${base}/screening`} title={t("Screening: watch the takes and the cut full screen")}>
                  <NavIcon name="screen" />
                  <span className="sc-tool-label">{t("Screen")}</span>
                </Link>
                <Suspense fallback={<span className="sc-tool"><NavIcon name="director" on={rolling > 0} /><span className="sc-tool-label">{t("Director")}</span></span>}>
                  <DirectorToggle rolling={rolling} />
                </Suspense>
                <Link className="sc-tool" href={settingsHref} aria-current={pathname === settingsHref ? "page" : undefined}>
                  <NavIcon name="settings" on={pathname === settingsHref} />
                  <span className="sc-tool-label">{t("Settings")}</span>
                </Link>
              </div>
            </div>
          </div>
          {shots.length > 0 && (
            <Suspense fallback={<div className="sc-line" />}>
              <FilmLine projectId={projectId} shots={shots} />
            </Suspense>
          )}
        </div>
      )}
      <Suspense fallback={null}>
        <DirectorDrawer projectId={projectId} view={view} rolling={rolling} />
        <WhereFrom room={`${base}/screening`} into={lastPage} />
      </Suspense>
      <main className="st-main st-main--project">
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
    <ProjectContext.Provider value={{ projectId, view, error, loading, reload, cameFrom }}>
      <NoticeProvider>
        <TakeWatch view={view} base={base} />
        {lightsDown ? <div className="st-lightsdown sc-room">{body}</div> : body}
      </NoticeProvider>
    </ProjectContext.Provider>
  );
}

/** The address with the Director panel open or closed (?panel=director), the rest of the query kept. */
function useDirectorPanel(): { open: boolean; setOpen: (open: boolean) => void } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const open = params.get("panel") === "director";
  const setOpen = (next: boolean) => {
    const q = new URLSearchParams(params.toString());
    if (next) q.set("panel", "director");
    else q.delete("panel");
    router.replace(q.size ? `${pathname}?${q}` : (pathname ?? "/"), { scroll: false });
  };
  return { open, setOpen };
}

function DirectorToggle({ rolling }: { rolling: number }) {
  const t = useT();
  const { open, setOpen } = useDirectorPanel();
  return (
    <button type="button" className="sc-tool" aria-expanded={open} aria-controls="dir-drawer" onClick={() => setOpen(!open)}
      title={rolling ? plural(t, rolling, "The director is at work: 1 take is rolling", "The director is at work: {n} takes are rolling") : t("What you asked the director for, what it decided, the reviews")}>
      <NavIcon name="director" on={rolling > 0} />
      <span className="sc-tool-label">{t("Director")}</span>
    </button>
  );
}

/* The Director panel, beside any page: what you asked for (requirements),
   what it decided (overturn any), the cold-reader reviews. What it may do
   without asking is on the Settings page. */
function DirectorDrawer({ projectId, view, rolling }: { projectId: string; view: ProjectView | null; rolling: number }) {
  const t = useT();
  const { open, setOpen } = useDirectorPanel();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!open) return null;
  return (
    <aside id="dir-drawer" className="dir-drawer" aria-label={t("Director")}>
      <div className="dir-drawer-head">
        <NavIcon name="director" on={rolling > 0} size={22} />
        <h2>{t("Director")}</h2>
        <button type="button" className="st-iconbtn dir-drawer-close" aria-label={t("Close")} onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="dir-drawer-status">
        {rolling
          ? <span className="st-lamp" data-state="running">{plural(t, rolling, "1 take is rolling", "{n} takes are rolling")}</span>
          : view && <span className="st-lamp" data-state="draft">{t("Nothing is rolling · last change {when}", { when: whenT(t, view.project.updatedAt) })}</span>}
        <Link className="st-link" href={`/p/${projectId}/settings`}>{t("What it may do")}</Link>
      </div>
      <DirectorPanel projectId={projectId} part="log" />
    </aside>
  );
}

/* Keeps the address of the page you are on, as long as it is not the Screening room. */
function WhereFrom({ room, into }: { room: string; into: RefObject<string | null> }) {
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    if (pathname && pathname !== room) into.current = params.size ? `${pathname}?${params}` : pathname;
  }, [pathname, params, room, into]);
  return null;
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
  const t = useT();
  const total = filmSeconds(shots);
  return (
    <nav className="sc-line" aria-label={t("Film")}>
      <div className="sc-line-track">
        {shots.map((s) => {
          const rolling = s.shot.takes.some((t) => t.status === "queued" || t.status === "running");
          const state = s.shot.id === here ? "here" : rolling ? "rolling" : s.picked ? "picked" : s.shot.takes.some((t) => t.status === "completed") ? "taken" : "planned";
          return (
            <Link key={s.shot.id} href={`/p/${projectId}/board?shot=${s.shot.id}`} className="sc-seg" style={{ flexGrow: s.durationS }} data-state={state} data-scene={s.firstOfScene ? "true" : undefined}
              data-join={s.linkIn === "continuous" ? "true" : undefined} aria-current={s.shot.id === here ? "true" : undefined}
              title={`${s.slate} · ${tc(s.startS)}–${tc(s.startS + s.durationS)} · ${s.shot.spec.intent || t("Untitled shot")}`}>
              {s.slate}
            </Link>
          );
        })}
      </div>
      <span className="sc-line-end st-num">{tc(total)}</span>
    </nav>
  );
}
