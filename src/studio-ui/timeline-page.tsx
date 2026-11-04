"use client";

import { useEffect, useMemo, useState } from "react";

import type { TimelineInput } from "@/studio/schemas";
import type { ExportJob } from "@/studio/types";

import { get, post, put, usd, when } from "./api";
import { Button, Empty, ErrorBanner, Field, Lamp, Section, useAction, UploadButton } from "./common";
import { RoughCut } from "./rough-cut";
import { useProjectContext } from "./shell";

const PRESETS = ["master-768p", "master-upscaled", "social-9x16", "preview-480p"] as const;

export function TimelinePage() {
  const { projectId, view, reload } = useProjectContext();
  const [timeline, setTimeline] = useState<TimelineInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>("master-768p");
  const [burnIn, setBurnIn] = useState(false);

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
  const auto = useAction(async () => {
    const { timeline: next } = await post<{ timeline: TimelineInput }>(`/api/projects/${projectId}/timeline/auto`);
    setTimeline(next);
    setDirty(false);
    await reload();
  });
  const exportNow = useAction(async (confirm) => {
    if (dirty && timeline) await put(`/api/projects/${projectId}/timeline`, timeline);
    setDirty(false);
    await post(`/api/projects/${projectId}/exports`, { preset, burnInSubtitles: burnIn, confirm });
    const r = await get<{ exports: ExportJob[] }>(`/api/projects/${projectId}/exports`);
    setExports(r.exports);
    await reload();
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
          <p className="st-subtitle">Order the picked takes, trim, choose transitions, then export. {timeline.clips.length} clips · {total.toFixed(1)} s.</p>
        </div>
        <div className="st-actions">
          <Button kind="quiet" busy={auto.busy} onClick={() => void auto.fire()}>
            Auto build
          </Button>
          <Button kind="primary" busy={save.busy} disabled={!dirty} onClick={() => void save.fire()}>
            Save timeline
          </Button>
        </div>
      </div>
      <ErrorBanner error={save.error ?? auto.error ?? exportNow.error} projectId={projectId} onConfirm={exportNow.error ? () => void exportNow.confirm() : undefined} onDismiss={() => { save.dismiss(); auto.dismiss(); exportNow.dismiss(); }} />

      {timeline.clips.length === 0 ? (
        <Empty title="Empty timeline" hint="Auto build takes the selected take of every shot in board order.">
          <Button busy={auto.busy} onClick={() => void auto.fire()}>
            Auto build
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
                      <select className="st-select st-input--sm" value={clip.transition} onChange={(e) => set({ ...timeline, clips: timeline.clips.map((c, j) => (j === i ? { ...c, transition: e.target.value as "cut" | "dissolve" } : c)) })}>
                        <option value="cut">cut</option>
                        <option value="dissolve">dissolve</option>
                      </select>
                    </Field>
                    {clip.transition === "dissolve" && (
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

      <div className="st-split" style={{ marginTop: 24 }}>
        <div className="st-card st-stack">
          <span className="st-label" style={{ marginBottom: 0 }}>Audio mix</span>
          <Field label="Music track">
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
              <input type="range" className="ohf-slider" min={-30} max={6} step={1} value={timeline.mix[key]} style={{ "--fill": `${((timeline.mix[key] + 30) / 36) * 100}%` } as React.CSSProperties} onChange={(e) => set({ ...timeline, mix: { ...timeline.mix, [key]: Number(e.target.value) } })} />
            </Field>
          ))}
        </div>
        <div className="st-card st-stack">
          <span className="st-label" style={{ marginBottom: 0 }}>Export</span>
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
        </div>
      </div>

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
