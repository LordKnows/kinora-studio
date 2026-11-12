"use client";

import { useEffect, useState, type ReactNode } from "react";

import { checkConstraint } from "@director/lint/constraints";

import { planDurations } from "@/studio/editing";
import type { LookSettings, LoraRef } from "@/studio/schemas";
import type { Asset, Project } from "@/studio/types";

import { get, patch } from "./api";
import { Button, Chips, ErrorBanner, Field, Lamp, UploadButton, useAction } from "./common";
import { StyleGallery } from "./library-page";
import { LoraPicker } from "./lora-picker";
import { useProjectContext } from "./shell";
import { PictureCaption, pictureTitle, useDeletePictures } from "./pictures";
import { ImageButton } from "./image-tools";

function clampSeconds(raw: string): number | null {
  const n = Math.round(Number(raw));
  return raw.trim() === "" || !Number.isFinite(n) ? null : Math.max(5, Math.min(3600, n));
}

/* Brief & style — Tier 1. Cards that each save on their own: the brief and
   running time the director reads first; the style (a preset compiled into
   the Look's fields and constraints); the aspect ratio; the project LoRAs;
   and last the style frame, drawn from the saved brief and style, or
   uploaded. Every shot inherits all of it. */

const RATIOS: LookSettings["aspectRatio"][] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const STYLE_FRAME_MAX = 3;

type CompiledStyle = { look: Partial<LookSettings>; cinematographyDefaults?: Record<string, unknown>; allowedCameraMoves?: string[]; durationGuide?: unknown };

/** The part of the Look the Style card owns. */
type StyleDraft = Pick<LookSettings, "style" | "genre" | "palette" | "camera" | "lens" | "lighting" | "negative">;
const styleOf = (l: StyleDraft): StyleDraft => ({ style: l.style, genre: l.genre, palette: l.palette, camera: l.camera, lens: l.lens, lighting: l.lighting, negative: l.negative });
const sameStyle = (a: StyleDraft, b: StyleDraft) => JSON.stringify(styleOf(a)) === JSON.stringify(styleOf(b));
const lorasKey = (v: LoraRef[]) => v.map((r) => `${r.id}:${r.strength ?? ""}`).join("|");

/** A save button that says "Saved" for a moment after it worked. */
function useSave(run: () => Promise<void>) {
  const [saved, setSaved] = useState(false);
  const action = useAction(async () => {
    await run();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  });
  return { ...action, saved };
}

/** The head of every card: its title (and "unsaved" while it differs from what is saved), its buttons on the right. */
function CardHead({ title, dirty, aside, children }: { title: string; dirty?: boolean; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="st-row st-row--between" style={{ flexWrap: "wrap", gap: 8 }}>
      <span className="st-row" style={{ gap: 8 }}>
        <span className="st-h2">{title}</span>
        {dirty && <span className="st-muted">unsaved</span>}
        {aside}
      </span>
      <span className="st-row" style={{ gap: 6, flexWrap: "wrap" }}>{children}</span>
    </div>
  );
}

export function LookPage() {
  const { projectId, view, reload } = useProjectContext();
  /* the running time is kept as typed (a number input that clamps on every key cannot be typed into) and clamped on blur and save */
  const [brief, setBrief] = useState<{ brief: string; targetSeconds: string } | null>(null);
  const [style, setStyle] = useState<StyleDraft | null>(null);
  const [ratio, setRatio] = useState<LookSettings["aspectRatio"] | null>(null);
  const [loras, setLoras] = useState<LoraRef[] | null>(null);
  const [pickingStyle, setPickingStyle] = useState(false);
  const [styleNote, setStyleNote] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    if (!brief) setBrief({ brief: view.project.brief, targetSeconds: view.project.targetSeconds ? String(view.project.targetSeconds) : "" });
    if (!style) setStyle(styleOf(view.project.look));
    if (!ratio) setRatio(view.project.look.aspectRatio);
    if (!loras) setLoras(view.project.look.loras);
  }, [view, brief, style, ratio, loras]);

  const saveBrief = useSave(async () => {
    if (!brief) return;
    const seconds = clampSeconds(brief.targetSeconds);
    setBrief({ ...brief, targetSeconds: seconds === null ? "" : String(seconds) });
    await patch(`/api/projects/${projectId}`, { brief: brief.brief, targetSeconds: seconds });
    await reload();
  });
  const saveStyle = useSave(async () => {
    if (!style) return;
    await patch(`/api/projects/${projectId}/look`, style);
    await reload();
  });
  const saveRatio = useSave(async () => {
    if (!ratio) return;
    await patch(`/api/projects/${projectId}/look`, { aspectRatio: ratio });
    await reload();
  });
  const saveLoras = useSave(async () => {
    if (!loras) return;
    await patch(`/api/projects/${projectId}/look`, { loras });
    await reload();
  });
  const compile = useAction(async (_c, slug: string) => {
    if (!style || !ratio || !loras) return;
    const r = await get<CompiledStyle>(`/api/styles/${slug}?aspectRatio=${encodeURIComponent(ratio)}`);
    const l = r.look;
    setStyle({
      ...style,
      style: slug,
      genre: l.genre ?? style.genre, palette: l.palette ?? style.palette, camera: l.camera ?? style.camera, lens: l.lens ?? style.lens, lighting: l.lighting ?? style.lighting,
      negative: l.negative ?? style.negative,
    });
    const presetLoras = l.loras && l.loras.length && lorasKey(l.loras) !== lorasKey(loras) ? l.loras : null;
    if (presetLoras) setLoras(presetLoras);
    setPickingStyle(false);
    setStyleNote(`Style filled from “${slug}”. Review the fields, then Save style.${presetLoras ? " The preset also set its LoRAs: save them in the LoRAs card." : ""} Apply the style to the Board once the shotlist exists.`);
  });

  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  const target = brief ? clampSeconds(brief.targetSeconds) ?? undefined : undefined;
  const plan = target ? planDurations(target) : null;

  if (!view || !brief || !style || !ratio || !loras) return null;
  const saved = view.project.look;
  const briefDirty = brief.brief !== view.project.brief || clampSeconds(brief.targetSeconds) !== (view.project.targetSeconds ?? null);
  const styleDirty = !sameStyle(style, styleOf(saved));
  const set = <K extends keyof StyleDraft>(key: K, value: StyleDraft[K]) => setStyle({ ...style, [key]: value });

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Brief & style</h1>
          <p className="st-subtitle">Tier 1. The brief and running time the director reads first, the style every shot inherits (a preset compiled into its fields), the aspect ratio and LoRAs, and the style frame drawn from them. Each card saves on its own.</p>
        </div>
      </div>
      <ErrorBanner
        error={saveBrief.error ?? saveStyle.error ?? saveRatio.error ?? saveLoras.error ?? compile.error}
        onDismiss={() => { saveBrief.dismiss(); saveStyle.dismiss(); saveRatio.dismiss(); saveLoras.dismiss(); compile.dismiss(); }}
      />

      <div className="st-stack" style={{ gap: 20 }}>
        <div className="st-card st-stack">
          <CardHead title="Brief" dirty={briefDirty}>
            <Button size="sm" kind="primary" busy={saveBrief.busy} onClick={() => void saveBrief.fire()}>{saveBrief.saved ? "Saved" : "Save brief"}</Button>
          </CardHead>
          <Field label="The film, in your own words">
            <textarea className="st-textarea" rows={6} value={brief.brief} onChange={(e) => setBrief({ ...brief, brief: e.target.value })} placeholder="A 60-second neon rain chase: Mara runs, looks back, vanishes into the crowd…" />
          </Field>
          <div className="st-fields">
            <Field label="Target running time (s)">
              <input className="st-input" type="number" inputMode="numeric" min={5} max={3600} step={1} value={brief.targetSeconds}
                onChange={(e) => setBrief({ ...brief, targetSeconds: e.target.value })}
                onBlur={() => { const s = clampSeconds(brief.targetSeconds); setBrief({ ...brief, targetSeconds: s === null ? "" : String(s) }); }} />
            </Field>
            <Field label="Board vs target">
              <span className="st-row" style={{ minHeight: 36 }}>
                {target !== undefined ? <Lamp state={boardSeconds === target ? "ok" : "warn"} label={`${boardSeconds} s of ${target} s on the Board`} /> : <span className="st-muted">set a target to compare</span>}
              </span>
            </Field>
          </div>
          {plan && <span className="st-muted st-num">Plan: {plan.shots} shots · {plan.durations.join(" + ")} s. {plan.note}</span>}
        </div>

        <div className="st-card st-stack">
          <CardHead title="Style" dirty={styleDirty}>
            <Button size="sm" onClick={() => setPickingStyle((v) => !v)}>{pickingStyle ? "Close presets" : style.style ? "Change preset" : "Choose a preset"}</Button>
            <Button size="sm" kind="primary" busy={saveStyle.busy} onClick={() => void saveStyle.fire()}>{saveStyle.saved ? "Saved" : "Save style"}</Button>
          </CardHead>
          {style.style ? (
            <div className="st-row">
              <span className="st-chip" aria-pressed="true">{style.style}</span>
              <span className="st-muted">the preset compiled into the fields below; the Board’s “Apply style” fills each shot’s cinematography from it.</span>
            </div>
          ) : (
            <p className="st-muted">Sixteen presets from the director layer (ink wash, cel anime, clay diorama, city symphony…). Picking one fills genre, palette, camera, lens, lighting, constraints and LoRAs; you can still edit everything.</p>
          )}
          {styleNote && (
            <div className="st-alert st-alert--info">
              <span>{styleNote}</span>
              <Button size="sm" kind="quiet" onClick={() => setStyleNote(null)}>Dismiss</Button>
            </div>
          )}
          {pickingStyle && (
            <div className="st-stack st-stack--tight">
              <span className="st-muted">Click a preset to compile it into the fields below.</span>
              <StyleGallery selected={style.style} onPick={(slug) => void compile.fire(slug)} />
            </div>
          )}
          <div className="st-fields">
            <Field label="Genre and tone"><input className="st-input" value={style.genre} onChange={(e) => set("genre", e.target.value)} placeholder="neo-noir thriller" /></Field>
            <Field label="Palette"><input className="st-input" value={style.palette} onChange={(e) => set("palette", e.target.value)} placeholder="teal and amber, crushed blacks" /></Field>
            <Field label="Camera"><input className="st-input" value={style.camera} onChange={(e) => set("camera", e.target.value)} placeholder="Arri Alexa, anamorphic" /></Field>
            <Field label="Lens"><input className="st-input" value={style.lens} onChange={(e) => set("lens", e.target.value)} placeholder="35mm, shallow depth of field" /></Field>
          </div>
          <Field label="Lighting"><input className="st-input" value={style.lighting} onChange={(e) => set("lighting", e.target.value)} placeholder="practical sources, hard key" /></Field>
          <Field label="Constraints" group>
            <Chips values={style.negative} onRemove={(i) => set("negative", style.negative.filter((_, j) => j !== i))} onAdd={(v) => style.negative.length < 10 && set("negative", [...style.negative, v])} placeholder="exactly two people in the room" />
            <span className="st-muted">What the picture shows. H3 has no negative prompt: a word written here is drawn, so “blurry” or “no logos” work against you.</span>
            {style.negative.map(checkConstraint).filter((v) => v.kind !== "ok").map((v, i) => (
              <span key={`${v.text}-${i}`} className="st-muted">
                “{v.text}” {v.inPrompt ? "is a ban and can add what it names" : "is left out of the prompt"}: {v.suggest}.
              </span>
            ))}
          </Field>
        </div>

        <div className="st-split">
          <div className="st-card st-stack">
            <CardHead title="Aspect ratio" dirty={ratio !== saved.aspectRatio}>
              <Button size="sm" kind="primary" busy={saveRatio.busy} onClick={() => void saveRatio.fire()}>{saveRatio.saved ? "Saved" : "Save aspect ratio"}</Button>
            </CardHead>
            <div className="st-ratios" role="group">
              {RATIOS.map((r) => {
                const [w, h] = r.split(":").map(Number) as [number, number];
                const scale = 28 / Math.max(w, h);
                return (
                  <button key={r} type="button" className="st-ratio" aria-pressed={ratio === r} onClick={() => setRatio(r)}>
                    <span className="st-ratio-box" style={{ width: Math.max(10, Math.round(w * scale)), height: Math.max(10, Math.round(h * scale)) }} />
                    {r}
                  </button>
                );
              })}
            </div>
            <span className="st-muted">H3-Base renders 768p (1344×768 at 16:9). Full resolution comes from the Finals page.</span>
          </div>
          <div className="st-card st-stack">
            <CardHead title="LoRAs" dirty={lorasKey(loras) !== lorasKey(saved.loras)}>
              <Button size="sm" kind="primary" busy={saveLoras.busy} onClick={() => void saveLoras.fire()}>{saveLoras.saved ? "Saved" : "Save LoRAs"}</Button>
            </CardHead>
            <LoraPicker value={loras} onChange={setLoras} />
            <span className="st-muted">Project defaults for every shot; a shot can override them. A speed LoRA sets the step count; none means the base chain at 20 steps.</span>
          </div>
        </div>

        <StyleFrameCard />
      </div>
    </div>
  );
}

/** What the style frame is drawn from, as saved: the brief and the style (a preset or its fields). */
function styleFrameBlocker(p: Project): string | undefined {
  const l = p.look;
  const hasBrief = p.brief.trim().length > 0;
  const hasStyle = !!l.style || [l.genre, l.palette, l.camera, l.lens, l.lighting].some((x) => x.trim().length > 0);
  if (hasBrief && hasStyle) return undefined;
  return !hasBrief && !hasStyle ? "Save the brief and the style first: the style frame is drawn from them" : !hasBrief ? "Save the brief first: the style frame is drawn from it" : "Save the style first (a preset or its fields): the style frame is drawn from it";
}

/* The style frame: one picture that sets the film's look. Up to three
   candidates, generated (once the brief and the style are saved) or
   uploaded; the one chosen is a reference for every generated sheet and
   frame. Each candidate has its own delete button. */
function StyleFrameCard() {
  const { projectId, view, reload } = useProjectContext();
  const current = view?.project.look.styleFrameAssetId;
  const frames = (view?.assets ?? []).filter((a) => a.kind === "image" && (a.meta.purpose === "style_frame" || a.id === current)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const choose = useAction(async (_c, assetId: string | null) => {
    await patch(`/api/projects/${projectId}/look`, { styleFrameAssetId: assetId ?? "" });
    await reload();
  });
  if (!view) return null;
  const full = frames.length >= STYLE_FRAME_MAX;
  const notReady = styleFrameBlocker(view.project);
  const fullWhy = `At most ${STYLE_FRAME_MAX} style frames: delete one first`;
  return (
    <div className="st-card st-stack">
      <CardHead title="Style frame" aside={<span className="st-muted st-num">{frames.length}/{STYLE_FRAME_MAX}</span>}>
        <UploadButton
          accept="image/jpeg,image/png,image/webp"
          projectId={projectId}
          purpose="style_frame"
          label="Upload"
          disabled={full}
          title={full ? fullWhy : "Upload a picture as a style frame"}
          onUploaded={async ({ assetId }) => {
            if (!current) await patch(`/api/projects/${projectId}/look`, { styleFrameAssetId: assetId });
            await reload();
          }}
        />
        <ImageButton label="Generate" kind="primary" body={{ action: "style_frame" }} blocked={full ? fullWhy : notReady} title="Draw a style frame from the brief and the style" />
      </CardHead>
      <span className="st-muted">One picture that sets the look. Generate it from the saved brief and style, or upload one; keep up to {STYLE_FRAME_MAX}. Click one to use it: every generated sheet and frame matches it.</span>
      {notReady && !full && <span className="st-warn">{notReady}.</span>}
      <ErrorBanner error={choose.error} onDismiss={choose.dismiss} />
      {frames.length > 0 && (
        <div className="st-thumbs st-thumbs--named">
          {frames.map((a) => (
            <StyleFrameTile key={a.id} asset={a} chosen={current === a.id} onChoose={() => void choose.fire(current === a.id ? null : a.id)} onDeleted={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function StyleFrameTile({ asset, chosen, onChoose, onDeleted }: { asset: Asset; chosen: boolean; onChoose: () => void; onDeleted: () => Promise<void> }) {
  const del = useDeletePictures(onDeleted);
  return (
    <div className="st-pic">
      <button type="button" className="st-thumb" aria-pressed={chosen} onClick={onChoose} title={chosen ? "The style frame (click to clear)" : "Use as the style frame"}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={(asset.meta.previewUrl as string | undefined) ?? asset.url} alt={pictureTitle(asset)} />
        {chosen && <span className="st-thumb-tag">STYLE</span>}
      </button>
      <div className="st-row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <PictureCaption asset={asset} />
        </span>
        <Button size="sm" kind="quiet" busy={del.busy} onClick={() => void del.fire([asset.id])} title="Delete this style frame">Delete</Button>
      </div>
      <ErrorBanner error={del.error} onDismiss={del.dismiss} />
    </div>
  );
}
