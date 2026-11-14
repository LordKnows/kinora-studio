"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { projectImageModel } from "@/studio/models";
import type { Asset, Job } from "@/studio/types";

import { get, post } from "./api";
import { Button, ErrorBanner, useAction } from "./common";
import { type T, useT } from "./i18n";
import { useProjectContext } from "./shell";

/* The web side of the project's pictures: every button posts one action to
   /api/projects/:id/images and follows the job until it is drawn, with the
   image model chosen on the Director page (a painter for GPT Image and
   Qwen-Image 3.0 Pro, the GPU pod for its models). The buttons are disabled
   while image generation is off for the project. */

export type Box = { x: number; y: number; w: number; h: number };

export type ImagingOn = { on: boolean; why?: string; label: string; runtime: "api" | "pod"; backend: string; drawnBy: string };

/** Whether the project draws pictures now, and with which model (the Director page). */
export function useImagingOn(): ImagingOn {
  const { view } = useProjectContext();
  const tr = useT();
  const i = view?.project.imaging;
  const model = projectImageModel(i);
  const pod = model.runtime === "pod";
  const base = { label: model.label, runtime: model.runtime, backend: model.backend ?? "", drawnBy: pod ? tr("{model}, on the GPU pod while it runs", { model: model.label }) : tr("{model}, by a painter", { model: model.label }) };
  if (!i?.enabled) return { ...base, on: false, why: tr("image generation is off for this project: switch it on from the project's Settings page") };
  if (i.stoppedReason) return { ...base, on: false, why: tr("image generation stopped: {reason}", { reason: i.stoppedReason }) };
  if (i.usedImages >= i.maxImages) return { ...base, on: false, why: tr("image quota used ({used}/{max}); raise it in Settings", { used: i.usedImages, max: i.maxImages }) };
  return { ...base, on: true };
}

/** GPT Image's quality tiers mean something; the other models have none. */
export function hasQualityTiers(i: { backend: string }): boolean {
  return i.backend === "codex" || i.backend === "api";
}

type Started = { job?: Job; runner?: string; painters?: { ready: boolean; note?: string }; note?: string; queued?: Array<{ jobId: string }>; later?: string[] };

/* The status is kept in English (its prefixes steer the polling) and translated when shown. */
function shownStatus(s: string, tr: T): string {
  if (s.startsWith("failed: ")) return tr("failed: {error}", { error: tr(s.slice(8)) });
  if (s.startsWith("drawing… ")) return tr("drawing… {n}", { n: s.slice(9) });
  if (s.startsWith("queued — ")) return tr("queued — {why}", { why: tr(s.slice(9)) });
  if (s === "done") return tr("done||picture drawn");
  return tr(s);
}

/** Start an image action and poll its job(s); reload the project when they are done. */
export function useImageAction() {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const [status, setStatus] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const follow = useCallback(async (jobIds: string[]) => {
    const pending = new Set(jobIds);
    const tick = async () => {
      for (const id of [...pending]) {
        const { job } = await get<{ job: Job; assets: Asset[] }>(`/api/jobs/${id}`);
        if (job.status === "completed") pending.delete(id);
        else if (job.status === "failed") {
          pending.delete(id);
          setStatus(`failed: ${job.error ?? "no picture"}`);
        }
      }
      if (pending.size) {
        setStatus((s) => (s.startsWith("failed") || s.startsWith("queued —") ? s : `drawing… ${jobIds.length - pending.size}/${jobIds.length}`));
        timer.current = setTimeout(() => void tick(), 3000);
      } else {
        setStatus((s) => (s.startsWith("failed") ? s : "done"));
        await reload();
      }
    };
    await tick();
  }, [reload]);
  const act = useAction(async (_confirm, body: Record<string, unknown>) => {
    setStatus("starting…");
    const r = await post<Started>(`/api/projects/${projectId}/images`, body);
    const ids = r.job ? [r.job.id] : (r.queued ?? []).map((q) => q.jobId);
    if (!ids.length) {
      setStatus(r.note ?? "nothing to draw");
      return;
    }
    if (r.note) setStatus(r.note);
    if (r.painters && !r.painters.ready) {
      /* nobody can draw it right now: say why; the GPU pod is only a fallback, never started from here */
      setStatus(`queued — ${r.painters.note ?? "waiting for a painter"}`);
    }
    void follow(ids);
  });
  return { ...act, status: status && shownStatus(status, tr) };
}

/** A button that runs one image action, with its status beside it. `blocked` disables it and says why. */
export function ImageButton({ label, body, paint = true, title, size = "sm", kind = "default", blocked }: { label: string; body: Record<string, unknown>; paint?: boolean; title?: string; size?: "sm" | "md"; kind?: "default" | "primary" | "secondary" | "quiet"; blocked?: string }) {
  const { projectId } = useProjectContext();
  const imaging = useImagingOn();
  const a = useImageAction();
  const off = paint && !imaging.on;
  const fire = () => void a.fire(body);
  return (
    <span className="st-row" style={{ gap: 6, flexWrap: "wrap" }}>
      <Button size={size === "sm" ? "sm" : undefined} kind={kind} busy={a.busy} disabled={off || !!blocked} title={blocked ?? (off ? imaging.why : title)} onClick={fire}>{label}</Button>
      {a.status && <span className="st-muted st-num">{a.status}</span>}
      <ErrorBanner error={a.error} projectId={projectId} onDismiss={a.dismiss} />
    </span>
  );
}

/** Drag a box on a picture; reports it as fractions of the picture. The box
    takes the picture's own aspect ratio (a 9:16 frame is shown whole, at most
    `height` px tall), so the fractions are fractions of the picture itself. */
export function RegionPicker({ src, value, onChange, height = 480 }: { src: string; value?: Box; onChange: (b: Box | undefined) => void; height?: number }) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Box | undefined>(value);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 16, h: 9 });
  useEffect(() => setDraft(value), [value]);
  const at = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const box = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  return (
    <div className="st-stack st-stack--tight">
      <div
        ref={ref}
        style={{ position: "relative", width: `min(100%, ${Math.round((height * size.w) / size.h)}px)`, aspectRatio: `${size.w} / ${size.h}`, margin: "0 auto", borderRadius: 0, overflow: "hidden", background: "#000", touchAction: "none", cursor: "crosshair" }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = at(e); setDraft(undefined); }}
        onPointerMove={(e) => { if (start.current) setDraft(box(start.current, at(e))); }}
        onPointerUp={(e) => { if (!start.current) return; const b = box(start.current, at(e)); start.current = null; const ok = b.w > 0.01 && b.h > 0.01; setDraft(ok ? b : undefined); onChange(ok ? b : undefined); }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" draggable={false} onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setSize({ w, h }); }} style={{ width: "100%", height: "100%", objectFit: "fill", userSelect: "none", pointerEvents: "none" }} />
        {draft && <div style={{ position: "absolute", left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%`, border: "2px solid #ffd166", background: "rgba(255,209,102,.15)", pointerEvents: "none" }} />}
      </div>
      <span className="st-muted">{draft ? tr("region {w}% × {h}% — only this box will change", { w: Math.round(draft.w * 100), h: Math.round(draft.h * 100) }) : tr("Drag a box over the part to change (no box: the whole picture is redrawn).")}</span>
    </div>
  );
}

/** Edit a region of a picture: box + instruction → a new picture (attached where asked). */
export function EditRegion({ asset, attach, purpose, onClose }: { asset: Asset; attach?: { heroOf?: string; endOf?: string }; purpose?: "edit" | "remake_key"; onClose?: () => void }) {
  const imaging = useImagingOn();
  const tr = useT();
  const [box, setBox] = useState<Box | undefined>();
  const [text, setText] = useState("");
  return (
    <div className="st-card st-stack">
      <RegionPicker src={(asset.meta.previewUrl as string | undefined) ?? asset.url} value={box} onChange={setBox} />
      <textarea className="st-textarea" rows={2} placeholder={tr("What it should look like, e.g. 'he wears a red wool beret'")} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="st-row st-row--between">
        <ImageButton label={tr("Edit with {model}", { model: imaging.label })} body={{ action: "edit", assetId: asset.id, instruction: text, ...(box ? { region: box } : {}), ...(attach ?? {}), ...(purpose ? { purpose } : {}) }} />
        {onClose && <Button size="sm" kind="quiet" onClick={onClose}>{tr("Close")}</Button>}
      </div>
    </div>
  );
}

export function reviewChip(asset?: Asset): string | undefined {
  const r = asset?.meta.review;
  return r === "pass" ? "reviewed ✓" : r === "fail" ? "review failed" : r === "pending" ? "not reviewed" : undefined;
}
