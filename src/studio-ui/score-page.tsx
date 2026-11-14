"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { cutAfter, filmSeconds, filmShots, pipState, rendersSeconds, shotPicture, shotSpend, takesInOrder, tc, type FilmShot } from "./film";
import { coverage } from "@/studio/coverage";

import { plural, useLang, useT } from "./i18n";
import { lintOfShot, needsOf, nextStep, type LintReport, type Need } from "./needs";
import { ProblemsList } from "./problems-list";
import { useProjectContext } from "./shell";
import { Loading } from "./common";
import { useLintState } from "./use-lint";
import { lintLine } from "./zh/lint";

/* The Score: a project's home. One time axis, and on it every layer of the
   film as a stave — scenes, the board's frames, the takes, the sound, the
   cut, what the checks found, what was spent. Above it, what waits for the
   person. The shot in the address (?shot=) is where the playhead stands; the
   line in the shell reads the same address. */

export function ReelPage() {
  return (
    <Suspense fallback={null}>
      <Score />
    </Suspense>
  );
}

function Score() {
  const { projectId, view } = useProjectContext();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { lint, loading: lintLoading } = useLintState(projectId, view);
  const t = useT();
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  if (!view) return null;
  const base = `/p/${projectId}`;
  const total = filmSeconds(shots);
  const here = shots.find((s) => s.shot.id === params.get("shot")) ?? shots.find((s) => !s.picked) ?? shots[0];
  const goto = (s: FilmShot) => router.replace(`${pathname}?shot=${s.shot.id}`, { scroll: false });
  const needs = needsOf(view, lint, base, t);
  const step = nextStep(view, base, t);
  const allTakes = shots.flatMap((s) => s.shot.takes);
  const rolling = allTakes.filter((x) => x.status === "queued" || x.status === "running").length;
  const ng = allTakes.filter((x) => x.status === "failed" || x.status === "timeout").length;

  return (
    <div className="st-page sc-page">
      <header className="sc-head">
        <div className="sc-head-name">
          <span className="sc-cap">{t("Reel")}</span>
          <h1 className="sc-film">{view.project.name}</h1>
          <p className="sc-head-facts st-num">
            {tc(total)} · {view.project.look.aspectRatio} · {view.project.look.resolution} · {plural(t, view.scenes.length, "1 scene", "{n} scenes")} · {plural(t, shots.length, "1 shot", "{n} shots")}
          </p>
        </div>
        <dl className="sc-readouts">
          <div><dt className="sc-cap">{t("Running")}</dt><dd className="st-num">{tc(total)}</dd></div>
          <div><dt className="sc-cap">{t("Spent")}</dt><dd className="st-num">{usd(view.project.spentUsd)}</dd><dd>{t("of {cap} cap", { cap: usd(view.project.budgetCapUsd) })}</dd></div>
          <div><dt className="sc-cap">{t("Takes")}</dt><dd className="st-num">{allTakes.length}</dd><dd>{t("{n} circled", { n: shots.filter((s) => s.picked).length })}{ng ? t(" · {n} NG", { n: ng }) : ""}</dd></div>
          <div><dt className="sc-cap">{t("Rolling")}</dt><dd className="st-num">{rolling}</dd><dd>{rolling ? <span className="st-lamp" data-state="running">{t("on the GPU")}</span> : t("nothing on the GPU")}</dd></div>
        </dl>
        {step && <Link className="st-btn st-btn--tally sc-next" href={step.href}>{step.label}</Link>}
      </header>

      <NeedsYou needs={needs} base={base} loading={lintLoading} />

      {shots.length === 0 ? (
        <div className="st-empty"><strong>{t("No shots yet")}</strong>{t("The score fills in as the film is planned: scenes and shots first, then frames, takes and the cut.")}</div>
      ) : (
        <>
          <Staves view={view} shots={shots} total={total} here={here} lint={lint} base={base} onPick={goto} />
          {here && <UnderTheLine s={here} lint={lint} base={base} />}
        </>
      )}

      <ProblemsList view={view} lint={lint} base={base} />
    </div>
  );
}

/* `loading`: the lint has not answered yet, so the list may still grow (its checks add needs). */
export function NeedsYou({ needs, full, loading }: { needs: Need[]; base: string; full?: boolean; loading?: boolean }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = full || all ? needs : needs.slice(0, 4);
  return (
    <section className="sc-needs" aria-label={t("Needs you")} data-full={full ? "true" : undefined}>
      <div className="sc-needs-head">
        <h2>{t("Needs you")}</h2>
        {loading && <Loading label={t("Checking…")} />}
        {!full && needs.length > 4 && <button type="button" className="st-link" onClick={() => setAll((v) => !v)}>{all ? t("Fewer") : t("All {n}", { n: needs.length })}</button>}
      </div>
      {needs.length === 0 ? (
        loading ? null : <p className="sc-needs-none">{t("Nothing waits for you. The director carries on, and anything it stops to ask lands here.")}</p>
      ) : (
        shown.map((n, i) => (
          <div className="sc-need" key={n.key}>
            <div className="sc-need-title"><span className="sc-slate">{n.count}</span><strong>{n.title}</strong></div>
            <p>{n.detail}</p>
            <Link className={`st-btn${i === 0 ? " st-btn--primary" : ""}`} href={n.action.href}>{n.action.label}</Link>
            {n.note && <span className="st-num sc-need-note">{n.note}</span>}
          </div>
        ))
      )}
    </section>
  );
}

function Stave({ label, sub, href, children, last }: { label: string; sub?: string; href?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="sc-stave" data-last={last ? "true" : undefined}>
      <div className="sc-stave-label">
        {href ? <Link href={href}>{label}</Link> : <span>{label}</span>}
        {sub && <span className="sc-cap">{sub}</span>}
      </div>
      <div className="sc-stave-track">{children}</div>
    </div>
  );
}

/* More shots than this and the staves no longer fit the page: they keep about this many to a screen
   (the film is still to scale, so a long shot takes more of it) and scroll sideways, labels in place. */
const SHOTS_ACROSS = 5;

function Staves({ view, shots, total, here, lint, base, onPick }: { view: ProjectView; shots: FilmShot[]; total: number; here?: FilmShot; lint: LintReport | null; base: string; onPick: (s: FilmShot) => void }) {
  const pct = (s: number) => `${(s / total) * 100}%`;
  const wide = shots.length > SHOTS_ACROSS;
  /* the ruler's marks follow the seconds on screen, not the whole film's */
  const onScreen = wide ? (total * SHOTS_ACROSS) / shots.length : total;
  const step = onScreen <= 90 ? 10 : onScreen <= 300 ? 30 : onScreen <= 900 ? 60 : 300;
  const scroller = useRef<HTMLElement>(null);
  /* the width of the labels, as the stylesheet sets it (--sc-label) */
  const labelPx = () => (scroller.current ? parseFloat(getComputedStyle(scroller.current.firstElementChild as Element).getPropertyValue("--sc-label")) || 136 : 136);
  const hereId = here?.shot.id, hereFrom = here?.startS ?? 0, hereFor = here?.durationS ?? 0;
  /* the shot under the playhead is brought to the middle when it is not wholly in view */
  useEffect(() => {
    const el = scroller.current;
    if (!el || !wide || !hereId) return;
    const label = labelPx();
    const track = el.scrollWidth - label, visible = el.clientWidth - label;
    const from = (hereFrom / total) * track, to = ((hereFrom + hereFor) / total) * track;
    if (from >= el.scrollLeft && to <= el.scrollLeft + visible) return;
    el.scrollLeft = Math.max(0, (from + to) / 2 - visible / 2);
  }, [hereId, hereFrom, hereFor, total, wide]);
  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * (el.clientWidth - labelPx()), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const marks: number[] = [];
  for (let x = 0; x < total; x += step) marks.push(x);
  /* the playhead stands where the shot starts, as on any timeline */
  const headAt = here ? here.startS : 0;
  const clips = view.timeline.clips;
  const cutSeconds = clips.reduce((n, c) => n + Math.max(0, c.outS - c.inS), 0);
  const noMusic = !view.timeline.music && shots.every((s) => { const m = (s.shot.spec.sound?.music ?? "").trim().toLowerCase(); return m === "" || m === "n/a" || m === "none"; });
  const sceneRows = view.scenes.filter((sc) => sc.sound?.ambience).length;
  const maxSpend = Math.max(0.0001, ...shots.map((s) => shotSpend(s.shot)));
  const takeCount = shots.reduce((n, s) => n + s.shot.takes.length, 0);
  const t = useT();
  const lang = useLang();
  const cov = view.script ? coverage(view.script.text, shots.map((s) => ({ id: s.shot.id, slate: s.slate, scriptLines: s.shot.spec.scriptLines }))) : null;
  let cutAt = 0;

  return (
    <section className="sc-score" aria-label={t("Score")} ref={scroller} data-wide={wide ? "true" : undefined}>
      <div className="sc-score-inner" style={{ ["--sc-total" as string]: total, ...(wide ? { width: `calc(var(--sc-label) + (100% - var(--sc-label)) * ${shots.length / SHOTS_ACROSS})` } : {}) }}>
        {here && (
          <>
            <div className="sc-head-line" aria-hidden="true" style={{ left: `calc(var(--sc-label) + (100% - var(--sc-label)) * ${headAt / total})` }} />
            {/* the slate hangs into the shot; near the end of the film, back over the line */}
            <div className="sc-head-flag st-num" data-flip={headAt / total > 0.92 ? "true" : undefined} style={{ left: `calc(var(--sc-label) + (100% - var(--sc-label)) * ${headAt / total})` }}>{here.slate}</div>
          </>
        )}

        <div className="sc-stave sc-stave--ruler">
          <div className="sc-stave-label">
            <span className="sc-cap">{t("Time")}</span>
            {wide && (
              <span className="sc-pager">
                <button type="button" aria-label={t("Earlier shots")} title={t("Earlier shots")} onClick={() => page(-1)}>‹</button>
                <button type="button" aria-label={t("Later shots")} title={t("Later shots")} onClick={() => page(1)}>›</button>
              </span>
            )}
          </div>
          <div className="sc-stave-track sc-ruler">
            {marks.map((x) => <span key={x} className="st-num" style={{ left: pct(x) }}>{tc(x)}</span>)}
            <span className="st-num sc-ruler-end">{tc(total)}</span>
          </div>
        </div>

        <Stave label={t("Scenes")} sub={t("{n} · board", { n: view.scenes.length })} href={`${base}/board`}>
          <div className="sc-row">
            {view.scenes.map((sc, i) => {
              const secs = sc.shots.reduce((n, x) => n + x.spec.durationS, 0);
              return (
                <div key={sc.id} className="sc-scene" style={{ flexGrow: secs }} title={sc.summary}>
                  {/* one group, so on a film that scrolls it can stay in view for as long as its scene does */}
                  <span className="sc-scene-in">
                    <span className="sc-slate">{i + 1}</span>
                    <span className="sc-scene-text"><strong>{sc.slug}</strong><span className="st-num">{secs} s</span><span className="sc-scene-sum">{sc.summary}</span></span>
                  </span>
                </div>
              );
            })}
          </div>
        </Stave>

        <Stave label={t("Script")} sub={view.script ? t("v{v} · {a}", { v: view.script.version, a: t(view.script.approval) }) : t("none")} href={view.script ? `${base}/story?view=lined` : `${base}/story`}>
          <div className="sc-band">
            {view.script ? <span className="sc-song">{firstLines(view.script.text)}</span> : <span>{t("No script yet.")}</span>}
            {cov && <span className="st-num sc-cov-sum">{cov.inUse ? t("{c} of {n} lines on a shot", { c: cov.lines.filter((l) => !l.open).length, n: cov.lines.length }) : t("no shot names its lines")}</span>}
            {(lint?.warnings ?? []).some((w) => w.code === "treatment.missing") && <span className="sc-bang-text"><i className="sc-bang">!</i>{t("no treatment")}</span>}
          </div>
          {cov?.inUse && (
            <div className="sc-row sc-cov st-num">
              {shots.map((s) => {
                const n = cov.lines.filter((l) => l.shots.includes(s.shot.id)).length;
                return <div key={s.shot.id} style={{ flexGrow: s.durationS }} data-none={n === 0 ? "true" : undefined}>{n ? plural(t, n, "1 line", "{n} lines") : t("no line")}</div>;
              })}
            </div>
          )}
        </Stave>

        <Stave label={t("Board")} sub={plural(t, shots.length, "1 shot", "{n} shots")} href={`${base}/board`}>
          <div className="sc-slurs" aria-hidden="true">
            {shots.map((s, i) => {
              const prev = shots[i - 1];
              if (!prev || s.linkIn !== "continuous") return null;
              const from = prev.startS + prev.durationS / 2;
              const to = s.startS + s.durationS / 2;
              return <span key={s.shot.id} style={{ left: pct(from), width: pct(to - from) }} />;
            })}
          </div>
          <div className="sc-row sc-frames">
            {shots.map((s, i) => {
              const pic = shotPicture(s.shot);
              return (
                <button key={s.shot.id} type="button" className="sc-frame" style={{ flexGrow: s.durationS }} data-gap={cutAfter(shots, i) ? "true" : undefined} aria-pressed={here?.shot.id === s.shot.id}
                  aria-label={t("Shot {s}, {a} to {b}", { s: s.slate, a: tc(s.startS), b: tc(s.startS + s.durationS) })} onClick={() => onPick(s)}>
                  {pic ? <img src={pic} alt="" loading="lazy" /> : <span className="sc-frame-empty">{String(s.shot.spec.cinematography?.size ?? "").toUpperCase() || "—"}</span>}
                  <span className="st-thumb-tag">{s.slate}</span>
                </button>
              );
            })}
          </div>
        </Stave>

        <Stave label={t("Takes")} sub={t("{n} rolled", { n: takeCount })} href={here ? `${base}/screening?shot=${here.shot.id}` : `${base}/screening`}>
          <div className="sc-row sc-pips">
            {shots.map((s) => (
              <div key={s.shot.id} style={{ flexGrow: s.durationS }}>
                {takesInOrder(s.shot).map((k) => {
                  const st = pipState(k, s.picked?.id);
                  return <span key={k.id} className="sc-pip" data-state={st} title={t("Take {n}: {state}", { n: k.n, state: t(st === "ng" ? "no good" : st) })}>{st === "ng" ? "NG" : k.n}</span>;
                })}
              </div>
            ))}
          </div>
        </Stave>

        <Stave label={t("Sound")} sub={sceneRows === view.scenes.length ? t("scene rows") : sceneRows === 0 ? t("from the shots") : t("{a} of {b} scene rows", { a: sceneRows, b: view.scenes.length })} href={`${base}/cut`}>
          <div className="sc-row sc-sound">
            {view.scenes.map((sc) => {
              const secs = sc.shots.reduce((n, x) => n + x.spec.durationS, 0);
              const text = sc.sound?.ambience || sc.shots.find((x) => x.spec.sound?.ambience)?.spec.sound?.ambience || "";
              return <div key={sc.id} style={{ flexGrow: secs }} title={text}><span>{text || t("no ambience written")}</span></div>;
            })}
          </div>
          <div className="sc-music" data-none={noMusic ? "true" : undefined}><span className="st-num">{noMusic ? t("no music in any shot, no music track") : view.timeline.music ? t("music track on the timeline") : t("music is asked for in some shots; no music track")}</span></div>
        </Stave>

        <Stave label={t("Cut")} sub={clips.length ? t("{n} clips · {t}", { n: clips.length, t: tc(cutSeconds, true) }) : t("no cut yet")} href={`${base}/cut`}>
          {clips.length === 0 ? (
            <div className="sc-band"><span>{t("Nothing is on the timeline yet.")}</span></div>
          ) : (
            <div className="sc-row sc-cut">
              {clips.map((c, i) => {
                const len = Math.max(0, c.outS - c.inS);
                const s = shots.find((x) => x.shot.id === c.shotId);
                const take = s?.shot.takes.find((k) => k.id === c.takeId);
                const at = cutAt;
                cutAt += len;
                const joined = i > 0 && c.transition !== "cut";
                return (
                  <div key={`${c.shotId}-${i}`} className="sc-clip st-num" style={{ flexGrow: len }} data-joined={joined ? "true" : undefined} title={`${t("{slate} take {n}", { slate: s?.slate ?? "?", n: take?.n ?? "?" })} · ${tc(at, true)}–${tc(at + len, true)}${joined ? ` · ${t(c.transition.replace("_", " "))}` : ""}`}>
                    {joined && <i aria-hidden="true" />}
                    T{take?.n ?? "?"} · {trim(c.inS)}–{trim(c.outS)}
                  </div>
                );
              })}
              {cutSeconds < total && <div className="sc-clip-rest" style={{ flexGrow: total - cutSeconds }} />}
            </div>
          )}
        </Stave>

        <Stave label={t("Problems")} sub={lint ? `${lint.counts.error ? t("{e} err · ", { e: lint.counts.error }) : ""}${t("{w} warn · {i} notes", { w: lint.counts.warn, i: lint.counts.info })}` : t("checking")} href="#problems">
          <div className="sc-row sc-problems st-num">
            {shots.map((s) => {
              const mine = lintOfShot(lint, s.scene.slug, s.shot.index);
              const seam = mine.some((w) => w.code.startsWith("seam."));
              const loud = mine.filter((w) => w.severity !== "info" && !w.code.startsWith("seam."));
              const notes = mine.filter((w) => w.severity === "info").length;
              return (
                <div key={s.shot.id} style={{ flexGrow: s.durationS }} title={mine.map((w) => `${w.code}: ${lintLine(lang, w).text}`).join("\n")}>
                  {seam && <i className="sc-bang sc-bang--seam" title={t("The cut jumps at this join")}>!</i>}
                  {loud.length > 0 && <span className="sc-bang-text"><i className="sc-bang">!</i>{loud[0]!.code}{loud.length > 1 ? ` +${loud.length - 1}` : ""}</span>}
                  {notes > 0 && <span>{plural(t, notes, "1 note", "{n} notes")}</span>}
                </div>
              );
            })}
          </div>
        </Stave>

        <Stave label={t("Spend")} sub={t("{x} in takes", { x: usd(shots.reduce((n, s) => n + shotSpend(s.shot), 0)) })} last>
          <div className="sc-row sc-spend st-num">
            {shots.map((s) => {
              const spent = shotSpend(s.shot);
              return (
                <div key={s.shot.id} style={{ flexGrow: s.durationS }}>
                  <span>{spent ? usd(spent) : "—"}</span>
                  <i style={{ height: `${Math.round((spent / maxSpend) * 28)}px` }} />
                </div>
              );
            })}
          </div>
        </Stave>
      </div>
    </section>
  );
}

function UnderTheLine({ s, lint, base }: { s: FilmShot; lint: LintReport | null; base: string }) {
  const spec = s.shot.spec;
  const c = (spec.cinematography ?? {}) as Record<string, unknown>;
  const chips = [c.size, c.angle, c.lens, c.dof, ...((c.lighting as string[] | undefined) ?? []), c.grade, c.texture, ...((c.vfx as string[] | undefined) ?? []), c.pace].filter((x): x is string => typeof x === "string" && x.length > 0);
  const pic = shotPicture(s.shot);
  const finished = s.shot.takes.filter((k) => k.status === "completed").length;
  const renders = rendersSeconds(s.durationS);
  const mine = lintOfShot(lint, s.scene.slug, s.shot.index);
  const t = useT();
  const lang = useLang();
  return (
    <section className="sc-under" aria-label={t("Shot under the playhead")}>
      <Link className="sc-under-pic" href={`${base}/board?shot=${s.shot.id}`}>
        {pic ? <img src={pic} alt={`Shot ${s.slate}`} /> : <span className="st-placeholder">{t("no picture yet")}</span>}
      </Link>
      <div className="sc-under-body">
        <div className="sc-under-slate">
          <span className="sc-slate sc-slate--xl">{s.slate}</span>
          <span>
            <span className="sc-here st-num">{t("under the line")} · {tc(s.startS)}–{tc(s.startS + s.durationS)}</span>
            <span className="st-num sc-under-facts">{s.durationS} s · {t(spec.mode)} · {t(String(spec.camera?.move ?? "static").replace(/_/g, " "))}{s.linkIn !== "cut" ? ` · ${t(s.linkIn.replace(/_/g, " "))}` : ""}</span>
          </span>
        </div>
        <p className="sc-intent">{spec.intent || t("Untitled shot")}</p>
        {chips.length > 0 && <div className="st-chips">{chips.map((x, i) => <span key={`${x}-${i}`} className="st-chip st-chip--mono">{x}</span>)}</div>}
        {(spec.beats ?? []).slice(0, 2).map((b, i) => (
          <p key={i} className="sc-beat"><span className="st-num">{trim(b.from)}–{trim(b.to)}</span> {b.action}</p>
        ))}
        {mine.filter((w) => w.severity !== "info").map((w, i) => {
          const line = lintLine(lang, w);
          return <p key={i} className="sc-beat" title={line.detail}><i className="sc-bang">!</i> {line.text}</p>;
        })}
      </div>
      <div className="sc-under-take">
        <span className="sc-cap">{s.picked ? t("Circled take") : finished ? t("No take circled") : t("No take yet")}</span>
        {s.picked && (
          <div className="sc-circled">
            <span className="sc-pip sc-pip--xl" data-state="circled">{s.picked.n}</span>
            <span className="st-num">{s.picked.workflow}{s.picked.seed !== undefined ? ` · ${t("seed {n}", { n: s.picked.seed })}` : ""}<br />{s.picked.outputSeconds ? `${s.picked.outputSeconds.toFixed(2)} s · ` : ""}{usd(s.picked.costUsd)}{s.picked.executionMs ? ` · ${t("{s} s GPU", { s: Math.round(s.picked.executionMs / 1000) })}` : ""}</span>
          </div>
        )}
        <span className="st-num sc-grid-note">{t("asks {a} s → renders {b} s", { a: s.durationS, b: renders.toFixed(2) })}</span>
        <div className="st-row">
          <Link className="st-btn" href={`${base}/board?shot=${s.shot.id}`}>{t("Open shot")}</Link>
          {finished > 0 && <Link className="st-btn st-btn--primary" href={`${base}/screening?shot=${s.shot.id}`}>{plural(t, finished, "Screen 1 take", "Screen {n} takes")}</Link>}
        </div>
      </div>
    </section>
  );
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

/** The opening of the script, without its title lines, for the one-line band. */
function firstLines(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 24);
  return (lines[0] ?? text.trim()).slice(0, 220);
}
