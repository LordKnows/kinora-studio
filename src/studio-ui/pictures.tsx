"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { Asset } from "@/studio/types";

import { ApiError, get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Skeleton, useAction } from "./common";
import { CheckIcon } from "./icons";
import { reviewChip } from "./image-tools";
import { useProjectContext } from "./shell";

/* Pictures as things to talk about and tidy up: every picture shows its
   handle (IMG-12) and name, can be renamed, and any grid can switch to
   "select" to delete a batch. The Pictures page lists them all with where
   each is used. */

type Use = { kind: string; id: string; label: string };
type Listed = Asset & { uses: Use[] };

export function pictureTitle(a: Asset): string {
  return [a.handle, a.name].filter(Boolean).join(" · ") || a.id;
}

/** The handle and name under a thumbnail. */
export function PictureCaption({ asset, extra }: { asset: Asset; extra?: ReactNode }) {
  return (
    <span className="st-pic-caption" title={pictureTitle(asset)}>
      <span className="st-pic-line">
        {asset.handle && <span className="st-pic-handle st-num">{asset.handle}</span>}
        <span className="st-pic-name">{asset.name ?? (asset.source === "upload" ? "upload" : asset.source === "frame-extract" ? "take frame" : "")}</span>
      </span>
      {extra && <span className="st-pic-extra">{extra}</span>}
    </span>
  );
}

/** Which pictures of a grid are ticked, while "select" is on. */
export function usePictureSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = useCallback((id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])), []);
  const stop = useCallback(() => {
    setSelecting(false);
    setSelected([]);
  }, []);
  return { selecting, setSelecting, selected, setSelected, toggle, stop };
}

/** The tick on a thumbnail in select mode. */
export function SelectMark({ on }: { on: boolean }) {
  return <span className="st-pic-select" data-on={on ? "true" : "false"}>{on ? <CheckIcon size={11} /> : null}</span>;
}

/** Delete the selected pictures; in-use ones are listed and confirmed first. */
export function useDeletePictures(onDone: () => Promise<void> | void) {
  const { projectId } = useProjectContext();
  return useAction(async (_c, refs: string[]) => {
    if (!refs.length) return;
    if (!window.confirm(`Delete ${refs.length} picture${refs.length > 1 ? "s" : ""}? This cannot be undone.`)) return;
    try {
      await post(`/api/projects/${projectId}/pictures/delete`, { refs });
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "needs_confirm") throw caught;
      const inUse = (caught.details?.inUse as Array<{ handle?: string; id: string; uses: Use[] }> | undefined) ?? [];
      const lines = inUse.map((u) => `${u.handle ?? u.id}: ${u.uses.map((x) => x.label).join("; ")}`);
      if (!window.confirm(`These are in use and will be taken out of those places:\n\n${lines.join("\n")}\n\nDelete anyway?`)) return;
      await post(`/api/projects/${projectId}/pictures/delete`, { refs, confirm: true });
    }
    await onDone();
  });
}

/** "Select" / "Delete N" / "Cancel" for any grid of pictures. */
export function SelectBar({ sel, all, onDeleted, label = "Select" }: { sel: ReturnType<typeof usePictureSelection>; all: string[]; onDeleted: () => Promise<void> | void; label?: string }) {
  const del = useDeletePictures(async () => {
    sel.stop();
    await onDeleted();
  });
  if (!sel.selecting) {
    return all.length ? <Button size="sm" kind="quiet" onClick={() => sel.setSelecting(true)} title="Select pictures to delete">{label}</Button> : null;
  }
  const allOn = all.length > 0 && all.every((id) => sel.selected.includes(id));
  return (
    <span className="st-row" style={{ gap: 6, flexWrap: "wrap" }}>
      <ErrorBanner error={del.error} onDismiss={del.dismiss} />
      <Button size="sm" kind="quiet" onClick={() => sel.setSelected(allOn ? [] : all)}>{allOn ? "None" : "All"}</Button>
      <Button size="sm" kind="danger" busy={del.busy} disabled={!sel.selected.length} onClick={() => void del.fire(sel.selected)}>
        Delete {sel.selected.length || ""}
      </Button>
      <Button size="sm" kind="quiet" onClick={sel.stop}>Cancel</Button>
    </span>
  );
}

/** Rename a picture (a prompt is enough: one short line). */
export function useRenamePicture(onDone: () => Promise<void> | void) {
  const { projectId } = useProjectContext();
  return useAction(async (_c, asset: Asset) => {
    const name = window.prompt(`Name for ${asset.handle ?? "this picture"}`, asset.name ?? "");
    if (name === null || !name.trim() || name.trim() === asset.name) return;
    await patch(`/api/projects/${projectId}/pictures/${encodeURIComponent(asset.id)}`, { name: name.trim() });
    await onDone();
  });
}

const FILTERS: Array<{ key: string; label: string; test: (a: Listed) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "sheets", label: "Sheets", test: (a) => a.meta.purpose === "element_sheet" || a.uses.some((u) => u.kind === "element_ref") },
  { key: "frames", label: "Frames", test: (a) => ["shot_first", "shot_last", "crop"].includes(String(a.meta.purpose)) || a.uses.some((u) => u.kind === "first_frame" || u.kind === "last_frame") },
  { key: "style", label: "Style", test: (a) => a.meta.purpose === "style_frame" || a.uses.some((u) => u.kind === "style_frame") },
  { key: "edits", label: "Edits & keyframes", test: (a) => a.meta.purpose === "edit" || a.meta.purpose === "remake_key" },
  { key: "canvas", label: "Canvas", test: (a) => a.meta.purpose === "canvas" || !!a.meta.reference },
  { key: "takes", label: "From takes", test: (a) => a.source === "frame-extract" },
  { key: "uploads", label: "Uploads & imports", test: (a) => a.source === "upload" || !!a.meta.importedFrom },
  { key: "unused", label: "Unused", test: (a) => a.uses.length === 0 },
  { key: "flagged", label: "Flagged", test: (a) => a.meta.review === "fail" || (a.meta.autoReview as { verdict?: string } | undefined)?.verdict === "fail" || ((a.meta.checks as Array<{ level: string }> | undefined) ?? []).some((c) => c.level === "fail") },
];

function checkChip(a: Asset): string | undefined {
  const auto = (a.meta.autoReview as { verdict?: string; findings?: unknown[] } | undefined)?.verdict;
  const checks = (a.meta.checks as Array<{ level: string }> | undefined) ?? [];
  if (auto === "fail") return "self-check: fail";
  if (checks.some((c) => c.level === "fail")) return "check: fail";
  if (checks.length) return `${checks.length} warning${checks.length > 1 ? "s" : ""}`;
  return auto === "pass" ? "self-check ✓" : undefined;
}

/** The project's pictures, all in one place. */
export function PicturesPage() {
  const { projectId, reload: reloadProject } = useProjectContext();
  const [pictures, setPictures] = useState<Listed[] | null>(null);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sel = usePictureSelection();
  const load = useCallback(async () => {
    try {
      setPictures((await get<{ pictures: Listed[] }>(`/api/projects/${projectId}/pictures`)).pictures);
    } catch (caught) {
      setError(caught);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const after = useCallback(async () => {
    await load();
    await reloadProject();
  }, [load, reloadProject]);
  const rename = useRenamePicture(after);
  const shown = useMemo(() => (pictures ?? []).filter(FILTERS.find((f) => f.key === filter)!.test).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)), [pictures, filter]);
  const current = shown.find((a) => a.id === open) ?? pictures?.find((a) => a.id === open);
  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Pictures</h1>
          <p className="st-subtitle">Every picture of the project with its handle — say “IMG-12” to the director and it knows which one. Rename them, see where each is used, and clear out the drafts.</p>
        </div>
        <SelectBar sel={sel} all={shown.map((a) => a.id)} onDeleted={after} label="Select to delete" />
      </div>
      <ErrorBanner error={error ?? rename.error} onDismiss={() => { setError(null); rename.dismiss(); }} />
      <div className="st-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {FILTERS.map((f) => {
          const n = (pictures ?? []).filter(f.test).length;
          return (
            <Button key={f.key} size="sm" kind={filter === f.key ? "primary" : "quiet"} onClick={() => setFilter(f.key)}>
              {f.label}{pictures ? ` ${n}` : ""}
            </Button>
          );
        })}
      </div>
      {!pictures ? (
        <Skeleton />
      ) : shown.length === 0 ? (
        <Empty title="No pictures here" hint="Uploads, GPT Image sheets and frames, edits and frames grabbed from takes all land here." />
      ) : (
        <div className="st-thumbs st-thumbs--named">
          {shown.map((a) => {
            const on = sel.selected.includes(a.id);
            const chip = checkChip(a);
            return (
              <div key={a.id} className="st-pic">
                <button type="button" className="st-thumb" aria-pressed={sel.selecting ? on : open === a.id} onClick={() => (sel.selecting ? sel.toggle(a.id) : setOpen(open === a.id ? null : a.id))} title={pictureTitle(a)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={pictureTitle(a)} loading="lazy" />
                  {sel.selecting && <SelectMark on={on} />}
                  {a.uses.length > 0 && <span className="st-thumb-tag">IN USE</span>}
                </button>
                <PictureCaption asset={a} extra={reviewChip(a) || chip ? <span className={chip?.includes("fail") ? "st-warn" : "st-muted"}>{[reviewChip(a), chip].filter(Boolean).join(" · ")}</span> : undefined} />
              </div>
            );
          })}
        </div>
      )}
      {current && !sel.selecting && (
        <div className="st-card st-stack" style={{ marginTop: 16 }}>
          <div className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
            <strong>{pictureTitle(current)}</strong>
            <span className="st-row" style={{ gap: 6 }}>
              <Button size="sm" busy={rename.busy} onClick={() => void rename.fire(current)}>Rename</Button>
              <a className="st-btn st-btn--sm st-btn--quiet" href={current.url} target="_blank" rel="noreferrer">Open full size</a>
              <Button size="sm" kind="quiet" onClick={() => setOpen(null)}>Close</Button>
            </span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current.url} alt={pictureTitle(current)} style={{ width: "100%", maxHeight: 520, objectFit: "contain", background: "#000", borderRadius: 8 }} />
          <PictureFacts asset={current} uses={current.uses} />
        </div>
      )}
    </div>
  );
}

/** What a picture is, where it is used, and what the checks said. */
export function PictureFacts({ asset, uses }: { asset: Asset; uses?: Use[] }) {
  const m = asset.meta;
  const checks = (m.checks as Array<{ id: string; level: string; message: string }> | undefined) ?? [];
  const auto = m.autoReview as { verdict?: string; summary?: string; findings?: Array<{ code?: string; severity?: string; where?: string; what?: string; fix?: string }> } | undefined;
  const findings = (m.reviewFindings as Array<{ code?: string; severity?: string; where?: string; problem?: string; fix?: string }> | undefined) ?? [];
  return (
    <dl className="st-kv">
      <dt>Size</dt>
      <dd className="st-num">{asset.width ? `${asset.width}×${asset.height}` : "—"} · {asset.source}{m.purpose ? ` · ${String(m.purpose)}` : ""}</dd>
      {uses && (
        <>
          <dt>Used as</dt>
          <dd>{uses.length ? uses.map((u) => u.label).join("; ") : <span className="st-muted">nothing — safe to delete</span>}</dd>
        </>
      )}
      {checks.length > 0 && (
        <>
          <dt>Pixel checks</dt>
          <dd>{checks.map((c) => <div key={c.id} className={c.level === "fail" ? "st-warn" : "st-muted"}>{c.level}: {c.message}</div>)}</dd>
        </>
      )}
      {auto && (
        <>
          <dt>Self-check</dt>
          <dd>
            <div className={auto.verdict === "fail" ? "st-warn" : undefined}>{auto.verdict}{auto.summary ? ` — ${auto.summary}` : ""}</div>
            {(auto.findings ?? []).map((f, k) => <div key={k} className="st-muted">{f.severity} · {f.code} · {f.where}: {f.what}{f.fix ? ` → ${f.fix}` : ""}</div>)}
          </dd>
        </>
      )}
      {m.review !== undefined && (
        <>
          <dt>Review</dt>
          <dd>
            {reviewChip(asset)}
            {findings.map((f, k) => <div key={k} className="st-muted">{f.severity ?? ""} {f.code ? `· ${f.code} ` : ""}· {f.where}: {f.problem}{f.fix ? ` → ${f.fix}` : ""}</div>)}
          </dd>
        </>
      )}
      {typeof m.prompt === "string" && (
        <>
          <dt>Asked for</dt>
          <dd><pre className="st-pre" style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{m.prompt}</pre></dd>
        </>
      )}
    </dl>
  );
}
