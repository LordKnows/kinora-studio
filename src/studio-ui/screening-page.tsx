"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TAKE_FAULTS, type TakeFault } from "@/studio/schemas";
import type { Take } from "@/studio/types";

import { post, usd } from "./api";
import { ErrorBanner, useAction } from "./common";
import { filmShots, shotPicture, takePicture, takesInOrder, tc, type FilmShot } from "./film";
import { plural, useT } from "./i18n";
import { ArrowLeftIcon, PlayIcon } from "./icons";
import { useProjectContext } from "./shell";

/* Screening: lights down. One shot at a time, its takes side by side and
   played in step, one review, then straight on to the next circled take that
   has none. Everything here is in the address: ?shot= is the shot, ?take=
   the take under review (A), ?b= the take beside it. The keys do what the
   buttons do, so a film can be reviewed without the mouse. */

export function ScreeningPage() {
  return (
    <Suspense fallback={null}>
      <Screening />
    </Suspense>
  );
}

const finishedOf = (s: FilmShot): Take[] => takesInOrder(s.shot).filter((t) => t.status === "completed");

function Screening() {
  const { projectId, view, reload, cameFrom } = useProjectContext();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tr = useT();
  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  const screenable = useMemo(() => shots.filter((s) => finishedOf(s).length > 0), [shots]);
  const here = screenable.find((s) => s.shot.id === params.get("shot")) ?? screenable.find((s) => s.picked && !s.picked.review) ?? screenable[0];
  const takes = here ? finishedOf(here) : [];
  const a = takes.find((t) => t.id === params.get("take")) ?? (here?.picked && takes.find((t) => t.id === here.picked!.id)) ?? takes[takes.length - 1];
  const b = takes.find((t) => t.id === params.get("b") && t.id !== a?.id);
  const base = `/p/${projectId}`;

  const go = useCallback((next: { shot?: string; take?: string | null; b?: string | null }, how: "push" | "replace" = "replace") => {
    const q = new URLSearchParams(params.toString());
    if (next.shot) { q.set("shot", next.shot); q.delete("take"); q.delete("b"); }
    for (const k of ["take", "b"] as const) {
      const v = next[k];
      if (v === null) q.delete(k);
      else if (v) q.set(k, v);
    }
    const url = `${pathname}?${q}`;
    if (how === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  }, [params, pathname, router]);

  /* the next circled take with no review, after this shot and wrapping round */
  const nextOpen = useMemo(() => {
    if (!here) return undefined;
    const i = screenable.indexOf(here);
    const order = [...screenable.slice(i + 1), ...screenable.slice(0, i)];
    return order.find((s) => s.picked && !s.picked.review) ?? order.find((s) => !s.picked);
  }, [screenable, here]);

  const select = useAction(async (_confirm, takeId: string) => {
    if (!here) return;
    await post(`/api/shots/${here.shot.id}/select-take`, { takeId });
    await reload();
  });

  /* transport: A leads, B follows */
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  useEffect(() => { setPlaying(false); setT(0); }, [a?.id, b?.id]);
  const toggle = useCallback(() => {
    const va = aRef.current;
    if (!va) return;
    if (va.paused) {
      if (bRef.current) { bRef.current.currentTime = va.currentTime; void bRef.current.play().catch(() => undefined); }
      void va.play().catch(() => undefined);
      setPlaying(true);
    } else {
      va.pause();
      bRef.current?.pause();
      setPlaying(false);
    }
  }, []);
  const seek = (x: number) => {
    if (aRef.current) aRef.current.currentTime = x;
    if (bRef.current) bRef.current.currentTime = x;
    setT(x);
  };

  const stepTake = useCallback((dir: 1 | -1) => {
    if (takes.length < 2 || !a) return;
    if (b) {
      /* compare: the arrows change what stands beside A */
      const others = takes.filter((x) => x.id !== a.id);
      const j = others.findIndex((x) => x.id === b.id);
      go({ b: others[(j + dir + others.length) % others.length]!.id });
    } else {
      const j = takes.findIndex((x) => x.id === a.id);
      go({ take: takes[(j + dir + takes.length) % takes.length]!.id });
    }
  }, [takes, a, b, go]);
  const stepShot = useCallback((dir: 1 | -1) => {
    if (!here) return;
    const j = screenable.indexOf(here) + dir;
    if (screenable[j]) go({ shot: screenable[j]!.shot.id });
  }, [screenable, here, go]);
  const compare = useCallback(() => {
    if (!a) return;
    if (b) return go({ b: null });
    const other = [...takes].reverse().find((x) => x.id !== a.id);
    if (other) go({ b: other.id });
  }, [a, b, takes, go]);

  /* the review of A; the panel is keyed by the take, so it starts clean on each */
  const [score, setScore] = useState<number | undefined>(undefined);
  const saveRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveRef.current(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "5") { setScore(Number(e.key)); e.preventDefault(); }
      else if (e.key === " ") { toggle(); e.preventDefault(); }
      else if (e.key === "ArrowRight") { stepTake(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { stepTake(-1); e.preventDefault(); }
      else if (e.key === "ArrowDown") { stepShot(1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { stepShot(-1); e.preventDefault(); }
      else if (e.key === "c" || e.key === "C") compare();
      else if (e.key === "n" || e.key === "N") { if (nextOpen) go({ shot: nextOpen.shot.id }, "push"); }
      else if (e.key === "Enter" && a && here && here.picked?.id !== a.id) { void select.fire(a.id); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, stepTake, stepShot, compare, nextOpen, go, a, here, select]);

  if (!view) return null;
  /* Back: the page of this project you came in from, as you left it; the Reel when the room was opened directly */
  const back = (
    <button type="button" className="st-btn scr-back" onClick={() => router.push(cameFrom() ?? base)}>
      <ArrowLeftIcon />
      {tr("Back")}
    </button>
  );
  const pickedShots = shots.filter((s) => s.picked);
  const reviewed = pickedShots.filter((s) => s.picked!.review).length;

  if (!here || !a) {
    return (
      <div className="st-page scr-page">
        <div className="scr-top">{back}</div>
        <div className="st-empty"><strong>{tr("Nothing to screen yet")}</strong>{tr("A shot shows up here once one of its takes has finished rendering.")} <Link className="st-link" href={`${base}/board`}>{tr("Open the Board")}</Link></div>
      </div>
    );
  }
  const spec = here.shot.spec;
  const circled = here.picked?.id;

  return (
    <div className="st-page scr-page">
      <div className="scr-top">
        {back}
        <span className="sc-slate sc-slate--xl">{here.slate}</span>
        <span className="st-num scr-facts">
          {tr("{a}–{b} · {d} s · {mode} · {move}", { a: tc(here.startS), b: tc(here.startS + here.durationS), d: here.durationS, mode: tr(spec.mode), move: tr(String(spec.camera?.move ?? "static").replace(/_/g, " ")) })}
          <br />
          {here.linkIn !== "cut" ? tr("{link} from the shot before · ", { link: tr(here.linkIn.replace(/_/g, " ")) }) : ""}{plural(tr, takes.length, "1 take", "{n} takes")}
        </span>
        <span className="scr-spacer" />
        <span className="st-num scr-count">{tr("{r} of {p} circled takes reviewed", { r: reviewed, p: pickedShots.length })}</span>
        {takes.length > 1 && (
          <div className="st-seg" role="group" aria-label={tr("View")}>
            <button type="button" aria-pressed={!b} onClick={() => go({ b: null })}>{tr("One take")}</button>
            <button type="button" aria-pressed={Boolean(b)} onClick={() => { if (!b) compare(); }}>{tr("Compare")}</button>
          </div>
        )}
        <Link className="st-link" href={`${base}/board?shot=${here.shot.id}`}>{tr("Shot sheet")}</Link>
        <Link className="st-btn scr-lights" href={`${base}?shot=${here.shot.id}`}>{tr("Lights up")}</Link>
      </div>

      <div className="scr-main">
        <section className="scr-stage" aria-label={tr("Takes")}>
          <div className="scr-takes" data-two={b ? "true" : undefined}>
            <TakeFigure letter={b ? "A" : undefined} take={a} circled={circled === a.id} focus videoRef={aRef} muted={false}
              onTime={(x) => { setT(x); const vb = bRef.current; if (vb && Math.abs(vb.currentTime - x) > 0.25) vb.currentTime = x; }}
              onMeta={(d) => setDur(d)} onEnded={() => { setPlaying(false); bRef.current?.pause(); }}
              action={circled === a.id ? undefined : { label: tr("Circle this take"), busy: select.busy, run: () => void select.fire(a.id) }} />
            {b && (
              <TakeFigure letter="B" take={b} circled={circled === b.id} videoRef={bRef} muted
                action={circled === b.id ? undefined : { label: tr("Circle B instead"), busy: select.busy, run: () => void select.fire(b.id) }} />
            )}
          </div>

          <div className="scr-transport">
            <button type="button" className="scr-play" aria-label={playing ? tr("Pause") : b ? tr("Play both takes") : tr("Play")} aria-pressed={playing} onClick={toggle}>
              {playing ? <span className="scr-pause" aria-hidden="true" /> : <PlayIcon size={16} />}
            </button>
            <div className="scr-scrub">
              <input type="range" aria-label={tr("Position in the take")} min={0} max={dur || a.outputSeconds || here.durationS} step={0.01} value={t} onChange={(e) => seek(Number(e.target.value))} />
              <div className="st-num scr-scrub-read">
                <span>{t.toFixed(1)} s</span>
                <span>{b ? tr("A and B play in step · ") : ""}{tr("{s} s asked", { s: here.durationS })}{a.outputSeconds ? tr(" · {s} s rendered", { s: a.outputSeconds.toFixed(2) }) : ""}</span>
              </div>
            </div>
          </div>
          {(spec.beats ?? []).map((beat, i) => (
            <p key={i} className="scr-beat"><span className="st-num">{beat.from}–{beat.to}</span> {beat.action}</p>
          ))}

          {takes.length > 1 && (
            <div className="scr-others">
              <span className="sc-cap">{tr("Takes")}</span>
              {takes.map((x) => (
                <button key={x.id} type="button" className="sc-pip sc-pip--lg" data-state={x.id === circled ? "circled" : "done"} aria-pressed={x.id === a.id}
                  title={x.id === a.id ? tr("Under review (A)") : b && x.id === b.id ? tr("Beside it (B)") : tr("Review this take")} onClick={() => go({ take: x.id, ...(b && b.id === x.id ? { b: a.id } : {}) })}>
                  {x.n}
                </button>
              ))}
              <span className="st-num scr-hint">{b ? tr("the arrows change B") : tr("the arrows change the take")}</span>
            </div>
          )}
          <ErrorBanner error={select.error} projectId={projectId} onDismiss={select.dismiss} />
        </section>

        <ReviewPanel key={a.id} take={a} letter={b ? "A" : undefined} score={score} setScore={setScore} saveRef={saveRef} next={nextOpen}
          onSaved={async () => { await reload(); if (nextOpen) go({ shot: nextOpen.shot.id }, "push"); }} />
      </div>

      <nav className="scr-line" aria-label={tr("Film")}>
        <div className="scr-line-head"><span className="sc-cap">{tr("The line · the score of each circled take")}</span><span className="st-num scr-here-range">{tc(here.startS)}–{tc(here.startS + here.durationS)}</span></div>
        <div className="scr-strip-scroll">
          <div className="scr-strip">
            {shots.map((s) => {
              const pic = shotPicture(s.shot);
              const can = finishedOf(s).length > 0;
              const tag = s.picked?.review ? `${s.picked.review.score}/5` : s.picked ? "–" : can ? tr("pick") : "";
              const inner = (
                <>
                  {pic ? <img src={pic} alt="" loading="lazy" /> : <span className="sc-frame-empty" />}
                  <span className="st-thumb-tag">{s.slate}</span>
                  {tag && <em className="st-thumb-tag scr-score-tag">{tag}</em>}
                </>
              );
              return can ? (
                <Link key={s.shot.id} href={`${pathname}?shot=${s.shot.id}`} scroll={false} className="scr-fr" style={{ flexGrow: s.durationS }} aria-current={s.shot.id === here.shot.id ? "true" : undefined} data-join={s.linkIn === "continuous" ? "true" : undefined}>{inner}</Link>
              ) : (
                <span key={s.shot.id} className="scr-fr" style={{ flexGrow: s.durationS }} data-off="true" data-join={s.linkIn === "continuous" ? "true" : undefined}>{inner}</span>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}

function TakeFigure({ letter, take, circled, focus, videoRef, muted, onTime, onMeta, onEnded, action }: {
  letter?: string; take: Take; circled: boolean; focus?: boolean; videoRef: React.RefObject<HTMLVideoElement | null>; muted: boolean;
  onTime?: (t: number) => void; onMeta?: (duration: number) => void; onEnded?: () => void; action?: { label: string; busy: boolean; run: () => void };
}) {
  const tr = useT();
  const up = take.upscale;
  const src = up?.status === "completed" && up.url ? up.url : take.resultUrl;
  return (
    <figure className="scr-take" data-focus={focus ? "true" : undefined}>
      <figcaption>
        {letter && <span className="sc-slate scr-letter">{letter}</span>}
        <span className="sc-pip sc-pip--lg" data-state={circled ? "circled" : "done"}>{take.n}</span>
        {circled && <strong>{tr("Circled · in the cut")}</strong>}
        <span className="st-num scr-take-facts">{take.workflow}{take.seed !== undefined ? ` · ${tr("seed {n}", { n: take.seed })}` : ""}{take.outputSeconds ? ` · ${take.outputSeconds.toFixed(2)} s` : ""} · {usd(take.costUsd)}</span>
        <span className="scr-spacer" />
        {action && <button type="button" className="st-link st-link--btn" disabled={action.busy} onClick={action.run}>{action.label}</button>}
      </figcaption>
      {src ? (
        <video ref={videoRef} src={src} poster={takePicture(take)} muted={muted} playsInline preload="metadata"
          onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined} onLoadedMetadata={onMeta ? (e) => onMeta(e.currentTarget.duration) : undefined} onEnded={onEnded} />
      ) : (
        <div className="st-placeholder">{tr("no video")}</div>
      )}
    </figure>
  );
}

function ReviewPanel({ take, letter, score, setScore, saveRef, next, onSaved }: {
  take: Take; letter?: string; score: number | undefined; setScore: (n: number | undefined) => void; saveRef: React.RefObject<() => void>; next?: FilmShot; onSaved: () => Promise<void>;
}) {
  const { projectId } = useProjectContext();
  const [notes, setNotes] = useState(take.review?.notes ?? "");
  const [faults, setFaults] = useState<TakeFault[]>(take.review?.faults ?? []);
  const [audioOk, setAudioOk] = useState<boolean | undefined>(take.review?.audioOk);
  /* a new take starts from its own review, or from nothing */
  useEffect(() => { setScore(take.review?.score); }, [take.id, take.review?.score, setScore]);
  const save = useAction(async () => {
    if (!score) return;
    await post(`/api/takes/${take.id}/review`, { score, notes, faults, ...(audioOk !== undefined ? { audioOk } : {}) });
    await onSaved();
  });
  saveRef.current = () => { if (score && !save.busy) void save.fire(); };
  const tr = useT();
  return (
    <section className="scr-review" aria-label={tr("Review this take")}>
      <div className="scr-review-head">
        <h2>{tr("Review {letter}take {n}", { letter: letter ? `${letter} · ` : "", n: take.n })}</h2>
        <span className="st-num">{take.review ? tr(take.review.by === "human" ? "{s}/5 by you" : "{s}/5 by the director", { s: take.review.score }) : tr("not reviewed yet")}</span>
      </div>
      {take.review?.by === "agent" && take.review.basis && <p className="scr-basis">{tr("The director judged it from {basis}.", { basis: take.review.basis })}</p>}
      <div className="scr-scores st-num" role="group" aria-label={tr("Rating")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={score === n} onClick={() => setScore(score === n ? undefined : n)}>{n}</button>
        ))}
      </div>
      <label className="scr-label">{tr("Review notes")}
        <textarea className="st-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <span className="sc-cap scr-faults-cap">{tr("What went wrong · feeds the retro")}</span>
      <div className="st-chips">
        {TAKE_FAULTS.map((f) => (
          <button key={f} type="button" className="st-chip st-chip--btn" aria-pressed={faults.includes(f)} onClick={() => setFaults((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))}>
            {tr(f.replaceAll("_", " "))}
          </button>
        ))}
      </div>
      <label className="st-toggle scr-mute">
        <input type="checkbox" checked={audioOk === false} onChange={(e) => setAudioOk(e.target.checked ? false : true)} />
        {tr("Sound unusable — mute it in the cut")}
      </label>
      <ErrorBanner error={save.error} projectId={projectId} onDismiss={save.dismiss} />
      <button type="button" className="st-btn st-btn--primary scr-save" disabled={!score || save.busy} data-busy={save.busy ? "true" : undefined} onClick={() => void save.fire()}>
        <span>{next ? tr("Save and go to {s}", { s: next.slate }) : tr("Save review")}</span>
        <small className="st-num">{!score ? tr("give it a score first") : next ? (next.picked ? tr("the next circled take without a review") : tr("the next shot with no take circled")) : tr("every circled take has a review")}</small>
      </button>
      <dl className="scr-keys st-num">
        <div><dt>1–5</dt><dd>{tr("score")}</dd></div><div><dt>⌘↵</dt><dd>{tr("save")}</dd></div>
        <div><dt>{tr("Space")}</dt><dd>{tr("play")}</dd></div><div><dt>C</dt><dd>{tr("compare")}</dd></div>
        <div><dt>← →</dt><dd>{tr("take")}</dd></div><div><dt>↑ ↓</dt><dd>{tr("shot")}</dd></div>
        <div><dt>↵</dt><dd>{tr("circle")}</dd></div><div><dt>N</dt><dd>{tr("next unreviewed")}</dd></div>
      </dl>
    </section>
  );
}
