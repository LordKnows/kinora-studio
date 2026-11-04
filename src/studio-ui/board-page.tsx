"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckIcon } from "@/openhiggsfield/icons";
import type { SceneView, ShotView } from "@/studio/orchestrator";
import type { ShotInput } from "@/studio/schemas";
import type { Asset, Job, Take } from "@/studio/types";

import { del, get, patch, post, usd } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, Lamp, Section, Stars, statusLabel, useAction } from "./common";
import { useProjectContext } from "./shell";
import { ShotEditor, validateDraft, type ShotDraft } from "./shot-editor";

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
  const removeScene = useAction(async (_c, scene: SceneView) => {
    if (!window.confirm(`Delete scene "${scene.slug}" and its ${scene.shots.length} shots?`)) return;
    await del(`/api/scenes/${scene.id}`);
    await reload();
  });

  if (!view) return null;
  const open = view.scenes.flatMap((s) => s.shots).find((s) => s.id === openId) ?? null;
  const approved = view.project.shotlistApproval === "approved";
  const shotCount = view.scenes.reduce((n, s) => n + s.shots.length, 0);
  const error = approve.error ?? addScene.error ?? addShot.error ?? reorder.error ?? removeScene.error;

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
          <Lamp state={view.project.shotlistApproval} label={approved ? "Shotlist approved" : "Shotlist draft"} />
          {!approved && (
            <Button kind="primary" busy={approve.busy} disabled={shotCount === 0} onClick={() => void approve.fire()}>
              Approve shotlist
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={error} projectId={projectId} onDismiss={() => { approve.dismiss(); addScene.dismiss(); addShot.dismiss(); reorder.dismiss(); removeScene.dismiss(); }} />

      {view.scenes.length === 0 && (
        <Empty title="No scenes yet" hint="Ask the director agent to save_shotlist, or add a scene below and build shots by hand." />
      )}

      {view.scenes.map((scene) => (
        <section key={scene.id} className="st-scene">
          <div className="st-scene-head">
            <div>
              <span className="st-scene-slug">{scene.index + 1}. {scene.slug}</span>
              {scene.summary && <span className="st-scene-summary"> · {scene.summary}</span>}
            </div>
            <div className="st-row">
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
    </div>
  );
}

function ShotCard({ shot, index, open, onOpen, onUp, onDown }: { shot: ShotView; index: number; open: boolean; onOpen: () => void; onUp?: () => void; onDown?: () => void }) {
  const latest = shot.takes[0];
  const cost = shot.takes.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  return (
    <div className="st-shot" aria-pressed={open}>
      <button type="button" className="st-shot-media" onClick={onOpen} style={{ display: "block", width: "100%" }}>
        {shot.selectedTake?.thumbUrls[0] ? <img src={shot.selectedTake.thumbUrls[0]} alt="" /> : shot.hero ? <img src={shot.hero.url} alt="" /> : <div className="st-placeholder" />}
        <span className="st-shot-index">{index + 1}</span>
        {latest && (
          <span className="st-shot-status">
            <Lamp state={latest.status} label={statusLabel(latest.status)} />
          </span>
        )}
      </button>
      <div className="st-shot-body">
        <button type="button" className="st-shot-intent" onClick={onOpen} style={{ textAlign: "left" }}>
          {shot.spec.intent || "Untitled shot"}
        </button>
        <div className="st-shot-facts">
          {shot.spec.durationS}s · {shot.spec.mode} · {shot.spec.camera.move.replace("_", " ")}
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

type Compiled = { workflow: string; prompt: string; warnings: string[]; estimate: { usd: number; gpuSeconds: number; steps: number } };
type JobRow = Job & { assets: Asset[] };

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
  const [steps, setSteps] = useState(8);
  const [data, setData] = useState<Compiled | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await get<Compiled>(`/api/shots/${shotId}/compile?steps=${steps}`));
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
        <Field label="Steps">
          <input className="st-input st-input--sm" type="number" min={4} max={30} value={steps} onChange={(e) => setSteps(Number(e.target.value) || 8)} style={{ width: 90 }} />
        </Field>
        {data && (
          <dl className="st-kv">
            <dt>Workflow</dt>
            <dd>{data.workflow}</dd>
            <dt>Estimate</dt>
            <dd>
              {usd(data.estimate.usd)} · {Math.round(data.estimate.gpuSeconds)} GPU s
            </dd>
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
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const loadJobs = useCallback(async () => {
    const { jobs } = await get<{ jobs: JobRow[] }>(`/api/shots/${shot.id}/hero-frames`);
    setJobs(jobs);
  }, [shot.id]);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  const running = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void loadJobs(), 4000);
    return () => window.clearInterval(t);
  }, [running, loadJobs]);

  const generate = useAction(async (confirm) => {
    await post(`/api/shots/${shot.id}/hero-frames`, { n: 4, confirm });
    await loadJobs();
  });
  const pickHero = useAction(async (_c, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/hero-frame`, { assetId });
    await reload();
  });
  const pickEnd = useAction(async (_c, assetId: string | null) => {
    await post(`/api/shots/${shot.id}/end-frame`, { assetId });
    await reload();
  });

  const candidates = jobs.flatMap((j) => j.assets);
  const images = (view?.assets ?? []).filter((a) => a.kind === "image");
  const lastFrames = (view?.scenes ?? []).flatMap((s) => s.shots).flatMap((s) => s.takes).filter((t) => t.lastFrameUrl);

  return (
    <div className="st-stack">
      <ErrorBanner error={generate.error ?? pickHero.error ?? pickEnd.error} projectId={projectId} onConfirm={generate.error ? () => void generate.confirm() : undefined} onDismiss={() => { generate.dismiss(); pickHero.dismiss(); pickEnd.dismiss(); }} />
      <Section
        title="Hero frame"
        aside={
          <Button size="sm" busy={generate.busy || running} onClick={() => void generate.fire()}>
            {running ? "Generating…" : "Generate 4"}
          </Button>
        }
      >
        {candidates.length === 0 && !running ? (
          <Empty title="No candidates yet" hint="Generate stills from the shot and the Look, then pick the one the video starts from." />
        ) : (
          <div className="st-thumbs">
            {candidates.map((a) => (
              <button key={a.id} type="button" className="st-thumb" aria-pressed={shot.heroAssetId === a.id} onClick={() => void pickHero.fire(shot.heroAssetId === a.id ? null : a.id)}>
                <img src={a.url} alt="" />
                {shot.heroAssetId === a.id && (
                  <span className="st-thumb-check">
                    <CheckIcon size={11} />
                  </span>
                )}
              </button>
            ))}
            {running && <div className="st-skeleton" style={{ aspectRatio: "16 / 9" }} />}
          </div>
        )}
        {jobs.some((j) => j.status === "failed") && <Lamp state="failed" label={jobs.find((j) => j.status === "failed")?.error ?? "generation failed"} />}
      </Section>
      <Section title="Or pick any image in the project">
        <div className="st-thumbs">
          {images.slice(0, 24).map((a) => (
            <button key={a.id} type="button" className="st-thumb" aria-pressed={shot.heroAssetId === a.id} onClick={() => void pickHero.fire(a.id)}>
              <img src={a.url} alt="" />
              {a.source === "frame-extract" && <span className="st-thumb-tag">LAST FRAME</span>}
            </button>
          ))}
          {images.length === 0 && <span className="st-muted">No images in this project yet.</span>}
        </div>
      </Section>
      <Section title="End frame (keyframe mode, optional)" aside={shot.endAssetId ? <Button size="sm" kind="quiet" onClick={() => void pickEnd.fire(null)}>Clear</Button> : undefined}>
        <div className="st-thumbs">
          {[...candidates, ...images.filter((a) => !candidates.some((c) => c.id === a.id))].slice(0, 24).map((a) => (
            <button key={a.id} type="button" className="st-thumb" aria-pressed={shot.endAssetId === a.id} onClick={() => void pickEnd.fire(a.id)}>
              <img src={a.url} alt="" />
            </button>
          ))}
        </div>
        {lastFrames.length > 0 && <span className="st-muted">Last frames of finished takes are listed among the project images, tagged LAST FRAME.</span>}
      </Section>
    </div>
  );
}

function TakesPanel({ shot }: { shot: ShotView }) {
  const { projectId, reload } = useProjectContext();
  const [n, setN] = useState(1);
  const [steps, setSteps] = useState(8);
  const generate = useAction(async (confirm) => {
    await post(`/api/shots/${shot.id}/takes`, { n, steps, confirm });
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
            <input className="st-input st-input--sm" type="number" min={4} max={30} value={steps} onChange={(e) => setSteps(Math.max(4, Math.min(30, Number(e.target.value) || 8)))} style={{ width: 70 }} />
          </Field>
        </div>
        <Button kind="primary" busy={generate.busy} onClick={() => void generate.fire()}>
          Generate take{n > 1 ? "s" : ""}
        </Button>
      </div>
      {shot.takes.length === 0 ? (
        <Empty title="No takes yet" hint="Render at 8 steps first; raise steps once the shot works." />
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
  const review = useAction(async () => {
    if (!score) return;
    await post(`/api/takes/${take.id}/review`, { score, notes });
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
  const active = take.status === "queued" || take.status === "running";
  const selected = shot.selectedTakeId === take.id;
  return (
    <div className="st-take" data-selected={selected}>
      <div>
        {take.resultUrl ? (
          <video className="st-video" src={take.resultUrl} controls preload="metadata" poster={take.thumbUrls[0]} />
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
        {take.error && (
          <div className="st-alert">
            <span>{take.error}</span>
          </div>
        )}
        <ErrorBanner error={review.error ?? select.error ?? cancel.error ?? retry.error} projectId={projectId} onConfirm={retry.error ? () => void retry.confirm() : undefined} onDismiss={() => { review.dismiss(); select.dismiss(); cancel.dismiss(); retry.dismiss(); }} />
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
        {take.review && (
          <span className="st-muted">
            Reviewed {take.review.score}/5 by {take.review.by}
            {take.review.notes ? ` — ${take.review.notes}` : ""}
          </span>
        )}
        <div className="st-row">
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
