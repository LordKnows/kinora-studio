"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { VoiceJob } from "@/studio/types";

import { get, post } from "./api";
import { Button, ErrorBanner, useAction, useBusyKeys, whenT } from "./common";
import { ChevronIcon } from "./icons";
import { useT } from "./i18n";

/* Voice takes for a shot's dialogue lines (voice-pod.ts): with the project's voice model on the GPU pod
   (Qwen3-TTS VoiceDesign), a line is spoken several times and the user keeps one by ear. The checks only
   mark takes that went wrong (off the voice, misread); they never choose. The kept take becomes the
   line's audio in the draft, saved with the shot.

   One block a line (LineVoice): the final voice (the recording the line carries, to hear and download), the
   Speak takes button, and the batches of takes, newest first, the newest open. */

type VoicingLite = { enabled: boolean; model: string; models: Array<{ id: string; provider?: string }> };

/** A recording to listen to and keep: the player and a download link. */
export function AudioClip({ url, filename }: { url: string; filename: string }) {
  const tr = useT();
  const ext = /\.([a-z0-9]{2,4})(?:[?#].*)?$/i.exec(url)?.[1] ?? "wav";
  return (
    <span className="st-row st-audio-clip">
      <audio className="vc-audio" controls preload="none" src={url} />
      <a className="st-btn st-btn--quiet st-btn--sm" href={url} download={`${filename}.${ext}`} target="_blank" rel="noreferrer">{tr("Download")}</a>
    </span>
  );
}

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

/* What the pronunciation check heard, with the characters the line does not have marked: the places it
   went wrong show without comparing the two by eye. Punctuation and spaces are not marked. */
function heardParts(heard: string, line: string): Array<{ text: string; bad: boolean }> {
  const a = Array.from(heard);
  const b = Array.from(line);
  if (a.length * b.length > 90000) return [{ text: heard, bad: false }];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const kept = new Array<boolean>(a.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { kept[i] = true; i++; j++; } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++; else j++;
  }
  const parts: Array<{ text: string; bad: boolean }> = [];
  a.forEach((ch, i) => {
    const bad = !kept[i] && !/[\s\p{P}]/u.test(ch);
    const last = parts[parts.length - 1];
    if (last && last.bad === bad) last.text += ch; else parts.push({ text: ch, bad });
  });
  return parts;
}

const SHOWN = 5;

export function LineVoice({ projectId, shotId, lineIndex, lineText, name, audioAssetId, clipUrl, canSpeak, jobs, reload, onUse }: {
  projectId: string;
  shotId?: string;
  lineIndex: number;
  lineText: string;
  /** the speaker's name, for the file name of a download */
  name: string;
  audioAssetId?: string;
  /** the final voice's file, when the project still has it */
  clipUrl?: string;
  /** the voice model runs on the GPU pod: takes can be made here */
  canSpeak: boolean;
  jobs: VoiceJob[];
  reload: () => Promise<void>;
  onUse: (assetId: string | undefined) => void;
}) {
  const tr = useT();
  const mine = useMemo(() => jobs.filter((j) => j.lineIndex === lineIndex).sort((a, b) => b.createdAt - a.createdAt), [jobs, lineIndex]);
  /* a batch's number is its place in the order they were made */
  const numberOf = (job: VoiceJob) => mine.length - mine.indexOf(job);
  const [show, setShow] = useState(false);
  const [openJob, setOpenJob] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  const speak = useAction(async () => {
    if (!shotId) return;
    await post(`/api/projects/${projectId}/voice-jobs`, { shotId, line: lineIndex });
    setShow(true);
    await reload();
  });
  const going = useBusyKeys();
  const pick = useAction(async (_confirm, job: VoiceJob, take: number) => going.run(`${job.id}:${take}`, async () => {
    const r = await post<{ asset: { id: string } }>(`/api/projects/${projectId}/voice-jobs/${job.id}/pick`, { take });
    onUse(r.asset.id);
    await reload();
  }));
  const out = mine.some(OUT);
  const from = audioAssetId ? mine.find((j) => j.pickedAssetId === audioAssetId && j.picked !== undefined) : undefined;
  const fromTake = from?.takes.find((t) => t.index === from.picked);
  if (!audioAssetId && !canSpeak) return null;
  return (
    <div className="vt">
      {audioAssetId ? (
        <div className="vt-final">
          <div className="st-row st-row--between">
            <span className="st-label" style={{ marginBottom: 0 }}>{tr("Final voice")}</span>
            <Button size="sm" kind="quiet" onClick={() => onUse(undefined)} title={tr("The line stops carrying this recording; the recording itself stays in the library")}>{tr("Remove")}</Button>
          </div>
          {clipUrl ? <AudioClip url={clipUrl} filename={`${name}-${lineIndex + 1}`} /> : <span className="st-muted">{tr("The recording is no longer in the library.")}</span>}
          {from && fromTake && (
            <span className="st-muted">
              {tr("From batch {b} · take {t}", { b: numberOf(from), t: fromTake.index })}
              {fromTake.similarity !== null && ` · ${tr("voice {s}", { s: fromTake.similarity.toFixed(2) })}`}
            </span>
          )}
        </div>
      ) : (
        <div className="vt-final vt-final--empty">
          <span className="st-label" style={{ marginBottom: 0 }}>{tr("Final voice")}</span>
          <span className="st-muted">{tr("None yet. Speak takes, listen, and keep one.")}</span>
        </div>
      )}
      {canSpeak && (
        <div className="st-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" kind="secondary" onClick={() => void speak.fire()} busy={speak.busy || out} disabled={!lineText.trim()} title={tr("Speaks the saved line on the GPU pod, several times")}>
            {tr("Speak takes")}
          </Button>
          {mine.length > 0 && (
            <Button size="sm" aria-expanded={show} onClick={() => setShow(!show)}>{tr("View takes")}</Button>
          )}
        </div>
      )}
      <ErrorBanner error={speak.error ?? pick.error} onDismiss={() => { speak.dismiss(); pick.dismiss(); }} projectId={projectId} />
      {canSpeak && show && mine.map((job, at) => {
        const open = openJob[job.id] ?? at === 0;
        const rows = all[job.id] ? job.takes : job.takes.slice(0, SHOWN);
        return (
          <div key={job.id} className="vt-batch" data-open={open}>
            <button type="button" className="vt-batch-head" aria-expanded={open} onClick={() => setOpenJob({ ...openJob, [job.id]: !open })}>
              <strong>{tr("Batch {n}", { n: numberOf(job) })}</strong>
              <span className="st-muted">
                {job.takes.length ? `${tr("{n} takes", { n: job.takes.length })} · ` : ""}{job.delivery ? job.delivery : tr("Neutral delivery")} · {whenT(tr, job.createdAt)}
              </span>
              {job.text !== lineText.trim() && <span className="vt-tag vt-tag--warn" title={tr("made for an earlier wording: “{text}”", { text: job.text })}>{tr("earlier wording")}</span>}
              {job.status === "failed" && <span className="vt-tag vt-tag--err" title={job.error}>{tr("Failed")}</span>}
              <ChevronIcon />
            </button>
            {OUT(job) && <div className="vt-prog" role="progressbar" aria-label={tr("Speaking…")}><i /></div>}
            {open && job.status === "failed" && job.error && <div className="vt-sub st-muted">{tr("failed: {e}", { e: job.error })}</div>}
            {open && rows.map((take) => {
              const inUse = !!audioAssetId && job.pickedAssetId === audioAssetId && job.picked === take.index;
              const low = take.flags.includes("off_voice");
              return (
                <div key={take.index} className="vt-take" data-current={inUse}>
                  <span className="vt-n">{take.index}</span>
                  <audio controls preload="none" src={take.url} onPlay={(e) => { for (const el of document.querySelectorAll("audio")) if (el !== e.currentTarget) el.pause(); }} />
                  {take.similarity !== null
                    ? <span className={low ? "vt-score vt-score--low" : "vt-score"} title={tr("Closeness to the voice card's reference audio (speaker embeddings); short clips score low")}>{take.similarity.toFixed(2)}</span>
                    : <span />}
                  <span className="vt-acts">
                    {inUse
                      ? <span className="vt-tag vt-tag--ok">{tr("In use")}</span>
                      : <Button size="sm" busy={going.busy(`${job.id}:${take.index}`)} onClick={() => void pick.fire(job, take.index)}>{tr("Keep")}</Button>}
                    <a className="st-btn st-btn--quiet st-btn--sm" href={take.url} download={`${name}-${lineIndex + 1}-b${numberOf(job)}-${take.index}.wav`} target="_blank" rel="noreferrer" aria-label={tr("Download")} title={tr("Download")}>⤓</a>
                  </span>
                  {(low || take.flags.includes("misread")) && (
                    <span className="vt-sub">
                      {low && <span className="vt-tag vt-tag--warn">{tr("off the voice")}</span>}
                      {take.flags.includes("misread") && take.heard && (
                        <span className="st-muted">{tr("heard")} “{heardParts(take.heard, job.text).map((p, i) => (p.bad ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}”</span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
            {open && job.takes.length > SHOWN && (
              <button type="button" className="vt-more" onClick={() => setAll({ ...all, [job.id]: !all[job.id] })}>
                {all[job.id] ? tr("Show fewer") : tr("+ {n} more", { n: job.takes.length - SHOWN })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
