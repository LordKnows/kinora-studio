"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { TRANSITIONS, type TimelineInput } from "@/studio/schemas";
import type { ExportJob } from "@/studio/types";

import { get, post, put, usd, when } from "./api";
import { Button, Empty, ErrorBanner, Field, Lamp, Section, useAction, UploadButton } from "./common";
import { RoughCut } from "./rough-cut";
import { useProjectContext } from "./shell";

const PRESETS = ["master-768p", "master-upscaled", "social-9x16", "preview-480p"] as const;

/* The default timeline (and Reset): the selected take of every shot, in board
   order, each from 0 s to the end of its take. */
const DEFAULT_BUILD = { selectedOnly: true, fullLength: true };

export function TimelinePage() {
  const { projectId, view, reload } = useProjectContext();
  const [timeline, setTimeline] = useState<TimelineInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("master-768p");
  const [burnIn, setBurnIn] = useState(false);
  const [exportNote, setExportNote] = useState<string[] | null>(null);
  const [grid, setGrid] = useState({ bpm: 120, beatsPerBar: 4, subdivision: 1 });
  const [gridResult, setGridResult] = useState<{ cuts: Array<{ startS: number; outS: number; cutAtS: number }>; warnings: Array<{ message: string }> } | null>(null);
  const [subs, setSubs] = useState<{ issues: Array<{ id?: string; message: string; severity?: string }>; srt: string } | null>(null);
  const [showSrt, setShowSrt] = useState(false);

  useEffect(() => {
    if (view && !timeline) setTimeline(view.timeline);
  }, [view, timeline]);

  useEffect(() => {
    void get<{ exports: ExportJob[] }>(`/api/projects/${projectId}/exports`).then((r) => setExports(r.exports)).catch(() => undefined);
  }, [projectId, view]);

  const takesById = useMemo(() => {
    const map = new Map<string, { url?: string; thumb?: string; shotIndex: number; intent: string; durationS: number; status: string }>();
    for (const scene of view?.scenes ?? []) {
      for (const shot of scene.shots) {
        for (const t of shot.takes) map.set(t.id, { url: t.resultUrl, thumb: t.thumbUrls[0], shotIndex: shot.index, intent: shot.spec.intent, durationS: shot.spec.durationS, status: t.status });
      }
    }
    return map;
  }, [view]);

  const save = useAction(async () => {
    if (!timeline) return;
    const { timeline: next } = await put<{ timeline: TimelineInput }>(`/api/projects/${projectId}/timeline`, timeline);
    setTimeline(next);
    setDirty(false);
    await reload();
  });
  const reset = useAction(async (_c, ask: boolean) => {
    if (ask && timeline?.clips.length && !window.confirm("Reset the timeline? Every selected take joins in board order, from 0 s at its full length; the current order, trims and transitions are replaced.")) return;
    const { timeline: next } = await post<{ timeline: TimelineInput }>(`/api/projects/${projectId}/timeline/auto`, DEFAULT_BUILD);
    setTimeline(next);
    setDirty(false);
    await reload();
  });
  /* an empty saved timeline starts as the default one, once per visit */
  const built = useRef(false);
  const hasSelected = (view?.scenes ?? []).some((sc) => sc.shots.some((sh) => sh.selectedTake?.status === "completed"));
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
    const shots = timeline.clips.map((c) => ({ durationS: takesById.get(c.takeId)?.durationS ?? Math.max(0, c.outS - c.inS) }));
    const r = await post<{ cuts: Array<{ startS: number; outS: number; cutAtS: number }>; warnings: Array<{ message: string }> }>("/api/director/cue", {
      cueMap: { sections: [{ id: "a", t: 0, bpm: grid.bpm, beatsPerBar: grid.beatsPerBar }], hits: [] },
      shots, subdivision: grid.subdivision, startS: 0,
    });
    setGridResult(r);
    set({ ...timeline, clips: timeline.clips.map((c, i) => (r.cuts[i] ? { ...c, outS: Math.round((c.inS + r.cuts[i]!.outS) * 100) / 100 } : c)) });
  });
  const checkSubs = useAction(async () => {
    if (!timeline || !view) return;
    const lines: Array<{ id: string; text: string; t0: number; t1: number; language?: string }> = [];
    let cursor = 0;
    for (const clip of timeline.clips) {
      const shot = view.scenes.flatMap((sc) => sc.shots).find((sh) => sh.takes.some((t) => t.id === clip.takeId));
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

  if (!timeline || !view) return null;
  const set = (next: TimelineInput) => {
    setTimeline(next);
    setDirty(true);
  };
  const total = timeline.clips.reduce((n, c) => n + Math.max(0, c.outS - c.inS), 0);
  const music = view.assets.filter((a) => a.kind === "audio");

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Timeline</h1>
          <p className="st-subtitle">Every selected take joined in board order, each from 0 s at its full length. Reorder, trim, choose transitions, then export. {timeline.clips.length} clips · {total.toFixed(1)} s.</p>
        </div>
        <div className="st-actions">
          <Button kind="quiet" busy={reset.busy} onClick={() => void reset.fire(true)} title="Rebuild from the selected take of every shot, from 0 s at full length">
            Reset
          </Button>
          <Button kind="primary" busy={save.busy} disabled={!dirty} onClick={() => void save.fire()}>
            Save timeline
          </Button>
        </div>
      </div>
      <ErrorBanner error={save.error ?? reset.error ?? exportNow.error ?? snap.error ?? checkSubs.error} projectId={projectId} onConfirm={exportNow.error ? () => void exportNow.confirm() : undefined} onDismiss={() => { save.dismiss(); reset.dismiss(); exportNow.dismiss(); snap.dismiss(); checkSubs.dismiss(); }} />
      {exportNote && (
        <div className="st-alert st-alert--warn" style={{ marginBottom: 16 }}>
          <span>{exportNote.join(" ")}</span>
          <Button size="sm" kind="quiet" onClick={() => setExportNote(null)}>Dismiss</Button>
        </div>
      )}

      {timeline.clips.length === 0 ? (
        <Empty title="Empty timeline" hint={hasSelected ? "Reset joins the selected take of every shot in board order." : "No shot has a selected take yet: pick one per shot on the Board (Use this take) and it joins the timeline."}>
          <Button busy={reset.busy} disabled={!hasSelected} onClick={() => void reset.fire(false)}>
            Reset
          </Button>
        </Empty>
      ) : (
        <div className="st-stack st-stack--tight">
          {timeline.clips.map((clip, i) => {
            const take = takesById.get(clip.takeId);
            return (
              <div key={`${clip.takeId}-${i}`} className="st-clip">
                <div className="st-row" style={{ flexDirection: "column", gap: 2 }}>
                  <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={i === 0} aria-label="Move up" onClick={() => {
                    const clips = [...timeline.clips];
                    [clips[i - 1], clips[i]] = [clips[i]!, clips[i - 1]!];
                    set({ ...timeline, clips });
                  }}>
                    ↑
                  </button>
                  <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={i === timeline.clips.length - 1} aria-label="Move down" onClick={() => {
                    const clips = [...timeline.clips];
                    [clips[i + 1], clips[i]] = [clips[i]!, clips[i + 1]!];
                    set({ ...timeline, clips });
                  }}>
                    ↓
                  </button>
                </div>
                <div className="st-clip-thumb">{take?.thumb ? <img src={take.thumb} alt="" /> : take?.url ? <video src={take.url} muted preload="metadata" /> : <div className="st-placeholder" />}</div>
                <div className="st-stack st-stack--tight">
                  <div className="st-row st-row--between">
                    <strong>
                      {take ? `Shot ${take.shotIndex + 1} · ${take.intent}` : clip.shotId}
                    </strong>
                    {take && take.status !== "completed" && <Lamp state={take.status} label={take.status} />}
                  </div>
                  <div className="st-row">
                    <Field label="In (s)">
                      <input className="st-input st-input--sm" type="number" step={0.1} min={0} value={clip.inS} style={{ width: 80 }} onChange={(e) => set({ ...timeline, clips: timeline.clips.map((c, j) => (j === i ? { ...c, inS: Number(e.target.value) } : c)) })} />
                    </Field>
                    <Field label="Out (s)">
                      <input className="st-input st-input--sm" type="number" step={0.1} max={15} value={clip.outS} style={{ width: 80 }} onChange={(e) => set({ ...timeline, clips: timeline.clips.map((c, j) => (j === i ? { ...c, outS: Number(e.target.value) } : c)) })} />
                    </Field>
                    <Field label="Transition in">
                      <select className="st-select st-input--sm" value={clip.transition} onChange={(e) => set({ ...timeline, clips: timeline.clips.map((c, j) => (j === i ? { ...c, transition: e.target.value as (typeof TRANSITIONS)[number] } : c)) })}>
                        {TRANSITIONS.map((name) => <option key={name} value={name}>{name.replace("_", " ")}</option>)}
                      </select>
                    </Field>
                    {clip.transition !== "cut" && (
                      <Field label="Length (s)">
                        <input className="st-input st-input--sm" type="number" step={0.1} min={0.2} max={1} value={clip.transitionS ?? 0.4} style={{ width: 80 }} onChange={(e) => set({ ...timeline, clips: timeline.clips.map((c, j) => (j === i ? { ...c, transitionS: Number(e.target.value) } : c)) })} />
                      </Field>
                    )}
                  </div>
                </div>
                <Button size="sm" kind="quiet" onClick={() => set({ ...timeline, clips: timeline.clips.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Section title="Rough cut preview">
        <RoughCut timeline={timeline} view={view} />
      </Section>

      <div className="st-section" style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="st-card st-stack">
          <span className="st-h2">Beat grid</span>
          <span className="st-muted">Snap every cut to the music: each clip ends on a beat, bar or half beat within what its take can give.</span>
          <div className="st-fields">
            <Field label="BPM">
              <input className="st-input" type="number" min={20} max={300} value={grid.bpm} onChange={(e) => setGrid({ ...grid, bpm: Number(e.target.value) || 120 })} />
            </Field>
            <Field label="Beats per bar">
              <input className="st-input" type="number" min={1} max={12} value={grid.beatsPerBar} onChange={(e) => setGrid({ ...grid, beatsPerBar: Number(e.target.value) || 4 })} />
            </Field>
            <Field label="Cut on">
              <select className="st-select" value={grid.subdivision} onChange={(e) => setGrid({ ...grid, subdivision: Number(e.target.value) })}>
                <option value={1}>beat</option>
                <option value={0.25}>bar</option>
                <option value={2}>half beat</option>
              </select>
            </Field>
          </div>
          <div className="st-row st-row--between">
            <span className="st-muted st-num">{gridResult ? `${gridResult.cuts.length} cuts snapped · last at ${gridResult.cuts.at(-1)?.cutAtS.toFixed(2) ?? "—"} s` : "not applied"}</span>
            <Button busy={snap.busy} disabled={timeline.clips.length === 0} onClick={() => void snap.fire()}>Snap cuts to grid</Button>
          </div>
        </div>
        <div className="st-card st-stack">
          <span className="st-h2">Audio mix</span>
          <Field label="Music track" group>
            <UploadButton accept="audio/mpeg,audio/wav,audio/x-wav" projectId={projectId} label="Upload music" onUploaded={async ({ assetId }) => { await reload(); set({ ...timeline, music: assetId }); }} />
            <select className="st-select" value={timeline.music ?? ""} onChange={(e) => set({ ...timeline, music: e.target.value || undefined })}>
              <option value="">None</option>
              {music.map((a) => (
                <option key={a.id} value={a.id}>
                  {String(a.meta.key ?? a.id)}
                </option>
              ))}
            </select>
          </Field>
          {(["dialogueDb", "sfxDb", "musicDb"] as const).map((key) => (
            <Field key={key} label={`${key.replace("Db", "")} ${timeline.mix[key]} dB`}>
              <input type="range" className="st-range" min={-30} max={6} step={1} value={timeline.mix[key]} style={{ "--fill": `${((timeline.mix[key] + 30) / 36) * 100}%` } as React.CSSProperties} onChange={(e) => set({ ...timeline, mix: { ...timeline.mix, [key]: Number(e.target.value) } })} />
            </Field>
          ))}
        </div>
        <div className="st-card st-stack">
          <span className="st-h2">Export</span>
          <Field label="Preset">
            <select className="st-select" value={preset} onChange={(e) => setPreset(e.target.value as (typeof PRESETS)[number])}>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <label className="st-toggle">
            <input type="checkbox" checked={burnIn} onChange={(e) => setBurnIn(e.target.checked)} />
            Burn in subtitles
          </label>
          <Button kind="primary" busy={exportNow.busy} disabled={timeline.clips.length === 0} onClick={() => void exportNow.fire()}>
            Export
          </Button>
          <span className="st-muted">master-upscaled uses each pick’s 2K file from Finals; clips without one fall back to 768p and are listed when the export starts.</span>
        </div>
      </div>

      <Section title="Subtitles" aside={<small>reading time: CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, at least 1.8 s</small>}>
        <div className="st-card st-stack">
          <div className="st-row st-row--between">
            <span className="st-muted">Dialogue lines of the clips in order, spread across each clip. The check flags lines too short to read; the SRT is what burn-in uses.</span>
            <Button busy={checkSubs.busy} disabled={timeline.clips.length === 0} onClick={() => void checkSubs.fire()}>Check subtitles</Button>
          </div>
          {subs && (
            <>
              {subs.issues.length === 0 ? <Lamp state="ok" label="every line has time to be read" /> : (
                <div className="st-lint">
                  {subs.issues.map((i, n) => (
                    <div key={n} className="st-lint-row" data-severity={i.severity ?? "warn"}>
                      <span className="st-lint-where">{i.id ?? "line"}</span>
                      <span>{i.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="st-row">
                <Button size="sm" kind="quiet" onClick={() => setShowSrt((v) => !v)}>{showSrt ? "Hide SRT" : "Show SRT"}</Button>
                <Button size="sm" kind="quiet" onClick={() => void navigator.clipboard.writeText(subs.srt)}>Copy SRT</Button>
              </div>
              {showSrt && <pre className="st-pre">{subs.srt || "(no dialogue in the timeline)"}</pre>}
            </>
          )}
        </div>
      </Section>

      <Section title="Exports" aside={<small>{exports.length}</small>}>
        {exports.length === 0 ? (
          <Empty title="No exports yet" />
        ) : (
          <div className="st-card st-card--pad0">
            <table className="st-table">
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td>{e.preset}</td>
                    <td>
                      <Lamp state={e.status} label={e.status} />
                      {e.error && <span className="st-muted"> · {e.error}</span>}
                    </td>
                    <td>{when(e.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      {e.resultUrl && (
                        <a className="st-link" href={e.resultUrl} target="_blank" rel="noreferrer">
                          Download
                        </a>
                      )}
                      {e.srtUrl && (
                        <>
                          {" · "}
                          <a className="st-link" href={e.srtUrl} target="_blank" rel="noreferrer">
                            SRT
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <p className="st-muted" style={{ marginTop: 12 }}>Spent so far: {usd(view.project.spentUsd)} of {usd(view.project.budgetCapUsd)}.</p>
    </div>
  );
}
