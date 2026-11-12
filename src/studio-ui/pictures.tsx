"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { Asset } from "@/studio/types";

import { ApiError, get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Skeleton, useAction } from "./common";
import { CheckIcon } from "./icons";
import { describeVerdict, faceLabel, pictureTag, type FaceVerdict } from "@/studio/face-verdict";

import { EditRegion, reviewChip, useImagingOn } from "./image-tools";
import { useUndoable } from "./notices";
import { useProjectContext } from "./shell";

/* Pictures as things to talk about and tidy up: every picture shows its
   handle (IMG-12) and name, can be renamed, and any grid can switch to
   "select" to delete a batch. The Pictures page lists them all with where
   each is used, and is where a region of a picture is edited. */

type Use = { kind: string; id: string; label: string };
type Listed = Asset & { uses: Use[] };

export function pictureTitle(a: Asset): string {
  return [a.handle, a.name].filter(Boolean).join(" · ") || a.id;
}

/** A picture's tag: 模拟 (any reference, R18 included) or 真实 (not for R18). */
export function TagBadge({ sim, title }: { sim: boolean; title: string }) {
  return <span className="st-face" data-allowed={sim ? "true" : undefined} title={title}>{sim ? "模拟" : "真实"}</span>;
}

/** An upload's tag from its face check (模拟 / 真实). */
export function FaceBadge({ verdict, error }: { verdict: FaceVerdict | null | undefined; error?: { why?: string } | string }) {
  const l = faceLabel(verdict ?? undefined, typeof error === "string" ? { why: error } : error);
  return <span className="st-face" data-allowed={l.allowed ? "true" : undefined} title={l.title}>{l.label}</span>;
}

/** A picture that came from outside the Studio (an upload, an import) and so carries a face check. */
export function fromOutside(a: Asset): boolean {
  return a.kind === "image" && !a.meta.reference && (a.source === "upload" || (a.source === "generated" && !a.meta.jobId));
}

/** The handle and name under a thumbnail. */
export function PictureCaption({ asset, extra }: { asset: Asset; extra?: ReactNode }) {
  const tag = asset.kind === "image" ? pictureTag(asset.meta, fromOutside(asset)) : undefined;
  return (
    <span className="st-pic-caption" title={pictureTitle(asset)}>
      <span className="st-pic-line">
        {asset.handle && <span className="st-pic-handle st-num">{asset.handle}</span>}
        <span className="st-pic-name">{asset.name ?? (asset.source === "upload" ? "upload" : asset.source === "frame-extract" ? "take frame" : "")}</span>
        {tag && <TagBadge sim={tag.sim} title={tag.title} />}
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
  const undoable = useUndoable(onDone);
  return useAction(async (_c, refs: string[]) => {
    if (!refs.length) return;
    let plan: { trashId?: string; deleted: unknown[] };
    try {
      plan = await post(`/api/projects/${projectId}/pictures/delete`, { refs });
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "needs_confirm") throw caught;
      /* in use: say where they are taken out of (Undo puts them back there too) */
      const inUse = (caught.details?.inUse as Array<{ handle?: string; id: string; uses: Use[] }> | undefined) ?? [];
      const lines = inUse.map((u) => `${u.handle ?? u.id}: ${u.uses.map((x) => x.label).join("; ")}`);
      if (!window.confirm(`These are in use and will be taken out of those places:\n\n${lines.join("\n")}\n\nDelete anyway? Undo puts them back.`)) return;
      plan = await post(`/api/projects/${projectId}/pictures/delete`, { refs, confirm: true });
    }
    await onDone();
    undoable(plan.trashId, `Deleted ${plan.deleted.length} ${plan.deleted.length === 1 ? "picture" : "pictures"}`);
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
  { key: "review", label: "Awaiting review", test: (a) => a.meta.review === "pending" },
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
  return (
    <Suspense fallback={null}>
      <Pictures />
    </Suspense>
  );
}

/* The filter and the open picture are in the address (?show=review&pic=…),
   so "7 pictures await review" can link straight to them. */
function Pictures() {
  const { projectId, view, reload: reloadProject } = useProjectContext();
  const [pictures, setPictures] = useState<Listed[] | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = FILTERS.some((f) => f.key === params.get("show")) || params.get("show") === "twice" ? params.get("show")! : "all";
  const open = params.get("pic");
  const address = (change: { show?: string; pic?: string | null }) => {
    const q = new URLSearchParams(params.toString());
    if (change.show !== undefined) { if (change.show === "all") q.delete("show"); else q.set("show", change.show); }
    if (change.pic !== undefined) { if (change.pic === null) q.delete("pic"); else q.set("pic", change.pic); }
    router.replace(q.size ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const setFilter = (key: string) => address({ show: key });
  const setOpen = (id: string | null) => address({ pic: id });
  const [editing, setEditing] = useState<string | null>(null);
  const imaging = useImagingOn();
  const [error, setError] = useState<unknown>(null);
  const sel = usePictureSelection();
  const load = useCallback(async () => {
    try {
      setPictures((await get<{ pictures: Listed[] }>(`/api/projects/${projectId}/pictures`)).pictures);
    } catch (caught) {
      setError(caught);
    }
  }, [projectId]);
  /* reload when the project gains or loses a picture (an edit finishing, a frame generated elsewhere) */
  const assetCount = view?.assets.length;
  useEffect(() => {
    void load();
  }, [load, assetCount]);
  const after = useCallback(async () => {
    await load();
    await reloadProject();
  }, [load, reloadProject]);
  const rename = useRenamePicture(after);
  /* one file listed under two handles: the later ones are the copies */
  const twins = useMemo(() => {
    const first = new Map<string, Listed>();
    const map = new Map<string, Listed>();
    for (const a of [...(pictures ?? [])].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))) {
      const original = first.get(a.url);
      if (original) map.set(a.id, original);
      else first.set(a.url, a);
    }
    return map;
  }, [pictures]);
  const shown = useMemo(() => (pictures ?? []).filter(filter === "twice" ? (a) => twins.has(a.id) : FILTERS.find((f) => f.key === filter)!.test).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)), [pictures, filter, twins]);
  const verdict = useAction(async (_c, asset: Listed, v: "pass" | "fail", problem: string) => {
    await post(`/api/projects/${projectId}/pictures/${encodeURIComponent(asset.id)}/review`, { verdict: v, ...(problem.trim() ? { problem: problem.trim() } : {}) });
    /* on to the next one that waits, oldest first, as a sheet is drawn */
    const waiting = (pictures ?? []).filter((a) => a.meta.review === "pending" && a.id !== asset.id).sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
    if (filter === "review") setOpen(waiting[0]?.id ?? null);
    await after();
  });
  const [problem, setProblem] = useState("");
  useEffect(() => setProblem(""), [open]);
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
      <ErrorBanner error={error ?? rename.error ?? verdict.error} onDismiss={() => { setError(null); rename.dismiss(); verdict.dismiss(); }} />
      <div className="st-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {FILTERS.map((f) => {
          const n = (pictures ?? []).filter(f.test).length;
          return (
            <Button key={f.key} size="sm" kind={filter === f.key ? "primary" : "quiet"} onClick={() => setFilter(f.key)}>
              {f.label}{pictures ? ` ${n}` : ""}
            </Button>
          );
        })}
        {twins.size > 0 && <Button size="sm" kind={filter === "twice" ? "primary" : "quiet"} onClick={() => setFilter("twice")} title="The same file under more than one handle">Listed twice {twins.size}</Button>}
      </div>
      {!pictures ? (
        <Skeleton />
      ) : shown.length === 0 ? (
        <Empty title="No pictures here" hint="Uploads, generated sheets and frames, edits and frames grabbed from takes all land here." />
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
                <PictureCaption asset={a} extra={reviewChip(a) || chip || twins.has(a.id) ? <span className={chip?.includes("fail") ? "st-warn" : "st-muted"}>{[reviewChip(a), chip, twins.has(a.id) ? `= ${twins.get(a.id)!.handle ?? "another"}` : undefined].filter(Boolean).join(" · ")}</span> : undefined} />
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
              <Button size="sm" kind={editing === current.id ? "primary" : "default"} onClick={() => setEditing(editing === current.id ? null : current.id)} title={`Box the part to change and say what it should become; ${imaging.label} draws a new picture`}>
                Edit a region
              </Button>
              <a className="st-btn st-btn--sm st-btn--quiet" href={current.url} target="_blank" rel="noreferrer">Open full size</a>
              <Button size="sm" kind="quiet" onClick={() => { setOpen(null); setEditing(null); }}>Close</Button>
            </span>
          </div>
          {editing === current.id ? (
            <>
              <EditRegion key={current.id} asset={current} onClose={() => setEditing(null)} />
              <span className="st-muted">The edit is a new picture next to this one; choose it where you need it (a shot's frame, an element sheet).</span>
            </>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={current.url} alt={pictureTitle(current)} style={{ width: "100%", maxHeight: 520, objectFit: "contain", background: "#000", borderRadius: 0 }} />
          )}
          {current.kind === "image" && editing !== current.id && (
            <div className="pic-verdict">
              <span className="sc-cap">Your verdict{current.meta.review === "pending" ? " · it waits for one" : current.meta.review ? ` · now ${String(current.meta.review)}${current.meta.reviewedBy === "human" ? " by you" : current.meta.reviewedBy ? " by the director" : ""}` : ""}</span>
              <div className="st-row">
                <input className="st-input" style={{ flex: 1, minWidth: 180 }} aria-label="What is wrong, if anything" placeholder="What is wrong, if anything" maxLength={500} value={problem} onChange={(e) => setProblem(e.target.value)} />
                <Button kind="primary" busy={verdict.busy} onClick={() => void verdict.fire(current, "pass", problem)}>Pass</Button>
                <Button busy={verdict.busy} onClick={() => void verdict.fire(current, "fail", problem)} title="A failed picture is not used for takes; have it redrawn or edit a region">Fail</Button>
              </div>
              {twins.has(current.id) && <span className="st-muted">This is the same file as {twins.get(current.id)!.handle ?? "another picture"}; a verdict on one does not mark the other.</span>}
            </div>
          )}
          <PictureFacts asset={current} uses={current.uses} projectId={projectId} onChanged={after} />
        </div>
      )}
    </div>
  );
}

/** What a picture is, where it is used, and what the checks said. */
export function PictureFacts({ asset, uses, projectId, onChanged }: { asset: Asset; uses?: Use[]; projectId?: string; onChanged?: () => Promise<void> | void }) {
  const recheck = useAction(async () => {
    await post(`/api/projects/${projectId}/pictures/${encodeURIComponent(asset.id)}/face-check`, {});
    await onChanged?.();
  });
  const m = asset.meta;
  const checks = (m.checks as Array<{ id: string; level: string; message: string }> | undefined) ?? [];
  const face = m.faceCheck as FaceVerdict | undefined;
  const faceError = m.faceCheckError as { why?: string } | undefined;
  const outside = fromOutside(asset);
  const tag = asset.kind === "image" ? pictureTag(m, outside) : undefined;
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
      {tag && (
        <>
          <dt>模拟 / 真实</dt>
          <dd className={tag.sim ? undefined : "st-muted"}>
            <TagBadge sim={tag.sim} title={tag.title} />{" "}
            {tag.sim ? "any reference, R18 included" : "not for R18; every other picture is fine"}
            {outside
              ? <> · {face ? <>{describeVerdict(face).replace(/^face check: /, "")}{face.reason ? ` — ${face.reason}` : ""}</> : faceError?.why ? <>the check did not run: {faceError.why}</> : <>not checked</>}
                  {projectId && <>{" "}<Button size="sm" kind="quiet" busy={recheck.busy} onClick={() => void recheck.fire()}>Check again</Button></>}
                  <ErrorBanner error={recheck.error} projectId={projectId} onDismiss={recheck.dismiss} />
                </>
              : m.reference ? <> · the reference library</> : <> · {tag.sim ? "drawn from 模拟 pictures only, or from text" : "drawn from a 真实 picture"}</>}
          </dd>
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
