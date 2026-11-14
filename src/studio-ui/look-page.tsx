"use client";

import { useEffect, useState, type ReactNode } from "react";

import { checkConstraint } from "@director/lint/constraints";

import type { LookSettings } from "@/studio/schemas";
import type { Asset, Project } from "@/studio/types";

import { get, patch } from "./api";
import { Button, Chips, ErrorBanner, Field, Lamp, UploadButton, useAction } from "./common";
import { useT } from "./i18n";
import { StyleGallery } from "./library-page";
import { useProjectContext } from "./shell";
import { Zoomable } from "./picture-zoom";
import { PictureCaption, pictureSize, pictureTitle, useDeletePictures } from "./pictures";
import { ImageButton } from "./image-tools";

function clampSeconds(raw: string): number | null {
  const n = Math.round(Number(raw));
  return raw.trim() === "" || !Number.isFinite(n) ? null : Math.max(5, Math.min(3600, n));
}

/* The Look — Tier 1, the Design page's first tab. Cards that each save on
   their own: the style (a preset compiled into the Look's fields and
   constraints); the aspect ratio; the project LoRAs; and last the style
   frame, drawn from the saved brief and style, or uploaded. Every shot
   inherits all of it. The brief and running time the director reads first
   are on the Story page (BriefCard, below). */

const RATIOS: LookSettings["aspectRatio"][] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const STYLE_FRAME_MAX = 3;

type CompiledStyle = { look: Partial<LookSettings>; cinematographyDefaults?: Record<string, unknown>; allowedCameraMoves?: string[]; durationGuide?: unknown };

/** The part of the Look the Style card owns. */
type StyleDraft = Pick<LookSettings, "style" | "genre" | "palette" | "camera" | "lens" | "lighting" | "negative">;
const styleOf = (l: StyleDraft): StyleDraft => ({ style: l.style, genre: l.genre, palette: l.palette, camera: l.camera, lens: l.lens, lighting: l.lighting, negative: l.negative });
const sameStyle = (a: StyleDraft, b: StyleDraft) => JSON.stringify(styleOf(a)) === JSON.stringify(styleOf(b));

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
  const t = useT();
  return (
    <div className="st-row st-row--between" style={{ flexWrap: "wrap", gap: 8 }}>
      <span className="st-row" style={{ gap: 8 }}>
        <span className="st-h2">{t(title)}</span>
        {dirty && <span className="st-muted">{t("unsaved")}</span>}
        {aside}
      </span>
      <span className="st-row" style={{ gap: 6, flexWrap: "wrap" }}>{children}</span>
    </div>
  );
}

/* The brief and the running time: what the director reads first. The Story
   page opens with it. */
export function BriefCard() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  /* the running time is kept as typed (a number input that clamps on every key cannot be typed into) and clamped on blur and save */
  const [brief, setBrief] = useState<{ brief: string; targetSeconds: string } | null>(null);
  useEffect(() => {
    if (view && !brief) setBrief({ brief: view.project.brief, targetSeconds: view.project.targetSeconds ? String(view.project.targetSeconds) : "" });
  }, [view, brief]);
  const saveBrief = useSave(async () => {
    if (!brief) return;
    const seconds = clampSeconds(brief.targetSeconds);
    setBrief({ ...brief, targetSeconds: seconds === null ? "" : String(seconds) });
    await patch(`/api/projects/${projectId}`, { brief: brief.brief, targetSeconds: seconds });
    await reload();
  });
  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  const target = brief ? clampSeconds(brief.targetSeconds) ?? undefined : undefined;
  if (!view || !brief) return null;
  const briefDirty = brief.brief !== view.project.brief || clampSeconds(brief.targetSeconds) !== (view.project.targetSeconds ?? null);
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={saveBrief.error} onDismiss={saveBrief.dismiss} />
      <CardHead title="Brief" dirty={briefDirty}>
        <Button size="sm" kind="secondary" busy={saveBrief.busy} onClick={() => void saveBrief.fire()}>{saveBrief.saved ? t("Saved") : t("Save brief")}</Button>
      </CardHead>
      <Field label={t("The film, in your own words")}>
        <textarea className="st-textarea" rows={6} value={brief.brief} onChange={(e) => setBrief({ ...brief, brief: e.target.value })} placeholder={t("A 60-second neon rain chase: Mara runs, looks back, vanishes into the crowd…")} />
      </Field>
      <div className="st-fields">
        <Field label={t("Target running time (s)")}>
          <input className="st-input" type="number" inputMode="numeric" min={5} max={3600} step={1} value={brief.targetSeconds}
            onChange={(e) => setBrief({ ...brief, targetSeconds: e.target.value })}
            onBlur={() => { const s = clampSeconds(brief.targetSeconds); setBrief({ ...brief, targetSeconds: s === null ? "" : String(s) }); }} />
        </Field>
        <Field label={t("Board vs target")}>
          <span className="st-row" style={{ minHeight: 36 }}>
            {target !== undefined ? <Lamp state={boardSeconds === target ? "ok" : "warn"} label={t("{board} s of {target} s on the Board", { board: boardSeconds, target })} /> : <span className="st-muted">{t("set a target to compare")}</span>}
          </span>
        </Field>
      </div>
    </div>
  );
}

export function LookPage() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [style, setStyle] = useState<StyleDraft | null>(null);
  const [ratio, setRatio] = useState<LookSettings["aspectRatio"] | null>(null);
  const [pickingStyle, setPickingStyle] = useState(false);
  const [styleNote, setStyleNote] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    if (!style) setStyle(styleOf(view.project.look));
    if (!ratio) setRatio(view.project.look.aspectRatio);
  }, [view, style, ratio]);

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
  const compile = useAction(async (_c, slug: string) => {
    if (!style || !ratio) return;
    const r = await get<CompiledStyle>(`/api/styles/${slug}?aspectRatio=${encodeURIComponent(ratio)}`);
    const l = r.look;
    setStyle({
      ...style,
      style: slug,
      genre: l.genre ?? style.genre, palette: l.palette ?? style.palette, camera: l.camera ?? style.camera, lens: l.lens ?? style.lens, lighting: l.lighting ?? style.lighting,
      negative: l.negative ?? style.negative,
    });
    setPickingStyle(false);
    setStyleNote(t("Style filled from “{slug}”. Review the fields, then Save style. Apply the style to the Board once the shotlist exists.", { slug }));
  });

  if (!view || !style || !ratio) return null;
  const saved = view.project.look;
  const styleDirty = !sameStyle(style, styleOf(saved));
  const set = <K extends keyof StyleDraft>(key: K, value: StyleDraft[K]) => setStyle({ ...style, [key]: value });

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Look")}</h1>
          <p className="st-subtitle">{t("Tier 1. The style every shot inherits (a preset compiled into its fields), the aspect ratio, and the style frame drawn from the brief and the style. Each card saves on its own. LoRAs are per shot, on the Board.")}</p>
        </div>
      </div>
      <ErrorBanner
        error={saveStyle.error ?? saveRatio.error ?? compile.error}
        onDismiss={() => { saveStyle.dismiss(); saveRatio.dismiss(); compile.dismiss(); }}
      />

      <div className="st-stack" style={{ gap: 20 }}>
        <div className="st-card st-stack">
          <CardHead title="Style" dirty={styleDirty}>
            <Button size="sm" onClick={() => setPickingStyle((v) => !v)}>{pickingStyle ? t("Close presets") : style.style ? t("Change preset") : t("Choose a preset")}</Button>
            <Button size="sm" kind="secondary" busy={saveStyle.busy} onClick={() => void saveStyle.fire()}>{saveStyle.saved ? t("Saved") : t("Save style")}</Button>
          </CardHead>
          {style.style ? (
            <div className="st-row">
              <span className="st-chip" aria-pressed="true">{style.style}</span>
              <span className="st-muted">{t("the preset compiled into the fields below; the Board’s “Apply style” fills each shot’s cinematography from it.")}</span>
            </div>
          ) : (
            <p className="st-muted">{t("Sixteen presets from the director layer (ink wash, cel anime, clay diorama, city symphony…). Picking one fills genre, palette, camera, lens, lighting and constraints; you can still edit everything.")}</p>
          )}
          {styleNote && (
            <div className="st-alert st-alert--info">
              <span>{styleNote}</span>
              <Button size="sm" kind="quiet" onClick={() => setStyleNote(null)}>{t("Dismiss")}</Button>
            </div>
          )}
          {pickingStyle && (
            <div className="st-stack st-stack--tight">
              <span className="st-muted">{t("Click a preset to compile it into the fields below.")}</span>
              <StyleGallery selected={style.style} onPick={(slug) => void compile.fire(slug)} />
            </div>
          )}
          <div className="st-fields">
            <Field label={t("Genre and tone")}><input className="st-input" value={style.genre} onChange={(e) => set("genre", e.target.value)} placeholder={t("neo-noir thriller")} /></Field>
            <Field label={t("Palette")}><input className="st-input" value={style.palette} onChange={(e) => set("palette", e.target.value)} placeholder={t("teal and amber, crushed blacks")} /></Field>
            <Field label={t("Camera")}><input className="st-input" value={style.camera} onChange={(e) => set("camera", e.target.value)} placeholder={t("Arri Alexa, anamorphic")} /></Field>
            <Field label={t("Lens")}><input className="st-input" value={style.lens} onChange={(e) => set("lens", e.target.value)} placeholder={t("35mm, shallow depth of field")} /></Field>
          </div>
          <Field label={t("Lighting")}><input className="st-input" value={style.lighting} onChange={(e) => set("lighting", e.target.value)} placeholder={t("practical sources, hard key")} /></Field>
          <Field label={t("Constraints")} group>
            <Chips values={style.negative} onRemove={(i) => set("negative", style.negative.filter((_, j) => j !== i))} onAdd={(v) => style.negative.length < 10 && set("negative", [...style.negative, v])} placeholder={t("exactly two people in the room")} />
            <span className="st-muted">{t("What the picture shows. H3 has no negative prompt: a word written here is drawn, so “blurry” or “no logos” work against you.")}</span>
            {style.negative.map(checkConstraint).filter((v) => v.kind !== "ok").map((v, i) => (
              <span key={`${v.text}-${i}`} className="st-muted">
                {t("“{text}” {what}: {suggest}.", { text: v.text, what: v.inPrompt ? t("is a ban and can add what it names") : t("is left out of the prompt"), suggest: v.suggest ? t(v.suggest) : "" })}
              </span>
            ))}
          </Field>
        </div>

        <div className="st-split">
          <div className="st-card st-stack">
            <CardHead title="Aspect ratio" dirty={ratio !== saved.aspectRatio}>
              <Button size="sm" kind="secondary" busy={saveRatio.busy} onClick={() => void saveRatio.fire()}>{saveRatio.saved ? t("Saved") : t("Save aspect ratio")}</Button>
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
            <span className="st-muted">{t("H3-Base renders 768p (1344×768 at 16:9). Full resolution comes from the Cut page, in its export panel.")}</span>
          </div>
          {/* beside the aspect ratio, so the row is full on a wide screen */}
          <StyleFrameCard />
        </div>
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
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const current = view?.project.look.styleFrameAssetId;
  const frames = (view?.assets ?? []).filter((a) => a.kind === "image" && (a.meta.purpose === "style_frame" || a.id === current)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const choose = useAction(async (_c, assetId: string | null) => {
    await patch(`/api/projects/${projectId}/look`, { styleFrameAssetId: assetId ?? "" });
    await reload();
  });
  if (!view) return null;
  const full = frames.length >= STYLE_FRAME_MAX;
  const blocker = styleFrameBlocker(view.project);
  const notReady = blocker && t(blocker);
  const fullWhy = t("At most {n} style frames: delete one first", { n: STYLE_FRAME_MAX });
  return (
    <div className="st-card st-stack">
      <CardHead title="Style frame" aside={<span className="st-muted st-num">{frames.length}/{STYLE_FRAME_MAX}</span>}>
        <UploadButton
          accept="image/jpeg,image/png,image/webp"
          projectId={projectId}
          purpose="style_frame"
          label="Upload"
          disabled={full}
          title={full ? fullWhy : t("Upload a picture as a style frame")}
          onUploaded={async ({ assetId }) => {
            if (!current) await patch(`/api/projects/${projectId}/look`, { styleFrameAssetId: assetId });
            await reload();
          }}
        />
        <ImageButton label={t("Generate")} kind="secondary" body={{ action: "style_frame" }} blocked={full ? fullWhy : notReady} title={t("Draw a style frame from the brief and the style")} />
      </CardHead>
      <span className="st-muted">{t("One picture that sets the look. Generate it from the saved brief and style, or upload one; keep up to {n}. Click one to use it: every generated sheet and frame matches it.", { n: STYLE_FRAME_MAX })}</span>
      {notReady && !full && <span className="st-warn">{t("{why}.", { why: notReady })}</span>}
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
  const t = useT();
  const del = useDeletePictures(onDeleted);
  return (
    <div className="st-pic">
      <Zoomable url={asset.url} title={pictureTitle(asset)} facts={pictureSize(asset)}>
        <button type="button" className="st-thumb" aria-pressed={chosen} onClick={onChoose} title={chosen ? t("The style frame (click to clear)") : t("Use as the style frame")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={(asset.meta.previewUrl as string | undefined) ?? asset.url} alt={pictureTitle(asset)} />
          {chosen && <span className="st-thumb-tag">{t("STYLE")}</span>}
        </button>
      </Zoomable>
      <div className="st-row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <PictureCaption asset={asset} />
        </span>
        <Button size="sm" kind="quiet" busy={del.busy} onClick={() => void del.fire([asset.id])} title={t("Delete this style frame")}>{t("Delete")}</Button>
      </div>
      <ErrorBanner error={del.error} onDismiss={del.dismiss} />
    </div>
  );
}
