"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { describeParams, type InferenceParams } from "@/studio/models";
import type { SceneView, ShotView } from "@/studio/orchestrator";
import { TAKE_FAULTS, type ShotInput, type TakeFault } from "@/studio/schemas";
import { FINDING_LABELS, findingAt, readTake } from "@/studio/take-checks";
import type { Take } from "@/studio/types";
import { faultRoutes } from "@director/faults";
import { FramesPanel } from "./frames-panel";
import { RemakePanel } from "./remake-panel";

import { del, describe, get, patch, post, put, usd } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, Lamp, NumberInput, Stars, statusLabel, useAction } from "./common";
import { plural, type T, useLang, useT } from "./i18n";
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
    open: (id: string) => go((q) => { q.set("shot", id); q.delete("tab"); }, "push"),
    close: () => go((q) => { q.delete("shot"); q.delete("tab"); }, "replace"),
    setTab: (tab: string) => go((q) => q.set("tab", tab), "replace"),
  };
}

function Board() {
  const { projectId, view, reload } = useProjectContext();
  const tr = useT();
  const lang = useLang();
  const undoable = useUndoable(reload);
  const address = useShotAddress();
  const openId = address.openId;
  const setOpenId = (id: string | null) => (id ? address.open(id) : address.close());
  const [newScene, setNewScene] = useState("");
  const [lint, setLint] = useState<LintReport | null>(null);
  const [lintOpen, setLintOpen] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [sketchGray, setSketchGray] = useState(false);
  const [sketchKey, setSketchKey] = useState(0);
  const [batch, setBatch] = useState<BatchPlan | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [styleNote, setStyleNote] = useState<string | null>(null);
  const shotKey = (scene: string, i: number) => `${scene}#${i + 1}`;
  const refreshLint = useCallback(async () => {
    try {
      setLint(await get<LintReport>(`/api/projects/${projectId}/lint`));
    } catch {
      setLint(null);
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
  const applyStyle = useAction(async () => {
    const style = view?.project.look.style;
    if (!style) return;
    const r = await post<{ warnings: LintWarning[] }>(`/api/projects/${projectId}/apply-style`, { style });
    setStyleNote(tr("Style “{style}” applied to every shot{notes}. The shotlist is back in draft until you approve it.", { style, notes: r.warnings.length ? tr("; {n} note(s) in Lint", { n: r.warnings.length }) : "" }));
    await reload();
    await refreshLint();
  });
  const plan = useAction(async () => {
    setBatch(await post<BatchPlan>(`/api/projects/${projectId}/batch`, { takesPerShot: 1, onlyMissing: true }));
    setBatchOpen(true);
  });
  const renderPass = useAction(async (confirm, ids: string[]) => {
    for (const id of ids) await post(`/api/shots/${id}/takes`, { n: 1, confirm });
    setBatchOpen(false);
    await reload();
  });

  const approve = useAction(async () => {
    await post(`/api/projects/${projectId}/shotlist/approve`);
    await reload();
  });
  const addScene = useAction(async () => {
    if (!newScene.trim()) return;
    await post(`/api/projects/${projectId}/scenes`, { slug: newScene.trim() });
    setNewScene("");
    await reload();
  });
  const addShot = useAction(async (_c, sceneId: string) => {
    const { shot } = await post<{ shot: { id: string } }>(`/api/scenes/${sceneId}/shots`, { ...BLANK_SHOT, intent: "New shot — describe it" });
    await reload();
    setOpenId(shot.id);
  });
  const reorder = useAction(async (_c, scene: SceneView, from: number, to: number) => {
    const ids = scene.shots.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    await post("/api/shots/reorder", { sceneId: scene.id, shotIds: ids });
    await reload();
  });
  const editPalette = useAction(async (_c, scene: SceneView) => {
    const current = scene.palette ? `${scene.palette.colors.join(" ")}${scene.palette.note ? ` | ${scene.palette.note}` : ""}` : "";
    const raw = window.prompt(tr("Colour script for \"{slug}\": hex colours darkest first, then | and a note. Empty clears it.\nExample: #1d2430 #3b4a5c #d9c7a3 #b23a2b | warm practicals against a cold window; red only on the scarf", { slug: scene.slug }), current);
    if (raw === null) return;
    const [cols, note] = raw.split("|");
    const colors = (cols ?? "").match(/#[0-9a-fA-F]{6}/g) ?? [];
    await put(`/api/scenes/${scene.id}/palette`, { palette: colors.length ? { colors: colors.slice(0, 6), ...(note?.trim() ? { note: note.trim() } : {}) } : null });
    await reload();
  });
  const removeScene = useAction(async (_c, scene: SceneView) => {
    const { trashId } = await del<{ trashId?: string }>(`/api/scenes/${scene.id}`);
    await reload();
    undoable(trashId, tr("Deleted scene {i} · {slug}{shots}", { i: view ? view.scenes.indexOf(scene) + 1 : "", slug: scene.slug, shots: scene.shots.length ? plural(tr, scene.shots.length, " and its 1 shot", " and its {n} shots") : "" }));
  });

  if (!view) return null;
  const open = view.scenes.flatMap((s) => s.shots).find((s) => s.id === openId) ?? null;
  const approved = view.project.shotlistApproval === "approved";
  const shotCount = view.scenes.reduce((n, s) => n + s.shots.length, 0);
  const error = approve.error ?? addScene.error ?? addShot.error ?? reorder.error ?? removeScene.error ?? editPalette.error;

  return (
    <div className="st-page st-page--wide">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{tr("Board")}</h1>
          <p className="st-subtitle">
            {tr("Checkpoint 2. Structural edits return the shotlist to draft.")} {view.canGenerate ? tr("Ready to render.") : tr("Blocked: {list}.", { list: view.blockers.join(", ") })}
          </p>
        </div>
        <div className="st-actions">
          <Lamp state={approved ? "ok" : "warn"} label={approved ? (view.delegated?.shotlist ? tr("Shotlist approved by the director") : tr("Shotlist approved")) : tr("Shotlist draft")} />
          {shotCount > 0 && (
            <Button kind="quiet" onClick={() => setSketchOpen(true)} title={tr("Colour-block storyboard from the shotlist: sizes, 38/62 composition, blocking, scene palettes")}>
              {tr("Sketch")}
            </Button>
          )}
          {shotCount > 0 && (
            <Button kind={lint && (lint.counts.error || lint.counts.warn) ? "default" : "quiet"} onClick={() => setLintOpen(true)} title={tr("Rhythm and craft lint of the shotlist")}>
              {tr("Lint")}{lint ? ` · ${lint.counts.error + lint.counts.warn}` : ""}
            </Button>
          )}
          {shotCount > 0 && view.project.look.style && (
            <Button busy={applyStyle.busy} onClick={() => void applyStyle.fire()} title={tr("Fill every shot's cinematography from the style “{style}”", { style: view.project.look.style })}>
              {tr("Apply style")}
            </Button>
          )}
          {!approved && (
            <Button kind="primary" busy={approve.busy} disabled={shotCount === 0} onClick={() => void approve.fire()}>
              {tr("Approve shotlist")}
            </Button>
          )}
          {approved && (
            <Button kind="tally" busy={plan.busy} onClick={() => void plan.fire()} title={tr("Order the shots without a take: R2VA first, anchors before linked shots, one estimate. Nothing renders until you confirm it.")}>
              {tr("Render batch")}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={error ?? applyStyle.error ?? plan.error ?? renderPass.error} projectId={projectId} onConfirm={renderPass.error ? () => void renderPass.confirm() : undefined} onDismiss={() => { approve.dismiss(); addScene.dismiss(); addShot.dismiss(); reorder.dismiss(); removeScene.dismiss(); editPalette.dismiss(); applyStyle.dismiss(); plan.dismiss(); renderPass.dismiss(); }} />
      {styleNote && (
        <div className="st-alert st-alert--info" style={{ marginBottom: 16 }}>
          <span>{styleNote}</span>
          <Button size="sm" kind="quiet" onClick={() => setStyleNote(null)}>{tr("Dismiss")}</Button>
        </div>
      )}

      {view.scenes.length === 0 && (
        <Empty title={tr("No scenes yet")} hint={tr("Ask the director agent to save_shotlist, or add a scene below and build shots by hand.")} />
      )}

      {view.scenes.map((scene) => (
        <section key={scene.id} className="st-scene">
          <div className="st-scene-head">
            <div>
              <span className="st-scene-slug">{scene.index + 1}. {scene.slug}</span>
              {scene.summary && <span className="st-scene-summary"> · {scene.summary}</span>}
              {scene.palette && (
                <span className="st-row" style={{ display: "inline-flex", gap: 2, marginLeft: 8, verticalAlign: "middle" }} title={scene.palette.note ?? tr("scene palette")}>
                  {scene.palette.colors.map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 0, background: c, display: "inline-block" }} />)}
                </span>
              )}
            </div>
            <div className="st-row">
              <Button size="sm" kind="quiet" onClick={() => void editPalette.fire(scene)} title={tr("This scene's colour script; it compiles into every shot")}>
                {tr("Palette||scene colours")}
              </Button>
              <Button size="sm" busy={addShot.busy} onClick={() => void addShot.fire(scene.id)}>
                {tr("Add shot")}
              </Button>
              <Button size="sm" kind="quiet" onClick={() => void removeScene.fire(scene)} title={tr("Delete scene")}>
                {tr("Delete")}
              </Button>
            </div>
          </div>
          {scene.shots.length === 0 ? (
            <Empty title={tr("Empty scene")} />
          ) : (
            <div className="st-shots">
              {scene.shots.map((shot, i) => (
                <ShotCard
                  key={shot.id}
                  shot={shot}
                  index={i}
                  slate={`${view.scenes.indexOf(scene) + 1}·${i + 1}`}
                  lint={lintByShot.get(shotKey(scene.slug, i)) ?? []}
                  open={openId === shot.id}
                  onOpen={() => setOpenId(shot.id)}
                  onUp={i > 0 ? () => void reorder.fire(scene, i, i - 1) : undefined}
                  onDown={i < scene.shots.length - 1 ? () => void reorder.fire(scene, i, i + 1) : undefined}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      <div className="st-section st-row">
        <input className="st-input" style={{ maxWidth: 280 }} placeholder={tr("New scene slug, e.g. alley-chase")} value={newScene} onChange={(e) => setNewScene(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addScene.fire()} />
        <Button busy={addScene.busy} disabled={!newScene.trim()} onClick={() => void addScene.fire()}>
          {tr("Add scene")}
        </Button>
      </div>

      {open && <ShotDrawer key={open.id} shot={open} onClose={() => setOpenId(null)} />}
      {sketchOpen && (
        <Drawer
          title={tr("Sketch · colour-block storyboard")}
          onClose={() => setSketchOpen(false)}
          head={
            <span className="st-row">
              <Button size="sm" kind={sketchGray ? "default" : "quiet"} onClick={() => setSketchGray((g) => !g)} title={tr("Black and white: does the subject separate from the background by value alone?")}>{sketchGray ? tr("Colour") : tr("Grayscale")}</Button>
              <Button size="sm" kind="quiet" onClick={() => setSketchKey((k) => k + 1)}>{tr("Refresh")}</Button>
              <a className="st-link" href={`/api/projects/${projectId}/sketch${sketchGray ? "?gray=1" : ""}`} target="_blank" rel="noreferrer">{tr("Open")}</a>
            </span>
          }
        >
          <p className="st-muted">{tr("Drawn from the shotlist alone: subject size from the shot size, its place on the 38 % / 62 % guides, blocking arrows, the scene palette, and “dead frame” where nothing moves. Check the rhythm of sizes and the colour script before any frame is drawn.")}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={sketchKey} src={`/api/projects/${projectId}/sketch${sketchGray ? "?gray=1" : ""}${sketchGray ? "&" : "?"}v=${sketchKey}`} alt={tr("Colour-block storyboard")} style={{ width: "100%", height: "auto", borderRadius: 0 }} />
        </Drawer>
      )}
      {lintOpen && (
        <Drawer title={lint ? tr("Lint · {e} errors, {w} warnings, {i} notes", { e: lint.counts.error, w: lint.counts.warn, i: lint.counts.info }) : tr("Lint · …")} onClose={() => setLintOpen(false)}>
          {!lint ? (
            <span className="st-muted">{tr("Loading…")}</span>
          ) : lint.warnings.length === 0 ? (
            <Empty title={tr("Nothing to fix")} hint={tr("Rhythm, variety, breath, links and cinematography all pass.")} />
          ) : (
            <div className="st-lint">
              {lint.warnings.map((w, i) => {
                /* in Chinese: what the code means, and the server's own message beneath it */
                const line = lintLine(lang, w);
                return (
                  <div key={i} className="st-lint-row" data-severity={w.severity}>
                    <span className="st-lint-where">{w.scene ? `${w.scene}${w.shot ? ` #${w.shot}` : ""}` : tr("film")}</span>
                    <span>
                      <span className={w.severity === "error" ? "st-danger" : w.severity === "warn" ? "st-warn" : "st-muted"} style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginRight: 8 }}>{w.code}</span>
                      {line.text}
                      {line.detail && <span className="st-muted" style={{ display: "block" }}>{line.detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Drawer>
      )}
      {batchOpen && batch && (
        <Drawer title={tr("Render batch")} onClose={() => setBatchOpen(false)}>
          <div className="st-stack">
            <div className="st-card st-stack st-stack--tight">
              <div className="st-row st-row--between">
                <span className="st-h2">{plural(tr, batch.order.length, "1 shot to render", "{n} shots to render")} · {plural(tr, batch.passes.length, "1 pass", "{n} passes")}</span>
                <span className="st-num" style={{ color: batch.withinCap ? "var(--tx)" : "var(--danger)" }}>{tr("≈ {estimate} · {left} left", { estimate: usd(batch.totalEstimateUsd), left: usd(batch.remainingCapUsd) })}</span>
              </div>
              <span className="st-muted">{tr("R2VA shots first, then the fl2va family; linked shots wait for their anchors in the next pass. Estimates marked fallback come from the planner, the others from the compiler.")}</span>
              {batch.warnings.map((w, i) => <span key={i} className="st-warn">{w}</span>)}
            </div>
            {batch.probe && batch.probe.shotIds.length > 0 && (
              <div className="st-card st-row st-row--between">
                <span><strong>{tr("Probe first.")}</strong> <span className="st-muted">{batch.probe.why} · ≈ {usd(batch.probe.estimateUsd)}</span></span>
                <Button busy={renderPass.busy} onClick={() => void renderPass.fire(batch.probe!.shotIds)}>{tr("Render probe ({n})", { n: batch.probe.shotIds.length })} <span className="st-btn-price">· ≈ {usd(batch.probe.estimateUsd)}</span></Button>
              </div>
            )}
            {batch.passes.map((pass, pi) => (
              <div key={pi} className="st-card st-card--pad0">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>{tr("Pass {n}", { n: pi + 1 })}</th>
                      <th>{tr("Mode")}</th>
                      <th>{tr("Link")}</th>
                      <th title={tr("Weak spots of AI video found in the shot (fragile.* in Lint)")}>{tr("Fragile")}</th>
                      <th className="st-num">{tr("Est.")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pass.map((id) => {
                      const sh = batch.shots.find((x) => x.shotId === id);
                      const est = batch.estimates.find((x) => x.shotId === id);
                      return (
                        <tr key={id}>
                          <td>{sh?.label ?? id}</td>
                          <td className="st-num">{sh?.mode && tr(sh.mode)}</td>
                          <td className="st-num">{tr(sh?.link ?? "cut")}</td>
                          <td className="st-num" title={sh?.fragile?.join(", ")}>{sh?.fragility ? `${sh.fragility}${sh.tier === "careful" ? tr(" · careful") : ""}` : "—"}</td>
                          <td className="st-num">{est ? `${usd(est.usd)}${est.source === "fallback" ? " ~" : ""}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            {batch.deferred.length > 0 && <span className="st-muted">{tr("Waiting for an anchor: {list}", { list: batch.deferred.map((d) => d.shotId).join(", ") })}</span>}
            <div className="st-row st-row--between">
              <span className="st-muted">{tr("Rendering pass 1 queues one take per shot; come back for the next pass once anchors have takes.")}</span>
              <Button kind="tally" busy={renderPass.busy} disabled={!batch.passes[0]?.length} onClick={() => void renderPass.fire(batch.passes[0] ?? [])}>
                {tr("Render pass 1 ({n})", { n: batch.passes[0]?.length ?? 0 })} <span className="st-btn-price">· ≈ {usd((batch.passes[0] ?? []).reduce((n, id) => n + (batch.estimates.find((x) => x.shotId === id)?.usd ?? 0), 0))}</span>
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

/* The link type on the card, when it is anything but a plain cut. */
function linkLabel(spec: ShotView["spec"]): string | null {
  const type = spec.link?.type ?? (spec.linkToPrev === "continuous" ? "continuous" : "cut");
  if (type === "cut") return null;
  return EDIT_GRAMMAR.find((g) => g.type === type)?.label.toLowerCase() ?? type;
}

function ShotCard({ shot, index, slate, lint, open, onOpen, onUp, onDown }: { shot: ShotView; index: number; slate?: string; lint: LintWarning[]; open: boolean; onOpen: () => void; onUp?: () => void; onDown?: () => void }) {
  const tr = useT();
  const lang = useLang();
  const latest = shot.takes[0];
  const cost = shot.takes.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  const codes = cineCodes(shot.spec);
  const link = linkLabel(shot.spec);
  const problems = lint.filter((w) => w.severity !== "info").length;
  const { loras: library } = useLoraLibrary();
  const loraChips = shotLoraChips(shot.spec, library);
  return (
    <div className="st-shot" aria-pressed={open}>
      <button type="button" className="st-shot-media" onClick={onOpen} style={{ display: "block", width: "100%" }}>
        {(() => {
          /* Poster order: the selected take, else the newest completed take, else the hero frame. */
          const poster = shot.selectedTake?.thumbUrls[0] ?? shot.takes.find((t) => t.status === "completed" && t.thumbUrls[0])?.thumbUrls[0] ?? shot.hero?.url;
          return poster ? <img src={poster} alt="" /> : <div className="st-placeholder">{latest ? "" : tr("no take yet")}</div>;
        })()}
        <span className="st-shot-index">{slate ?? index + 1}</span>
        {latest && (
          <span className="st-shot-status">
            <Lamp state={latest.status} label={tr(statusLabel(latest.status))} />
          </span>
        )}
      </button>
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
        <div className="st-row" style={{ gap: 4 }}>
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!onUp} onClick={onUp} aria-label={tr("Move up")}>
            ↑
          </button>
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!onDown} onClick={onDown} aria-label={tr("Move down")}>
            ↓
          </button>
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
              <Button size="sm" kind="danger" busy={remove.busy} onClick={() => void remove.fire()}>{tr("Delete this shot")}</Button>
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
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await get<Compiled>(`/api/shots/${shotId}/compile${steps ? `?steps=${steps}` : ""}`));
      get<{ estimateBasis?: { gpuTypeId?: string } }>("/api/gpu/stats").then((r) => setBasisGpu(r.estimateBasis?.gpuTypeId ?? null)).catch(() => setBasisGpu(null));
    } catch (caught) {
      setError(caught);
      setData(null);
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
      {data && <pre className="st-pre">{data.prompt}</pre>}
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
  const active = take.status === "queued" || take.status === "running" || Boolean(upActive);
  const playUrl = up?.status === "completed" && up.url && show2k ? up.url : take.resultUrl;
  const selected = shot.selectedTakeId === take.id;
  /* another take was picked and nobody said what was wrong with this one */
  const passedOver = Boolean(shot.selectedTakeId) && !selected && take.status === "completed" && !take.review;
  return (
    <div className="st-take" data-selected={selected}>
      <div>
        {playUrl ? (
          <video className="st-video" src={playUrl} controls preload="metadata" poster={take.thumbUrls[0]} />
        ) : (
          <div className="st-video" style={{ display: "grid", placeItems: "center" }}>
            <Lamp state={take.status} label={tr(statusLabel(take.status))} />
          </div>
        )}
      </div>
      <div className="st-stack st-stack--tight">
        <div className="st-row st-row--between">
          <div className="st-row">
            <strong className="st-num">{tr("Take {n}", { n: take.n })}</strong>
            <Lamp state={take.status} label={tr(statusLabel(take.status))} />
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
                <select className="st-input st-input--sm" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)} style={{ width: 90 }}>
                  <option value="1080p">1080p</option>
                  <option value="2k">2K</option>
                  <option value="4k">4K</option>
                </select>
                <label className="st-row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={closeToDraft} onChange={(e) => setCloseToDraft(e.target.checked)} />
                  <span className="st-muted">{tr("stay close to the draft")}</span>
                </label>
                <Button size="sm" busy={regen.busy} onClick={() => void regen.fire()} title={tr("Open-H3-Regenerate-2K: three refine steps on the pod")}>{tr("Regenerate {res}", { res: resolution.toUpperCase() })}</Button>
                {up?.status === "failed" && <span className="st-danger">{up.error ?? tr("regeneration failed")}</span>}
              </>
            )}
          </div>
        )}
        {take.thumbUrls.length > 0 && (
          <div className="st-row" style={{ gap: 4 }}>
            {take.thumbUrls.map((u) => (
              <img key={u} src={u} alt="" style={{ width: 64, aspectRatio: "16 / 9", objectFit: "contain", background: "#000", borderRadius: 0 }} />
            ))}
          </div>
        )}
        <div className="st-row">
          <Stars value={score} onChange={setScore} />
          <input className="st-input st-input--sm" style={{ flex: 1, minWidth: 120 }} placeholder={tr("Review notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button size="sm" busy={review.busy} disabled={!score} onClick={() => void review.fire()}>
            {tr("Save review")}
          </Button>
        </div>
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
          <details open={passedOver || faults.length > 0}>
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
        {take.review && (
          <span className="st-muted">
            {tr("Reviewed {score}/5 by {by}", { score: take.review.score, by: tr(`${take.review.by}||reviewer`) })}
            {take.review.notes ? ` — ${take.review.notes}` : ""}
            {take.review.faults?.length ? ` · ${take.review.faults.map((f) => tr(f.replaceAll("_", " "))).join(", ")}` : ""}
            {take.review.audioOk === false ? tr(" · audio muted") : ""}
            {take.review.basis ? tr(" · basis: {basis}", { basis: take.review.basis }) : ""}
          </span>
        )}
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
