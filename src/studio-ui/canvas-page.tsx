"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { buildCanvasPrompt, CANVAS_MAX_REFS, CANVAS_MAX_REFS_ANY, CANVAS_SIZE_LABEL, CANVAS_SIZES, CANVAS_STYLES, type CanvasPromptRecipe } from "@/studio/canvas-prompt";
import { describeParams, findModel, IMAGE_MODELS, imageModelOfBackend, resolveParams, type ModelEntry, type Resolved } from "@/studio/models";
import type { ProjectView } from "@/studio/orchestrator";
import { COSTUME_SOURCES, POSE_ANGLES, referenceImage, type RefCostume, type RefItem, type RefKind, type RefPortrait, type RefPose } from "@/studio/references-model";
import { REF_VIEWS, type LoraRef, type RefView } from "@/studio/schemas";
import type { Asset, Job, Project } from "@/studio/types";

import { get, post, put } from "./api";
import { Button, Empty, ErrorBanner, Field, Lamp, Modal, Section } from "./common";
import { CanvasLibrary, loadReferences, type UseOptions } from "./canvas-library";
import { LoraPicker, useLoraLibrary } from "./lora-picker";
import { CloseIcon, UploadIcon } from "./icons";
import { uploadMedia } from "./upload";

/* Canvas: pick a portrait, a costume and a pose from the reference library
   (or upload your own), and GPT Image draws the character into a project —
   a picture with a handle, ready to go onto an element as its look. */

type Upload = { assetId: string; url: string; name: string };
type Slot<T> = { item: T; upload?: undefined } | { item?: undefined; upload: Upload };
type Recipe = {
  portrait?: Slot<RefPortrait>;
  costume?: Slot<RefCostume> & { view?: string };
  pose?: Slot<RefPose>;
  depth: boolean;
  /** The pose flipped left to right (the painter mirrors the picture). */
  mirror?: boolean;
  extras: Upload[];
  style: string;
  size: (typeof CANVAS_SIZES)[number];
  quality?: "low" | "medium" | "high";
  /** The image model (models.ts); unset = the project's GPT Image backend. */
  model?: string;
  /** Pod models: LoRAs from the library, trained for the model's family. */
  loras?: LoraRef[];
  /** Qwen-Image 3.0 Pro (API): let the vendor rewrite the prompt, and what the picture must not show. */
  promptExtend?: boolean;
  negative?: string;
  note: string;
  /** The prompt typed over the composed one. */
  prompt?: string;
};
type SlotKind = "portrait" | "costume" | "pose";
type Prefs = { projectId?: string; kind: RefKind; attach?: { elementId: string; view: RefView } };

const SLOT_LABEL: Record<SlotKind, string> = { portrait: "Portrait · 人像", costume: "Costume · 服装", pose: "Pose · 姿势" };
const RECIPE_KEY = "canvas.recipe.v1";
const PREFS_KEY = "canvas.prefs.v1";
const EMPTY: Recipe = { depth: false, extras: [], style: "realistic", size: "1024x1536", note: "" };

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

const slotName = (s?: Slot<RefItem>) => (s?.item ? (s.item.kind === "portrait" ? s.item.title : s.item.name) : s?.upload?.name ?? "");

function toPromptRecipe(r: Recipe, refStyle?: "zh" | "qwen"): CanvasPromptRecipe {
  return {
    portrait: r.portrait && (r.portrait.item ? { item: r.portrait.item } : { upload: { name: r.portrait.upload.name } }),
    costume: r.costume && (r.costume.item ? { item: r.costume.item } : { upload: { name: r.costume.upload.name } }),
    pose: r.pose && (r.pose.item ? { item: r.pose.item, depth: r.depth, mirror: !!r.mirror } : { upload: { name: r.pose.upload.name }, mirror: !!r.mirror }),
    extras: r.extras.map((e) => ({ name: e.name })),
    style: r.style,
    note: r.note,
    refStyle,
  };
}

type ModelStatus = { id: string; painters?: { ready: boolean; note?: string; drawers: string[] } };

type Settings = { adultContent: boolean };
type Started = { job: Job; runner: string; painters: { ready: boolean; note?: string }; prompt: string };

export function CanvasPage() {
  const [recipe, setRecipe] = useState<Recipe>(EMPTY);
  const [prefs, setPrefs] = useState<Prefs>({ kind: "portrait" });
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [adultVersion, setAdultVersion] = useState(0);
  const [ageGate, setAgeGate] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [view, setView] = useState<ProjectView | null>(null);
  const [jobs, setJobs] = useState<Record<string, { status: string; error?: string; runner?: string }>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string>("");
  const [result, setResult] = useState<Asset | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [modelStatus, setModelStatus] = useState<ModelStatus[]>([]);
  const [gpuStatus, setGpuStatus] = useState<{ status: string; configured: boolean } | null>(null);
  const loadModels = useCallback(async () => {
    try {
      const r = await get<{ models: ModelStatus[]; gpu: { status: string; configured: boolean } | null }>("/api/models?kind=image");
      setModelStatus(r.models);
      setGpuStatus(r.gpu);
    } catch {
      /* the picker still works; readiness is a hint */
    }
  }, []);
  useEffect(() => {
    void loadModels();
    const t = setInterval(() => void loadModels(), 20_000);
    return () => clearInterval(t);
  }, [loadModels]);

  /* ---------- load ---------- */
  useEffect(() => {
    setRecipe(readStore(RECIPE_KEY, EMPTY));
    setPrefs(readStore<Prefs>(PREFS_KEY, { kind: "portrait" }));
    setLoaded(true);
    get<Settings>("/api/me/settings").then(setSettings).catch(() => setSettings({ adultContent: false }));
    get<{ projects: Project[] }>("/api/projects").then((r) => setProjects(r.projects)).catch(setError);
  }, []);
  useEffect(() => {
    if (loaded) writeStore(RECIPE_KEY, recipe);
  }, [recipe, loaded]);
  useEffect(() => {
    if (loaded) writeStore(PREFS_KEY, prefs);
  }, [prefs, loaded]);
  useEffect(() => {
    if (!projects || !loaded) return;
    if (projects.length && !projects.some((p) => p.id === prefs.projectId)) setPrefs((p) => ({ ...p, projectId: projects[0]!.id, attach: undefined }));
  }, [projects, loaded, prefs.projectId]);

  const projectId = prefs.projectId && projects?.some((p) => p.id === prefs.projectId) ? prefs.projectId : undefined;
  const reload = useCallback(async () => {
    if (!projectId) return setView(null);
    try {
      setView(await get<ProjectView>(`/api/projects/${projectId}`));
    } catch (e) {
      setError(e);
    }
  }, [projectId]);

  const follow = useCallback((jobId: string) => {
    const tick = async () => {
      try {
        const { job } = await get<{ job: Job }>(`/api/jobs/${jobId}`);
        setJobs((m) => ({ ...m, [jobId]: { ...m[jobId], status: job.status, error: job.error } }));
        if (job.status === "completed" || job.status === "failed") {
          timers.current.delete(jobId);
          if (job.status === "completed") await reload();
          return;
        }
      } catch {
        /* keep polling */
      }
      timers.current.set(jobId, setTimeout(() => void tick(), 3000));
    };
    if (!timers.current.has(jobId)) void tick();
  }, [reload]);

  useEffect(() => {
    void reload();
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    setJobs({});
    if (!projectId) return;
    get<{ jobs: Job[] }>(`/api/projects/${projectId}/images`).then((r) => {
      for (const j of r.jobs) if ((j.status === "queued" || j.status === "running") && j.input.purpose === "canvas") {
        setJobs((m) => ({ ...m, [j.id]: { status: j.status } }));
        follow(j.id);
      }
    }).catch(() => undefined);
  }, [projectId, reload, follow]);
  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
  }, []);

  /* ---------- recipe ---------- */
  const adult = !!settings?.adultContent;
  const use = useCallback((item: RefItem, opts: UseOptions) => {
    setRecipe((r) => {
      if (item.kind === "portrait") return { ...r, portrait: r.portrait?.item?.id === item.id ? undefined : { item } };
      if (item.kind === "costume") return { ...r, costume: r.costume?.item?.id === item.id && !opts.view ? undefined : { item, view: opts.view } };
      return { ...r, pose: r.pose?.item?.id === item.id ? undefined : { item }, depth: opts.depth ?? r.depth };
    });
  }, []);
  const selected = { portrait: recipe.portrait?.item?.id, costume: recipe.costume?.item?.id, pose: recipe.pose?.item?.id };
  const count = [recipe.portrait, recipe.costume, recipe.pose].filter(Boolean).length + recipe.extras.length;
  const model: ModelEntry = findModel(recipe.model ?? "") ?? imageModelOfBackend(view?.project.imaging?.backend ?? "codex") ?? IMAGE_MODELS[0]!;
  const maxRefs = model.maxRefs ?? CANVAS_MAX_REFS;
  /* GPT Image's quality tiers; Qwen's API has none */
  const takesQuality = model.backend === "codex" || model.backend === "api";
  const { loras: library } = useLoraLibrary();
  /* only the LoRAs of this model's family travel with the recipe */
  const activeLoras = model.runtime === "pod" ? (recipe.loras ?? []).flatMap((r) => {
    const l = library?.find((x) => x.id === r.id && x.baseModel === model.family);
    return l ? [{ ...l, strength: r.strength ?? l.recommended.strength ?? l.defaultStrength }] : [];
  }) : [];
  const resolved = resolveParams(model, { loras: activeLoras });
  const adultLora = activeLoras.find((l) => l.adult);
  const anyUpload = !!(recipe.portrait?.upload || recipe.costume?.upload || recipe.pose?.upload || recipe.extras.length);
  const composed = useMemo(() => buildCanvasPrompt(toPromptRecipe(recipe, model.refStyle)), [recipe, model.refStyle]);
  const prompt = recipe.prompt ?? composed;
  const hiddenInRecipe = !adult && [recipe.portrait?.item, recipe.costume?.item, recipe.pose?.item].some((x) => x?.nsfw);
  const charadbOnUpload = recipe.costume?.item?.source === "charadb" && !!recipe.portrait?.upload;

  const randomize = async (slot: SlotKind, scope: "similar" | "any") => {
    const pool = (await loadReferences(slot, adultVersion)).items;
    const cur = recipe[slot]?.item;
    const candidates = pool.filter((x) => {
      if (x.id === cur?.id) return false;
      if (scope === "any" || !cur) return slot !== "costume" || (x as RefCostume).style === "real" || !!cur;
      if (x.kind === "portrait" && cur.kind === "portrait") return x.section === cur.section && x.hairLength === cur.hairLength;
      if (x.kind === "costume" && cur.kind === "costume") return x.source === cur.source && x.category === cur.category;
      if (x.kind === "pose" && cur.kind === "pose") return x.system === cur.system && x.category === cur.category && x.angle === cur.angle;
      return false;
    });
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (!pick) return;
    setRecipe((r) => ({ ...r, [slot]: { item: pick } }));
  };
  const randomizeAll = async () => {
    for (const s of ["portrait", "costume", "pose"] as const) await randomize(s, "any");
  };

  const uploadTo = async (file: File, target: SlotKind | "extra") => {
    if (!projectId) throw new Error("Pick a project first: uploads belong to a project");
    if (!file.type.startsWith("image/")) throw new Error("Pick an image file (PNG, JPEG or WebP)");
    setUploading(target);
    try {
      const { assetId, url } = await uploadMedia(file, projectId);
      const up: Upload = { assetId, url, name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "picture" };
      setRecipe((r) => (target === "extra" ? { ...r, extras: [...r.extras, up].slice(0, CANVAS_MAX_REFS_ANY) } : { ...r, [target]: { upload: up } }));
    } finally {
      setUploading("");
    }
  };
  const tryUpload = (file: File | undefined, target: SlotKind | "extra") => {
    if (!file) return;
    setError(null);
    uploadTo(file, target).catch(setError);
  };

  /* paste an image anywhere on the page → an extra picture */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      if (count >= maxRefs) return setError(new Error(`${model.label} takes at most ${maxRefs} pictures per call`));
      if (model.poseRecipe) return setError(new Error(`${model.label} takes no extra pictures: drop it on the portrait, costume or pose`));
      tryUpload(file, "extra");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  /* ---------- 18+ ---------- */
  const setAdult = async (on: boolean) => {
    const s = await put<Settings>("/api/me/settings", { adultContent: on, confirmAdult: on });
    setSettings(s);
    setAdultVersion((v) => v + 1);
  };

  /* ---------- generate ---------- */
  const generate = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        portrait: recipe.portrait && (recipe.portrait.item ? { id: recipe.portrait.item.id } : { assetId: recipe.portrait.upload.assetId }),
        costume: recipe.costume && (recipe.costume.item ? { id: recipe.costume.item.id, view: recipe.costume.view } : { assetId: recipe.costume.upload.assetId }),
        pose: recipe.pose && { ...(recipe.pose.item ? { id: recipe.pose.item.id, depth: recipe.depth } : { assetId: recipe.pose.upload.assetId }), ...(recipe.mirror ? { mirror: true } : {}) },
        extras: recipe.extras.map((e) => ({ assetId: e.assetId, name: e.name })),
        style: recipe.style,
        size: recipe.size,
        model: model.id,
        ...(activeLoras.length ? { loras: activeLoras.map((l) => ({ id: l.id, strength: l.strength })) } : {}),
        ...(recipe.quality && takesQuality ? { quality: recipe.quality } : {}),
        ...(model.options?.includes("prompt_extend") ? { promptExtend: !!recipe.promptExtend } : {}),
        ...(model.options?.includes("negative_prompt") && recipe.negative?.trim() ? { negativePrompt: recipe.negative.trim() } : {}),
        ...(recipe.note.trim() ? { note: recipe.note.trim() } : {}),
        ...(recipe.prompt?.trim() ? { prompt: recipe.prompt.trim() } : {}),
        ...(prefs.attach ? { attach: prefs.attach } : {}),
      };
      const r = await post<Started>(`/api/projects/${projectId}/canvas`, body);
      setJobs((m) => ({ ...m, [r.job.id]: { status: r.job.status, runner: r.painters.ready ? undefined : r.runner } }));
      follow(r.job.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const importOne = async (item: RefItem, opts: UseOptions): Promise<string> => {
    if (!projectId) throw new Error("Pick a project first");
    const { asset } = await post<{ asset: Asset }>(`/api/projects/${projectId}/canvas/import`, { id: item.id, depth: !!opts.depth, ...(opts.view ? { view: opts.view } : {}) });
    void reload();
    return `${asset.handle ?? "Picture"} added to the project's Pictures`;
  };

  const restore = async (asset: Asset) => {
    const c = asset.meta.canvas as { refs?: Array<{ role: string; refId?: string; assetId?: string; url: string; label: string }>; style?: string; size?: string; depth?: boolean; mirror?: boolean; costumeView?: string; note?: string; model?: string; promptExtend?: boolean; negativePrompt?: string } | undefined;
    if (!c?.refs) return;
    const next: Recipe = { ...EMPTY, style: c.style ?? "realistic", size: (CANVAS_SIZES as readonly string[]).includes(c.size ?? "") ? (c.size as Recipe["size"]) : "1024x1536", depth: !!c.depth, mirror: !!c.mirror, note: c.note ?? "", ...(c.model ? { model: c.model } : {}), ...(c.promptExtend ? { promptExtend: true } : {}), ...(c.negativePrompt ? { negative: c.negativePrompt } : {}) };
    for (const ref of c.refs) {
      const up: Upload | undefined = ref.assetId ? { assetId: ref.assetId, url: ref.url, name: ref.label } : undefined;
      let item: RefItem | undefined;
      if (ref.refId) item = await get<{ item: RefItem }>(`/api/references/${encodeURIComponent(ref.refId)}`).then((r) => r.item).catch(() => undefined);
      if (ref.role === "extra" && up) next.extras.push(up);
      else if (ref.role === "portrait") next.portrait = item?.kind === "portrait" ? { item } : up ? { upload: up } : undefined;
      else if (ref.role === "costume") next.costume = item?.kind === "costume" ? { item, view: c.costumeView } : up ? { upload: up } : undefined;
      else if (ref.role === "pose") next.pose = item?.kind === "pose" ? { item } : up ? { upload: up } : undefined;
    }
    setRecipe(next);
    setResult(null);
  };

  /* ---------- view ---------- */
  const project = view?.project.id === projectId ? view?.project : undefined;
  const imaging = project?.imaging;
  const uploadedFaceAdult = !!recipe.portrait?.upload && [recipe.costume?.item, recipe.pose?.item].some((x) => x?.nsfw);
  const imagingWhy = !project ? "Pick a project" : !imaging?.enabled ? "Pictures are off for this project (the GPT Image switch)" : imaging.stoppedReason ? `GPT Image stopped: ${imaging.stoppedReason}` : imaging.usedImages >= imaging.maxImages ? `Image quota used (${imaging.usedImages}/${imaging.maxImages})` : "";
  /* Qwen-Image-Edit 2509: fixed slots, a pose and a portrait and/or a costume */
  const poseRecipeWhy = !model.poseRecipe || count === 0 ? "" : !recipe.pose ? `${model.label} draws a pose: pick one` : !recipe.portrait && !recipe.costume ? `${model.label} needs a portrait or a costume next to the pose` : recipe.extras.length ? `${model.label} takes no extra pictures` : "";
  const blocked = imagingWhy || (count === 0 ? "Pick at least one reference" : poseRecipeWhy ? poseRecipeWhy : count > maxRefs ? `${model.label} takes at most ${maxRefs} pictures` : hiddenInRecipe ? "The recipe holds an 18+ reference; show 18+ or replace it" : charadbOnUpload ? "CharaDB outfits cannot go on an uploaded photo" : uploadedFaceAdult ? "18+ references cannot go on an uploaded face" : adultLora && !adult ? `${adultLora.name} is 18+: show 18+ first` : adultLora && anyUpload ? `${adultLora.name} draws with library pictures only` : "");
  const results = (view?.assets ?? []).filter((a) => a.kind === "image" && a.meta.purpose === "canvas").sort((a, b) => b.createdAt - a.createdAt);
  const pending = Object.entries(jobs).filter(([, j]) => j.status === "queued" || j.status === "running");
  const failed = Object.entries(jobs).filter(([, j]) => j.status === "failed");
  const characters = (view?.elements ?? []).filter((e) => e.projectId === projectId);

  return (
    <div className="st-page st-page--wide">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Canvas</h1>
          <p className="st-subtitle">Compose a character from a portrait, a costume and a pose — from the reference library or your own pictures. GPT Image, Qwen-Image 3.0 Pro (API), or Qwen-Image (2.1, or Edit 2509 — the pose gallery&apos;s own workflow) on the GPU pod, draws it into a project, ready to become an element&apos;s look.</p>
        </div>
        <div className="st-row">
          <button type="button" className="st-chip st-chip--btn" aria-pressed={adult} title={adult ? "18+ references are shown; click to hide them" : "18+ references are hidden"} onClick={() => (adult ? void setAdult(false).catch(setError) : setAgeGate(true))}>
            {adult ? "18+ shown" : "18+ hidden"}
          </button>
        </div>
      </div>
      <ErrorBanner error={error} projectId={projectId} onDismiss={() => setError(null)} />

      <div className="st-canvas">
        <aside className="st-canvas-recipe">
          <Section title="Project">
            {projects && projects.length === 0 ? (
              <Empty title="No project yet" hint="Canvas pictures belong to a project.">
                <Button kind="primary" onClick={async () => {
                  try {
                    const { project: p } = await post<{ project: Project }>("/api/projects", { name: "Canvas" });
                    setProjects([p]);
                    setPrefs((x) => ({ ...x, projectId: p.id }));
                  } catch (e) {
                    setError(e);
                  }
                }}>Create a Canvas project</Button>
              </Empty>
            ) : (
              <div className="st-stack" style={{ gap: 10 }}>
                <select className="st-select" value={projectId ?? ""} onChange={(e) => setPrefs((p) => ({ ...p, projectId: e.target.value, attach: undefined }))} aria-label="Project">
                  {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {project && (
                  imaging?.enabled ? (
                    <span className="st-muted st-num">GPT Image · {imaging.backend} · {imaging.usedImages}/{imaging.maxImages} used · {imaging.quality}{imaging.stoppedReason ? ` · stopped: ${imaging.stoppedReason}` : ""}</span>
                  ) : (
                    <div className="st-alert st-alert--warn">
                      <span>GPT Image is off for this project. Pictures are drawn by a painter with Codex on your ChatGPT plan (up to 100, change it in Project settings).</span>
                      <Button size="sm" onClick={async () => {
                        try {
                          await put(`/api/projects/${projectId}/imaging`, { enabled: true });
                          await reload();
                        } catch (e) {
                          setError(e);
                        }
                      }}>Turn on</Button>
                    </div>
                  )
                )}
                <div className="st-row" style={{ flexWrap: "nowrap" }}>
                  <select className="st-select" value={prefs.attach?.elementId ?? ""} aria-label="Attach to element" onChange={(e) => setPrefs((p) => ({ ...p, attach: e.target.value ? { elementId: e.target.value, view: p.attach?.view ?? "full_body" } : undefined }))}>
                    <option value="">Keep in Pictures only</option>
                    {characters.map((el) => <option key={el.id} value={el.id}>Put on {el.name} ({el.kind})</option>)}
                  </select>
                  {prefs.attach && (
                    <select className="st-select" style={{ width: 150 }} value={prefs.attach.view} aria-label="As view" onChange={(e) => setPrefs((p) => ({ ...p, attach: p.attach && { ...p.attach, view: e.target.value as RefView } }))}>
                      {REF_VIEWS.map((v) => <option key={v} value={v}>{v.replace("_", " ")}</option>)}
                    </select>
                  )}
                </div>
              </div>
            )}
          </Section>

          <Section title="Recipe" aside={<span className="st-row" style={{ gap: 6 }}><span className="st-muted st-num">{count}/{maxRefs} pictures</span><Button size="sm" kind="quiet" onClick={() => void randomizeAll()}>Random</Button><Button size="sm" kind="quiet" onClick={() => setRecipe((r) => ({ ...EMPTY, style: r.style, size: r.size, quality: r.quality }))}>Clear</Button></span>}>
            <div className="st-slots">
              {(["portrait", "costume", "pose"] as const).map((k) => (
                <SlotCard key={k} kind={k} recipe={recipe} adult={adult} uploading={uploading === k} canUpload={!!projectId}
                  onBrowse={() => {
                    setPrefs((p) => ({ ...p, kind: k }));
                    if (window.innerWidth < 1100) document.getElementById("canvas-library")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  onClear={() => setRecipe((r) => ({ ...r, [k]: undefined }))}
                  onRandom={(scope) => void randomize(k, scope).catch(setError)}
                  onUpload={(f) => tryUpload(f, k)}
                  onDepth={(d) => setRecipe((r) => ({ ...r, depth: d }))}
                  onMirror={(m) => setRecipe((r) => ({ ...r, mirror: m }))}
                  onView={(v) => setRecipe((r) => (r.costume?.item ? { ...r, costume: { ...r.costume, view: v } } : r))} />
              ))}
            </div>
            {model.poseRecipe && <p className="st-muted">{model.label} draws a pose with a portrait and/or a costume: portrait + costume + pose, or one of them + pose. No extra pictures.</p>}
            <Extras recipe={recipe} canAdd={!!projectId && count < maxRefs && !model.poseRecipe} uploading={uploading === "extra"}
              onAdd={(f) => tryUpload(f, "extra")}
              onRemove={(i) => setRecipe((r) => ({ ...r, extras: r.extras.filter((_, j) => j !== i) }))}
              onRename={(i, name) => setRecipe((r) => ({ ...r, extras: r.extras.map((e, j) => (j === i ? { ...e, name } : e)) }))} />
            {charadbOnUpload && <p className="st-danger">CharaDB outfits cannot go on an uploaded photo: its author forbids depicting real people. Use a library portrait or another costume source.</p>}
            {hiddenInRecipe && <p className="st-warn">The recipe holds an 18+ reference that is hidden now: show 18+ or replace it.</p>}
            {uploadedFaceAdult && <p className="st-danger">18+ references cannot be combined with an uploaded face: it may be a real person. Use a library portrait (AI-generated adults).</p>}
            {adultLora && anyUpload && <p className="st-danger">{adultLora.name} draws with library pictures only (AI-generated adults): remove the uploaded pictures — an upload may be a real person.</p>}
          </Section>

          <Section title="Picture">
            <ModelPicker model={model} status={modelStatus.find((m) => m.id === model.id)} gpu={gpuStatus} resolved={resolved}
              loras={model.runtime === "pod" && library?.some((l) => l.baseModel === model.family) ? (
                <Field label="LoRAs" hint="Picking one applies its card's settings">
                  <LoraPicker compact family={model.family} adult={adult} value={(recipe.loras ?? []).filter((r) => library?.find((l) => l.id === r.id)?.baseModel === model.family)} onChange={(next) => setRecipe((r) => ({ ...r, loras: next }))} />
                </Field>
              ) : null}
              onModel={(id) => setRecipe((r) => ({ ...r, model: id }))}
              onStartGpu={async () => {
                try {
                  await post("/api/gpu/start", { confirm: true });
                  await loadModels();
                } catch (e) {
                  setError(e);
                }
              }} />
            <Field label="Style">
              <select className="st-select" value={recipe.style} onChange={(e) => setRecipe((r) => ({ ...r, style: e.target.value }))}>
                {CANVAS_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.zh}</option>)}
              </select>
            </Field>
            <div className="st-fields st-canvas-fields">
              <Field label="Size" hint={model.canvasSize ? `${model.label}: follows the pose picture` : undefined}>
                <select className="st-select" value={model.canvasSize ?? recipe.size} disabled={!!model.canvasSize} onChange={(e) => setRecipe((r) => ({ ...r, size: e.target.value as Recipe["size"] }))}>
                  {CANVAS_SIZES.map((s) => <option key={s} value={s}>{CANVAS_SIZE_LABEL[s]} · {s}</option>)}
                </select>
              </Field>
              {takesQuality && (
                <Field label="Quality">
                  <select className="st-select" value={recipe.quality ?? ""} onChange={(e) => setRecipe((r) => ({ ...r, quality: (e.target.value || undefined) as Recipe["quality"] }))}>
                    <option value="">Project default{imaging ? ` (${imaging.quality})` : ""}</option>
                    <option value="low">Low · draft</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
              )}
            </div>
            {model.options?.includes("prompt_extend") && (
              <label className="st-toggle" title="prompt_extend: the vendor rewrites the prompt before drawing (the pose gallery turns it on; off keeps the 图1/图2/图3 roles exactly as composed)">
                <input type="checkbox" checked={!!recipe.promptExtend} onChange={(e) => setRecipe((r) => ({ ...r, promptExtend: e.target.checked }))} /> 智能改写 · let Qwen rewrite the prompt
              </label>
            )}
            {model.options?.includes("negative_prompt") && (
              <Field label="Negative prompt" hint="What the picture must not show, e.g. 多余的手指, 文字水印">
                <input className="st-input" maxLength={500} value={recipe.negative ?? ""} onChange={(e) => setRecipe((r) => ({ ...r, negative: e.target.value }))} />
              </Field>
            )}
            <Field label="Note" hint="Added to the prompt, e.g. 教室窗边逆光，微风吹拂发丝">
              <textarea className="st-textarea" rows={2} maxLength={600} value={recipe.note} onChange={(e) => setRecipe((r) => ({ ...r, note: e.target.value }))} />
            </Field>
            <div className="st-stack st-stack--tight">
              <div className="st-row st-row--between">
                <span className="st-label">Prompt {recipe.prompt !== undefined && <span className="st-chip st-chip--mono">edited</span>}</span>
                <span className="st-row" style={{ gap: 6 }}>
                  {recipe.prompt === undefined ? (
                    <Button size="sm" kind="quiet" disabled={!composed} onClick={() => setRecipe((r) => ({ ...r, prompt: composed }))}>Edit</Button>
                  ) : (
                    <Button size="sm" kind="quiet" onClick={() => setRecipe((r) => ({ ...r, prompt: undefined }))}>Back to composed</Button>
                  )}
                  <Button size="sm" kind="quiet" disabled={!prompt} onClick={() => void navigator.clipboard?.writeText(prompt)}>Copy</Button>
                </span>
              </div>
              {recipe.prompt === undefined ? (
                <pre className="st-pre st-canvas-prompt">{composed || "Pick a portrait, a costume or a pose."}</pre>
              ) : (
                <textarea className="st-textarea st-canvas-prompt" rows={10} maxLength={4000} value={recipe.prompt} onChange={(e) => setRecipe((r) => ({ ...r, prompt: e.target.value }))} />
              )}
            </div>
            <div className="st-row">
              <Button kind="primary" busy={busy} disabled={!!blocked} title={blocked || undefined} onClick={() => void generate()}>Generate</Button>
              {blocked && <span className="st-muted">{blocked}</span>}
            </div>
          </Section>

          <Section title={`Results${results.length ? ` (${results.length})` : ""}`} aside={projectId ? <Link className="st-link" href={`/p/${projectId}/pictures`}>All pictures</Link> : undefined}>
            {pending.map(([id, j]) => <div key={id} className="st-alert st-alert--info"><span className="st-lamp" data-state="running">Drawing…</span><span className="st-muted">{j.runner ?? (j.status === "queued" ? "queued for a painter" : "a painter is drawing it")}</span></div>)}
            {failed.map(([id, j]) => <div key={id} className="st-alert"><span>Failed: {j.error ?? "no picture"}</span><button type="button" className="st-btn st-btn--quiet st-btn--sm" aria-label="Dismiss" onClick={() => setJobs((m) => { const n = { ...m }; delete n[id]; return n; })}><CloseIcon size={12} /></button></div>)}
            {results.length === 0 && !pending.length ? <p className="st-muted">Generated characters appear here, and in the project&apos;s Pictures.</p> : (
              <div className="st-canvas-results">
                {results.slice(0, 24).map((a) => (
                  <button key={a.id} type="button" className="st-ref-img" onClick={() => setResult(a)} title={a.name}>
                    <img src={(a.meta.previewUrl as string | undefined) ?? a.url} alt={a.name ?? "result"} loading="lazy" />
                    <span className="st-thumb-tag">{a.handle}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </aside>

        <section id="canvas-library" className="st-canvas-library" aria-label="Reference library">
          <CanvasLibrary kind={prefs.kind} onKind={(k) => setPrefs((p) => ({ ...p, kind: k }))} adultVersion={adultVersion} adult={adult} depth={recipe.depth} onDepth={(d) => setRecipe((r) => ({ ...r, depth: d }))} selected={selected} onUse={use} onImport={projectId ? importOne : undefined} />
        </section>
      </div>

      {ageGate && <AgeGate onClose={() => setAgeGate(false)} onConfirm={async () => { await setAdult(true); setAgeGate(false); }} />}
      {result && <ResultModal asset={result} projectId={projectId!} onClose={() => setResult(null)} onRestore={() => void restore(result).catch(setError)} />}
    </div>
  );
}

/* ---------- the model ---------- */

function ModelPicker({ model, status, gpu, resolved, loras, onModel, onStartGpu }: { model: ModelEntry; status?: ModelStatus; gpu: { status: string; configured: boolean } | null; resolved: Resolved; loras: React.ReactNode; onModel: (id: string) => void; onStartGpu: () => Promise<void> }) {
  const [starting, setStarting] = useState(false);
  const ready = status?.painters?.ready;
  const gpuDown = model.runtime === "pod" && gpu?.configured && !["running", "starting"].includes(gpu.status);
  return (
    <div className="st-stack st-stack--tight">
      <Field label="Model">
        <select className="st-select" value={model.id} onChange={(e) => onModel(e.target.value)}>
          {IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.runtime === "pod" ? "GPU pod" : m.backend === "codex" ? "ChatGPT plan" : "API, per picture"}</option>)}
        </select>
      </Field>
      {loras}
      <span className="st-muted st-num">{describeParams(resolved.params) || "settings by the service"}{resolved.sources.length > 1 ? ` (from ${resolved.sources.slice(1).join(", ")})` : ""} · {model.poseRecipe ? "pose + portrait and/or costume" : `up to ${model.maxRefs ?? CANVAS_MAX_REFS} pictures`}{model.moderation === "openai" ? " · OpenAI moderation" : model.moderation === "alibaba" ? " · Alibaba Cloud moderation" : " · no content filter"}</span>
      {resolved.warnings.map((w) => <span key={w} className="st-warn">{w}</span>)}
      {status?.painters && (ready ? <Lamp state="ok" label={`can draw now · ${status.painters.drawers.join(", ")}`} /> : (
        <div className="st-alert st-alert--warn">
          <span>{status.painters.note}{gpu?.status === "starting" ? " The pod is starting; its painter reports once the model is loaded." : ""}</span>
          {gpuDown && <Button size="sm" busy={starting} title="Bills per hour; stops by itself when idle" onClick={async () => { setStarting(true); try { await onStartGpu(); } finally { setStarting(false); } }}>Start GPU pod</Button>}
        </div>
      ))}
      {model.commercial === false && <span className="st-warn">{model.license}</span>}
    </div>
  );
}

/* ---------- slots ---------- */

function SlotCard({ kind, recipe, adult, uploading, canUpload, onBrowse, onClear, onRandom, onUpload, onDepth, onMirror, onView }: {
  kind: SlotKind; recipe: Recipe; adult: boolean; uploading: boolean; canUpload: boolean;
  onBrowse: () => void; onClear: () => void; onRandom: (scope: "similar" | "any") => void; onUpload: (f: File | undefined) => void; onDepth: (d: boolean) => void; onMirror: (m: boolean) => void; onView: (v: string) => void;
}) {
  const slot = recipe[kind] as Slot<RefItem> | undefined;
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const thumb = slot?.item ? referenceImage(slot.item, { depth: recipe.depth, view: kind === "costume" ? recipe.costume?.view : undefined }).thumb : slot?.upload?.url;
  const item = slot?.item;
  const sub = item?.kind === "portrait" ? `${item.section} · ${item.hairLength}` : item?.kind === "costume" ? `${item.category} · ${COSTUME_SOURCES.find((s) => s.id === item.source)?.label}` : item?.kind === "pose" ? `${item.category} · ${POSE_ANGLES.find((a) => a.id === item.angle)?.zh}` : slot?.upload ? "your picture" : "";
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (canUpload) onUpload(e.dataTransfer.files?.[0]);
  };
  return (
    <div className="st-slot" data-drag={drag ? "true" : undefined} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <span className="st-label">{SLOT_LABEL[kind]}</span>
      <button type="button" className="st-slot-pic" onClick={onBrowse} title={slot ? "Change it in the library" : "Pick from the library"}>
        {thumb ? <img src={thumb} alt={slotName(slot)} referrerPolicy="no-referrer" data-mirror={kind === "pose" && recipe.mirror ? "true" : undefined} /> : <span className="st-muted">{uploading ? "Uploading…" : "Pick from the library, or drop a picture"}</span>}
        {item?.nsfw && <span className="st-ref-badge">18+</span>}
      </button>
      <div className="st-slot-name" title={slotName(slot)}>{slotName(slot) || "—"}</div>
      {sub && <div className="st-muted st-slot-sub">{sub}</div>}
      {item?.nsfw && !adult && <div className="st-warn st-slot-sub">hidden now</div>}
      {kind === "pose" && slot && (
        <div className="st-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {item && (
            <div className="st-seg st-seg--sm" role="group" aria-label="Pose picture">
              <button type="button" aria-pressed={!recipe.depth} title="Line art" onClick={() => onDepth(false)}>白模</button>
              <button type="button" aria-pressed={recipe.depth} title="Depth map" onClick={() => onDepth(true)}>深度</button>
            </div>
          )}
          <button type="button" className="st-chip st-chip--btn" aria-pressed={!!recipe.mirror} title="Flip the pose left to right" onClick={() => onMirror(!recipe.mirror)}>⇋ 镜像</button>
        </div>
      )}
      {kind === "costume" && item?.kind === "costume" && item.views && (
        <div className="st-chips">{item.views.map((v) => <button key={v.id} type="button" className="st-chip st-chip--btn" aria-pressed={(recipe.costume?.view ?? "front") === v.id} onClick={() => onView(v.id)}>{v.label}</button>)}</div>
      )}
      <div className="st-slot-actions">
        <button type="button" className="st-btn st-btn--quiet st-btn--sm" title="Random, like this one" aria-label={`Random ${kind}, like this one`} onClick={() => onRandom("similar")}>~</button>
        <button type="button" className="st-btn st-btn--quiet st-btn--sm" title="Random from everything" aria-label={`Random ${kind} from everything`} onClick={() => onRandom("any")}>?</button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { onUpload(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="st-btn st-btn--quiet st-btn--sm" disabled={!canUpload || uploading} title={canUpload ? "Upload your own picture" : "Pick a project first"} onClick={() => input.current?.click()} aria-label={`Upload a ${kind} picture`}><UploadIcon size={12} /></button>
        {slot && <button type="button" className="st-btn st-btn--quiet st-btn--sm" title="Clear" aria-label={`Clear the ${kind}`} onClick={onClear}><CloseIcon size={12} /></button>}
      </div>
    </div>
  );
}

function Extras({ recipe, canAdd, uploading, onAdd, onRemove, onRename }: { recipe: Recipe; canAdd: boolean; uploading: boolean; onAdd: (f: File | undefined) => void; onRemove: (i: number) => void; onRename: (i: number, name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div className="st-stack st-stack--tight">
      <span className="st-label">More pictures <span className="st-muted">(props, accessories, a background — paste with ⌘V / Ctrl+V)</span></span>
      <div className="st-extras" data-drag={drag ? "true" : undefined} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); if (canAdd) onAdd(e.dataTransfer.files?.[0]); }}>
        {recipe.extras.map((x, i) => (
          <div key={x.assetId} className="st-extra">
            <img src={x.url} alt={x.name} />
            <input className="st-input st-input--sm" value={x.name} maxLength={60} aria-label="Name" onChange={(e) => onRename(i, e.target.value)} />
            <button type="button" className="st-btn st-btn--quiet st-btn--sm" aria-label={`Remove ${x.name}`} onClick={() => onRemove(i)}><CloseIcon size={12} /></button>
          </div>
        ))}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { onAdd(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="st-extra-add" disabled={!canAdd || uploading} onClick={() => input.current?.click()}>
          <UploadIcon size={12} /> {uploading ? "Uploading…" : canAdd ? "Add a picture" : "No room"}
        </button>
      </div>
    </div>
  );
}

/* ---------- 18+ gate ---------- */

function AgeGate({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title="Show 18+ references" onClose={onClose}>
      <div className="st-stack" style={{ gap: 12 }}>
        <p>The library holds adult reference material: two pose systems (全身单人・性感系, 双人缠绵 — grey mannequins) and lingerie and sensual outfits (内衣・睡衣, 性感穿搭). It stays hidden — for you and for the director connected to this Studio — until you confirm you are an adult.</p>
        <p className="st-muted">This is your own confirmation, not an age check. It is stored for your account; switch it off any time. Image models keep their own rules: GPT Image refuses sexual content, and repeated refusals can put the account it runs on at risk. CharaDB pictures are never used for minors or real people.</p>
        <label className="st-toggle"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I am 18 or older and want to see 18+ reference material</label>
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        <div className="st-row" style={{ justifyContent: "flex-end" }}>
          <Button kind="quiet" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!checked} busy={busy} onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}>Show 18+ references</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- a result ---------- */

function ResultModal({ asset, projectId, onClose, onRestore }: { asset: Asset; projectId: string; onClose: () => void; onRestore: () => void }) {
  const c = asset.meta.canvas as { refs?: Array<{ role: string; label: string; thumb: string; url: string }>; style?: string } | undefined;
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <Modal size="lg" onClose={onClose} title={<span>{asset.handle} <span className="st-muted">{asset.name}</span></span>}>
      <div className="st-ref-light">
        <div className="st-ref-light-pic"><img src={asset.url} alt={asset.name ?? "result"} /></div>
        <div className="st-stack" style={{ gap: 12 }}>
          <span className="st-label">References</span>
          <div className="st-canvas-refs">
            {(c?.refs ?? []).map((r, i) => (
              <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className="st-canvas-ref" title={r.label}>
                <img src={r.thumb || r.url} alt={r.label} referrerPolicy="no-referrer" />
                <span className="st-muted">{i + 1} · {r.role}</span>
              </a>
            ))}
          </div>
          {typeof asset.meta.review === "string" && <span className="st-muted">Review: {asset.meta.review}</span>}
          <div className="st-row">
            <Button kind="primary" onClick={onRestore}>Use this recipe again</Button>
            <a className="st-btn" href={asset.url} target="_blank" rel="noopener noreferrer" download>Download</a>
            <Link className="st-btn st-btn--quiet" href={`/p/${projectId}/pictures`}>Open in Pictures</Link>
          </div>
          <Button size="sm" kind="quiet" onClick={() => setShowPrompt((s) => !s)}>{showPrompt ? "Hide the prompt" : "Show the prompt"}</Button>
          {showPrompt && <pre className="st-pre st-canvas-prompt">{String(asset.meta.prompt ?? "")}</pre>}
        </div>
      </div>
    </Modal>
  );
}

