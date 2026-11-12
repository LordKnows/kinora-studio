"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import type { ProjectView } from "@/studio/orchestrator";

import { usd } from "./api";
import { cutAfter, filmSeconds, filmShots, pipState, rendersSeconds, shotPicture, shotSpend, takesInOrder, tc, type FilmShot } from "./film";
import { lintOfShot, needsOf, nextStep, type LintReport, type Need } from "./needs";
import { useProjectContext } from "./shell";
import { useLint } from "./use-lint";

/* The Score: a project's home. One time axis, and on it every layer of the
   film as a stave — scenes, the board's frames, the takes, the sound, the
   cut, what the checks found, what was spent. Above it, what waits for the
   person. The shot in the address (?shot=) is where the playhead stands; the
   line in the shell reads the same address. */

export function ScorePage() {
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
  const lint = useLint(projectId, view);
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  if (!view) return null;
  const base = `/p/${projectId}`;
  const total = filmSeconds(shots);
  const here = shots.find((s) => s.shot.id === params.get("shot")) ?? shots.find((s) => !s.picked) ?? shots[0];
  const goto = (s: FilmShot) => router.replace(`${pathname}?shot=${s.shot.id}`, { scroll: false });
  const needs = needsOf(view, lint, base);
  const step = nextStep(view, base);
  const allTakes = shots.flatMap((s) => s.shot.takes);
  const rolling = allTakes.filter((t) => t.status === "queued" || t.status === "running").length;
  const ng = allTakes.filter((t) => t.status === "failed" || t.status === "timeout").length;
  const target = view.project.targetSeconds;

  return (
    <div className="st-page sc-page">
      <header className="sc-head">
        <div className="sc-head-name">
          <span className="sc-cap">Score</span>
          <h1 className="sc-film">{view.project.name}</h1>
          <p className="sc-head-facts st-num">
            {tc(total)} · {view.project.look.aspectRatio} · {view.project.look.resolution} · {view.scenes.length} {view.scenes.length === 1 ? "scene" : "scenes"} · {shots.length} {shots.length === 1 ? "shot" : "shots"}
          </p>
        </div>
        <dl className="sc-readouts">
          <div><dt className="sc-cap">Running</dt><dd className="st-num">{tc(total)}</dd><dd>{target === undefined ? "no target set" : total === target ? `on target, ${target} s` : `${total > target ? "+" : "−"}${Math.abs(total - target)} s against ${target} s`}</dd></div>
          <div><dt className="sc-cap">Spent</dt><dd className="st-num">{usd(view.project.spentUsd)}</dd><dd>of {usd(view.project.budgetCapUsd)} cap</dd></div>
          <div><dt className="sc-cap">Takes</dt><dd className="st-num">{allTakes.length}</dd><dd>{shots.filter((s) => s.picked).length} circled{ng ? ` · ${ng} NG` : ""}</dd></div>
          <div><dt className="sc-cap">Rolling</dt><dd className="st-num">{rolling}</dd><dd>{rolling ? <span className="st-lamp" data-state="running">on the GPU</span> : "nothing on the GPU"}</dd></div>
        </dl>
        <Link className="st-btn st-btn--tally sc-next" href={step.href}>{step.label}</Link>
      </header>

      <NeedsYou needs={needs} base={base} />

      {shots.length === 0 ? (
        <div className="st-empty"><strong>No shots yet</strong>The score fills in as the film is planned: scenes and shots first, then frames, takes and the cut.</div>
      ) : (
        <>
          <Staves view={view} shots={shots} total={total} here={here} lint={lint} base={base} onPick={goto} />
          {here && <UnderTheLine s={here} lint={lint} base={base} />}
        </>
      )}
    </div>
  );
}

export function NeedsYou({ needs, base, full }: { needs: Need[]; base: string; full?: boolean }) {
  const shown = full ? needs : needs.slice(0, 4);
  return (
    <section className="sc-needs" aria-label="Needs you" data-full={full ? "true" : undefined}>
      <div className="sc-needs-head">
        <h2>Needs you</h2>
        <span className="st-num">{needs.length}</span>
        {!full && needs.length > shown.length && <Link className="st-link" href={`${base}/director`}>All {needs.length}</Link>}
      </div>
      {needs.length === 0 ? (
        <p className="sc-needs-none">Nothing waits for you. The director carries on, and anything it stops to ask lands here.</p>
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

function Staves({ view, shots, total, here, lint, base, onPick }: { view: ProjectView; shots: FilmShot[]; total: number; here?: FilmShot; lint: LintReport | null; base: string; onPick: (s: FilmShot) => void }) {
  const pct = (s: number) => `${(s / total) * 100}%`;
  const step = total <= 90 ? 10 : total <= 300 ? 30 : total <= 900 ? 60 : 300;
  const marks: number[] = [];
  for (let t = 0; t < total; t += step) marks.push(t);
  const headAt = here ? here.startS + here.durationS / 2 : 0;
  const clips = view.timeline.clips;
  const cutSeconds = clips.reduce((n, c) => n + Math.max(0, c.outS - c.inS), 0);
  const noMusic = !view.timeline.music && shots.every((s) => { const m = (s.shot.spec.sound?.music ?? "").trim().toLowerCase(); return m === "" || m === "n/a" || m === "none"; });
  const sceneRows = view.scenes.filter((sc) => sc.sound?.ambience).length;
  const maxSpend = Math.max(0.0001, ...shots.map((s) => shotSpend(s.shot)));
  const takeCount = shots.reduce((n, s) => n + s.shot.takes.length, 0);
  let cutAt = 0;

  return (
    <section className="sc-score" aria-label="Score">
      <div className="sc-score-inner" style={{ ["--sc-total" as string]: total }}>
        {here && (
          <>
            <div className="sc-head-line" aria-hidden="true" style={{ left: `calc(var(--sc-label) + (100% - var(--sc-label)) * ${headAt / total})` }} />
            <div className="sc-head-flag st-num" style={{ left: `calc(var(--sc-label) + (100% - var(--sc-label)) * ${headAt / total})` }}>{here.slate}</div>
          </>
        )}

        <div className="sc-stave sc-stave--ruler">
          <div className="sc-stave-label"><span className="sc-cap">Time</span></div>
          <div className="sc-stave-track sc-ruler">
            {marks.map((t) => <span key={t} className="st-num" style={{ left: pct(t) }}>{tc(t)}</span>)}
            <span className="st-num sc-ruler-end">{tc(total)}</span>
          </div>
        </div>

        <Stave label="Scenes" sub={`${view.scenes.length} · board`} href={`${base}/board`}>
          <div className="sc-row">
            {view.scenes.map((sc, i) => {
              const secs = sc.shots.reduce((n, x) => n + x.spec.durationS, 0);
              return (
                <div key={sc.id} className="sc-scene" style={{ flexGrow: secs }} title={sc.summary}>
                  <span className="sc-slate">{i + 1}</span>
                  <span className="sc-scene-text"><strong>{sc.slug}</strong><span className="st-num">{secs} s</span><span className="sc-scene-sum">{sc.summary}</span></span>
                </div>
              );
            })}
          </div>
        </Stave>

        <Stave label="Script" sub={view.script ? `v${view.script.version} · ${view.script.approval}` : "none"} href={`${base}/script`}>
          <div className="sc-band">
            {view.script ? <span className="sc-song">{firstLines(view.script.text)}</span> : <span>No script yet.</span>}
            {(lint?.warnings ?? []).some((w) => w.code === "treatment.missing") && <span className="sc-bang-text"><i className="sc-bang">!</i>no treatment</span>}
          </div>
        </Stave>

        <Stave label="Board" sub={`${shots.length} ${shots.length === 1 ? "shot" : "shots"}`} href={`${base}/board`}>
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
                  aria-label={`Shot ${s.slate}, ${tc(s.startS)} to ${tc(s.startS + s.durationS)}`} onClick={() => onPick(s)}>
                  {pic ? <img src={pic} alt="" loading="lazy" /> : <span className="sc-frame-empty">{String(s.shot.spec.cinematography?.size ?? "").toUpperCase() || "—"}</span>}
                  <span className="st-thumb-tag">{s.slate}</span>
                </button>
              );
            })}
          </div>
        </Stave>

        <Stave label="Takes" sub={`${takeCount} rolled`} href={here ? `${base}/screening?shot=${here.shot.id}` : `${base}/screening`}>
          <div className="sc-row sc-pips">
            {shots.map((s) => (
              <div key={s.shot.id} style={{ flexGrow: s.durationS }}>
                {takesInOrder(s.shot).map((t) => {
                  const st = pipState(t, s.picked?.id);
                  return <span key={t.id} className="sc-pip" data-state={st} title={`Take ${t.n}: ${st === "ng" ? "no good" : st}`}>{st === "ng" ? "NG" : t.n}</span>;
                })}
              </div>
            ))}
          </div>
        </Stave>

        <Stave label="Sound" sub={sceneRows === view.scenes.length ? "scene rows" : sceneRows === 0 ? "from the shots" : `${sceneRows} of ${view.scenes.length} scene rows`} href={`${base}/timeline`}>
          <div className="sc-row sc-sound">
            {view.scenes.map((sc) => {
              const secs = sc.shots.reduce((n, x) => n + x.spec.durationS, 0);
              const text = sc.sound?.ambience || sc.shots.find((x) => x.spec.sound?.ambience)?.spec.sound?.ambience || "";
              return <div key={sc.id} style={{ flexGrow: secs }} title={text}>{text || "no ambience written"}</div>;
            })}
          </div>
          <div className="sc-music" data-none={noMusic ? "true" : undefined}><span className="st-num">{noMusic ? "no music in any shot, no music track" : view.timeline.music ? "music track on the timeline" : "music is asked for in some shots; no music track"}</span></div>
        </Stave>

        <Stave label="Cut" sub={clips.length ? `${clips.length} clips · ${tc(cutSeconds, true)}` : "no cut yet"} href={`${base}/timeline`}>
          {clips.length === 0 ? (
            <div className="sc-band"><span>Nothing is on the timeline yet.</span></div>
          ) : (
            <div className="sc-row sc-cut">
              {clips.map((c, i) => {
                const len = Math.max(0, c.outS - c.inS);
                const s = shots.find((x) => x.shot.id === c.shotId);
                const take = s?.shot.takes.find((t) => t.id === c.takeId);
                const at = cutAt;
                cutAt += len;
                const joined = i > 0 && c.transition !== "cut";
                return (
                  <div key={`${c.shotId}-${i}`} className="sc-clip st-num" style={{ flexGrow: len }} data-joined={joined ? "true" : undefined} title={`${s?.slate ?? "?"} take ${take?.n ?? "?"} · ${tc(at, true)}–${tc(at + len, true)}${joined ? ` · ${c.transition}` : ""}`}>
                    {joined && <i aria-hidden="true" />}
                    T{take?.n ?? "?"} · {trim(c.inS)}–{trim(c.outS)}
                  </div>
                );
              })}
              {cutSeconds < total && <div className="sc-clip-rest" style={{ flexGrow: total - cutSeconds }} />}
            </div>
          )}
        </Stave>

        <Stave label="Problems" sub={lint ? `${lint.counts.error ? `${lint.counts.error} err · ` : ""}${lint.counts.warn} warn · ${lint.counts.info} notes` : "checking"} href={`${base}/director#problems`}>
          <div className="sc-row sc-problems st-num">
            {shots.map((s) => {
              const mine = lintOfShot(lint, s.scene.slug, s.shot.index);
              const seam = mine.some((w) => w.code.startsWith("seam."));
              const loud = mine.filter((w) => w.severity !== "info" && !w.code.startsWith("seam."));
              const notes = mine.filter((w) => w.severity === "info").length;
              return (
                <div key={s.shot.id} style={{ flexGrow: s.durationS }} title={mine.map((w) => `${w.code}: ${w.message}`).join("\n")}>
                  {seam && <i className="sc-bang sc-bang--seam" title="The cut jumps at this join">!</i>}
                  {loud.length > 0 && <span className="sc-bang-text"><i className="sc-bang">!</i>{loud[0]!.code}{loud.length > 1 ? ` +${loud.length - 1}` : ""}</span>}
                  {notes > 0 && <span>{notes} {notes === 1 ? "note" : "notes"}</span>}
                </div>
              );
            })}
          </div>
        </Stave>

        <Stave label="Spend" sub={`${usd(shots.reduce((n, s) => n + shotSpend(s.shot), 0))} in takes`} last>
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
  const finished = s.shot.takes.filter((t) => t.status === "completed").length;
  const renders = rendersSeconds(s.durationS);
  const mine = lintOfShot(lint, s.scene.slug, s.shot.index);
  return (
    <section className="sc-under" aria-label="Shot under the playhead">
      <Link className="sc-under-pic" href={`${base}/board?shot=${s.shot.id}`}>
        {pic ? <img src={pic} alt={`Shot ${s.slate}`} /> : <span className="st-placeholder">no picture yet</span>}
      </Link>
      <div className="sc-under-body">
        <div className="sc-under-slate">
          <span className="sc-slate sc-slate--xl">{s.slate}</span>
          <span>
            <span className="sc-here st-num">under the line · {tc(s.startS)}–{tc(s.startS + s.durationS)}</span>
            <span className="st-num sc-under-facts">{s.durationS} s · {spec.mode} · {String(spec.camera?.move ?? "static").replace(/_/g, " ")}{s.linkIn !== "cut" ? ` · ${s.linkIn.replace(/_/g, " ")}` : ""}</span>
          </span>
        </div>
        <p className="sc-intent">{spec.intent || "Untitled shot"}</p>
        {chips.length > 0 && <div className="st-chips">{chips.map((x, i) => <span key={`${x}-${i}`} className="st-chip st-chip--mono">{x}</span>)}</div>}
        {(spec.beats ?? []).slice(0, 2).map((b, i) => (
          <p key={i} className="sc-beat"><span className="st-num">{trim(b.from)}–{trim(b.to)}</span> {b.action}</p>
        ))}
        {mine.filter((w) => w.severity !== "info").map((w, i) => (
          <p key={i} className="sc-beat"><i className="sc-bang">!</i> {w.message}</p>
        ))}
      </div>
      <div className="sc-under-take">
        <span className="sc-cap">{s.picked ? "Circled take" : finished ? "No take circled" : "No take yet"}</span>
        {s.picked && (
          <div className="sc-circled">
            <span className="sc-pip sc-pip--xl" data-state="circled">{s.picked.n}</span>
            <span className="st-num">{s.picked.workflow}{s.picked.seed !== undefined ? ` · seed ${s.picked.seed}` : ""}<br />{s.picked.outputSeconds ? `${s.picked.outputSeconds.toFixed(2)} s · ` : ""}{usd(s.picked.costUsd)}{s.picked.executionMs ? ` · ${Math.round(s.picked.executionMs / 1000)} s GPU` : ""}</span>
          </div>
        )}
        <span className="st-num sc-grid-note">asks {s.durationS} s → renders {renders.toFixed(2)} s</span>
        <div className="st-row">
          <Link className="st-btn" href={`${base}/board?shot=${s.shot.id}`}>Open shot</Link>
          {finished > 0 && <Link className="st-btn st-btn--primary" href={`${base}/screening?shot=${s.shot.id}`}>Screen {finished} {finished === 1 ? "take" : "takes"}</Link>}
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
