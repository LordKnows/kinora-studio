"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckIcon } from "./icons";
import type { SceneView, ShotView } from "@/studio/orchestrator";
import { TAKE_FAULTS, type ShotInput, type TakeFault } from "@/studio/schemas";
import type { Take } from "@/studio/types";
import { uploadMedia } from "./upload";
import { EditRegion, ImageButton, reviewChip } from "./image-tools";
import { RemakePanel } from "./remake-panel";
import { preferredViews } from "@/studio/compiler";

import { del, get, patch, post, put, usd } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, Lamp, Section, Stars, statusLabel, useAction, UploadButton } from "./common";
import { useProjectContext } from "./shell";
import { EDIT_GRAMMAR } from "@/studio/editing";

import { ShotEditor, validateDraft, type ShotDraft } from "./shot-editor";

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
  const { projectId, view, reload } = useProjectContext();
  const [openId, setOpenId] = useState<string | null>(null);
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
    setStyleNote(`Style “${style}” applied to every shot${r.warnings.length ? `; ${r.warnings.length} note(s) in Lint` : ""}. The shotlist is back in draft until you approve it.`);
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
    const raw = window.prompt(`Colour script for "${scene.slug}": hex colours darkest first, then | and a note. Empty clears it.\nExample: #1d2430 #3b4a5c #d9c7a3 #b23a2b | warm practicals against a cold window; red only on the scarf`, current);
    if (raw === null) return;
    const [cols, note] = raw.split("|");
    const colors = (cols ?? "").match(/#[0-9a-fA-F]{6}/g) ?? [];
    await put(`/api/scenes/${scene.id}/palette`, { palette: colors.length ? { colors: colors.slice(0, 6), ...(note?.trim() ? { note: note.trim() } : {}) } : null });
    await reload();
  });
  const removeScene = useAction(async (_c, scene: SceneView) => {
    if (!window.confirm(`Delete scene "${scene.slug}" and its ${scene.shots.length} shots?`)) return;
    await del(`/api/scenes/${scene.id}`);
    await reload();
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
          <h1 className="st-title">Board</h1>
          <p className="st-subtitle">
            Checkpoint 2. Structural edits return the shotlist to draft. {view.canGenerate ? "Ready to render." : `Blocked: ${view.blockers.join(", ")}.`}
          </p>
        </div>
        <div className="st-actions">
          <Lamp state={approved ? "ok" : "warn"} label={approved ? (view.delegated?.shotlist ? "Shotlist approved by the director" : "Shotlist approved") : "Shotlist draft"} />
          {shotCount > 0 && (
            <Button kind="quiet" onClick={() => setSketchOpen(true)} title="Colour-block storyboard from the shotlist: sizes, 38/62 composition, blocking, scene palettes">
              Sketch
            </Button>
          )}
          {shotCount > 0 && (
            <Button kind={lint && (lint.counts.error || lint.counts.warn) ? "default" : "quiet"} onClick={() => setLintOpen(true)} title="Rhythm and craft lint of the shotlist">
              Lint{lint ? ` · ${lint.counts.error + lint.counts.warn}` : ""}
            </Button>
          )}
          {shotCount > 0 && view.project.look.style && (
            <Button busy={applyStyle.busy} onClick={() => void applyStyle.fire()} title={`Fill every shot's cinematography from the style “${view.project.look.style}”`}>
              Apply style
            </Button>
          )}
          {!approved && (
            <Button kind="primary" busy={approve.busy} disabled={shotCount === 0} onClick={() => void approve.fire()}>
              Approve shotlist
            </Button>
          )}
          {approved && (
            <Button kind="primary" busy={plan.busy} onClick={() => void plan.fire()} title="Order the shots without a take: R2VA first, anchors before linked shots, one estimate">
              Render batch
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={error ?? applyStyle.error ?? plan.error ?? renderPass.error} projectId={projectId} onConfirm={renderPass.error ? () => void renderPass.confirm() : undefined} onDismiss={() => { approve.dismiss(); addScene.dismiss(); addShot.dismiss(); reorder.dismiss(); removeScene.dismiss(); editPalette.dismiss(); applyStyle.dismiss(); plan.dismiss(); renderPass.dismiss(); }} />
      {styleNote && (
        <div className="st-alert st-alert--info" style={{ marginBottom: 16 }}>
          <span>{styleNote}</span>
          <Button size="sm" kind="quiet" onClick={() => setStyleNote(null)}>Dismiss</Button>
        </div>
      )}

      {view.scenes.length === 0 && (
        <Empty title="No scenes yet" hint="Ask the director agent to save_shotlist, or add a scene below and build shots by hand." />
      )}

      {view.scenes.map((scene) => (
        <section key={scene.id} className="st-scene">
          <div className="st-scene-head">
            <div>
              <span className="st-scene-slug">{scene.index + 1}. {scene.slug}</span>
              {scene.summary && <span className="st-scene-summary"> · {scene.summary}</span>}
              {scene.palette && (
                <span className="st-row" style={{ display: "inline-flex", gap: 2, marginLeft: 8, verticalAlign: "middle" }} title={scene.palette.note ?? "scene palette"}>
                  {scene.palette.colors.map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 2, background: c, display: "inline-block" }} />)}
                </span>
              )}
            </div>
            <div className="st-row">
              <Button size="sm" kind="quiet" onClick={() => void editPalette.fire(scene)} title="This scene's colour script; it compiles into every shot">
                Palette
              </Button>
              <Button size="sm" busy={addShot.busy} onClick={() => void addShot.fire(scene.id)}>
                Add shot
              </Button>
              <Button size="sm" kind="quiet" onClick={() => void removeScene.fire(scene)} title="Delete scene">
                Delete
              </Button>
            </div>
          </div>
          {scene.shots.length === 0 ? (
            <Empty title="Empty scene" />
          ) : (
            <div className="st-shots">
              {scene.shots.map((shot, i) => (
                <ShotCard
                  key={shot.id}
                  shot={shot}
                  index={i}
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
        <input className="st-input" style={{ maxWidth: 280 }} placeholder="New scene slug, e.g. alley-chase" value={newScene} onChange={(e) => setNewScene(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addScene.fire()} />
        <Button busy={addScene.busy} disabled={!newScene.trim()} onClick={() => void addScene.fire()}>
          Add scene
        </Button>
      </div>

      {open && <ShotDrawer key={open.id} shot={open} onClose={() => setOpenId(null)} />}
      {sketchOpen && (
        <Drawer
          title="Sketch · colour-block storyboard"
          onClose={() => setSketchOpen(false)}
          head={
            <span className="st-row">
              <Button size="sm" kind={sketchGray ? "default" : "quiet"} onClick={() => setSketchGray((g) => !g)} title="Black and white: does the subject separate from the background by value alone?">{sketchGray ? "Colour" : "Grayscale"}</Button>
              <Button size="sm" kind="quiet" onClick={() => setSketchKey((k) => k + 1)}>Refresh</Button>
              <a className="st-link" href={`/api/projects/${projectId}/sketch${sketchGray ? "?gray=1" : ""}`} target="_blank" rel="noreferrer">Open</a>
            </span>
          }
        >
          <p className="st-muted">Drawn from the shotlist alone: subject size from the shot size, its place on the 38 % / 62 % guides, blocking arrows, the scene palette, and “dead frame” where nothing moves. Check the rhythm of sizes and the colour script before any frame is drawn.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={sketchKey} src={`/api/projects/${projectId}/sketch${sketchGray ? "?gray=1" : ""}${sketchGray ? "&" : "?"}v=${sketchKey}`} alt="Colour-block storyboard" style={{ width: "100%", height: "auto", borderRadius: 8 }} />
        </Drawer>
      )}
      {lintOpen && (
        <Drawer title={`Lint · ${lint ? `${lint.counts.error} errors, ${lint.counts.warn} warnings, ${lint.counts.info} notes` : "…"}`} onClose={() => setLintOpen(false)}>
          {!lint ? (
            <span className="st-muted">Loading…</span>
          ) : lint.warnings.length === 0 ? (
            <Empty title="Nothing to fix" hint="Rhythm, variety, breath, links and cinematography all pass." />
          ) : (
            <div className="st-lint">
              {lint.warnings.map((w, i) => (
                <div key={i} className="st-lint-row" data-severity={w.severity}>
                  <span className="st-lint-where">{w.scene ? `${w.scene}${w.shot ? ` #${w.shot}` : ""}` : "film"}</span>
                  <span>
                    <span className={w.severity === "error" ? "st-danger" : w.severity === "warn" ? "st-warn" : "st-muted"} style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginRight: 8 }}>{w.code}</span>
                    {w.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Drawer>
      )}
      {batchOpen && batch && (
        <Drawer title="Render batch" onClose={() => setBatchOpen(false)}>
          <div className="st-stack">
            <div className="st-card st-stack st-stack--tight">
              <div className="st-row st-row--between">
                <span className="st-h2">{batch.order.length} shot{batch.order.length === 1 ? "" : "s"} to render · {batch.passes.length} pass{batch.passes.length === 1 ? "" : "es"}</span>
                <span className="st-num" style={{ color: batch.withinCap ? "var(--tx)" : "var(--danger)" }}>≈ {usd(batch.totalEstimateUsd)} · {usd(batch.remainingCapUsd)} left</span>
              </div>
              <span className="st-muted">R2VA shots first, then the fl2va family; linked shots wait for their anchors in the next pass. Estimates marked fallback come from the planner, the others from the compiler.</span>
              {batch.warnings.map((w, i) => <span key={i} className="st-warn">{w}</span>)}
            </div>
            {batch.probe && batch.probe.shotIds.length > 0 && (
              <div className="st-card st-row st-row--between">
                <span><strong>Probe first.</strong> <span className="st-muted">{batch.probe.why} · ≈ {usd(batch.probe.estimateUsd)}</span></span>
                <Button busy={renderPass.busy} onClick={() => void renderPass.fire(batch.probe!.shotIds)}>Render probe ({batch.probe.shotIds.length})</Button>
              </div>
            )}
            {batch.passes.map((pass, pi) => (
              <div key={pi} className="st-card st-card--pad0">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>Pass {pi + 1}</th>
                      <th>Mode</th>
                      <th>Link</th>
                      <th title="Weak spots of AI video found in the shot (fragile.* in Lint)">Fragile</th>
                      <th className="st-num">Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pass.map((id) => {
                      const sh = batch.shots.find((x) => x.shotId === id);
                      const est = batch.estimates.find((x) => x.shotId === id);
                      return (
                        <tr key={id}>
                          <td>{sh?.label ?? id}</td>
                          <td className="st-num">{sh?.mode}</td>
                          <td className="st-num">{sh?.link ?? "cut"}</td>
                          <td className="st-num" title={sh?.fragile?.join(", ")}>{sh?.fragility ? `${sh.fragility}${sh.tier === "careful" ? " · careful" : ""}` : "—"}</td>
                          <td className="st-num">{est ? `${usd(est.usd)}${est.source === "fallback" ? " ~" : ""}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
            {batch.deferred.length > 0 && <span className="st-muted">Waiting for an anchor: {batch.deferred.map((d) => d.shotId).join(", ")}</span>}
            <div className="st-row st-row--between">
              <span className="st-muted">Rendering pass 1 queues one take per shot; come back for the next pass once anchors have takes.</span>
              <Button kind="primary" busy={renderPass.busy} disabled={!batch.passes[0]?.length} onClick={() => void renderPass.fire(batch.passes[0] ?? [])}>
                Render pass 1 ({batch.passes[0]?.length ?? 0})
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

function ShotCard({ shot, index, lint, open, onOpen, onUp, onDown }: { shot: ShotView; index: number; lint: LintWarning[]; open: boolean; onOpen: () => void; onUp?: () => void; onDown?: () => void }) {
  const latest = shot.takes[0];
  const cost = shot.takes.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  const codes = cineCodes(shot.spec);
  const problems = lint.filter((w) => w.severity !== "info").length;
  return (
    <div className="st-shot" aria-pressed={open}>
      <button type="button" className="st-shot-media" onClick={onOpen} style={{ display: "block", width: "100%" }}>
        {(() => {
          /* Poster order: the selected take, else the newest completed take, else the hero frame. */
          const poster = shot.selectedTake?.thumbUrls[0] ?? shot.takes.find((t) => t.status === "completed" && t.thumbUrls[0])?.thumbUrls[0] ?? shot.hero?.url;
          return poster ? <img src={poster} alt="" /> : <div className="st-placeholder">{latest ? "" : "no take yet"}</div>;
        })()}
        <span className="st-shot-index">{index + 1}</span>
        {latest && (
          <span className="st-shot-status">
            <Lamp state={latest.status} label={statusLabel(latest.status)} />
          </span>
        )}
      </button>
      <div className="st-shot-body">
        <div className="st-shot-tags">
          {codes.length ? codes.map((c) => <span key={c} className="st-chip st-chip--mono">{c}</span>) : <span className="st-chip st-chip--mono st-chip--warn">no cinematography</span>}
          {linkLabel(shot.spec) && <span className="st-chip st-chip--mono" aria-pressed="true">{linkLabel(shot.spec)}</span>}
          {problems > 0 && <span className="st-chip st-chip--mono st-chip--warn" title={lint.map((w) => w.message).join("\n")}>⚠ {problems}</span>}
        </div>
        <button type="button" className="st-shot-intent" onClick={onOpen} style={{ textAlign: "left" }}>
          {shot.spec.intent || "Untitled shot"}
        </button>
        <div className="st-shot-facts">
          {shot.spec.durationS} s · {shot.spec.mode} · {shot.spec.camera.move.replace("_", " ")}
          {shot.takes.length > 0 && ` · ${shot.takes.length} take${shot.takes.length === 1 ? "" : "s"} · ${usd(cost)}`}
        </div>
        <div className="st-row" style={{ gap: 4 }}>
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!onUp} onClick={onUp} aria-label="Move up">
            ↑
          </button>
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!onDown} onClick={onDown} aria-label="Move down">
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
  input?: { loras?: Array<{ name: string; strength: number; kind: string }> };
};

function ShotDrawer({ shot, onClose }: { shot: ShotView; onClose: () => void }) {
  const { projectId, view, reload } = useProjectContext();
  const [tab, setTab] = useState<"edit" | "compile" | "frames" | "takes">(shot.takes.length ? "takes" : "edit");
  const [draft, setDraft] = useState<ShotDraft>({ ...shot.spec, promptOverride: shot.promptOverride ?? shot.spec.promptOverride });
  const [dirty, setDirty] = useState(false);
  const problems = useMemo(() => validateDraft(draft), [draft]);

  const save = useAction(async () => {
    await patch(`/api/shots/${shot.id}`, { ...draft, promptOverride: draft.promptOverride ?? null });
    setDirty(false);
    await reload();
  });
  const remove = useAction(async () => {
    if (!window.confirm("Delete this shot?")) return;
    await del(`/api/shots/${shot.id}`);
    onClose();
    await reload();
  });

  const elements = view?.elements ?? [];

  return (
    <Drawer
      title={`Shot ${shot.index + 1} · ${shot.spec.intent || "untitled"}`}
      onClose={onClose}
      head={
        <>
          <Button size="sm" kind="danger" busy={remove.busy} onClick={() => void remove.fire()}>
            Delete
          </Button>
          <Button size="sm" kind="primary" busy={save.busy} disabled={!dirty || problems.length > 0} onClick={() => void save.fire()}>
            Save
          </Button>
        </>
      }
    >
      <div className="st-stack">
        <div className="st-tabs" role="tablist">
          {(["edit", "compile", "frames", "takes"] as const).map((t) => (
            <button key={t} type="button" role="tab" className="st-tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "edit" ? "Edit" : t === "compile" ? "Compile" : t === "frames" ? "Frames" : `Takes${shot.takes.length ? ` (${shot.takes.length})` : ""}`}
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
          <span>Unsaved edits are not reflected here. Save first.</span>
        </div>
      )}
      <div className="st-row st-row--between">
        <Field label="Steps" hint="empty = auto: the speed LoRA's count, or 20 on the base chain">
          <input className="st-input st-input--sm" type="number" min={4} max={50} placeholder="auto" value={steps ?? ""} onChange={(e) => setSteps(e.target.value ? Number(e.target.value) : null)} style={{ width: 90 }} />
        </Field>
        {data && (
          <dl className="st-kv">
            <dt>Workflow</dt>
            <dd>{data.workflow}</dd>
            <dt>Estimate</dt>
            <dd>
              {usd(data.estimate.usd)} · {Math.round(data.estimate.gpuSeconds)} GPU s
              <span className="st-muted"> · {data.estimate.source === "measured" ? `measured on ${basisGpu ?? "your GPU"}` : "placeholder constants"}</span>
            </dd>
            <dt>Steps</dt>
            <dd className="st-num">{data.estimate.steps}</dd>
            {data.input?.loras?.length ? (
              <>
                <dt>LoRAs</dt>
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

function FramesPanel({ shot }: { shot: ShotView }) {
  const { projectId, view, reload } = useProjectContext();
  const pickHero = useAction(async (_confirm, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/hero-frame`, { assetId });
    await reload();
  });
  const pickEnd = useAction(async (_confirm, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/end-frame`, { assetId });
    await reload();
  });

  const derive = useAction(async () => {
    if (!shot.hero) return;
    const x = shot.spec.composition?.subjectX === "left" ? 0.38 : shot.spec.composition?.subjectX === "right" ? 0.62 : 0.5;
    const file = await cropForPushIn(shot.hero.url, 1.2, x);
    const { assetId } = await uploadMedia(file, projectId);
    await post(`/api/shots/${shot.id}/end-frame`, { assetId });
    await reload();
  });

  /* The Studio has no image model: hero and end frames are uploads, images
     the director imports (import_image), or last frames of finished takes. */
  const images = (view?.assets ?? []).filter((a) => a.kind === "image");

  const grid = (picked: string | undefined, onPick: (id: string) => void) => (
    <div className="st-thumbs">
      {images.slice(0, 48).map((a) => (
        <button key={a.id} type="button" className="st-thumb" aria-pressed={picked === a.id} onClick={() => onPick(a.id)}>
          <img src={a.url} alt="" />
          {picked === a.id && (
            <span className="st-thumb-check">
              <CheckIcon size={11} />
            </span>
          )}
          {a.source === "frame-extract" && <span className="st-thumb-tag">LAST FRAME</span>}
        </button>
      ))}
      {images.length === 0 && <span className="st-muted">No images in this project yet. Upload one, generate it with GPT Image below, or finish a take to get its last frame.</span>}
    </div>
  );

  return (
    <div className="st-stack">
      <ErrorBanner error={pickHero.error ?? pickEnd.error} projectId={projectId} onDismiss={() => { pickHero.dismiss(); pickEnd.dismiss(); }} />
      <Section
        title="Hero frame"
        aside={
          <span className="st-row">
            {shot.heroAssetId && <Button size="sm" kind="quiet" onClick={() => void pickHero.fire(null)}>Clear</Button>}
            <UploadButton accept="image/jpeg,image/png,image/webp" projectId={projectId} label="Upload hero frame" onUploaded={({ assetId }) => pickHero.fire(assetId)} />
          </span>
        }
      >
        {grid(shot.heroAssetId, (id) => void pickHero.fire(shot.heroAssetId === id ? null : id))}
      </Section>
      <Section
        title="End frame (keyframe mode, optional)"
        aside={
          <span className="st-row">
            {shot.hero && (
              <Button size="sm" kind="quiet" busy={derive.busy} onClick={() => void derive.fire()} title="Crop the hero frame toward the subject and scale it back up: the end frame of a push-in, so FL2VA has to push">
                Derive end frame (push-in)
              </Button>
            )}
            {shot.endAssetId && <Button size="sm" kind="quiet" onClick={() => void pickEnd.fire(null)}>Clear</Button>}
          </span>
        }
      >
        <ErrorBanner error={derive.error} projectId={projectId} onDismiss={derive.dismiss} />
        {grid(shot.endAssetId, (id) => void pickEnd.fire(shot.endAssetId === id ? null : id))}
      </Section>
      <FramePlanTools shot={shot} />
      {shot.hero && shot.end && <FrameCheck first={shot.hero.url} last={shot.end.url} />}
      {shot.hero && <PhoneCheck url={shot.hero.url} />}
    </div>
  );
}

type PlanRow = { shotId: string; first: string | null; last: string | null; why: string; have: { first: boolean; last: boolean } };
const METHOD_LABEL: Record<string, string> = {
  none: "nothing to draw", sheets: "uses the element sheets (below)", anchor: "the anchor take's last frame", edit_anchor: "edit the anchor's last frame",
  new: "draw new", edit_from_last: "edit from the last frame", edit_from_previous: "edit the earlier shot's frame", crop_from_first: "crop the first frame", crop_from_last: "crop the last frame",
};

/* GPT Image for this shot's frames, by the plan (cheapest first). */
function FramePlanTools({ shot }: { shot: ShotView }) {
  const { projectId } = useProjectContext();
  const [row, setRow] = useState<PlanRow | null>(null);
  const [editing, setEditing] = useState<"first" | "last" | null>(null);
  useEffect(() => {
    void get<{ shots: PlanRow[] }>(`/api/projects/${projectId}/frame-plan`).then((p) => setRow(p.shots.find((r) => r.shotId === shot.id) ?? null)).catch(() => setRow(null));
  }, [projectId, shot.id, shot.heroAssetId, shot.endAssetId]);
  const drawable = (m: string | null) => !!m && !["none", "sheets", "anchor"].includes(m);
  const paints = (m: string | null) => !!m && !m.startsWith("crop");
  return (
    <Section title="Frames with GPT Image">
      <div className="st-stack st-stack--tight">
        {row ? <span className="st-muted">{row.why}</span> : <span className="st-muted">Loading the plan…</span>}
        {row && (["first", "last"] as const).map((which) => {
          const m = which === "first" ? row.first : row.last;
          if (!m) return null;
          const asset = which === "first" ? shot.hero : shot.end;
          return (
            <div key={which} className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
              <span>
                <strong>{which === "first" ? "First" : "Last"} frame</strong> · {METHOD_LABEL[m] ?? m}
                {asset && reviewChip(asset) ? <span className="st-chip" style={{ marginLeft: 6 }}>{reviewChip(asset)}</span> : null}
              </span>
              <span className="st-row" style={{ gap: 6 }}>
                {drawable(m) && <ImageButton label={asset ? "Redraw" : "Generate"} paint={paints(m)} body={{ action: "shot_frame", shotId: shot.id, which }} />}
                {asset && <Button size="sm" kind="quiet" onClick={() => setEditing(editing === which ? null : which)}>Edit a region</Button>}
              </span>
            </div>
          );
        })}
        {row?.first === "sheets" && <SheetNeeds shot={shot} />}
        {editing && (editing === "first" ? shot.hero : shot.end) && (
          <EditRegion asset={(editing === "first" ? shot.hero : shot.end)!} attach={editing === "first" ? { heroOf: shot.id } : { endOf: shot.id }} onClose={() => setEditing(null)} />
        )}
      </div>
    </Section>
  );
}

/* A reference-mode shot reads the element sheets: show which ones this shot
   still lacks (no picture yet, or not the view its angle wants), with a
   button for each, and the optional reference frame. */
function SheetNeeds({ shot }: { shot: ShotView }) {
  const { view } = useProjectContext();
  const scene = view?.scenes.find((s) => s.id === shot.sceneId);
  const ids = [...new Set([...shot.spec.characters, ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : scene?.locationElementId ? [scene.locationElementId] : [])])];
  const wanted = preferredViews(shot.spec)[0]!;
  const rows = ids.map((id) => view?.elements.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className="st-stack st-stack--tight" style={{ marginTop: 6 }}>
      {rows.length === 0 && <span className="st-muted">No characters, props or location on this shot yet: add them in the Edit tab so R2VA has references to read.</span>}
      {rows.map((el) => {
        const views = Object.values(el.refViews ?? {});
        const isChar = el.kind === "character";
        const has = el.refAssetIds.length > 0;
        const needsView = isChar && has && !views.includes(wanted);
        return (
          <div key={el.id} className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
            <span>
              <strong>{el.name}</strong> <span className="st-muted">({el.kind})</span> ·{" "}
              {!has ? "no sheet yet" : needsView ? `has ${views.join(", ") || "an untagged picture"}; this shot's angle wants the ${wanted.replace("_", " ")} view` : `ready${views.length ? ` (${views.join(", ")})` : ""}`}
            </span>
            {!has && <ImageButton label={isChar ? "Generate sheet (front first)" : "Generate reference"} body={{ action: "element_sheet", elementId: el.id, views: ["front"] }} />}
            {needsView && <ImageButton label={`Add the ${wanted.replace("_", " ")} view`} body={{ action: "element_view", elementId: el.id, view: wanted }} />}
          </div>
        );
      })}
      <div className="st-row st-row--between" style={{ flexWrap: "wrap", marginTop: 4 }}>
        <span className="st-muted">Optional: a reference frame for this shot's composition and light. R2VA reads it as the first of its three reference pictures.</span>
        <ImageButton label={shot.hero ? "Redraw reference frame" : "Draw a reference frame"} body={{ action: "shot_frame", shotId: shot.id, which: "first", method: "new" }} />
      </div>
    </div>
  );
}

/* Overlay first and last frame: whatever should not change must cancel out
   to black in difference mode (a wall that changes colour fades in the
   video; a cup that grows, grows). */
function FrameCheck({ first, last }: { first: string; last: string }) {
  const [mode, setMode] = useState<"difference" | "onion">("difference");
  const [mix, setMix] = useState(50);
  return (
    <Section
      title="Frame check · first vs last"
      aside={
        <span className="st-row">
          <Button size="sm" kind={mode === "difference" ? "default" : "quiet"} onClick={() => setMode("difference")}>Difference</Button>
          <Button size="sm" kind={mode === "onion" ? "default" : "quiet"} onClick={() => setMode("onion")}>Onion skin</Button>
        </span>
      }
    >
      <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", background: "#000", borderRadius: 6, overflow: "hidden" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first} alt="first frame" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={last} alt="last frame" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", mixBlendMode: mode === "difference" ? "difference" : "normal", opacity: mode === "onion" ? mix / 100 : 1 }} />
      </div>
      {mode === "onion" && <input type="range" min={0} max={100} value={mix} onChange={(e) => setMix(Number(e.target.value))} style={{ width: "100%" }} aria-label="Last frame opacity" />}
      <p className="st-muted">{mode === "difference" ? "Black = identical. Anything bright outside the action will drift during the shot: walls, furniture, prop sizes, the horizon." : "Slide between the frames: camera position, scale and background must stay put."}</p>
    </Section>
  );
}

/* Phone-size preview: is every important person still readable? */
function PhoneCheck({ url }: { url: string }) {
  return (
    <Section title="Phone size">
      <div className="st-row" style={{ alignItems: "flex-end", gap: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="hero frame at phone width" style={{ width: 180, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 4 }} />
        <span className="st-muted">The hero frame at the width it plays in a feed. Faces and props that matter should still read here.</span>
      </div>
    </Section>
  );
}

/** Crop toward the composition point and scale back to the hero frame's size. */
async function cropForPushIn(url: string, zoom: number, subjectX: number): Promise<File> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cw = Math.round(W / zoom), ch = Math.round(H / zoom);
  const x = Math.round(Math.min(W - cw, Math.max(0, subjectX * W - cw / 2)));
  const y = Math.round(Math.min(H - ch, Math.max(0, H * 0.45 - ch / 2)));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, cw, ch, 0, 0, W, H);
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, "image/png");
    } catch {
      resolve(null);
    }
  });
  if (!blob) throw new Error("the image host does not allow the browser to read the frame (CORS); ask the director to run derive_end_frame instead");
  return new File([blob], `end-pushin-${zoom}.png`, { type: "image/png" });
}

function TakesPanel({ shot }: { shot: ShotView }) {
  const { projectId, reload } = useProjectContext();
  const [n, setN] = useState(1);
  const [steps, setSteps] = useState<number | null>(null);
  const generate = useAction(async (confirm) => {
    await post(`/api/shots/${shot.id}/takes`, { n, ...(steps ? { steps } : {}), confirm });
    await reload();
  });
  return (
    <div className="st-stack">
      <ErrorBanner error={generate.error} projectId={projectId} onConfirm={() => void generate.confirm()} onDismiss={generate.dismiss} />
      <div className="st-card st-row st-row--between">
        <div className="st-row">
          <Field label="Takes">
            <input className="st-input st-input--sm" type="number" min={1} max={4} value={n} onChange={(e) => setN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} style={{ width: 70 }} />
          </Field>
          <Field label="Steps">
            <input className="st-input st-input--sm" type="number" min={4} max={50} placeholder="auto" value={steps ?? ""} onChange={(e) => setSteps(e.target.value ? Math.max(4, Math.min(50, Number(e.target.value))) : null)} style={{ width: 70 }} />
          </Field>
        </div>
        <Button kind="primary" busy={generate.busy} onClick={() => void generate.fire()}>
          Generate take{n > 1 ? "s" : ""}
        </Button>
      </div>
      {shot.takes.length === 0 ? (
        <Empty title="No takes yet" hint="Steps follow the LoRA: 8 with a turbo LoRA, 20 on the base chain. Leave it empty unless you want to override." />
      ) : (
        shot.takes.map((take) => <TakeRow key={take.id} take={take} shot={shot} />)
      )}
    </div>
  );
}

function TakeRow({ take, shot }: { take: Take; shot: ShotView }) {
  const { projectId, reload } = useProjectContext();
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
  const [closeToDraft, setCloseToDraft] = useState(false);
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
  return (
    <div className="st-take" data-selected={selected}>
      <div>
        {playUrl ? (
          <video className="st-video" src={playUrl} controls preload="metadata" poster={take.thumbUrls[0]} />
        ) : (
          <div className="st-video" style={{ display: "grid", placeItems: "center" }}>
            <Lamp state={take.status} label={statusLabel(take.status)} />
          </div>
        )}
      </div>
      <div className="st-stack st-stack--tight">
        <div className="st-row st-row--between">
          <div className="st-row">
            <strong className="st-num">Take {take.n}</strong>
            <Lamp state={take.status} label={statusLabel(take.status)} />
            {selected && <span className="st-chip" aria-pressed="true">Selected</span>}
          </div>
          <span className="st-muted st-num">
            {take.workflow} · seed {take.seed ?? "—"} · {usd(take.costUsd)}
            {take.executionMs ? ` · ${Math.round(take.executionMs / 1000)}s` : ""}
          </span>
        </div>
        {active && <TakeProgressBar take={take} />}
        {take.error && (
          <div className="st-alert">
            <span>{take.error}</span>
          </div>
        )}
        <ErrorBanner error={review.error ?? select.error ?? cancel.error ?? retry.error ?? regen.error ?? cancelRegen.error} projectId={projectId} onConfirm={retry.error ? () => void retry.confirm() : regen.error ? () => void regen.confirm() : undefined} onDismiss={() => { review.dismiss(); select.dismiss(); cancel.dismiss(); retry.dismiss(); regen.dismiss(); cancelRegen.dismiss(); }} />
        {take.status === "completed" && (
          <div className="st-row" style={{ flexWrap: "wrap", gap: 8 }}>
            {up?.status === "completed" && up.url ? (
              <>
                <span className="st-chip" aria-pressed={show2k}>{up.resolution.toUpperCase()} ready{up.costUsd ? ` · ${usd(up.costUsd)}` : ""}</span>
                <Button kind="quiet" size="sm" onClick={() => setShow2k((v) => !v)}>{show2k ? "Show 768p" : `Show ${up.resolution.toUpperCase()}`}</Button>
              </>
            ) : upActive ? (
              <>
                <span className="st-muted st-num">Regenerate {up!.resolution.toUpperCase()}: {up!.status}{up!.progress?.stage ? ` · ${STAGE_LABEL[up!.progress.stage] ?? up!.progress.stage}` : ""}{up!.progress?.stage === "sampling" && up!.progress.total ? ` ${up!.progress.step ?? 0}/${up!.progress.total}` : ""}</span>
                <Button kind="quiet" size="sm" busy={cancelRegen.busy} onClick={() => void cancelRegen.fire()}>Cancel</Button>
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
                  <span className="st-muted">stay close to the draft</span>
                </label>
                <Button size="sm" busy={regen.busy} onClick={() => void regen.fire()} title="Open-H3-Regenerate-2K: three refine steps on the pod">Regenerate {resolution.toUpperCase()}</Button>
                {up?.status === "failed" && <span className="st-danger">{up.error ?? "regeneration failed"}</span>}
              </>
            )}
          </div>
        )}
        {take.thumbUrls.length > 0 && (
          <div className="st-row" style={{ gap: 4 }}>
            {take.thumbUrls.map((u) => (
              <img key={u} src={u} alt="" style={{ width: 64, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 4 }} />
            ))}
          </div>
        )}
        <div className="st-row">
          <Stars value={score} onChange={setScore} />
          <input className="st-input st-input--sm" style={{ flex: 1, minWidth: 120 }} placeholder="Review notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button size="sm" busy={review.busy} disabled={!score} onClick={() => void review.fire()}>
            Save review
          </Button>
        </div>
        {take.status === "completed" && (
          <details>
            <summary className="st-muted">What went wrong (feeds the retro){faults.length ? ` · ${faults.length}` : ""}</summary>
            <div className="st-chips" style={{ marginTop: 6 }}>
              {TAKE_FAULTS.map((f) => (
                <button key={f} type="button" className="st-chip" aria-pressed={faults.includes(f)} onClick={() => setFaults((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))}>
                  {f.replaceAll("_", " ")}
                </button>
              ))}
            </div>
            <label className="st-row" style={{ gap: 6, marginTop: 6 }}>
              <input type="checkbox" checked={audioOk === false} onChange={(e) => setAudioOk(e.target.checked ? false : true)} />
              <span className="st-muted">Sound unusable — mute this take's own audio on the timeline</span>
            </label>
          </details>
        )}
        {take.review && (
          <span className="st-muted">
            Reviewed {take.review.score}/5 by {take.review.by}
            {take.review.notes ? ` — ${take.review.notes}` : ""}
            {take.review.faults?.length ? ` · ${take.review.faults.join(", ").replaceAll("_", " ")}` : ""}
            {take.review.audioOk === false ? " · audio muted" : ""}
            {take.review.basis ? ` · basis: ${take.review.basis}` : ""}
          </span>
        )}
        {take.workflow === "REMAKE" && typeof take.input.studio_remake === "object" && take.input.studio_remake ? (
          <span className="st-muted">Remake ({String((take.input.studio_remake as { mode?: string }).mode)}) of take #{String((take.input.studio_remake as { sourceN?: number }).sourceN ?? "?")}</span>
        ) : null}
        {remakeOpen && take.status === "completed" && <RemakePanel take={take} onClose={() => setRemakeOpen(false)} />}
        <div className="st-row">
          {take.status === "completed" && !remakeOpen && (
            <Button size="sm" kind="quiet" onClick={() => setRemakeOpen(true)} title="Viggle Remake: fix props, wardrobe, a face or the background from painted frames, keeping the motion">
              Fix with Remake
            </Button>
          )}
          {take.status === "completed" && !selected && (
            <Button size="sm" kind="primary" busy={select.busy} onClick={() => void select.fire()}>
              Use this take
            </Button>
          )}
          {active && (
            <Button size="sm" kind="quiet" busy={cancel.busy} onClick={() => void cancel.fire()}>
              Cancel
            </Button>
          )}
          {(take.status === "failed" || take.status === "timeout") && (
            <Button size="sm" busy={retry.busy} onClick={() => void retry.fire()}>
              Retry
            </Button>
          )}
          {take.resultUrl && (
            <a className="st-btn st-btn--quiet st-btn--sm" href={take.resultUrl} download target="_blank" rel="noreferrer">
              Download
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

function eta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/* Where a running take is: the pod reports stage and sampling step through
   /status. The SSE snapshot carries it, and while the take is active the row
   also asks /api/takes/:id itself every few seconds (that call refreshes the
   take from the pod), so the bar does not depend on the event stream. */
function TakeProgressBar({ take: fromView }: { take: Take }) {
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
  if (take.status === "queued" && !take.requestId) return <p className="st-muted">Waiting for the GPU pod</p>;
  if (!p) return <p className="st-muted">{take.status === "queued" ? "Queued on the pod" : "Running (no progress reported yet)"}</p>;
  const percent = p.stage === "sampling" ? (p.percent ?? 0) : p.stage === "decoding" ? 92 : p.stage === "finishing" || p.stage === "uploading" ? 97 : p.stage === "loading" ? 5 : 2;
  const detail = p.stage === "sampling" && p.total
    ? `step ${p.step ?? 0}/${p.total}${p.secondsPerStep ? ` · ${p.secondsPerStep} s/step` : ""}${p.etaSeconds !== undefined ? ` · ~${eta(p.etaSeconds)} left` : ""}`
    : "";
  return (
    <div className="st-stack st-stack--tight">
      <div className="st-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="st-progress__fill" style={{ width: `${percent}%` }} data-indeterminate={p.stage !== "sampling" ? "true" : undefined} />
      </div>
      <span className="st-muted st-num">{STAGE_LABEL[p.stage] ?? p.stage}{detail ? ` · ${detail}` : ""}{ageS !== undefined && ageS > 20 ? ` · updated ${ageS} s ago` : ""}</span>
    </div>
  );
}
