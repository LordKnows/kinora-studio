"use client";

import { useEffect, useState } from "react";

import { planDurations } from "@/studio/editing";
import type { LookSettings } from "@/studio/schemas";

import { get, patch } from "./api";
import { Button, Chips, ErrorBanner, Field, Lamp, useAction } from "./common";
import { StyleGallery } from "./library-page";
import { LoraPicker } from "./lora-picker";
import { useProjectContext } from "./shell";

/* Brief & style — Tier 1. The brief and the running time the director
   reads first; a style preset compiled into the Look; the Look's fields,
   aspect ratio, LoRAs and negatives, inherited by every shot. */

const RATIOS: LookSettings["aspectRatio"][] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

type CompiledStyle = { look: Partial<LookSettings>; cinematographyDefaults?: Record<string, unknown>; allowedCameraMoves?: string[]; durationGuide?: unknown };

export function LookPage() {
  const { projectId, view, reload } = useProjectContext();
  const [look, setLook] = useState<LookSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [brief, setBrief] = useState<{ brief: string; targetSeconds: number | "" } | null>(null);
  const [briefSaved, setBriefSaved] = useState(false);
  const [pickingStyle, setPickingStyle] = useState(false);
  const [styleNote, setStyleNote] = useState<string | null>(null);

  useEffect(() => {
    if (view && !look) setLook(view.project.look);
    if (view && !brief) setBrief({ brief: view.project.brief, targetSeconds: view.project.targetSeconds ?? "" });
  }, [view, look, brief]);

  const saveBrief = useAction(async () => {
    if (!brief) return;
    await patch(`/api/projects/${projectId}`, { brief: brief.brief, targetSeconds: brief.targetSeconds === "" ? null : brief.targetSeconds });
    await reload();
    setBriefSaved(true);
    window.setTimeout(() => setBriefSaved(false), 1500);
  });
  const save = useAction(async () => {
    if (!look) return;
    await patch(`/api/projects/${projectId}/look`, look);
    await reload();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  });
  const compile = useAction(async (_c, slug: string) => {
    if (!look) return;
    const r = await get<CompiledStyle>(`/api/styles/${slug}?aspectRatio=${encodeURIComponent(look.aspectRatio)}`);
    const l = r.look;
    setLook({
      ...look,
      style: slug,
      genre: l.genre ?? look.genre, palette: l.palette ?? look.palette, camera: l.camera ?? look.camera, lens: l.lens ?? look.lens, lighting: l.lighting ?? look.lighting,
      negative: l.negative ?? look.negative,
      loras: l.loras && l.loras.length ? l.loras : look.loras,
    });
    setPickingStyle(false);
    setStyleNote(`Look filled from “${slug}”. Review the fields, then Save look. Apply the style to the Board once the shotlist exists.`);
  });

  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  const target = brief && brief.targetSeconds !== "" ? brief.targetSeconds : undefined;
  const plan = target ? planDurations(target) : null;

  if (!look || !brief) return null;
  const set = <K extends keyof LookSettings>(key: K, value: LookSettings[K]) => setLook({ ...look, [key]: value });

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Brief & style</h1>
          <p className="st-subtitle">Tier 1. The brief and running time the director reads first, a style preset compiled into the Look, and the Look every shot inherits.</p>
        </div>
      </div>
      <ErrorBanner error={save.error ?? saveBrief.error ?? compile.error} onDismiss={() => { save.dismiss(); saveBrief.dismiss(); compile.dismiss(); }} />

      <div className="st-split st-split--wide-left">
        <div className="st-card st-stack">
          <div className="st-row st-row--between">
            <span className="st-h2">Brief</span>
            <Button size="sm" kind="primary" busy={saveBrief.busy} onClick={() => void saveBrief.fire()}>{briefSaved ? "Saved" : "Save brief"}</Button>
          </div>
          <Field label="The film, in your own words">
            <textarea className="st-textarea" rows={6} value={brief.brief} onChange={(e) => setBrief({ ...brief, brief: e.target.value })} placeholder="A 60-second neon rain chase: Mara runs, looks back, vanishes into the crowd…" />
          </Field>
          <div className="st-fields">
            <Field label="Target running time (s)">
              <input className="st-input" type="number" min={5} max={3600} step={1} value={brief.targetSeconds} onChange={(e) => setBrief({ ...brief, targetSeconds: e.target.value === "" ? "" : Math.max(5, Math.min(3600, Math.round(Number(e.target.value)))) })} />
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
          <div className="st-row st-row--between">
            <span className="st-h2">Style preset</span>
            <Button size="sm" onClick={() => setPickingStyle((v) => !v)}>{pickingStyle ? "Close" : look.style ? "Change" : "Choose a style"}</Button>
          </div>
          {look.style ? (
            <div className="st-row">
              <span className="st-chip" aria-pressed="true">{look.style}</span>
              <span className="st-muted">compiled into the fields below; the Board’s “Apply style” fills each shot’s cinematography from it.</span>
            </div>
          ) : (
            <p className="st-muted">Sixteen presets from the director layer (ink wash, cel anime, clay diorama, city symphony…). Picking one fills genre, palette, camera, lens, lighting, negatives and LoRAs; you can still edit everything.</p>
          )}
          {styleNote && <div className="st-alert st-alert--info"><span>{styleNote}</span></div>}
        </div>
      </div>

      {pickingStyle && (
        <div className="st-section">
          <div className="st-section-title"><span>Choose a style</span><small>click a card to compile it into the Look</small></div>
          <StyleGallery selected={look.style} onPick={(slug) => void compile.fire(slug)} />
        </div>
      )}

      <div className="st-section">
        <div className="st-section-title">
          <span>Look</span>
          <Button kind="primary" busy={save.busy} onClick={() => void save.fire()}>{saved ? "Saved" : "Save look"}</Button>
        </div>
        <div className="st-split st-split--wide-left">
          <div className="st-card st-stack">
            <div className="st-fields">
              <Field label="Genre and tone"><input className="st-input" value={look.genre} onChange={(e) => set("genre", e.target.value)} placeholder="neo-noir thriller" /></Field>
              <Field label="Palette"><input className="st-input" value={look.palette} onChange={(e) => set("palette", e.target.value)} placeholder="teal and amber, crushed blacks" /></Field>
              <Field label="Camera"><input className="st-input" value={look.camera} onChange={(e) => set("camera", e.target.value)} placeholder="Arri Alexa, anamorphic" /></Field>
              <Field label="Lens"><input className="st-input" value={look.lens} onChange={(e) => set("lens", e.target.value)} placeholder="35mm, shallow depth of field" /></Field>
            </div>
            <Field label="Lighting"><input className="st-input" value={look.lighting} onChange={(e) => set("lighting", e.target.value)} placeholder="practical sources, hard key" /></Field>
            <Field label="Constraints (negative)">
              <Chips values={look.negative} onRemove={(i) => set("negative", look.negative.filter((_, j) => j !== i))} onAdd={(v) => look.negative.length < 10 && set("negative", [...look.negative, v])} placeholder="no on-screen text" />
            </Field>
          </div>
          <div className="st-stack">
            <div className="st-card st-stack">
              <span className="st-h2">Aspect ratio</span>
              <div className="st-ratios" role="group">
                {RATIOS.map((r) => {
                  const [w, h] = r.split(":").map(Number) as [number, number];
                  const scale = 28 / Math.max(w, h);
                  return (
                    <button key={r} type="button" className="st-ratio" aria-pressed={look.aspectRatio === r} onClick={() => set("aspectRatio", r)}>
                      <span className="st-ratio-box" style={{ width: Math.max(10, Math.round(w * scale)), height: Math.max(10, Math.round(h * scale)) }} />
                      {r}
                    </button>
                  );
                })}
              </div>
              <span className="st-muted">H3-Base renders 768p (1344×768 at 16:9). Full resolution comes from the Finals page (Regenerate 2K).</span>
            </div>
            <div className="st-card st-stack">
              <span className="st-h2">LoRAs</span>
              <LoraPicker value={look.loras} onChange={(v) => set("loras", v)} />
              <span className="st-muted">Project defaults for every shot; a shot can override them. A speed LoRA sets the step count; none means the base chain at 20 steps.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
