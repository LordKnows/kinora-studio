"use client";

import { useRef, useState } from "react";

import type { Asset, Take } from "@/studio/types";

import { post, usd } from "./api";
import { Button, ErrorBanner, Field, useAction } from "./common";
import { EditRegion, ImageButton, reviewChip } from "./image-tools";
import { SelectBar, SelectMark, usePictureSelection } from "./pictures";
import { useProjectContext } from "./shell";

type Change = { subject: string; target: string };

/* Viggle Remake of one take: grab the frames where it goes wrong, paint them
   right (GPT Image on a region, or upload your own), say what changes, and
   render a new take that keeps the motion, camera, timing and sound. */
export function RemakePanel({ take, onClose }: { take: Take; onClose: () => void }) {
  const { projectId, view, reload } = useProjectContext();
  const video = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "swap">("edit");
  const [changes, setChanges] = useState<Change[]>([{ subject: "", target: "" }]);
  const [result, setResult] = useState<string>("");
  const frames = (view?.assets ?? []).filter((a) => a.kind === "image" && a.meta.takeId === take.id).sort((a, b) => (Number(a.meta.frame ?? 0) - Number(b.meta.frame ?? 0)) || a.createdAt - b.createdAt);
  const render = useAction(async () => {
    const keyframes = picked.map((assetId) => ({ assetId }));
    const r = await post<{ take: Take; estimateUsd: number; frames: number; warnings: string[] }>(`/api/takes/${take.id}/remake`, { mode, keyframes, changes: changes.filter((c) => c.subject.trim() && c.target.trim()) });
    setResult(`Remake queued as take #${r.take.n} (${r.frames} frames, ≈ ${usd(r.estimateUsd)}).${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`);
    await reload();
  });
  const label = (a: Asset) => `${a.handle ? `${a.handle} · ` : ""}${a.source === "frame-extract" ? "frame" : "painted"} f${String(a.meta.frame ?? "?")}`;
  const sel = usePictureSelection();
  return (
    <div className="st-card st-stack">
      <div className="st-row st-row--between">
        <strong>Fix take #{take.n} with Viggle Remake</strong>
        <Button size="sm" kind="quiet" onClick={onClose}>Close</Button>
      </div>
      <span className="st-muted">For props, wardrobe, a face or the background that go wrong. Motion, direction and timing are copied from the take — re-render those instead.</span>
      <video ref={video} className="st-video" src={take.resultUrl} controls preload="metadata" onTimeUpdate={(e) => setFrame(Math.round(e.currentTarget.currentTime * 24))} />
      <div className="st-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="st-num">frame {frame}</span>
        <ImageButton label="Grab this frame" paint={false} body={{ action: "extract", takeId: take.id, frame }} />
      </div>
      {frames.length > 0 && (
        <div className="st-stack st-stack--tight">
          <span className="st-row st-row--between">
            <span className="st-label" style={{ marginBottom: 0 }}>Frames of this take — tick the painted ones to use as keyframes (1–4)</span>
            <SelectBar sel={sel} all={frames.map((a) => a.id)} onDeleted={async () => { setPicked([]); await reload(); }} />
          </span>
          <div className="st-thumbs">
            {frames.map((a) => (
              <div key={a.id} className="st-stack st-stack--tight" style={{ width: 200 }}>
                <span style={{ position: "relative", display: "block", cursor: sel.selecting ? "pointer" : undefined }} onClick={sel.selecting ? () => sel.toggle(a.id) : undefined}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={a.name ?? ""} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 4 }} />
                  {sel.selecting && <SelectMark on={sel.selected.includes(a.id)} />}
                </span>
                <span className="st-muted st-num">{label(a)}{reviewChip(a) ? ` · ${reviewChip(a)}` : ""}</span>
                <span className="st-row" style={{ gap: 6 }}>
                  {a.source !== "frame-extract" && (
                    <label className="st-row" style={{ gap: 4 }}>
                      <input type="checkbox" checked={picked.includes(a.id)} disabled={!picked.includes(a.id) && picked.length >= 4} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
                      <span>keyframe</span>
                    </label>
                  )}
                  <Button size="sm" kind="quiet" onClick={() => setEditing(editing === a.id ? null : a.id)}>Paint</Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && frames.find((a) => a.id === editing) && <EditRegion asset={frames.find((a) => a.id === editing)!} purpose="remake_key" onClose={() => setEditing(null)} />}
      <div className="st-fields">
        <Field label="Mode" hint="edit: objects, props, wardrobe, background, light, style. swap: replace a person.">
          <select className="st-select" value={mode} onChange={(e) => setMode(e.target.value as "edit" | "swap")}>
            <option value="edit">edit</option>
            <option value="swap">swap</option>
          </select>
        </Field>
      </div>
      <span className="st-label" style={{ marginBottom: 0 }}>What changes — written as how the fixed video looks</span>
      {changes.map((c, i) => (
        <div key={i} className="st-line">
          <input className="st-input st-input--sm" placeholder="what in the take (the man in the grey coat, frame right)" value={c.subject} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} />
          <input className="st-input st-input--sm" placeholder="how it is in the fix (he wears a red beret in every frame)" value={c.target} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} />
          <Button size="sm" kind="quiet" onClick={() => setChanges(changes.length > 1 ? changes.filter((_, j) => j !== i) : [{ subject: "", target: "" }])}>×</Button>
        </div>
      ))}
      <div className="st-row st-row--between">
        <Button size="sm" kind="quiet" disabled={changes.length >= 6} onClick={() => setChanges([...changes, { subject: "", target: "" }])}>Add a change</Button>
        <Button kind="primary" busy={render.busy} disabled={picked.length === 0 || !changes.some((c) => c.subject.trim() && c.target.trim())} onClick={() => void render.fire()}>Render the Remake</Button>
      </div>
      <ErrorBanner error={render.error} projectId={projectId} onDismiss={render.dismiss} />
      {result && <span className="st-muted">{result}</span>}
    </div>
  );
}
