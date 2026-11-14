"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { describeParams, type InferenceParams } from "@/studio/models";
import type { SceneView, ShotView } from "@/studio/orchestrator";
import { TAKE_FAULTS, type ShotInput, type TakeFault } from "@/studio/schemas";
import { FINDING_LABELS, findingAt, readTake } from "@/studio/take-checks";
import type { Take } from "@/studio/types";
import { faultRoutes } from "@director/faults";
import { FramesPanel } from "./frames-panel";
import { RemakePanel } from "./remake-panel";

import { del, describe, get, patch, post, put, usd } from "./api";
import { BackToTop, Button, ConfirmButton, Drawer, Empty, ErrorBanner, Field, Lamp, Loading, Modal, NumberInput, Popover, Stars, Status, statusLabel, useAction } from "./common";
import { REGENERATE_ENABLED } from "./flags";
import { Zoomable } from "./picture-zoom";
import { useShotSort } from "./shot-sort";
import { plural, type T, useLang, useT } from "./i18n";
import { CheckCircleIcon, ChevronIcon, CloseIcon, DraftIcon, ErrorIcon, InfoIcon, PlusIcon, WarningIcon } from "./icons";
import { lintLine } from "./zh/lint";
import { useUndoable } from "./notices";
import { useProjectContext } from "./shell";
import { EDIT_GRAMMAR } from "@/studio/editing";

import { ShotEditor, validateDraft, type ShotDraft } from "./shot-editor";
import { useLoraLibrary } from "./lora-picker";
import { shotLoraChips } from "./shot-loras-field";

type LintWarning = { code: string; message: string; scene?: string; shot?: number; severity: "error" | "warn" | "info" };
type LintReport = { warnings: LintWarning[]; counts: { error: number; warn: number; info: number } };
type BatchPlan = {
  order: string[]; passes: string[][]; deferred: Array<{ shotId: string; waitingFor: string }>; totalEstimateUsd: number; withinCap: boolean; remainingCapUsd: number;
  estimates: Array<{ shotId: string; usd: number; source: string }>; warnings: string[];
  shots: Array<{ shotId: string; label: string; durationS: number; mode: string; link?: string; hasTake: boolean; estimateUsd?: number; fragility?: number; fragile?: string[]; tier?: "turbo" | "careful" }>;
  probe?: { shotIds: string[]; estimateUsd: number; why: string };
};

/* Short codes for the card: ELS · HIGH · WIDE · NEON · TEAL. */
function cineCodes(spec: ShotView["spec"]): string[] {
  const c = (spec.cinematography ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["size", "angle", "lens"] as const) if (typeof c[k] === "string") out.push(String(c[k]).toUpperCase());
  if (Array.isArray(c.lighting) && c.lighting[0]) out.push(String(c.lighting[0]).toUpperCase());
  if (typeof c.grade === "string") out.push(String(c.grade).toUpperCase());
  return out;
}

/* The Board: scenes, shot cards, and the drawer where a shot is edited,
   compiled, given a hero frame and rendered into takes. */

const BLANK_SHOT: ShotInput = {
  durationS: 8,
  mode: "text",
  intent: "",
  beats: [{ from: 0, to: 8, action: "" }],
  camera: { move: "static", amplitude: "moderate", speed: "slow" },
  dialogue: [],
  sound: { sfx: [], ambience: "", music: "N/A" },
  characters: [],
  props: [],
  linkToPrev: "cut",
};

export function BoardPage() {
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}

/* The open shot and its tab live in the address (?shot=…&tab=…): a reload
   keeps them, Back closes the drawer, and the link can be sent to someone. */
function useShotAddress() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (change: (q: URLSearchParams) => void, how: "push" | "replace") => {
    const q = new URLSearchParams(params.toString());
    change(q);
    const url = q.size ? `${pathname}?${q}` : pathname;
    if (how === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  };
  return {
    openId: params.get("shot"),
    tab: params.get("tab"),
    open: (id: string) => go((q) => { q.set("shot", id); q.delete("tab"); q.delete("panel"); }, "push"),
    close: () => go((q) => { q.delete("shot"); q.delete("tab"); }, "replace"),
    setTab: (tab: string) => go((q) => q.set("tab", tab), "replace"),
  };
}

/* Which scenes are folded to their heading: kept per project in this browser, so a long board opens the way it was left. */
function useFoldedScenes(projectId: string): [Set<string>, (next: Set<string>) => void] {
  const key = `studio.board.folded.${projectId}`;
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setFolded(new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]));
    } catch {
      setFolded(new Set());
    }
  }, [key]);
  const set = useCallback((next: Set<string>) => {
    setFolded(next);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      /* private mode: the folds hold for this page only */
    }
  }, [key]);
  return [folded, set];
}

function Board() {
  const { projectId, view, reload } = useProjectContext();
  const [folded, setFolded] = useFoldedScenes(projectId);
  const tr = useT();
  const lang = useLang();
  const undoable = useUndoable(reload);
  const address = useShotAddress();
  const openId = address.openId;
  const setOpenId = (id: string | null) => (id ? address.open(id) : address.close());
  const [lint, setLint] = useState<LintReport | null>(null);
  const [lintFailed, setLintFailed] = useState(false);
  /* the Lint drawer and the Render batch popup belong to a scene: each is opened from that scene's buttons */
  const [lintScene, setLintScene] = useState<string | null>(null);
  /* the sketch is opened from a scene; `whole` shows the film instead of that scene */
  const [sketch, setSketch] = useState<{ sceneId: string; whole: boolean } | null>(null);
  const [sketchGray, setSketchGray] = useState(false);
  const [sketchKey, setSketchKey] = useState(0);
  const [batchScene, setBatchScene] = useState<string | null>(null);
  /* a scene just added from the top of the page: brought into view once the board has it */
  const [addedScene, setAddedScene] = useState<string | null>(null);
  const shotKey = (scene: string, i: number) => `${scene}#${i + 1}`;
  const refreshLint = useCallback(async () => {
    setLintFailed(false);
    try {
      setLint(await get<LintReport>(`/api/projects/${projectId}/lint`));
    } catch {
      setLint(null);
      setLintFailed(true);
    }
  }, [projectId]);
  useEffect(() => {
    void refreshLint();
  }, [refreshLint, view?.project.shotlistApproval, view?.scenes.length]);
  const lintByShot = useMemo(() => {
    const m = new Map<string, LintWarning[]>();
    for (const w of lint?.warnings ?? []) {
      if (!w.scene || !w.shot) continue;
      const k = `${w.scene}#${w.shot}`;
      m.set(k, [...(m.get(k) ?? []), w]);
    }
    return m;
  }, [lint]);
  /* a batch that is already rolling: every queued or running take of the scene is cancelled */
  const cancelScene = useAction(async (_c, scene: SceneView) => {
    for (const t of scene.shots.flatMap((sh) => sh.takes)) if (t.status === "queued" || t.status === "running") await post(`/api/takes/${t.id}/cancel`);
    await reload();
  });

  const approve = useAction(async () => {
    await post(`/api/projects/${projectId}/shotlist/approve`);
    await reload();
  });
  useEffect(() => {
    if (!addedScene || !view?.scenes.some((s) => s.id === addedScene)) return;
    document.getElementById(`scene-${addedScene}`)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setAddedScene(null);
  }, [addedScene, view]);
  /* a scene's shots in a new order: from a card dragged to its place, or nudged one place with Alt and an arrow key */
  const reorder = useAction(async (_c, sceneId: string, ids: string[]) => {
    await post("/api/shots/reorder", { sceneId, shotIds: ids });
    await reload();
  });
  /* the order a card was just dropped into, shown until the board comes back with it (or the save fails) */
  const [dropped, setDropped] = useState<Record<string, string[]>>({});
  const sorted = (sceneId: string, ids: string[]) => {
    setDropped((d) => ({ ...d, [sceneId]: ids }));
    void reorder.fire(sceneId, ids).finally(() => setDropped((d) => { const { [sceneId]: _done, ...rest } = d; return rest; }));
  };
  const nudge = (scene: SceneView, from: number, by: -1 | 1) => {
    const to = from + by;
    if (to < 0 || to >= scene.shots.length || reorder.busy) return;
    const ids = scene.shots.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    void reorder.fire(scene.id, ids);
  };
  const removeScene = useAction(async (_c, scene: SceneView) => {
    const { trashId } = await del<{ trashId?: string }>(`/api/scenes/${scene.id}`);
    await reload();
    undoable(trashId, tr("Deleted scene {i} · {slug}{shots}", { i: view ? view.scenes.indexOf(scene) + 1 : "", slug: scene.slug, shots: scene.shots.length ? plural(tr, scene.shots.length, " and its 1 shot", " and its {n} shots") : "" }));
  });

  if (!view) return null;
  const open = view.scenes.flatMap((s) => s.shots).find((s) => s.id === openId) ?? null;
  const approved = view.project.shotlistApproval === "approved";
  const shotCount = view.scenes.reduce((n, s) => n + s.shots.length, 0);
  const error = approve.error ?? reorder.error ?? removeScene.error;
  const sketchScene = sketch ? view.scenes.find((s) => s.id === sketch.sceneId) : undefined;
  const lintOf = lintScene ? view.scenes.find((s) => s.id === lintScene) : undefined;
  const batchOf = batchScene ? view.scenes.find((s) => s.id === batchScene) : undefined;
  const slateOf = new Map(view.scenes.flatMap((sc, si) => sc.shots.map((sh, i) => [sh.id, `${si + 1}·${i + 1}`] as const)));
  const sketchSrc = (extra?: Record<string, string>) => {
    const q = new URLSearchParams({ ...(sketchScene && !sketch?.whole ? { scene: sketchScene.id } : {}), ...(sketchGray ? { gray: "1" } : {}), ...extra });
    return `/api/projects/${projectId}/sketch${q.size ? `?${q}` : ""}`;
  };

  return (
    <div className="st-page st-page--wide">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{tr("Board")}</h1>
          <p className="st-subtitle">
            {/* the shotlist's state and nothing else: a green tick once approved, an amber pencil while it is a draft */}
            <Status tone={approved ? "ok" : "warn"} icon={approved ? <CheckCircleIcon /> : <DraftIcon />}>
              {approved ? (view.delegated?.shotlist ? tr("Shotlist approved by the director") : tr("Shotlist approved")) : tr("Shotlist draft")}
            </Status>
          </p>
        </div>
        <div className="st-actions">
          {view.scenes.length > 1 && (
            <Button kind="quiet" onClick={() => setFolded(folded.size >= view.scenes.length ? new Set() : new Set(view.scenes.map((s) => s.id)))}>
              {folded.size >= view.scenes.length ? tr("Unfold all") : tr("Fold all")}
            </Button>
          )}
          <Popover label={<><PlusIcon size={13} />{tr("Add scene")}</>} title={tr("Add a scene at the end of the board")} panelLabel={tr("Add scene")}>
            {(close) => <AddSceneForm onAdded={(id) => { close(); setAddedScene(id); }} />}
          </Popover>
          {!approved && (
            <Button kind="primary" busy={approve.busy} disabled={shotCount === 0} onClick={() => void approve.fire()}>
              {tr("Approve shotlist")}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={error ?? cancelScene.error} projectId={projectId} onDismiss={() => { approve.dismiss(); reorder.dismiss(); removeScene.dismiss(); cancelScene.dismiss(); }} />

      {view.scenes.length === 0 && (
        <Empty title={tr("No scenes yet")} hint={tr("Ask the director agent to save_shotlist, or add a scene (top right) and build shots by hand.")} />
      )}

      {view.scenes.map((scene) => {
        const found = (lint?.warnings ?? []).filter((w) => w.scene === scene.slug);
        const errors = found.filter((w) => w.severity === "error").length;
        const warns = found.filter((w) => w.severity === "warn").length;
        const rolling = scene.shots.flatMap((sh) => sh.takes).filter((t) => t.status === "queued" || t.status === "running").length;
        const isFolded = folded.has(scene.id);
        const fold = (to: boolean) => { const next = new Set(folded); if (to) next.add(scene.id); else next.delete(scene.id); setFolded(next); };
        return (
        <section key={scene.id} id={`scene-${scene.id}`} className="st-scene" data-folded={isFolded ? "true" : undefined}>
          <div className="st-scene-head">
            <div>
              {/* the heading folds the scene to this line and opens it again */}
              <button type="button" className="st-scene-fold" aria-expanded={!isFolded} aria-controls={`scene-shots-${scene.id}`} onClick={() => fold(!isFolded)} title={isFolded ? tr("Show this scene's shots") : tr("Fold this scene")}>
                <ChevronIcon size={12} />
                <span className="st-scene-slug">{scene.index + 1}. {scene.slug}</span>
              </button>
              {isFolded && <span className="st-scene-summary"> ·{plural(tr, scene.shots.length, "1 shot", "{n} shots")} · {tr("{s} s", { s: scene.shots.reduce((n, sh) => n + sh.spec.durationS, 0) })}</span>}
              {scene.summary && <span className="st-scene-summary"> · {scene.summary}</span>}
              {scene.palette && (
                <span className="st-row" style={{ display: "inline-flex", gap: 2, marginLeft: 8, verticalAlign: "middle" }} title={scene.palette.note ?? tr("scene palette")}>
                  {scene.palette.colors.map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 0, background: c, display: "inline-block" }} />)}
                </span>
              )}
            </div>
            <div className="st-row">
              <Button size="sm" kind="quiet" disabled={scene.shots.length === 0} onClick={() => setSketch({ sceneId: scene.id, whole: false })} title={tr("Colour-block storyboard from the shotlist: sizes, 38/62 composition, blocking, scene palettes")}>
                {tr("Sketch")}
              </Button>
              <Popover size="sm" kind="quiet" label={tr("Palette||scene colours")} title={tr("This scene's colour script; it compiles into every shot")} panelLabel={tr("Colour script · {slug}", { slug: scene.slug })}>
                {(close) => <PaletteForm scene={scene} onDone={close} />}
              </Popover>
              <Button size="sm" kind="quiet" disabled={scene.shots.length === 0} onClick={() => setLintScene(scene.id)} title={tr("Rhythm and craft lint of this scene's shots")}>
                {tr("Lint")}
                {errors > 0 && <span className="st-sev" data-severity="error"><ErrorIcon size={13} />{errors}</span>}
                {warns > 0 && <span className="st-sev" data-severity="warn"><WarningIcon size={13} />{warns}</span>}
              </Button>
              {approved && scene.shots.length > 0 && (rolling > 0 ? (
                <ConfirmButton size="sm" kind="default" busy={cancelScene.busy} title={tr("Cancel the takes of this scene that are queued or rolling")} confirmLabel={tr("Cancel rendering")} cancelLabel={tr("Keep rolling")} onConfirm={() => void cancelScene.fire(scene)}
                  question={plural(tr, rolling, "Cancel the 1 take of this scene that is queued or rolling?", "Cancel the {n} takes of this scene that are queued or rolling?")}>
                  {tr("Cancel rendering · {n}", { n: rolling })}
                </ConfirmButton>
              ) : (
                <Button size="sm" onClick={() => setBatchScene(scene.id)} title={tr("Order this scene's shots without a take: R2VA first, anchors before linked shots, one estimate. Nothing renders until you confirm it.")}>
                  {tr("Render batch")}
                </Button>
              ))}
              <Popover size="sm" label={tr("Add shot")} title={tr("Add a shot at the end of this scene")} panelLabel={tr("Add shot")}>
                {(close) => <AddShotForm scene={scene} sceneNumber={view.scenes.indexOf(scene) + 1} onSaved={() => fold(false)} onOpen={(id) => { close(); setOpenId(id); }} onClose={close} />}
              </Popover>
              <ConfirmButton size="sm" busy={removeScene.busy} title={tr("Delete scene")} confirmLabel={tr("Delete scene")} onConfirm={() => void removeScene.fire(scene)}
                question={tr("Delete scene {i} · {slug}{shots}? For 14 days it can be put back from Recently deleted, on the Settings page.", { i: view.scenes.indexOf(scene) + 1, slug: scene.slug, shots: scene.shots.length ? plural(tr, scene.shots.length, " and its 1 shot", " and its {n} shots") : "" })}>
                {tr("Delete")}
              </ConfirmButton>
            </div>
          </div>
          {isFolded ? null : scene.shots.length === 0 ? (
            <Empty title={tr("Empty scene")} />
          ) : (
            <ShotGrid scene={scene} order={dropped[scene.id]} onSorted={(ids) => sorted(scene.id, ids)}>
              {(shot, i) => {
                const was = scene.shots.indexOf(shot);
                return (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    index={i}
                    slate={`${view.scenes.indexOf(scene) + 1}·${i + 1}`}
                    lint={lintByShot.get(shotKey(scene.slug, was)) ?? []}
                    open={openId === shot.id}
                    onOpen={() => setOpenId(shot.id)}
                    onNudge={(by) => nudge(scene, was, by)}
                  />
                );
              }}
            </ShotGrid>
          )}
        </section>
        );
      })}

      <BackToTop />

      {open && <ShotDrawer key={open.id} shot={open} onClose={() => setOpenId(null)} />}
      {sketch && (
        <Drawer
          title={sketchScene && !sketch.whole ? tr("Sketch · {scene}", { scene: `${view.scenes.indexOf(sketchScene) + 1}. ${sketchScene.slug}` }) : tr("Sketch · colour-block storyboard")}
          onClose={() => setSketch(null)}
          head={
            <span className="st-row">
              {sketchScene && view.scenes.length > 1 && (
                <span className="st-seg st-seg--sm" role="group" aria-label={tr("Sketch of")}>
                  <button type="button" aria-pressed={!sketch.whole} onClick={() => setSketch({ ...sketch, whole: false })}>{tr("This scene")}</button>
                  <button type="button" aria-pressed={sketch.whole} onClick={() => setSketch({ ...sketch, whole: true })}>{tr("Whole film")}</button>
                </span>
              )}
              <Button size="sm" kind={sketchGray ? "default" : "quiet"} onClick={() => setSketchGray((g) => !g)} title={tr("Black and white: does the subject separate from the background by value alone?")}>{sketchGray ? tr("Colour") : tr("Grayscale")}</Button>
              <Button size="sm" kind="quiet" onClick={() => setSketchKey((k) => k + 1)}>{tr("Refresh")}</Button>
              <a className="st-link" href={sketchSrc()} target="_blank" rel="noreferrer">{tr("Open")}</a>
            </span>
          }
        >
          <p className="st-muted">{tr("Drawn from the shotlist alone: subject size from the shot size, its place on the 38 % / 62 % guides, blocking arrows, the scene palette, and “dead frame” where nothing moves. Check the rhythm of sizes and the colour script before any frame is drawn.")}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={sketchSrc({ v: String(sketchKey) })} src={sketchSrc({ v: String(sketchKey) })} alt={tr("Colour-block storyboard")} style={{ width: "100%", height: "auto", borderRadius: 0 }} />
        </Drawer>
      )}
      {lintOf && (() => {
        /* this scene's findings; what belongs to no scene (the script, the treatment, the cut) is on the Reel */
        const found = (lint?.warnings ?? []).filter((w) => w.scene === lintOf.slug);
        const count = (sev: LintWarning["severity"]) => found.filter((w) => w.severity === sev).length;
        const elsewhere = (lint?.warnings ?? []).filter((w) => !w.scene).length;
        return (
          <Drawer title={`${tr("Lint")} · ${view.scenes.indexOf(lintOf) + 1}. ${lintOf.slug}${lint ? ` · ${tr("{e} errors, {w} warnings, {i} notes", { e: count("error"), w: count("warn"), i: count("info") })}` : ""}`} size="narrow" onClose={() => setLintScene(null)}>
            {!lint ? (
              lintFailed ? (
                <div className="st-row">
                  <span className="st-muted">{tr("The lint could not be loaded.")}</span>
                  <Button size="sm" onClick={() => void refreshLint()}>{tr("Try again")}</Button>
                </div>
              ) : <Loading />
            ) : (
              <div className="st-stack">
                {found.length === 0 ? (
                  <Empty title={tr("Nothing to fix")} hint={tr("Rhythm, variety, breath, links and cinematography all pass in this scene.")} />
                ) : (
                  <LintGroups warnings={found} lang={lang} />
                )}
                {elsewhere > 0 && (
                  <p className="st-muted">
                    {plural(tr, elsewhere, "1 more finding belongs to no scene (the script, the treatment, the cut).", "{n} more findings belong to no scene (the script, the treatment, the cut).")}{" "}
                    <Link className="st-link" href={`/p/${projectId}#problems`}>{tr("See them on the Reel")}</Link>
                  </p>
                )}
              </div>
            )}
          </Drawer>
        );
      })()}
      {batchOf && (
        <BatchPopup key={batchOf.id} sceneId={batchOf.id} title={`${tr("Render batch")} · ${view.scenes.indexOf(batchOf) + 1}. ${batchOf.slug}`} slateOf={slateOf} onClose={() => setBatchScene(null)} />
      )}
    </div>
  );
}

/* The render batch of a scene, in a popup. The shots that can render now each have a tick, all
   ticked to begin with, so the whole pass is rolled or only some of it; a shot of a later pass
   waits for its anchor and cannot be ticked yet. The way out: Cancel before anything is queued,
   Stop and cancel while the ticked shots are being queued (the takes queued so far are cancelled). */
function BatchPopup({ sceneId, title, slateOf, onClose }: { sceneId: string; title: string; slateOf: Map<string, string>; onClose: () => void }) {
  const { projectId } = useProjectContext();
  const tr = useT();
  const [batch, setBatch] = useState<BatchPlan | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  /* The popup opens at the click and plans inside itself, so there is always something to see: the
     wait, then the shots, or what went wrong with a way to try again (not a banner far up the page). */
  const planIt = useCallback(async () => {
    setFailed(null);
    try {
      setBatch(await post<BatchPlan>(`/api/projects/${projectId}/batch`, { takesPerShot: 1, onlyMissing: true, sceneId }));
    } catch (caught) {
      setFailed(caught);
    }
  }, [projectId, sceneId]);
  useEffect(() => {
    void planIt();
  }, [planIt]);
  if (!batch)
    return (
      <Modal title={title} size="lg" onClose={onClose}>
        <div className="st-stack">
          {failed ? (
            <>
              <ErrorBanner error={failed} projectId={projectId} onDismiss={() => setFailed(null)} />
              <div className="st-row st-row--between">
                <Button kind="quiet" onClick={onClose}>{tr("Close")}</Button>
                <Button onClick={() => void planIt()}>{tr("Try again")}</Button>
              </div>
            </>
          ) : (
            <Loading label={tr("Ordering this scene's shots…")} />
          )}
        </div>
      </Modal>
    );
  return <BatchPicker title={title} batch={batch} slateOf={slateOf} onClose={onClose} />;
}

function BatchPicker({ title, batch, slateOf, onClose }: { title: string; batch: BatchPlan; slateOf: Map<string, string>; onClose: () => void }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const now = batch.passes[0] ?? [];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(now));
  const stopPass = useRef(false);
  const [stopping, setStopping] = useState(false);
  /* The ticked shots are queued one after another. Stop ends it between two shots and cancels the
     takes already queued, so a stopped batch leaves nothing of its own rolling. */
  const render = useAction(async (confirm, ids: string[]) => {
    stopPass.current = false;
    setStopping(false);
    const queued: string[] = [];
    try {
      for (const id of ids) {
        if (stopPass.current) break;
        const r = await post<{ takes?: Array<{ id: string }> }>(`/api/shots/${id}/takes`, { n: 1, confirm });
        for (const t of r.takes ?? []) queued.push(t.id);
      }
      if (stopPass.current) for (const id of queued) await post(`/api/takes/${id}/cancel`).catch(() => undefined);
      else onClose();
    } finally {
      setStopping(false);
      await reload();
    }
  });
  const chosen = now.filter((id) => picked.has(id));
  const priceOf = (ids: string[]) => ids.reduce((n, id) => n + (batch.estimates.find((x) => x.shotId === id)?.usd ?? 0), 0);
  const price = priceOf(chosen);
  const tick = (id: string) => setPicked((p) => { const next = new Set(p); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const probe = (batch.probe?.shotIds ?? []).filter((id) => now.includes(id));
  const row = (id: string, pass: number) => {
    const sh = batch.shots.find((x) => x.shotId === id);
    const est = batch.estimates.find((x) => x.shotId === id);
    const waits = pass > 0;
    return (
      <tr key={id} data-off={waits || !picked.has(id) ? "true" : undefined}>
        <td className="bp-tick"><input type="checkbox" aria-label={tr("Render {shot}", { shot: sh?.label ?? id })} checked={!waits && picked.has(id)} disabled={waits || render.busy} onChange={() => tick(id)} /></td>
        <td><span className="st-num">{slateOf.get(id) ?? ""}</span> {sh?.label.split(" · ").slice(1).join(" · ") || sh?.label || id}</td>
        <td className="st-num">{sh?.mode && tr(sh.mode)}</td>
        <td className="st-num">{tr(sh?.link ?? "cut")}</td>
        <td className="st-num" title={sh?.fragile?.join(", ")}>{sh?.fragility ? `${sh.fragility}${sh.tier === "careful" ? tr(" · careful") : ""}` : "—"}</td>
        <td className="st-num">{est ? `${usd(est.usd)}${est.source === "fallback" ? " ~" : ""}` : "—"}</td>
      </tr>
    );
  };
  return (
    <Modal title={title} size="lg" onClose={() => { if (!render.busy) onClose(); }}>
      <div className="st-stack">
        <div className="st-row st-row--between">
          <span className="st-h2">{tr("{n} of {m} shots ticked", { n: chosen.length, m: now.length })}{batch.passes.length > 1 ? ` · ${plural(tr, batch.passes.length, "1 pass", "{n} passes")}` : ""}</span>
          <span className="st-num" style={{ color: price <= batch.remainingCapUsd ? "var(--tx)" : "var(--sig-err)" }}>{tr("≈ {estimate} · {left} left", { estimate: usd(price), left: usd(batch.remainingCapUsd) })}</span>
        </div>
        <span className="st-muted">{tr("Every shot that can render now is ticked; untick the ones to leave for later. R2VA shots go first; a shot linked to another waits until its anchor has a take.")}</span>
        {batch.warnings.map((w, i) => <span key={i} className="st-warn">{w}</span>)}
        <ErrorBanner error={render.error} projectId={projectId} onConfirm={() => void render.confirm()} onDismiss={render.dismiss} />
        {probe.length > 0 && (
          <div className="st-card st-row st-row--between">
            <span><strong>{tr("Probe first.")}</strong> <span className="st-muted">{batch.probe!.why}</span></span>
            <Button size="sm" disabled={render.busy} onClick={() => setPicked(new Set(probe))}>{tr("Tick only the probe ({n})", { n: probe.length })}</Button>
          </div>
        )}
        {now.length === 0 && <p className="st-muted">{tr("No shot of this scene can render now.")}</p>}
        {batch.passes.map((pass, pi) => (
          <div key={pi} className="st-card st-card--pad0 st-table-scroll">
            <table className="st-table bp-table">
              <thead>
                <tr>
                  <th className="bp-tick">{pi === 0 && <input type="checkbox" aria-label={tr("Tick all")} title={tr("Tick all")} checked={chosen.length === now.length && now.length > 0} disabled={render.busy} onChange={() => setPicked(chosen.length === now.length ? new Set() : new Set(now))} />}</th>
                  <th>{pi === 0 ? tr("Can render now") : tr("Pass {n} · waits for its anchors", { n: pi + 1 })}</th>
                  <th>{tr("Mode")}</th>
                  <th>{tr("Link")}</th>
                  <th title={tr("Weak spots of AI video found in the shot (fragile.* in Lint)")}>{tr("Fragile")}</th>
                  <th className="st-num">{tr("Est.")}</th>
                </tr>
              </thead>
              <tbody>{pass.map((id) => row(id, pi))}</tbody>
            </table>
          </div>
        ))}
        {batch.deferred.length > 0 && <span className="st-muted">{tr("Waiting for an anchor: {list}", { list: batch.deferred.map((d) => tr("{shot} for {anchor}", { shot: slateOf.get(d.shotId) ?? d.shotId, anchor: slateOf.get(d.waitingFor) ?? d.waitingFor })).join(", ") })}</span>}
        <div className="st-row st-row--between">
          {render.busy ? (
            <Button busy={stopping} onClick={() => { stopPass.current = true; setStopping(true); }} title={tr("Stop queuing, and cancel the takes this pass has queued so far")}>{tr("Stop and cancel")}</Button>
          ) : (
            <Button kind="quiet" onClick={onClose}>{tr("Cancel")}</Button>
          )}
          <Button kind="tally" busy={render.busy} disabled={chosen.length === 0} onClick={() => void render.fire(chosen)}>
            {tr("Render the ticked ({n})", { n: chosen.length })} <span className="st-btn-price">· ≈ {usd(price)}</span>
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* The Lint drawer: errors, then warnings, then notes, each in its own colour
   with its own mark. Errors are open; warnings and notes are folded until
   asked for, so what must be fixed is not under what may be. */
const SEVERITIES = [
  { severity: "error", label: "Errors||lint", Icon: ErrorIcon },
  { severity: "warn", label: "Warnings||lint", Icon: WarningIcon },
  { severity: "info", label: "Notes||lint", Icon: InfoIcon },
] as const;

function LintGroups({ warnings, lang }: { warnings: LintWarning[]; lang: ReturnType<typeof useLang> }) {
  const tr = useT();
  const [open, setOpen] = useState<Record<LintWarning["severity"], boolean>>({ error: true, warn: false, info: false });
  const errors = warnings.filter((w) => w.severity === "error").length;
  return (
    <div className="st-lint-groups">
      {errors === 0 && <Status tone="ok" icon={<CheckCircleIcon />}>{tr("No errors.")}</Status>}
      {SEVERITIES.map(({ severity, label, Icon }) => {
        const rows = warnings.filter((w) => w.severity === severity);
        if (rows.length === 0) return null;
        const id = `lint-${severity}`;
        return (
          <section key={severity} className="st-lint-group" data-severity={severity}>
            <h3>
              <button type="button" className="st-lint-head" aria-expanded={open[severity]} aria-controls={id} onClick={() => setOpen((o) => ({ ...o, [severity]: !o[severity] }))}>
                <Icon size={15} />
                <span>{tr(label)}</span>
                <span className="st-lint-count st-num">{rows.length}</span>
                <ChevronIcon />
              </button>
            </h3>
            {open[severity] && (
              <div id={id} className="st-lint">
                {rows.map((w, i) => {
                  /* in Chinese: what the code means, and the server's own message beneath it */
                  const line = lintLine(lang, w);
                  return (
                    <div key={i} className="st-lint-row" data-severity={severity}>
                      <span className="st-lint-where">{w.scene ? `${w.scene}${w.shot ? ` #${w.shot}` : ""}` : tr("film")}</span>
                      <span>
                        <span className="st-lint-code">{w.code}</span>
                        {line.text}
                        {line.detail && <span className="st-muted" style={{ display: "block" }}>{line.detail}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* A new scene, from the button at the top of the board: its slug, then it is added at the end. */
function AddSceneForm({ onAdded }: { onAdded: (sceneId: string) => void }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const [slug, setSlug] = useState("");
  const add = useAction(async () => {
    if (!slug.trim()) return;
    const { scene } = await post<{ scene: { id: string } }>(`/api/projects/${projectId}/scenes`, { slug: slug.trim() });
    await reload();
    onAdded(scene.id);
  });
  return (
    <form className="st-stack st-stack--tight" onSubmit={(e) => { e.preventDefault(); void add.fire(); }}>
      <Field label={tr("Scene slug")} hint={tr("A short name for the scene. It is added at the end of the board, and the shotlist goes back to draft.")}>
        <input className="st-input" autoFocus maxLength={60} placeholder={tr("New scene slug, e.g. alley-chase")} value={slug} onChange={(e) => setSlug(e.target.value)} />
      </Field>
      <ErrorBanner error={add.error} projectId={projectId} onDismiss={add.dismiss} />
      <div className="st-row">
        <Button type="submit" kind="primary" size="sm" busy={add.busy} disabled={!slug.trim()}>{tr("Add scene")}</Button>
      </div>
    </form>
  );
}

/* A new shot, from a scene's Add shot: it is saved only with a name (the shot's intent, the line
   on its card), and the popup says whether the save went through. */
const SHOT_NAME_MIN = 5;

function AddShotForm({ scene, sceneNumber, onSaved, onOpen, onClose }: { scene: SceneView; sceneNumber: number; onSaved?: () => void; onOpen: (shotId: string) => void; onClose: () => void }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<{ id: string; slate: string; name: string } | null>(null);
  const add = useAction(async () => {
    const intent = name.trim();
    /* a shot needs one beat with an action in it (the schema refuses an empty one, which is why the old
       one-click Add shot was refused): the name stands in as that action until the shot is edited */
    const { shot } = await post<{ shot: { id: string; index: number } }>(`/api/scenes/${scene.id}/shots`, { ...BLANK_SHOT, intent, beats: [{ from: 0, to: BLANK_SHOT.durationS, action: intent }] });
    await reload();
    setSaved({ id: shot.id, slate: `${sceneNumber}·${shot.index + 1}`, name: intent });
    setName("");
    onSaved?.();
  });
  if (saved) {
    return (
      <div className="st-stack st-stack--tight" role="status">
        <Status tone="ok" icon={<CheckCircleIcon />}>{tr("Saved as shot {slate}", { slate: saved.slate })}</Status>
        <span className="st-pop-quote">{saved.name}</span>
        <div className="st-row">
          <Button size="sm" kind="primary" onClick={() => onOpen(saved.id)}>{tr("Open the shot")}</Button>
          <Button size="sm" onClick={() => setSaved(null)}>{tr("Add another")}</Button>
          <Button size="sm" kind="quiet" onClick={onClose}>{tr("Close")}</Button>
        </div>
      </div>
    );
  }
  const short = name.trim().length < SHOT_NAME_MIN;
  return (
    <form className="st-stack st-stack--tight" onSubmit={(e) => { e.preventDefault(); if (!short) void add.fire(); }}>
      <Field label={tr("Shot name")} hint={tr("One sentence: what this shot is for, at least {n} characters. It is the line on the shot's card; the rest is filled in under Edit.", { n: SHOT_NAME_MIN })}>
        <input className="st-input" autoFocus maxLength={300} placeholder={tr("e.g. the courier crosses the wet square")} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {add.error ? (
        <div className="st-stack st-stack--tight" role="alert">
          <Status tone="err" icon={<ErrorIcon />}>{tr("The shot was not saved")}</Status>
          <ErrorBanner error={add.error} projectId={projectId} onDismiss={add.dismiss} />
        </div>
      ) : null}
      <div className="st-row">
        <Button type="submit" kind="primary" size="sm" busy={add.busy} disabled={short}>{tr("Save")}</Button>
        <Button size="sm" kind="quiet" onClick={onClose}>{tr("Cancel")}</Button>
      </div>
    </form>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_COLOURS = 6;

/* A scene's colour script: up to six colours, darkest first, and a note. Each
   colour is a swatch (the system's colour picker) and its hex beside it; a
   pasted run of hex codes replaces the lot. */
function PaletteForm({ scene, onDone }: { scene: SceneView; onDone: () => void }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const [colors, setColors] = useState<string[]>(scene.palette?.colors ?? []);
  const [note, setNote] = useState(scene.palette?.note ?? "");
  const save = useAction(async (_c, palette: { colors: string[]; note?: string } | null) => {
    await put(`/api/scenes/${scene.id}/palette`, { palette });
    await reload();
    onDone();
  });
  const setAt = (i: number, c: string) => setColors((xs) => xs.map((x, j) => (j === i ? c : x)));
  const bad = colors.some((c) => !HEX.test(c));
  return (
    <form className="st-stack st-stack--tight pal-form" onSubmit={(e) => { e.preventDefault(); if (!bad) void save.fire(colors.length ? { colors, ...(note.trim() ? { note: note.trim() } : {}) } : null); }}>
      <strong>{tr("Colour script · {slug}", { slug: scene.slug })}</strong>
      <span className="st-muted">{tr("Up to six colours, darkest first; one accent at most. They compile into every shot of the scene.")}</span>
      <div className="pal-list">
        {colors.map((c, i) => (
          <div key={i} className="pal-colour">
            <label className="pal-swatch" style={{ background: HEX.test(c) ? c : "transparent" }} title={tr("Pick a colour")}>
              <input type="color" value={HEX.test(c) ? c.toLowerCase() : "#808080"} onChange={(e) => setAt(i, e.target.value)} aria-label={tr("Colour {n}", { n: i + 1 })} />
            </label>
            <input className="st-input st-input--sm pal-hex" value={c} maxLength={7} spellCheck={false} aria-label={tr("Colour {n}, hex", { n: i + 1 })} aria-invalid={!HEX.test(c)}
              onChange={(e) => setAt(i, e.target.value.trim())}
              onPaste={(e) => {
                /* a run of hex codes pasted into one field is a whole palette */
                const many = e.clipboardData.getData("text").match(/#[0-9a-fA-F]{6}\b/g);
                if (many && many.length > 1) { e.preventDefault(); setColors(many.slice(0, MAX_COLOURS)); }
              }} />
            <button type="button" className="st-btn st-btn--quiet st-btn--sm pal-remove" aria-label={tr("Remove colour {n}", { n: i + 1 })} onClick={() => setColors((xs) => xs.filter((_, j) => j !== i))}>
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
        {colors.length < MAX_COLOURS && (
          <button type="button" className="st-btn st-btn--sm pal-add" onClick={() => setColors((xs) => [...xs, "#808080"])}>
            <PlusIcon size={12} />{tr("Add a colour")}
          </button>
        )}
      </div>
      <Field label={tr("Note")}>
        <input className="st-input st-input--sm" maxLength={200} placeholder={tr("e.g. warm practicals against a cold window; red only on the scarf")} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {bad && <span className="st-muted">{tr("A colour is six hex digits after #, like #1d2430.")}</span>}
      <ErrorBanner error={save.error} projectId={projectId} onDismiss={save.dismiss} />
      <div className="st-row st-row--between">
        <span className="st-row">
          <Button type="submit" kind="primary" size="sm" busy={save.busy} disabled={bad}>{tr("Save")}</Button>
          <Button size="sm" kind="quiet" onClick={onDone}>{tr("Cancel")}</Button>
        </span>
        {scene.palette && <Button size="sm" kind="quiet" busy={save.busy} onClick={() => void save.fire(null)}>{tr("Clear the palette")}</Button>}
      </div>
    </form>
  );
}

/* The link type on the card, when it is anything but a plain cut. */
function linkLabel(spec: ShotView["spec"]): string | null {
  const type = spec.link?.type ?? (spec.linkToPrev === "continuous" ? "continuous" : "cut");
  if (type === "cut") return null;
  return EDIT_GRAMMAR.find((g) => g.type === type)?.label.toLowerCase() ?? type;
}

/* A scene's shots, as cards that can be dragged into a new order (shot-sort.ts). `order` is the order
   a card was just dropped into, drawn until the board itself comes back with it. */
function ShotGrid({ scene, order, onSorted, children }: { scene: SceneView; order?: string[]; onSorted: (ids: string[]) => void; children: (shot: ShotView, index: number) => ReactNode }) {
  const shots = order ? order.map((id) => scene.shots.find((s) => s.id === id)).filter((s): s is ShotView => Boolean(s)) : scene.shots;
  const grid = useShotSort(scene.id, shots.map((s) => s.id), onSorted);
  return (
    <div className="st-shots" id={`scene-shots-${scene.id}`} ref={grid}>
      {shots.map(children)}
    </div>
  );
}

/* A shot on the board. It is dragged to its place in the scene; from the keyboard, Alt with an arrow
   key moves it one place. */
function ShotCard({ shot, index, slate, lint, open, onOpen, onNudge }: {
  shot: ShotView; index: number; slate?: string; lint: LintWarning[]; open: boolean; onOpen: () => void; onNudge?: (by: -1 | 1) => void;
}) {
  const tr = useT();
  const lang = useLang();
  const latest = shot.takes[0];
  const cost = shot.takes.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  const codes = cineCodes(shot.spec);
  const link = linkLabel(shot.spec);
  const problems = lint.filter((w) => w.severity !== "info").length;
  const { loras: library } = useLoraLibrary();
  const loraChips = shotLoraChips(shot.spec, library);
  /* Poster order: the selected take, else the newest completed take, else the hero frame. */
  const poster = shot.selectedTake?.thumbUrls[0] ?? shot.takes.find((t) => t.status === "completed" && t.thumbUrls[0])?.thumbUrls[0] ?? shot.hero?.url;
  return (
    <div className="st-shot" aria-pressed={open} data-shot-id={shot.id} title={tr("Drag to reorder (on a touch screen, hold first; from the keyboard, Alt + arrow keys)")}
      onKeyDown={(e) => {
        if (!e.altKey || !onNudge) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onNudge(-1); }
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onNudge(1); }
      }}>
      <Zoomable url={poster} title={`${slate ?? index + 1} · ${shot.spec.intent || tr("Untitled shot")}`}>
        <button type="button" className="st-shot-media" onClick={onOpen} style={{ display: "block", width: "100%" }}>
          {poster ? <img src={poster} alt="" draggable={false} /> : <div className="st-placeholder">{latest ? "" : tr("no take yet")}</div>}
          <span className="st-shot-index">{slate ?? index + 1}</span>
          {latest && (
            <span className="st-shot-status">
              <Lamp state={latest.status} label={tr(statusLabel(latest.status, latest))} />
            </span>
          )}
        </button>
      </Zoomable>
      <div className="st-shot-body">
        <div className="st-shot-tags">
          {codes.length ? codes.map((c) => <span key={c} className="st-chip st-chip--mono">{c}</span>) : <span className="st-chip st-chip--mono st-chip--warn">{tr("no cinematography")}</span>}
          {link && <span className="st-chip st-chip--mono" aria-pressed="true">{tr(link)}</span>}
          {loraChips.map((c) => (
            <span key={c.key} className="st-chip st-chip--lora" data-off={c.off ? "true" : undefined} data-turbo={c.key === "turbo" ? "off" : undefined} title={c.title ? `${c.label}: ${c.title}` : c.key === "turbo" ? tr("Use turbo is off: the base chain, about 2.5× the render time") : tr("Use LoRA is off")}>
              {c.key === "turbo" ? tr("no turbo") : c.label}
            </span>
          ))}
          {problems > 0 && <span className="st-chip st-chip--mono st-chip--warn" title={lint.map((w) => lintLine(lang, w).text).join("\n")}>⚠ {problems}</span>}
        </div>
        <button type="button" className="st-shot-intent" onClick={onOpen} style={{ textAlign: "left" }}>
          {shot.spec.intent || tr("Untitled shot")}
        </button>
        <div className="st-shot-facts">
          {tr("{d} s · {mode} · {move}", { d: shot.spec.durationS, mode: tr(shot.spec.mode), move: tr(shot.spec.camera.move.replace("_", " ")) })}
          {shot.takes.length > 0 && plural(tr, shot.takes.length, " · 1 take · {cost}", " · {n} takes · {cost}", { cost: usd(cost) })}
        </div>
      </div>
    </div>
  );
}

type Compiled = {
  workflow: string;
  prompt: string;
  warnings: string[];
  estimate: { usd: number; gpuSeconds: number; steps: number; source?: "measured" | "placeholder"; perOutputSecond?: number };
  params?: InferenceParams;
  paramSources?: string[];
  input?: { loras?: Array<{ name: string; strength: number; kind: string }> };
};

function ShotDrawer({ shot, onClose }: { shot: ShotView; onClose: () => void }) {
  const { projectId, view, reload } = useProjectContext();
  const tr = useT();
  const address = useShotAddress();
  const TABS = ["edit", "compile", "frames", "takes"] as const;
  const tab = TABS.find((t) => t === address.tab) ?? (shot.takes.length ? "takes" : "edit");
  const setTab = (t: (typeof TABS)[number]) => address.setTab(t);
  const [draft, setDraft] = useState<ShotDraft>({ ...shot.spec, promptOverride: shot.promptOverride ?? shot.spec.promptOverride });
  const [dirty, setDirty] = useState(false);
  const problems = useMemo(() => validateDraft(draft, tr), [draft, tr]);

  const save = useAction(async () => {
    await patch(`/api/shots/${shot.id}`, { ...draft, promptOverride: draft.promptOverride ?? null });
    setDirty(false);
    await reload();
  });
  const undoable = useUndoable(reload);
  const remove = useAction(async () => {
    const takes = shot.takes.length;
    const slate = view ? `${view.scenes.findIndex((sc) => sc.id === shot.sceneId) + 1}·${shot.index + 1}` : `${shot.index + 1}`;
    const { trashId } = await del<{ trashId?: string }>(`/api/shots/${shot.id}`);
    onClose();
    await reload();
    undoable(trashId, tr("Deleted shot {slate}{takes}", { slate, takes: takes ? plural(tr, takes, " and its 1 take", " and its {n} takes") : "" }));
  });

  const elements = view?.elements ?? [];

  return (
    <Drawer
      title={`${view ? `${view.scenes.findIndex((sc) => sc.id === shot.sceneId) + 1}·${shot.index + 1}` : tr("Shot {n}", { n: shot.index + 1 })} · ${shot.spec.intent || tr("untitled")}`}
      onClose={onClose}
      head={
        <>
          <Button size="sm" kind="primary" busy={save.busy} disabled={!dirty || problems.length > 0} onClick={() => void save.fire()}>
            {tr("Save")}
          </Button>
        </>
      }
    >
      <div className="st-stack">
        <div className="st-tabs" role="tablist">
          {(["edit", "compile", "frames", "takes"] as const).map((t) => (
            <button key={t} type="button" role="tab" className="st-tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "edit" ? tr("Edit") : t === "compile" ? tr("Compile") : t === "frames" ? tr("Frames") : shot.takes.length ? tr("Takes ({n})", { n: shot.takes.length }) : tr("Takes")}
            </button>
          ))}
        </div>
        <ErrorBanner error={save.error ?? remove.error} projectId={projectId} onDismiss={() => { save.dismiss(); remove.dismiss(); }} />
        {tab === "edit" && (
          <>
            {problems.length > 0 && (
              <div className="st-alert st-alert--info">
                <span>{problems.join(" ")}</span>
              </div>
            )}
            <ShotEditor
              value={draft}
              elements={elements}
              takes={shot.takes}
              shotId={shot.id}
              onChange={(next) => {
                setDraft(next);
                setDirty(true);
              }}
            />
            {/* deleting the shot is here, in its own place — never next to the frame buttons */}
            <div className="st-row st-row--between" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <span className="st-muted">{tr("Remove this shot from the board (its takes too). Pictures stay in Pictures.")}</span>
              <ConfirmButton size="sm" kind="danger" busy={remove.busy} placement="above" confirmLabel={tr("Delete this shot")} onConfirm={() => void remove.fire()}
                question={tr("Delete this shot{takes}? For 14 days it can be put back from Recently deleted, on the Settings page.", { takes: shot.takes.length ? plural(tr, shot.takes.length, " and its 1 take", " and its {n} takes") : "" })}>
                {tr("Delete this shot")}
              </ConfirmButton>
            </div>
          </>
        )}
        {tab === "compile" && <CompilePanel shotId={shot.id} dirty={dirty} />}
        {tab === "frames" && <FramesPanel shot={shot} />}
        {tab === "takes" && <TakesPanel shot={shot} />}
      </div>
    </Drawer>
  );
}

function CompilePanel({ shotId, dirty }: { shotId: string; dirty: boolean }) {
  const { projectId } = useProjectContext();
  const tr = useT();
  const [steps, setSteps] = useState<number | null>(null);
  const [data, setData] = useState<Compiled | null>(null);
  const [basisGpu, setBasisGpu] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setData(await get<Compiled>(`/api/shots/${shotId}/compile${steps ? `?steps=${steps}` : ""}`));
      get<{ estimateBasis?: { gpuTypeId?: string } }>("/api/gpu/stats").then((r) => setBasisGpu(r.estimateBasis?.gpuTypeId ?? null)).catch(() => setBasisGpu(null));
    } catch (caught) {
      setError(caught);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [shotId, steps]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="st-stack">
      {dirty && (
        <div className="st-alert st-alert--info">
          <span>{tr("Unsaved edits are not reflected here. Save first.")}</span>
        </div>
      )}
      <div className="st-row st-row--between">
        <Field label={tr("Steps")} hint={tr("empty = auto: the model's and its speed LoRA's recommendation")}>
          <input className="st-input st-input--sm" type="number" min={4} max={50} placeholder={tr("auto")} value={steps ?? ""} onChange={(e) => setSteps(e.target.value ? Number(e.target.value) : null)} style={{ width: 90 }} />
        </Field>
        {data && (
          <dl className="st-kv">
            <dt>{tr("Workflow")}</dt>
            <dd>{data.workflow}</dd>
            <dt>{tr("Estimate")}</dt>
            <dd>
              {tr("{cost} · {gpu} GPU s", { cost: usd(data.estimate.usd), gpu: Math.round(data.estimate.gpuSeconds) })}
              <span className="st-muted"> · {data.estimate.source === "measured" ? tr("measured on {gpu}", { gpu: basisGpu ?? tr("your GPU") }) : tr("placeholder constants")}</span>
            </dd>
            <dt>{tr("Settings")}</dt>
            <dd className="st-num">
              {data.params ? describeParams(data.params) : tr("{n} steps", { n: data.estimate.steps })}
              {data.paramSources?.length ? <span className="st-muted">{tr(" · from {sources}", { sources: data.paramSources.join(" → ") })}</span> : null}
            </dd>
            {data.input?.loras?.length ? (
              <>
                <dt>{tr("LoRAs")}</dt>
                <dd>{data.input.loras.map((l) => `${l.name} ×${l.strength}`).join(", ")}</dd>
              </>
            ) : null}
          </dl>
        )}
      </div>
      <ErrorBanner error={error} projectId={projectId} />
      {data?.warnings.length ? (
        <div className="st-alert st-alert--info">
          <span>{data.warnings.join(" · ")}</span>
        </div>
      ) : null}
      {loading && <Loading label={tr("Compiling…")} />}
      {data && <pre className="st-pre" aria-busy={loading}>{data.prompt}</pre>}
    </div>
  );
}

function TakesPanel({ shot }: { shot: ShotView }) {
  const { projectId, view, reload } = useProjectContext();
  const tr = useT();
  const [n, setN] = useState(1);
  const [steps, setSteps] = useState<number | null>(null);
  /* the price goes on the button: what this shot compiles to, times the takes asked for */
  const [est, setEst] = useState<Compiled["estimate"] | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    get<Compiled>(`/api/shots/${shot.id}/compile${steps ? `?steps=${steps}` : ""}`)
      .then((c) => { if (alive) { setEst(c.estimate); setWhy(null); } })
      .catch((caught) => { if (alive) { setEst(null); setWhy(describe(caught)); } });
    return () => { alive = false; };
  }, [shot.id, shot.updatedAt, steps]);
  const generate = useAction(async (confirm) => {
    await post(`/api/shots/${shot.id}/takes`, { n, ...(steps ? { steps } : {}), confirm });
    await reload();
  });
  const next = Math.max(0, ...shot.takes.map((t) => t.n)) + 1;
  const left = view ? view.project.budgetCapUsd - view.project.spentUsd : undefined;
  /* failures that say the same thing are one line, not a wall of them */
  const rows: Array<{ kind: "take"; take: Take } | { kind: "ng"; takes: Take[] }> = [];
  for (const take of shot.takes) {
    const last = rows[rows.length - 1];
    const failed = take.status === "failed" || take.status === "timeout";
    if (failed && last?.kind === "ng" && last.takes[0]!.error === take.error) last.takes.push(take);
    else rows.push(failed ? { kind: "ng", takes: [take] } : { kind: "take", take });
  }
  return (
    <div className="st-stack">
      <ErrorBanner error={generate.error} projectId={projectId} onConfirm={() => void generate.confirm()} onDismiss={generate.dismiss} />
      <div className="st-card st-row st-row--between">
        <div className="st-row">
          <Field label={tr("Takes")}>
            <NumberInput className="st-input st-input--sm" min={1} max={4} value={n} onCommit={(v) => setN(v ?? 1)} style={{ width: 70 }} />
          </Field>
          <Field label={tr("Steps")}>
            <NumberInput className="st-input st-input--sm" min={4} max={50} placeholder={tr("auto")} allowEmpty value={steps} onCommit={(v) => setSteps(v)} style={{ width: 70 }} />
          </Field>
        </div>
        <div className="st-stack st-stack--tight" style={{ alignItems: "flex-end" }}>
          <Button kind="tally" busy={generate.busy} onClick={() => void generate.fire()}>
            {n > 1 ? tr("Roll takes {a}–{b}", { a: next, b: next + n - 1 }) : tr("Roll take {n}", { n: next })}{est ? <span className="st-btn-price"> · ≈ {usd(est.usd * n)}</span> : null}
          </Button>
          <span className="st-muted st-num">
            {est ? tr("{basis} · {gpu} GPU s", { basis: est.source === "measured" ? tr("from finished takes") : tr("placeholder constants, nothing measured yet"), gpu: Math.round(est.gpuSeconds * n) }) : why ? tr("no estimate: {why}", { why }) : tr("estimating…")}
            {left !== undefined && est ? tr(" · {left} left after", { left: usd(Math.max(0, left - est.usd * n)) }) : ""}
          </span>
        </div>
      </div>
      {shot.takes.length === 0 ? (
        <Empty title={tr("No takes yet")} hint={tr("Steps follow the LoRA: 8 with a turbo LoRA, 20 on the base chain. Leave it empty unless you want to override.")} />
      ) : (
        rows.map((row) => (row.kind === "take" || row.takes.length === 1 ? <TakeRow key={row.kind === "take" ? row.take.id : row.takes[0]!.id} take={row.kind === "take" ? row.take : row.takes[0]!} shot={shot} /> : <NgGroup key={row.takes[0]!.id} takes={row.takes} />))
      )}
    </div>
  );
}

/* Several takes that failed for one reason: said once, with what they cost together. */
function NgGroup({ takes }: { takes: Take[] }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const newest = takes[0]!;
  const retry = useAction(async (confirm) => {
    await post(`/api/takes/${newest.id}/retry`, { confirm });
    await reload();
  });
  return (
    <div className="st-take st-take--ng">
      <div className="st-take-ng-mark st-num">NG</div>
      <div className="st-stack st-stack--tight">
        <strong>{tr("Takes {list} · the same failure", { list: takes.map((t) => t.n).sort((a, b) => a - b).join(", ") })}</strong>
        <span className="st-muted st-num">{tr("{workflow} · {cost} together", { workflow: newest.workflow, cost: usd(takes.reduce((n, t) => n + (t.costUsd ?? 0), 0)) })}</span>
        <div className="st-alert"><span>{newest.error ?? tr("failed")}</span></div>
        <ErrorBanner error={retry.error} projectId={projectId} onConfirm={() => void retry.confirm()} onDismiss={retry.dismiss} />
        <div className="st-row"><Button size="sm" busy={retry.busy} onClick={() => void retry.fire()}>{tr("Retry take {n}", { n: newest.n })}</Button></div>
      </div>
    </div>
  );
}

function TakeRow({ take, shot }: { take: Take; shot: ShotView }) {
  const { projectId, reload } = useProjectContext();
  const tr = useT();
  const [notes, setNotes] = useState(take.review?.notes ?? "");
  const [score, setScore] = useState<number | undefined>(take.review?.score);
  const [faults, setFaults] = useState<TakeFault[]>(take.review?.faults ?? []);
  const [audioOk, setAudioOk] = useState<boolean | undefined>(take.review?.audioOk);
  const review = useAction(async () => {
    if (!score) return;
    await post(`/api/takes/${take.id}/review`, { score, notes, faults, ...(audioOk !== undefined ? { audioOk } : {}) });
    await reload();
  });
  const select = useAction(async () => {
    await post(`/api/shots/${shot.id}/select-take`, { takeId: take.id });
    await reload();
  });
  /* One click says what was wrong: a tag is saved as it is set, with the score the take has or 2
     (a take with a fault is a rejected one). The retro only learns from takes somebody judged. */
  const tag = useAction(async (_confirm, next: TakeFault[], fallbackScore: number) => {
    setFaults(next);
    const s = score ?? take.review?.score ?? fallbackScore;
    setScore(s);
    await post(`/api/takes/${take.id}/review`, { score: s, notes, faults: next, ...(audioOk !== undefined ? { audioOk } : {}) });
    await reload();
  });
  const toggleFault = (f: TakeFault) => void tag.fire(faults.includes(f) ? faults.filter((x) => x !== f) : [...faults, f], 2);
  /* what the worker measured on the file, read against the shot: leads, each with the tag it suggests */
  const measured = useMemo(() => (take.status === "completed" ? readTake(take, shot.spec).findings : []), [take, shot.spec]);
  const cancel = useAction(async () => {
    await post(`/api/takes/${take.id}/cancel`);
    await reload();
  });
  const retry = useAction(async (confirm) => {
    await post(`/api/takes/${take.id}/retry`, { confirm });
    await reload();
  });
  const [remakeOpen, setRemakeOpen] = useState(false);
  const [resolution, setResolution] = useState<"1080p" | "2k" | "4k">("2k");
  const [closeToDraft, setCloseToDraft] = useState(true);
  const [show2k, setShow2k] = useState(true);
  const regen = useAction(async (confirm) => {
    await post(`/api/takes/${take.id}/regenerate`, { resolution, startSigma: closeToDraft ? 0.8 : 0, confirm });
    await reload();
  });
  const cancelRegen = useAction(async () => {
    await del(`/api/takes/${take.id}/regenerate`);
    await reload();
  });
  const up = take.upscale;
  const upActive = up?.status === "queued" || up?.status === "running";
  const rolling = take.status === "queued" || take.status === "running";
  const active = take.status === "queued" || take.status === "running" || Boolean(upActive);
  const playUrl = up?.status === "completed" && up.url && show2k ? up.url : take.resultUrl;
  const selected = shot.selectedTakeId === take.id;
  /* another take was picked and nobody said what was wrong with this one */
  const passedOver = Boolean(shot.selectedTakeId) && !selected && take.status === "completed" && !take.review;
  return (
    /* a take's row keeps one height: what was said about it takes the room that is left and is cut with an ellipsis */
    <div className="st-take" data-selected={selected}>
      <div>
        {playUrl ? (
          <video className="st-video" src={playUrl} controls preload="metadata" poster={take.thumbUrls[0]} />
        ) : (
          <div className="st-video" style={{ display: "grid", placeItems: "center" }}>
            <Lamp state={take.status} label={tr(statusLabel(take.status, take))} />
          </div>
        )}
      </div>
      <div className="st-stack st-stack--tight st-take-info">
        <div className="st-row st-row--between">
          <div className="st-row">
            <strong className="st-num">{tr("Take {n}", { n: take.n })}</strong>
            <Lamp state={take.status} label={tr(statusLabel(take.status, take))} />
            {selected && <span className="st-chip" aria-pressed="true">{tr("Selected")}</span>}
          </div>
          <span className="st-muted st-num">
            {tr("{workflow} · seed {seed} · {cost}", { workflow: take.workflow, seed: take.seed ?? "—", cost: usd(take.costUsd) })}
            {take.executionMs ? ` · ${Math.round(take.executionMs / 1000)}s` : ""}
          </span>
        </div>
        {active && <TakeProgressBar take={take} />}
        {take.error && (
          <div className="st-alert">
            <span>{take.error}</span>
          </div>
        )}
        <ErrorBanner error={review.error ?? tag.error ?? select.error ?? cancel.error ?? retry.error ?? regen.error ?? cancelRegen.error} projectId={projectId} onConfirm={retry.error ? () => void retry.confirm() : regen.error ? () => void regen.confirm() : undefined} onDismiss={() => { review.dismiss(); tag.dismiss(); select.dismiss(); cancel.dismiss(); retry.dismiss(); regen.dismiss(); cancelRegen.dismiss(); }} />
        {take.status === "completed" && (
          <div className="st-row" style={{ flexWrap: "wrap", gap: 8 }}>
            {up?.status === "completed" && up.url ? (
              <>
                <span className="st-chip" aria-pressed={show2k}>{tr("{res} ready", { res: up.resolution.toUpperCase() })}{up.costUsd ? ` · ${usd(up.costUsd)}` : ""}</span>
                <Button kind="quiet" size="sm" onClick={() => setShow2k((v) => !v)}>{tr("Show {res}", { res: show2k ? "768p" : up.resolution.toUpperCase() })}</Button>
              </>
            ) : upActive ? (
              <>
                <span className="st-muted st-num">{tr("Regenerate {res}: {status}", { res: up!.resolution.toUpperCase(), status: tr(up!.status) })}{up!.progress?.stage ? ` · ${tr(STAGE_LABEL[up!.progress.stage] ?? up!.progress.stage)}` : ""}{up!.progress?.stage === "sampling" && up!.progress.total ? ` ${up!.progress.step ?? 0}/${up!.progress.total}` : ""}</span>
                <Button kind="quiet" size="sm" busy={cancelRegen.busy} onClick={() => void cancelRegen.fire()}>{tr("Cancel")}</Button>
              </>
            ) : (
              <>
                <select className="st-input st-input--sm" value={resolution} disabled={!REGENERATE_ENABLED} onChange={(e) => setResolution(e.target.value as typeof resolution)} style={{ width: 90 }}>
                  <option value="1080p">1080p</option>
                  <option value="2k">2K</option>
                  <option value="4k">4K</option>
                </select>
                <label className="st-row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={closeToDraft} disabled={!REGENERATE_ENABLED} onChange={(e) => setCloseToDraft(e.target.checked)} />
                  <span className="st-muted">{tr("stay close to the draft")}</span>
                </label>
                <Button size="sm" busy={regen.busy} disabled={!REGENERATE_ENABLED} onClick={() => void regen.fire()} title={REGENERATE_ENABLED ? tr("Open-H3-Regenerate-2K: three refine steps on the pod") : tr("Regenerating at a higher resolution is switched off for now")}>{tr("Regenerate {res}", { res: resolution.toUpperCase() })}</Button>
                {up?.status === "failed" && <span className="st-danger">{up.error ?? tr("regeneration failed")}</span>}
              </>
            )}
          </div>
        )}
        {/* nothing to score while the take is still rolling */}
        {!rolling && (
          <div className="st-row">
            <Stars value={score} onChange={setScore} />
            <input className="st-input st-input--sm" style={{ flex: 1, minWidth: 120 }} placeholder={tr("Review notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <Button size="sm" busy={review.busy} disabled={!score} onClick={() => void review.fire()}>
              {tr("Save review")}
            </Button>
          </div>
        )}
        {measured.length > 0 && (
          <div className="st-stack st-stack--tight">
            <span className="st-muted">{tr("Measured on the file — places to look, not a verdict")}</span>
            {measured.map((f, i) => (
              <div key={`${f.code}${i}`} className="st-row" style={{ gap: 6 }} title={f.message}>
                <span>{tr(FINDING_LABELS[f.code] ?? f.message, { at: findingAt(f) })}</span>
                {f.suggests && !faults.includes(f.suggests) && (
                  <button type="button" className="st-chip" disabled={tag.busy} onClick={() => toggleFault(f.suggests!)}>
                    {tr("Tag: {fault}", { fault: tr(f.suggests.replaceAll("_", " ")) })}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {take.status === "completed" && (
          <details open={passedOver}>
            <summary className="st-muted">{passedOver ? tr("Passed over — one click says why (feeds the retro)") : tr("What went wrong (feeds the retro)")}{faults.length ? ` · ${faults.length}` : ""}</summary>
            <div className="st-chips" style={{ marginTop: 6 }}>
              {TAKE_FAULTS.map((f) => (
                <button key={f} type="button" className="st-chip" aria-pressed={faults.includes(f)} disabled={tag.busy} onClick={() => toggleFault(f)}>
                  {tr(f.replaceAll("_", " "))}
                </button>
              ))}
              {passedOver && (
                <button type="button" className="st-chip" disabled={tag.busy} title={tr("Nothing wrong with it: it is an alternate")} onClick={() => void tag.fire([], 3)}>
                  {tr("nothing wrong — an alternate")}
                </button>
              )}
            </div>
            {faults.length > 0 && (
              <ul className="st-muted" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {faultRoutes(faults).map((r) => (
                  <li key={r.fault} title={r.fixes.map((x) => x.how).join(" · ")}>
                    {tr(r.fault.replaceAll("_", " "))}: {tr(`${r.fixes[0]!.kind}||fix`)}{r.not?.startsWith("rewording") ? tr(" — not by rewording the prompt") : ""}
                  </li>
                ))}
              </ul>
            )}
            <label className="st-row" style={{ gap: 6, marginTop: 6 }}>
              <input type="checkbox" checked={audioOk === false} onChange={(e) => setAudioOk(e.target.checked ? false : true)} />
              <span className="st-muted">{tr("Sound unusable — mute this take's own audio on the timeline")}</span>
            </label>
          </details>
        )}
        {take.review && <ReviewSaid review={take.review} />}
        {take.workflow === "REMAKE" && typeof take.input.studio_remake === "object" && take.input.studio_remake ? (
          <span className="st-muted">{tr("Remake ({mode}) of take #{n}", { mode: tr(String((take.input.studio_remake as { mode?: string }).mode)), n: String((take.input.studio_remake as { sourceN?: number }).sourceN ?? "?") })}</span>
        ) : null}
        {remakeOpen && take.status === "completed" && <RemakePanel take={take} onClose={() => setRemakeOpen(false)} />}
        <div className="st-row">
          {take.status === "completed" && !remakeOpen && (
            <Button size="sm" kind="quiet" onClick={() => setRemakeOpen(true)} title={tr("Viggle Remake: fix props, wardrobe, a face or the background from painted frames, keeping the motion")}>
              {tr("Fix with Remake")}
            </Button>
          )}
          {take.status === "completed" && !selected && (
            <Button size="sm" kind="primary" busy={select.busy} onClick={() => void select.fire()}>
              {tr("Use this take")}
            </Button>
          )}
          {active && (
            <Button size="sm" kind="quiet" busy={cancel.busy} onClick={() => void cancel.fire()}>
              {tr("Cancel")}
            </Button>
          )}
          {(take.status === "failed" || take.status === "timeout") && (
            <Button size="sm" busy={retry.busy} onClick={() => void retry.fire()}>
              {tr("Retry")}
            </Button>
          )}
          {take.resultUrl && (
            <a className="st-btn st-btn--quiet st-btn--sm" href={take.resultUrl} download target="_blank" rel="noreferrer">
              {tr("Download")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}


/* What was said about a take: who scored it, the notes, the faults, what it was judged from. It can
   be long, and it is the one part of a take's row that gives: it takes the height the row has left
   and ends in an ellipsis (as many whole lines as fit; the full text is in its title). Where the
   row is not held to a height (a phone, the column stacked) it shows a few lines instead. */
function ReviewSaid({ review }: { review: NonNullable<Take["review"]> }) {
  const tr = useT();
  const box = useRef<HTMLSpanElement>(null);
  /* The box has the height the row leaves; the text in it is cut to the whole lines that fit, so no
     half line shows under the ellipsis. Stacked under the player (a phone) the stylesheet's count stands. */
  useEffect(() => {
    const el = box.current;
    const text = el?.firstElementChild as HTMLElement | null;
    if (!el || !text) return;
    const fit = () => {
      if (getComputedStyle(el).flexGrow === "0") return text.style.removeProperty("-webkit-line-clamp");
      const line = parseFloat(getComputedStyle(text).lineHeight) || 18;
      text.style.setProperty("-webkit-line-clamp", String(Math.max(1, Math.floor((el.clientHeight + 1) / line))));
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const said = [
    tr("Reviewed {score}/5 by {by}", { score: review.score, by: tr(`${review.by}||reviewer`) }),
    review.notes ? ` — ${review.notes}` : "",
    review.faults?.length ? ` · ${review.faults.map((f) => tr(f.replaceAll("_", " "))).join(", ")}` : "",
    review.audioOk === false ? tr(" · audio muted") : "",
    review.basis ? tr(" · basis: {basis}", { basis: review.basis }) : "",
  ].join("");
  return <span ref={box} className="st-muted st-take-said" title={said}><span>{said}</span></span>;
}

const STAGE_LABEL: Record<string, string> = {
  inputs: "fetching inputs", queued: "queued on ComfyUI", preparing: "preparing", loading: "loading models", encoding: "encoding the draft", upscaling: "upscaling the latent", sampling: "sampling",
  decoding: "decoding video", finishing: "finishing", uploading: "uploading to R2", error: "error", interrupted: "interrupted",
};

function eta(seconds: number, tr: T): string {
  if (seconds < 60) return tr("{s} s", { s: Math.round(seconds) });
  return tr("{m} min {s} s", { m: Math.floor(seconds / 60), s: Math.round(seconds % 60) });
}

/* Where a running take is: the pod reports stage and sampling step through
   /status. The SSE snapshot carries it, and while the take is active the row
   also asks /api/takes/:id itself every few seconds (that call refreshes the
   take from the pod), so the bar does not depend on the event stream. */
function TakeProgressBar({ take: fromView }: { take: Take }) {
  const tr = useT();
  const [live, setLive] = useState<Take>(fromView);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setLive(fromView), [fromView]);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const { take } = await get<{ take: Take }>(`/api/takes/${fromView.id}`);
        if (!stopped) setLive(take);
      } catch {
        /* keep the last known state */
      }
      if (!stopped) setNow(Date.now());
    };
    const timer = window.setInterval(() => void tick(), 4000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [fromView.id]);
  const take = live;
  const p = take.progress;
  const ageS = p?.at ? Math.max(0, Math.round(now / 1000 - p.at)) : undefined;
  if (take.status === "queued" && !take.requestId) return <p className="st-muted">{tr("Waiting for the GPU pod")}</p>;
  if (!p) return <p className="st-muted">{take.status === "queued" ? tr("Queued on the pod") : tr("Running (no progress reported yet)")}</p>;
  const percent = p.stage === "sampling" ? (p.percent ?? 0) : p.stage === "decoding" ? 92 : p.stage === "finishing" || p.stage === "uploading" ? 97 : p.stage === "loading" ? 5 : 2;
  const detail = p.stage === "sampling" && p.total
    ? `${tr("step {a}/{b}", { a: p.step ?? 0, b: p.total })}${p.secondsPerStep ? tr(" · {s} s/step", { s: p.secondsPerStep }) : ""}${p.etaSeconds !== undefined ? tr(" · ~{eta} left", { eta: eta(p.etaSeconds, tr) }) : ""}`
    : "";
  return (
    <div className="st-stack st-stack--tight">
      <div className="st-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="st-progress__fill" style={{ width: `${percent}%` }} data-indeterminate={p.stage !== "sampling" ? "true" : undefined} />
      </div>
      <span className="st-muted st-num">{tr(STAGE_LABEL[p.stage] ?? p.stage)}{detail ? ` · ${detail}` : ""}{ageS !== undefined && ageS > 20 ? tr(" · updated {s} s ago", { s: ageS }) : ""}</span>
    </div>
  );
}
