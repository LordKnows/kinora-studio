"use client";

import { useCallback, useEffect, useState } from "react";

import type { VoiceJob } from "@/studio/types";

import { get, post } from "./api";
import { Button, ErrorBanner, useAction } from "./common";
import { useT } from "./i18n";

/* Voice takes for a shot's dialogue lines (voice-pod.ts): with the project's voice model on the GPU pod
   (Qwen3-TTS VoiceDesign), a line is spoken several times and the user keeps one by ear. The checks only
   mark takes that went wrong (off the voice, misread); they never choose. The kept take becomes the
   line's audio in the draft, saved with the shot. */

type VoicingLite = { enabled: boolean; model: string; models: Array<{ id: string; provider?: string }> };

const OUT = (j: VoiceJob) => j.status === "queued" || j.status === "running";

export function useVoiceTakes(projectId: string, shotId?: string) {
  const [voicing, setVoicing] = useState<VoicingLite | null>(null);
  const [jobs, setJobs] = useState<VoiceJob[]>([]);
  const reload = useCallback(async () => {
    if (!shotId) return;
    const [v, j] = await Promise.all([
      get<VoicingLite>(`/api/projects/${projectId}/voicing`).catch(() => null),
      get<{ voiceJobs: VoiceJob[] }>(`/api/projects/${projectId}/voice-jobs?shotId=${encodeURIComponent(shotId)}`).catch(() => ({ voiceJobs: [] as VoiceJob[] })),
    ]);
    setVoicing(v);
    setJobs(j.voiceJobs);
  }, [projectId, shotId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  /* while takes are out, ask the pod (the webhook usually answers first) */
  useEffect(() => {
    const out = jobs.filter(OUT);
    if (!out.length) return;
    const t = window.setTimeout(() => {
      void Promise.all(out.map((j) => get(`/api/projects/${projectId}/voice-jobs/${j.id}`).catch(() => null))).then(() => reload());
    }, 4000);
    return () => window.clearTimeout(t);
  }, [jobs, projectId, reload]);
  const onPod = !!voicing?.enabled && voicing.models.find((m) => m.id === voicing.model)?.provider === "pod";
  return { onPod, jobs, reload };
}

export function LineTakes({ projectId, shotId, lineIndex, lineText, audioAssetId, jobs, reload, onUse }: {
  projectId: string;
  shotId: string;
  lineIndex: number;
  lineText: string;
  audioAssetId?: string;
  jobs: VoiceJob[];
  reload: () => Promise<void>;
  onUse: (assetId: string) => void;
}) {
  const tr = useT();
  const mine = jobs.filter((j) => j.lineIndex === lineIndex);
  const [open, setOpen] = useState(false);
  const speak = useAction(async () => {
    await post(`/api/projects/${projectId}/voice-jobs`, { shotId, line: lineIndex });
    setOpen(true);
    await reload();
  });
  const pick = useAction(async (_confirm, job: VoiceJob, take: number) => {
    const r = await post<{ asset: { id: string } }>(`/api/projects/${projectId}/voice-jobs/${job.id}/pick`, { take });
    onUse(r.asset.id);
    await reload();
  });
  const out = mine.some(OUT);
  return (
    <div className="st-line-takes">
      <div className="st-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Button size="sm" kind="quiet" onClick={() => setOpen(!open)} disabled={!mine.length}>
          {open ? tr("Hide takes") : tr("Voice takes ({n})", { n: mine.length })}
        </Button>
        <Button size="sm" onClick={() => void speak.fire()} busy={speak.busy} disabled={out || !lineText.trim()} title={tr("Speaks the saved line on the GPU pod, several times")}>
          {out ? tr("Speaking…") : tr("Speak takes")}
        </Button>
        {audioAssetId && <span className="st-muted">{tr("This line has its audio.")}</span>}
      </div>
      <ErrorBanner error={speak.error ?? pick.error} onDismiss={() => { speak.dismiss(); pick.dismiss(); }} projectId={projectId} />
      {open && mine.map((job) => (
        <div key={job.id} className="st-stack st-stack--tight st-take-job">
          <span className="st-muted">
            {job.delivery ? tr("Delivery: {d}", { d: job.delivery }) : tr("Neutral delivery")}
            {job.text !== lineText.trim() && ` · ${tr("made for an earlier wording: “{text}”", { text: job.text })}`}
            {OUT(job) && ` · ${tr("on the GPU…")}`}
            {job.status === "failed" && ` · ${tr("failed: {e}", { e: job.error ?? "" })}`}
          </span>
          {job.takes.map((take) => {
            const inUse = !!audioAssetId && job.pickedAssetId === audioAssetId && job.picked === take.index;
            return (
              <div key={take.index} className="st-row st-take-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className="st-label" style={{ marginBottom: 0, minWidth: 18 }}>{take.index}</span>
                <audio controls preload="none" src={take.url} style={{ height: 32, maxWidth: "100%" }} />
                {take.similarity !== null && (
                  <span className={take.flags.includes("off_voice") ? "st-chip st-warn" : "st-chip"} title={tr("Closeness to the voice card's reference audio (speaker embeddings); short clips score low")}>
                    {tr("voice {s}", { s: take.similarity.toFixed(2) })}
                  </span>
                )}
                {take.flags.includes("misread") && <span className="st-chip st-warn">{tr("heard “{h}”", { h: take.heard ?? "" })}</span>}
                <Button size="sm" kind={inUse ? "primary" : "default"} disabled={inUse} busy={pick.busy} onClick={() => void pick.fire(job, take.index)}>
                  {inUse ? tr("In use") : tr("Keep this take")}
                </Button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
