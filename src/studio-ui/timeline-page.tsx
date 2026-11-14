"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TITLE_KINDS, TRANSITIONS, type TimelineInput } from "@/studio/schemas";
import type { ExportJob, Take } from "@/studio/types";

import { get, post, put, usd } from "./api";
import { Button, Empty, ErrorBanner, Field, Lamp, Section, useAction, UploadButton, whenT } from "./common";
import { clipSeconds, filmShots, seamTrims, takePicture, tc, type FilmShot } from "./film";
import { RoughCut } from "./rough-cut";
import { plural, useLang, useT } from "./i18n";
import { useNotify } from "./notices";
import { useProjectContext } from "./shell";
import { REGENERATE_ENABLED } from "./flags";
import { useLint } from "./use-lint";
import { lintLine } from "./zh/lint";

/* The Cut: the film as tracks on one time axis — titles, the picture, the
   takes' own sound, narration, music, silences — with the selected clip's
   settings beside the viewer and the way out (export, and the full-resolution
   pass of every pick, which used to be the Finals page). A clip is dragged to
   move it and by an edge to trim it; every change can be undone until the
   page is left. Nothing is stored until Save. */

const PRESETS = ["master-768p", "master-upscaled", "social-9x16", "preview-480p"] as const;
type Clip = TimelineInput["clips"][number];

/* The default timeline (and Reset): the selected take of every shot, in board
   order, each from 0 s to the end of its take. */
const DEFAULT_BUILD = { selectedOnly: true, fullLength: true };

const round2 = (n: number) => Math.round(n * 100) / 100;
const isTyping = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return Boolean(e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable));
};

export function TimelinePage() {
  const { projectId, view, reload } = useProjectContext();
  const [timeline, setTimeline] = useState<TimelineInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [past, setPast] = useState<TimelineInput[]>([]);
  const [sel, setSel] = useState(0);
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("master-768p");
  const [burnIn, setBurnIn] = useState(false);
  const [exportNote, setExportNote] = useState<string[] | null>(null);
  const [grid, setGrid] = useState({ bpm: 120, beatsPerBar: 4, subdivision: 1 });
  const [gridResult, setGridResult] = useState<{ cuts: Array<{ startS: number; outS: number; cutAtS: number }>; warnings: Array<{ message: string }> } | null>(null);
  const [subs, setSubs] = useState<{ issues: Array<{ id?: string; message: string; severity?: string }>; srt: string } | null>(null);
  const [showSrt, setShowSrt] = useState(false);
  const [resolution, setResolution] = useState<"1080p" | "2k" | "4k">("2k");
  const [closeToDraft, setCloseToDraft] = useState(true);
  const lint = useLint(projectId, view);
  const notify = useNotify();
  const tr = useT();
  const lang = useLang();

  useEffect(() => {
    if (view && !timeline) setTimeline(view.timeline);
  }, [view, timeline]);

  useEffect(() => {
    void get<{ exports: ExportJob[] }>(`/api/projects/${projectId}/exports`).then((r) => setExports(r.exports)).catch(() => undefined);
  }, [projectId, view]);

  const shots = useMemo(() => (view ? filmShots(view) : []), [view]);
  const takes = useMemo(() => {
    const map = new Map<string, { take: Take; s: FilmShot }>();
    for (const s of shots) for (const take of s.shot.takes) map.set(take.id, { take, s });
    return map;
  }, [shots]);

  /* every change goes through here, so it can be undone */
  const set = useCallback((next: TimelineInput, opts?: { keepHistory?: boolean }) => {
    setTimeline((cur) => {
      if (cur && !opts?.keepHistory) setPast((p) => [...p.slice(-49), cur]);
      return next;
    });
    setDirty(true);
  }, []);
  const undo = useCallback(() => {
    setPast((p) => {
      const prev = p[p.length - 1];
      if (prev) { setTimeline(prev); setDirty(true); }
      return p.slice(0, -1);
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !isTyping(e.target)) { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const save = useAction(async () => {
    if (!timeline) return;
    const { timeline: next } = await put<{ timeline: TimelineInput }>(`/api/projects/${projectId}/timeline`, timeline);
    setTimeline(next);
    setDirty(false);
    await reload();
  });
  const reset = useAction(async (_c, ask: boolean) => {
    if (ask && timeline?.clips.length && !window.confirm(tr("Reset the cut? Every circled take joins in board order, from 0 s at its full length; the current order, trims and transitions are replaced."))) return;
    const { timeline: next } = await post<{ timeline: TimelineInput }>(`/api/projects/${projectId}/timeline/auto`, DEFAULT_BUILD);
    if (timeline) setPast((p) => [...p.slice(-49), timeline]);
    setTimeline(next);
    setDirty(false);
    await reload();
  });
  /* an empty saved timeline starts as the default one, once per visit */
  const built = useRef(false);
  const hasSelected = shots.some((s) => s.shot.selectedTake?.status === "completed");
  useEffect(() => {
    if (built.current || !view || !hasSelected || view.timeline.clips.length > 0) return;
    built.current = true;
    void reset.fire(false);
  }, [view, hasSelected, reset]);
  const exportNow = useAction(async (confirm) => {
    if (dirty && timeline) await put(`/api/projects/${projectId}/timeline`, timeline);
    setDirty(false);
    const created = await post<{ warnings?: string[] }>(`/api/projects/${projectId}/exports`, { preset, burnInSubtitles: burnIn, confirm });
    setExportNote(created.warnings?.length ? created.warnings : null);
    const r = await get<{ exports: ExportJob[] }>(`/api/projects/${projectId}/exports`);
    setExports(r.exports);
    await reload();
  });

  const snap = useAction(async () => {
    if (!timeline) return;
    const list = timeline.clips.map((c) => ({ durationS: takes.get(c.takeId)?.s.durationS ?? Math.max(0, c.outS - c.inS) }));
    const r = await post<{ cuts: Array<{ startS: number; outS: number; cutAtS: number }>; warnings: Array<{ message: string }> }>("/api/director/cue", {
      cueMap: { sections: [{ id: "a", t: 0, bpm: grid.bpm, beatsPerBar: grid.beatsPerBar }], hits: [] },
      shots: list, subdivision: grid.subdivision, startS: 0,
    });
    setGridResult(r);
    set({ ...timeline, clips: timeline.clips.map((c, i) => (r.cuts[i] ? { ...c, outS: round2(c.inS + r.cuts[i]!.outS) } : c)) });
  });
  const checkSubs = useAction(async () => {
    if (!timeline || !view) return;
    const lines: Array<{ id: string; text: string; t0: number; t1: number; language?: string }> = [];
    let cursor = 0;
    for (const clip of timeline.clips) {
      const shot = takes.get(clip.takeId)?.s.shot;
      const len = Math.max(0, clip.outS - clip.inS);
      const dialogue = shot?.spec.dialogue ?? [];
      dialogue.forEach((d, i) => {
        const slot = len / dialogue.length;
        lines.push({ id: `${clip.takeId}-${i}`, text: d.text, t0: cursor + i * slot, t1: cursor + (i + 1) * slot, language: d.language });
      });
      cursor += len;
    }
    setSubs(await post("/api/director/subtitles", { lines }));
    setShowSrt(false);
  });

  /* the full-resolution pass: every pick on the timeline that has none, at once */
  const picks = useMemo(() => {
    const seen = new Set<string>();
    const out: Take[] = [];
    for (const c of timeline?.clips ?? []) {
      const t = takes.get(c.takeId)?.take;
      if (t && t.status === "completed" && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    return out;
  }, [timeline, takes]);
  const missingFull = picks.filter((t) => t.upscale?.status !== "completed");
  const runningFull = picks.filter((t) => t.upscale?.status === "queued" || t.upscale?.status === "running");
  const measuredFull = [...takes.values()].map((x) => x.take.upscale).filter((u) => u?.status === "completed" && typeof u.costUsd === "number");
  const batch = useAction(async (confirm, list: Take[]) => {
    for (const take of list) {
      if (take.upscale && (take.upscale.status === "queued" || take.upscale.status === "running")) continue;
      await post(`/api/takes/${take.id}/regenerate`, { resolution, startSigma: closeToDraft ? 0.8 : 0, confirm });
    }
    await reload();
  });

  if (!timeline || !view) return null;
  const clips = timeline.clips;
  const total = clips.reduce((n, c) => n + clipSeconds(c), 0);
  const music = view.assets.filter((a) => a.kind === "audio");
  const seams = seamTrims(shots, timeline);
  const otherSeams = (lint?.warnings ?? []).filter((w) => w.code.startsWith("seam.") && w.code !== "seam.trim");
  const selected = clips[Math.min(sel, clips.length - 1)];
  const selIndex = Math.min(sel, clips.length - 1);
  const patchClip = (i: number, change: Partial<Clip>, opts?: { keepHistory?: boolean }) => set({ ...timeline, clips: clips.map((c, j) => (j === i ? { ...c, ...change } : c)) }, opts);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= clips.length) return;
    const next = [...clips];
    const [c] = next.splice(from, 1);
    next.splice(to, 0, c!);
    set({ ...timeline, clips: next });
    setSel(to);
  };
  const fixSeams = (which: typeof seams) => {
    const ends = new Map(which.map((s) => [s.clipIndex, s.takeEndS]));
    set({ ...timeline, clips: clips.map((c, i) => (ends.has(i) ? { ...c, outS: Math.min(15, Math.round(ends.get(i)! * 1000) / 1000) } : c)) });
  };
  const fullLabel = resolution.toUpperCase();

  return (
    <div className="st-page cut-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{tr("Cut")}</h1>
          <p className="st-subtitle">{plural(tr, clips.length, "1 clip", "{n} clips")} · {tc(total, true)}{view.project.targetSeconds ? tr(" against a target of {t}", { t: tc(view.project.targetSeconds) }) : ""}{tr(". Drag a clip to move it, an edge to trim it.")}{dirty ? tr(" Not saved yet.") : ""}</p>
        </div>
        <div className="st-actions">
          <Button kind="quiet" disabled={past.length === 0} onClick={undo} title={tr("Undo the last change (Ctrl/⌘+Z)")}>{tr("Undo")}{past.length ? ` · ${past.length}` : ""}</Button>
          <Button kind="quiet" busy={reset.busy} onClick={() => void reset.fire(true)} title={tr("Rebuild from the circled take of every shot, from 0 s at full length")}>{tr("Reset")}</Button>
          <Button kind="primary" busy={save.busy} disabled={!dirty} onClick={() => void save.fire()}>{tr("Save the cut")}</Button>
        </div>
      </div>
      <ErrorBanner error={save.error ?? reset.error ?? exportNow.error ?? snap.error ?? checkSubs.error ?? batch.error} projectId={projectId}
        onConfirm={exportNow.error ? () => void exportNow.confirm() : batch.error ? () => void batch.confirm() : undefined}
        onDismiss={() => { save.dismiss(); reset.dismiss(); exportNow.dismiss(); snap.dismiss(); checkSubs.dismiss(); batch.dismiss(); }} />
      {exportNote && (
        <div className="st-alert st-alert--warn" style={{ marginBottom: 16 }}>
          <span>{exportNote.join(" ")}</span>
          <Button size="sm" kind="quiet" onClick={() => setExportNote(null)}>{tr("Dismiss")}</Button>
        </div>
      )}

      {clips.length === 0 ? (
        <Empty title={tr("Nothing in the cut yet")} hint={hasSelected ? tr("Reset joins the circled take of every shot in board order.") : tr("No shot has a circled take yet: circle one per shot in Screening and it joins the cut.")}>
          <Button busy={reset.busy} disabled={!hasSelected} onClick={() => void reset.fire(false)}>{tr("Build the cut")}</Button>
        </Empty>
      ) : (
        <>
          <div className="cut-top">
            <div className="cut-viewer"><RoughCut timeline={timeline} view={view} /></div>

            {selected && (
              <ClipInspector key={`${selected.takeId}-${selIndex}`} clip={selected} index={selIndex} count={clips.length} info={takes.get(selected.takeId)} seam={seams.find((s) => s.clipIndex === selIndex)}
                base={`/p/${projectId}`} onPatch={(c) => patchClip(selIndex, c)} onMove={(d) => move(selIndex, selIndex + d)}
                onRemove={() => {
                  const gone = takes.get(selected.takeId);
                  set({ ...timeline, clips: clips.filter((_, j) => j !== selIndex) });
                  setSel(Math.max(0, selIndex - 1));
                  notify({ text: gone ? tr("Removed {slate} take {n} from the cut", { slate: gone.s.slate, n: gone.take.n }) : tr("Removed the clip from the cut"), mark: "undo", ttlMs: 12_000, action: { label: tr("Undo"), run: undo } });
                }}
                onFixSeam={(s) => fixSeams([s])} />
            )}

            <section className="cut-panel" aria-label={tr("Export")}>
              <h2 className="cut-h">{tr("Export")}</h2>
              <fieldset className="cut-presets">
                <legend className="sc-cap">{tr("Preset")}</legend>
                {PRESETS.map((p) => (
                  <label key={p} className="st-toggle"><input type="radio" name="preset" checked={preset === p} onChange={() => setPreset(p)} /><span className="st-num">{p}</span></label>
                ))}
              </fieldset>
              <label className="st-toggle"><input type="checkbox" checked={burnIn} onChange={(e) => setBurnIn(e.target.checked)} />{tr("Burn in subtitles")}</label>
              <Button kind="tally" busy={exportNow.busy} onClick={() => void exportNow.fire()}>{tr("Export {preset}", { preset })}</Button>
              {(seams.length > 0 || otherSeams.length > 0) && <span className="st-num cut-note">{plural(tr, seams.length + otherSeams.length, "1 seam still jumps in this cut", "{n} seams still jump in this cut")}</span>}
              {dirty && <span className="st-num cut-note">{tr("the cut is saved first")}</span>}

              <div className="cut-full">
                <span className="sc-cap">{tr("Full resolution · {a} of {b} picks", { a: picks.length - missingFull.length, b: picks.length })}{runningFull.length ? tr(" · {n} rolling", { n: runningFull.length }) : ""}</span>
                <div className="st-row">
                  <select className="st-input st-input--sm" aria-label={tr("Final quality")} value={resolution} disabled={!REGENERATE_ENABLED} onChange={(e) => setResolution(e.target.value as typeof resolution)} style={{ width: 92 }}>
                    <option value="1080p">1080p</option><option value="2k">2K</option><option value="4k">4K</option>
                  </select>
                  <label className="st-toggle"><input type="checkbox" checked={closeToDraft} disabled={!REGENERATE_ENABLED} onChange={(e) => setCloseToDraft(e.target.checked)} />{tr("close to the draft")}</label>
                </div>
                <p className="st-muted">
                  {measuredFull.length > 0
                    ? tr("Measured so far: about {price} a pick. The exact estimate is shown before anything renders.", { price: usd(measuredFull.reduce((n, u) => n + (u!.costUsd ?? 0), 0) / measuredFull.length) })
                    : tr("No full-resolution take has finished in this project, so there is no measured price yet. Probe one pick before the rest; the estimate is shown before anything renders.")}
                </p>
                <div className="st-row">
                  {selected && takes.get(selected.takeId)?.take.upscale?.status !== "completed" && takes.get(selected.takeId)?.take.status === "completed" && (
                    <Button busy={batch.busy} disabled={!REGENERATE_ENABLED} title={REGENERATE_ENABLED ? undefined : tr("Regenerating at a higher resolution is switched off for now")} onClick={() => void batch.fire([takes.get(selected.takeId)!.take])}>{tr("Probe {slate} at {res}", { slate: takes.get(selected.takeId)!.s.slate, res: fullLabel })}</Button>
                  )}
                  <Button kind="primary" busy={batch.busy} disabled={!REGENERATE_ENABLED || missingFull.length === 0} title={REGENERATE_ENABLED ? undefined : tr("Regenerating at a higher resolution is switched off for now")} onClick={() => void batch.fire(missingFull)}>
                    {missingFull.length === 0 ? tr("All picks are at {res}", { res: fullLabel }) : plural(tr, missingFull.length, "Regenerate 1 pick at {res}", "Regenerate {n} picks at {res}", { res: fullLabel })}
                  </Button>
                </div>
              </div>
            </section>
          </div>

          <Tracks timeline={timeline} total={total} takes={takes} sel={selIndex} seams={seams} onSelect={setSel} onMove={move}
            onTrimStart={() => setPast((p) => [...p.slice(-49), timeline])} onTrim={(i, change) => patchClip(i, change, { keepHistory: true })} music={music.find((a) => a.id === timeline.music)?.name ?? (timeline.music ? tr("music track") : undefined)} />

          <div className="cut-panels">
            <section className="cut-panel cut-panel--wide" id="seams" aria-label={tr("Seams")}>
              <div className="cut-h-row">
                <h2 className="cut-h">{seams.length + otherSeams.length === 0 ? tr("Seams · none jump") : tr("Seams · {n} jump", { n: seams.length + otherSeams.length })}</h2>
                {seams.length > 0 && <Button kind="primary" onClick={() => fixSeams(seams)}>{seams.length === 1 ? tr("Run it to the last frame · +{s} s", { s: seams.reduce((n, s) => n + s.gapS, 0).toFixed(2) }) : tr("Run all {n} to the last frame · +{s} s", { n: seams.length, s: seams.reduce((n, s) => n + s.gapS, 0).toFixed(2) })}</Button>}
              </div>
              {seams.length === 0 && otherSeams.length === 0 ? (
                <p className="st-muted">{tr("Every continuous shot starts on the last frame its anchor shows in the cut.")}</p>
              ) : (
                <>
                  {seams.length > 0 && (
                    <div className="st-table-scroll">
                      <table className="st-table cut-seams st-num">
                        <thead><tr><th>{tr("At||seam")}</th><th>{tr("Join")}</th><th>{tr("Anchor is cut at")}</th><th>{tr("Its take ends at")}</th><th>{tr("Gap")}</th><th></th></tr></thead>
                        <tbody>
                          {seams.map((s) => (
                            <tr key={s.clipIndex}>
                              <td>{tc(s.atS, true)}</td><td>{s.anchorSlate} → {s.slate}</td><td>{s.cutAtS.toFixed(2)} s</td><td>{s.takeEndS.toFixed(2)} s</td><td>−{s.gapS.toFixed(2)} s</td>
                              <td><button type="button" className="st-link st-link--btn" onClick={() => { setSel(s.clipIndex); fixSeams([s]); }}>{tr("Fix")}</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {otherSeams.map((w, i) => {
                    const line = lintLine(lang, w);
                    return <p key={i} className="cut-seam-other" title={line.detail}><i className="sc-bang">!</i>{w.scene} #{w.shot}: {line.text}</p>;
                  })}
                  <p className="st-muted">{tr("A continuous shot starts on its anchor's last frame. A shot renders on H3's frame grid, so a 5 s shot is 5.17 s long; trimming the anchor to 5.00 s makes the picture jump at the join.")}</p>
                </>
              )}
            </section>

            <TitlesPanel timeline={timeline} total={total} onChange={set} />

            <section className="cut-panel" aria-label={tr("Mix")}>
              <h2 className="cut-h">{tr("Mix")}</h2>
              <Field label={tr("Music track")} group>
                <UploadButton accept="audio/mpeg,audio/wav,audio/x-wav" projectId={projectId} label={tr("Upload music")} title={tr("Upload from this device")} onUploaded={async ({ assetId }) => { await reload(); set({ ...timeline, music: assetId }); }} />
                <select className="st-select" value={timeline.music ?? ""} onChange={(e) => set({ ...timeline, music: e.target.value || undefined })}>
                  <option value="">{tr("None")}</option>
                  {music.map((a) => <option key={a.id} value={a.id}>{a.name ?? String(a.meta.key ?? a.id)}</option>)}
                </select>
              </Field>
              {([["dialogueDb", "Dialogue"], ["sfxDb", "Effects"], ["musicDb", "Music"]] as const).map(([key, label]) => (
                <Field key={key} label={`${tr(label)} ${timeline.mix[key]} dB`}>
                  <input type="range" className="st-range" min={-30} max={6} step={1} value={timeline.mix[key]} onChange={(e) => set({ ...timeline, mix: { ...timeline.mix, [key]: Number(e.target.value) } })} />
                </Field>
              ))}
              <div className="st-fields cut-fields">
                <Field label={tr("Fade in (s)")}><input className="st-input st-input--sm" type="number" min={0} max={5} step={0.1} value={timeline.fadeInS ?? 0} onChange={(e) => set({ ...timeline, fadeInS: Number(e.target.value) || undefined })} /></Field>
                <Field label={tr("Fade out (s)")}><input className="st-input st-input--sm" type="number" min={0} max={5} step={0.1} value={timeline.fadeOutS ?? 0} onChange={(e) => set({ ...timeline, fadeOutS: Number(e.target.value) || undefined })} /></Field>
              </div>
            </section>

            <SilencesPanel timeline={timeline} audio={music} onChange={set} />

            <section className="cut-panel" aria-label={tr("Beat grid")}>
              <h2 className="cut-h">{tr("Beat grid")}</h2>
              <p className="st-muted">{tr("Snap every cut to the music: each clip ends on a beat, bar or half beat within what its take can give.")}</p>
              <div className="st-fields cut-fields">
                <Field label="BPM"><input className="st-input st-input--sm" type="number" min={20} max={300} value={grid.bpm} onChange={(e) => setGrid({ ...grid, bpm: Number(e.target.value) || 120 })} /></Field>
                <Field label={tr("Beats per bar")}><input className="st-input st-input--sm" type="number" min={1} max={12} value={grid.beatsPerBar} onChange={(e) => setGrid({ ...grid, beatsPerBar: Number(e.target.value) || 4 })} /></Field>
                <Field label={tr("Cut on")}>
                  <select className="st-select st-input--sm" value={grid.subdivision} onChange={(e) => setGrid({ ...grid, subdivision: Number(e.target.value) })}>
                    <option value={1}>{tr("beat||grid")}</option><option value={0.25}>{tr("bar||grid")}</option><option value={2}>{tr("half beat||grid")}</option>
                  </select>
                </Field>
              </div>
              <div className="st-row st-row--between">
                <span className="st-muted st-num">{gridResult ? tr("{n} cuts snapped · last at {s} s", { n: gridResult.cuts.length, s: gridResult.cuts.at(-1)?.cutAtS.toFixed(2) ?? "—" }) : tr("not applied")}</span>
                <Button busy={snap.busy} onClick={() => void snap.fire()}>{tr("Snap cuts to the grid")}</Button>
              </div>
            </section>

            <section className="cut-panel" aria-label={tr("Subtitles")}>
              <h2 className="cut-h">{tr("Subtitles")}</h2>
              <p className="st-muted">{tr("The dialogue lines of the clips in order. Each is checked for reading time: CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, at least 1.8 s. The SRT is what burn-in uses.")}</p>
              <div className="st-row"><Button busy={checkSubs.busy} onClick={() => void checkSubs.fire()}>{tr("Check subtitles")}</Button></div>
              {subs && (
                <>
                  {subs.issues.length === 0 ? <Lamp state="ok" label={tr("every line has time to be read")} /> : (
                    <div className="st-lint">
                      {subs.issues.map((i, n) => (
                        <div key={n} className="st-lint-row" data-severity={i.severity ?? "warn"}><span className="st-lint-where">{i.id ?? tr("line||subtitle")}</span><span>{i.message}</span></div>
                      ))}
                    </div>
                  )}
                  <div className="st-row">
                    <Button size="sm" kind="quiet" onClick={() => setShowSrt((v) => !v)}>{showSrt ? tr("Hide SRT") : tr("Show SRT")}</Button>
                    <Button size="sm" kind="quiet" onClick={() => void navigator.clipboard.writeText(subs.srt)}>{tr("Copy SRT")}</Button>
                  </div>
                  {showSrt && <pre className="st-pre">{subs.srt || tr("(no dialogue in the cut)")}</pre>}
                </>
              )}
            </section>
          </div>
        </>
      )}

      <Section title={tr("Exports")} aside={<small>{exports.length}</small>}>
        {exports.length === 0 ? (
          <Empty title={tr("No exports yet")} />
        ) : (
          <div className="st-card st-card--pad0">
            <table className="st-table">
              <thead><tr><th>{tr("Preset")}</th><th>{tr("Status")}</th><th>{tr("Started")}</th><th></th></tr></thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td className="st-num">{e.preset}</td>
                    <td><Lamp state={e.status} label={tr(`${e.status}||status`)} />{e.error && <span className="st-muted"> · {e.error}</span>}</td>
                    <td>{whenT(tr, e.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      {e.resultUrl && <a className="st-link" href={e.resultUrl} target="_blank" rel="noreferrer">{tr("Download")}</a>}
                      {e.srtUrl && <>{" · "}<a className="st-link" href={e.srtUrl} target="_blank" rel="noreferrer">SRT</a></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <p className="st-muted" style={{ marginTop: 12 }}>{tr("Spent so far: {spent} of {cap}.", { spent: usd(view.project.spentUsd), cap: usd(view.project.budgetCapUsd) })}</p>
    </div>
  );
}

/* ---- the tracks ---- */

function Tracks({ timeline, total, takes, sel, seams, music, onSelect, onMove, onTrim, onTrimStart }: {
  timeline: TimelineInput; total: number; takes: Map<string, { take: Take; s: FilmShot }>; sel: number; seams: ReturnType<typeof seamTrims>; music?: string;
  onSelect: (i: number) => void; onMove: (from: number, to: number) => void; onTrim: (i: number, change: Partial<Clip>) => void; onTrimStart: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const tr = useT();
  const pct = (s: number) => `${(s / Math.max(total, 0.001)) * 100}%`;
  const step = total <= 90 ? 10 : total <= 300 ? 30 : total <= 900 ? 60 : 300;
  const marks: number[] = [];
  for (let t = 0; t < total; t += step) marks.push(t);

  /* trimming: an edge follows the pointer, in seconds of this track's own scale */
  const startTrim = (e: React.PointerEvent, i: number, edge: "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    const width = track.current?.getBoundingClientRect().width ?? 1;
    const perPx = total / width;
    const clip = timeline.clips[i]!;
    const takeEnd = Math.min(15, takes.get(clip.takeId)?.take.outputSeconds ?? 15);
    const x0 = e.clientX;
    onTrimStart();
    onSelect(i);
    const onMoveEv = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) * perPx * (clip.speed || 1);
      if (edge === "out") onTrim(i, { outS: round2(Math.max(clip.inS + 0.2, Math.min(takeEnd, clip.outS + d))) });
      else onTrim(i, { inS: round2(Math.max(0, Math.min(clip.outS - 0.2, clip.inS + d))) });
    };
    const onUp = () => { window.removeEventListener("pointermove", onMoveEv); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
  };

  let at = 0;
  return (
    <section className="sc-score cut-tracks" aria-label={tr("Tracks")}>
      <div className="sc-score-inner" style={{ ["--sc-total" as string]: Math.max(1, Math.round(total)) }}>
        <div className="sc-stave sc-stave--ruler">
          <div className="sc-stave-label"><span className="sc-cap">{tr("Time")}</span></div>
          <div className="sc-stave-track sc-ruler">
            {marks.map((t) => <span key={t} className="st-num" style={{ left: pct(t) }}>{tc(t)}</span>)}
            <span className="st-num sc-ruler-end">{tc(total, true)}</span>
          </div>
        </div>

        <div className="sc-stave">
          <div className="sc-stave-label"><span>{tr("Titles")}</span><span className="sc-cap">{tr("exact text")}</span></div>
          <div className="sc-stave-track">
            {(timeline.titles ?? []).length === 0 ? (
              <div className="cut-empty">{tr("No titles. Text is laid over the picture here; the model never draws it.")}</div>
            ) : (
              <div className="cut-lane">
                {(timeline.titles ?? []).map((t, i) => <span key={i} className="cut-title" style={{ left: pct(t.atS), width: pct(t.durationS) }} title={tr("{kind} · {at} for {d} s", { kind: tr(`${t.kind}||title kind`), at: tc(t.atS, true), d: t.durationS })}>{t.text}</span>)}
              </div>
            )}
          </div>
        </div>

        <div className="sc-stave">
          <div className="sc-stave-label"><span>{tr("Picture||track")}</span><span className="sc-cap">{tr("{n} clips · {t}", { n: timeline.clips.length, t: tc(total, true) })}</span></div>
          <div className="sc-stave-track cut-picture" ref={track}>
            <div className="sc-row">
              {timeline.clips.map((c, i) => {
                const info = takes.get(c.takeId);
                const len = clipSeconds(c);
                const start = at;
                at += len;
                const pic = takePicture(info?.take);
                const up = info?.take.upscale;
                const joined = i > 0 && c.transition !== "cut";
                const seam = seams.some((s) => s.clipIndex === i);
                return (
                  <div key={`${c.takeId}-${i}`} className="cut-clip" style={{ flexGrow: Math.max(0.2, len) }} role="button" tabIndex={0} aria-pressed={i === sel} data-over={over === i ? "true" : undefined} data-joined={joined ? "true" : undefined}
                    aria-label={tr("Clip {i}: {slate} take {n}, {a} to {b}", { i: i + 1, slate: info?.s.slate ?? "?", n: info?.take.n ?? "?", a: tc(start, true), b: tc(start + len, true) })}
                    draggable onDragStart={(e) => { drag.current = i; e.dataTransfer.effectAllowed = "move"; }} onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver((o) => (o === i ? null : o))}
                    onDrop={(e) => { e.preventDefault(); setOver(null); if (drag.current !== null) onMove(drag.current, i); drag.current = null; }} onDragEnd={() => { drag.current = null; setOver(null); }}
                    onClick={() => onSelect(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}>
                    {pic ? <img src={pic} alt="" draggable={false} /> : <span className="sc-frame-empty" />}
                    {joined && <i className="cut-x" aria-hidden="true" title={tr(`${c.transition.replace("_", " ")}||transition`)} />}
                    {seam && <i className="sc-bang cut-seam-mark" title={tr("The next shot starts on this take's last frame, and the cut leaves before it")}>!</i>}
                    <span className="st-thumb-tag">{info?.s.slate ?? "?"} T{info?.take.n ?? "?"}{up?.status === "completed" ? ` · ${up.resolution.toUpperCase()}` : ""}{(c.repeat ?? 1) > 1 ? ` ×${c.repeat}` : ""}</span>
                    <span className="cut-grip cut-grip--in" onPointerDown={(e) => startTrim(e, i, "in")} aria-hidden="true" />
                    <span className="cut-grip cut-grip--out" onPointerDown={(e) => startTrim(e, i, "out")} aria-hidden="true" />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="sc-stave">
          <div className="sc-stave-label"><span>{tr("Take sound")}</span><span className="sc-cap">{tr("effects {db} dB", { db: timeline.mix.sfxDb })}</span></div>
          <div className="sc-stave-track">
            <div className="sc-row cut-sound">
              {timeline.clips.map((c, i) => <span key={i} style={{ flexGrow: Math.max(0.2, clipSeconds(c)) }} data-muted={c.muteOwnAudio ? "true" : undefined} title={c.muteOwnAudio ? tr("muted") : undefined} />)}
            </div>
          </div>
        </div>

        <div className="sc-stave">
          <div className="sc-stave-label"><span>{tr("Narration")}</span><span className="sc-cap">{tr("dialogue {db} dB", { db: timeline.mix.dialogueDb })}</span></div>
          <div className="sc-stave-track">
            {(timeline.narration ?? []).length === 0 ? <div className="cut-empty">{tr("None.")}</div> : (
              <div className="cut-lane">{(timeline.narration ?? []).map((n, i) => <span key={i} className="cut-mark" style={{ left: pct(n.atS) }} title={tr("a line at {at}", { at: tc(n.atS, true) })} />)}</div>
            )}
          </div>
        </div>

        <div className="sc-stave">
          <div className="sc-stave-label"><span>{tr("Music")}</span><span className="sc-cap">{timeline.mix.musicDb} dB</span></div>
          <div className="sc-stave-track">
            {music ? <div className="cut-music">{music}</div> : <div className="cut-empty">{tr("No music track.")}</div>}
          </div>
        </div>

        <div className="sc-stave" data-last="true">
          <div className="sc-stave-label"><span>{tr("Silences")}</span></div>
          <div className="sc-stave-track">
            {(timeline.silences ?? []).length === 0 ? <div className="cut-empty">{tr("No silence is marked.")}</div> : (
              <div className="cut-lane">{(timeline.silences ?? []).map((s, i) => <span key={i} className="cut-silence" style={{ left: pct(s.atS), width: pct(s.durationS) }} title={tr("{at} for {d} s", { at: tc(s.atS, true), d: s.durationS })} />)}</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---- the selected clip ---- */

function ClipInspector({ clip, index, count, info, seam, base, onPatch, onMove, onRemove, onFixSeam }: {
  clip: Clip; index: number; count: number; info?: { take: Take; s: FilmShot }; seam?: ReturnType<typeof seamTrims>[number]; base: string;
  onPatch: (c: Partial<Clip>) => void; onMove: (delta: 1 | -1) => void; onRemove: () => void; onFixSeam: (s: ReturnType<typeof seamTrims>[number]) => void;
}) {
  const tr = useT();
  const num = (key: keyof Clip, label: string, opts: { min: number; max: number; step: number; fallback: number; optional?: boolean }) => (
    <Field label={label}>
      <input className="st-input st-input--sm" type="number" min={opts.min} max={opts.max} step={opts.step} value={(clip[key] as number | undefined) ?? opts.fallback}
        onChange={(e) => { const v = Number(e.target.value); onPatch({ [key]: opts.optional && !v ? undefined : v } as Partial<Clip>); }} />
    </Field>
  );
  const takeEnd = info?.take.outputSeconds;
  return (
    <section className="cut-panel cut-inspector" aria-label={tr("Selected clip")}>
      <div className="cut-h-row">
        <h2 className="cut-h">{info ? tr("Clip {i} · {slate} · take {n}", { i: index + 1, slate: info.s.slate, n: info.take.n }) : tr("Clip {i} · {id}", { i: index + 1, id: clip.shotId })}</h2>
        {info && <Link className="st-link" href={`${base}/screening?shot=${info.s.shot.id}`}>{tr("Screen takes")}</Link>}
      </div>
      {info && <p className="st-muted cut-intent">{info.s.shot.spec.intent}</p>}
      <div className="st-fields cut-fields">
        {num("inS", tr("In (s)"), { min: 0, max: 15, step: 0.01, fallback: 0 })}
        {num("outS", `${tr("Out (s)")}${takeEnd ? tr(" · take {s}", { s: takeEnd.toFixed(2) }) : ""}`, { min: 0, max: 15, step: 0.01, fallback: 0 })}
        <Field label={tr("Transition in")}>
          <select className="st-select st-input--sm" value={clip.transition} disabled={index === 0} onChange={(e) => onPatch({ transition: e.target.value as (typeof TRANSITIONS)[number] })}>
            {TRANSITIONS.map((name) => <option key={name} value={name}>{tr(`${name.replace("_", " ")}||transition`)}</option>)}
          </select>
        </Field>
        {clip.transition !== "cut" && num("transitionS", tr("Length (s)"), { min: 0.2, max: 1, step: 0.1, fallback: 0.4 })}
        {num("audioLeadS", tr("Sound leads (J-cut, s)"), { min: 0, max: 2, step: 0.1, fallback: 0, optional: true })}
        {num("audioTrailS", tr("Sound trails (L-cut, s)"), { min: 0, max: 2, step: 0.1, fallback: 0, optional: true })}
        {num("freezeS", tr("Hold last frame (s)"), { min: 0, max: 10, step: 0.1, fallback: 0, optional: true })}
        {num("speed", tr("Speed (×)"), { min: 0.5, max: 2, step: 0.05, fallback: 1 })}
        {num("repeat", tr("Repeat"), { min: 1, max: 120, step: 1, fallback: 1 })}
      </div>
      <label className="st-toggle"><input type="checkbox" checked={clip.muteOwnAudio ?? false} onChange={(e) => onPatch({ muteOwnAudio: e.target.checked })} />{tr("Mute this take's own sound")}</label>
      {seam && (
        <div className="st-alert">
          <span>{tr("{slate} starts on this take's last frame, and the cut leaves it {s} s before that.", { slate: seam.slate, s: seam.gapS.toFixed(2) })}</span>
          <Button size="sm" onClick={() => onFixSeam(seam)}>{tr("Run to the last frame")}</Button>
        </div>
      )}
      <div className="st-row">
        <Button size="sm" kind="quiet" disabled={index === 0} onClick={() => onMove(-1)}>{tr("Move earlier")}</Button>
        <Button size="sm" kind="quiet" disabled={index === count - 1} onClick={() => onMove(1)}>{tr("Move later")}</Button>
        <Button size="sm" kind="danger" onClick={onRemove}>{tr("Remove from the cut")}</Button>
      </div>
    </section>
  );
}

/* ---- titles: every word on screen is one of these ---- */

function TitlesPanel({ timeline, total, onChange }: { timeline: TimelineInput; total: number; onChange: (t: TimelineInput) => void }) {
  const titles = timeline.titles ?? [];
  const tr = useT();
  const patch = (i: number, change: Partial<NonNullable<TimelineInput["titles"]>[number]>) => onChange({ ...timeline, titles: titles.map((t, j) => (j === i ? { ...t, ...change } : t)) });
  return (
    <section className="cut-panel cut-panel--wide" aria-label={tr("Titles")}>
      <div className="cut-h-row">
        <h2 className="cut-h">{tr("Titles · {n}", { n: titles.length })}</h2>
        <Button size="sm" onClick={() => onChange({ ...timeline, titles: [...titles, { text: "Title", atS: 0, durationS: 3, kind: "overlay" }] })}>{tr("Add a title")}</Button>
      </div>
      {titles.length === 0 ? (
        <p className="st-muted">{tr("Titles, captions, signs and on-screen displays are added here and drawn by the assembler, so they are exact. The model is never asked for text.")}</p>
      ) : (
        titles.map((t, i) => (
          <div key={i} className="cut-title-row">
            <textarea className="st-textarea" rows={1} aria-label={tr("Text||title")} value={t.text} onChange={(e) => patch(i, { text: e.target.value || " " })} />
            <Field label={tr("At (s)")}><input className="st-input st-input--sm" type="number" min={0} max={Math.max(0, total)} step={0.1} value={t.atS} onChange={(e) => patch(i, { atS: Math.max(0, Number(e.target.value)) })} /></Field>
            <Field label={tr("For (s)")}><input className="st-input st-input--sm" type="number" min={0.2} max={600} step={0.1} value={t.durationS} onChange={(e) => patch(i, { durationS: Math.max(0.2, Number(e.target.value)) })} /></Field>
            <Field label={tr("Kind")}>
              <select className="st-select st-input--sm" value={t.kind} onChange={(e) => patch(i, { kind: e.target.value as (typeof TITLE_KINDS)[number] })}>
                {TITLE_KINDS.map((k) => <option key={k} value={k}>{tr(`${k}||title kind`)}</option>)}
              </select>
            </Field>
            <Button size="sm" kind="danger" onClick={() => onChange({ ...timeline, titles: titles.filter((_, j) => j !== i) })}>{tr("Remove")}</Button>
          </div>
        ))
      )}
    </section>
  );
}

/* ---- silences and narration ---- */

function SilencesPanel({ timeline, audio, onChange }: { timeline: TimelineInput; audio: Array<{ id: string; name?: string; meta: Record<string, unknown> }>; onChange: (t: TimelineInput) => void }) {
  const silences = timeline.silences ?? [];
  const narration = timeline.narration ?? [];
  const tr = useT();
  return (
    <section className="cut-panel" aria-label={tr("Silences and narration")}>
      <div className="cut-h-row">
        <h2 className="cut-h">{tr("Silences · {n}", { n: silences.length })}</h2>
        <Button size="sm" onClick={() => onChange({ ...timeline, silences: [...silences, { atS: 0, durationS: 1 }] })}>{tr("Mark a silence")}</Button>
      </div>
      {silences.length === 0 && <p className="st-muted">{tr("A silence takes the whole mix out for a stretch: the breath before a turn.")}</p>}
      {silences.map((s, i) => (
        <div key={i} className="cut-row">
          <Field label={tr("At (s)")}><input className="st-input st-input--sm" type="number" min={0} step={0.1} value={s.atS} onChange={(e) => onChange({ ...timeline, silences: silences.map((x, j) => (j === i ? { ...x, atS: Math.max(0, Number(e.target.value)) } : x)) })} /></Field>
          <Field label={tr("For (s)")}><input className="st-input st-input--sm" type="number" min={0.05} max={60} step={0.1} value={s.durationS} onChange={(e) => onChange({ ...timeline, silences: silences.map((x, j) => (j === i ? { ...x, durationS: Math.max(0.05, Number(e.target.value)) } : x)) })} /></Field>
          <Button size="sm" kind="danger" onClick={() => onChange({ ...timeline, silences: silences.filter((_, j) => j !== i) })}>{tr("Remove")}</Button>
        </div>
      ))}
      <div className="cut-h-row cut-h-row--next">
        <h2 className="cut-h">{tr("Narration · {n}", { n: narration.length })}</h2>
        <Button size="sm" disabled={audio.length === 0} title={audio.length === 0 ? tr("Upload a recording first, or have the director speak a line") : undefined} onClick={() => onChange({ ...timeline, narration: [...narration, { assetId: audio[0]!.id, atS: 0 }] })}>{tr("Add a line")}</Button>
      </div>
      {narration.length === 0 && <p className="st-muted">{tr("Off-screen and inner lines are laid on the film at their times; the music ducks under them.")}</p>}
      {narration.map((n, i) => (
        <div key={i} className="cut-row">
          <Field label={tr("Recording||narration")}>
            <select className="st-select st-input--sm" value={n.assetId} onChange={(e) => onChange({ ...timeline, narration: narration.map((x, j) => (j === i ? { ...x, assetId: e.target.value } : x)) })}>
              {audio.map((a) => <option key={a.id} value={a.id}>{a.name ?? String(a.meta.key ?? a.id)}</option>)}
            </select>
          </Field>
          <Field label={tr("At (s)")}><input className="st-input st-input--sm" type="number" min={0} step={0.1} value={n.atS} onChange={(e) => onChange({ ...timeline, narration: narration.map((x, j) => (j === i ? { ...x, atS: Math.max(0, Number(e.target.value)) } : x)) })} /></Field>
          <Button size="sm" kind="danger" onClick={() => onChange({ ...timeline, narration: narration.filter((_, j) => j !== i) })}>{tr("Remove")}</Button>
        </div>
      ))}
    </section>
  );
}
