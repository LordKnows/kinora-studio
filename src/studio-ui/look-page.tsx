"use client";

import { useEffect, useState } from "react";

import { ratioBox } from "@/openhiggsfield/data";
import { CheckIcon } from "@/openhiggsfield/icons";
import { planDurations } from "@/studio/editing";
import type { LookSettings } from "@/studio/schemas";

import { patch } from "./api";
import { Button, Chips, ErrorBanner, Field, Lamp, useAction } from "./common";
import { LoraPicker } from "./lora-picker";
import { useProjectContext } from "./shell";

const RATIOS: LookSettings["aspectRatio"][] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export function LookPage() {
  const { projectId, view, reload } = useProjectContext();
  const [look, setLook] = useState<LookSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [brief, setBrief] = useState<{ brief: string; targetSeconds: number | "" } | null>(null);
  const [briefSaved, setBriefSaved] = useState(false);

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

  const boardSeconds = (view?.scenes ?? []).flatMap((s) => s.shots).reduce((n, s) => n + s.spec.durationS, 0);
  const target = brief && brief.targetSeconds !== "" ? brief.targetSeconds : undefined;
  const plan = target ? planDurations(target) : null;

  const save = useAction(async () => {
    if (!look) return;
    await patch(`/api/projects/${projectId}/look`, look);
    await reload();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  });

  if (!look) return null;
  const set = <K extends keyof LookSettings>(key: K, value: LookSettings[K]) => setLook({ ...look, [key]: value });

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Look</h1>
          <p className="st-subtitle">Set once, inherited by every shot. The compiler writes these into each prompt’s LOOK block.</p>
        </div>
        <div className="st-actions">
          <Button kind="primary" busy={save.busy} onClick={() => void save.fire()}>
            {saved ? "Saved" : "Save look"}
          </Button>
        </div>
      </div>
      <ErrorBanner error={save.error ?? saveBrief.error} onDismiss={() => { save.dismiss(); saveBrief.dismiss(); }} />
      {brief && (
        <div className="st-card st-stack" style={{ marginTop: 12 }}>
          <div className="st-row st-row--between">
            <span className="st-label" style={{ marginBottom: 0 }}>Brief</span>
            <Button size="sm" kind="primary" busy={saveBrief.busy} onClick={() => void saveBrief.fire()}>
              {briefSaved ? "Saved" : "Save brief"}
            </Button>
          </div>
          <Field label="The film, in your own words" hint="Tier 1. The director reads this before writing the script and the shotlist.">
            <textarea className="st-textarea" rows={4} value={brief.brief} onChange={(e) => setBrief({ ...brief, brief: e.target.value })} placeholder="A 60-second neon rain chase: Mara runs, looks back, vanishes into the crowd…" />
          </Field>
          <div className="st-fields">
            <Field label="Target running time (s)">
              <input
                className="st-input"
                type="number"
                min={5}
                max={3600}
                step={1}
                value={brief.targetSeconds}
                onChange={(e) => setBrief({ ...brief, targetSeconds: e.target.value === "" ? "" : Math.max(5, Math.min(3600, Math.round(Number(e.target.value)))) })}
              />
            </Field>
            {target !== undefined && (
              <Field label="Board vs target">
                <span className="st-row">
                  <Lamp state={boardSeconds === target ? "approved" : "draft"} label={`${boardSeconds} s of ${target} s`} />
                </span>
              </Field>
            )}
          </div>
          {plan && (
            <span className="st-muted st-num">
              Plan: {plan.shots} shots · {plan.durations.join(" + ")} s. {plan.note}
            </span>
          )}
        </div>
      )}
      <div className="st-split" style={{ marginTop: 12 }}>
        <div className="st-card st-stack">
          <Field label="Genre and tone">
            <input className="st-input" value={look.genre} onChange={(e) => set("genre", e.target.value)} placeholder="neo-noir thriller" />
          </Field>
          <Field label="Palette">
            <input className="st-input" value={look.palette} onChange={(e) => set("palette", e.target.value)} placeholder="teal and amber, crushed blacks" />
          </Field>
          <Field label="Camera">
            <input className="st-input" value={look.camera} onChange={(e) => set("camera", e.target.value)} placeholder="Arri Alexa, anamorphic" />
          </Field>
          <Field label="Lens">
            <input className="st-input" value={look.lens} onChange={(e) => set("lens", e.target.value)} placeholder="35mm, shallow depth of field" />
          </Field>
          <Field label="Lighting">
            <input className="st-input" value={look.lighting} onChange={(e) => set("lighting", e.target.value)} placeholder="practical sources, hard key" />
          </Field>
        </div>
        <div className="st-stack">
          <div className="st-card st-stack">
            <span className="st-label">Aspect ratio</span>
            <div className="ohf-opts" role="group" style={{ maxHeight: 260 }}>
              {RATIOS.map((r) => {
                const box = ratioBox(r);
                const active = look.aspectRatio === r;
                return (
                  <button key={r} type="button" className="ohf-opt" aria-pressed={active} onClick={() => set("aspectRatio", r)}>
                    <span className="ohf-opt-ratio" aria-hidden>
                      <span className="ohf-opt-box" style={box ?? undefined} />
                    </span>
                    <span className="ohf-opt-label">{r}</span>
                    {active && (
                      <span className="ohf-opt-check" aria-hidden>
                        <CheckIcon size={12} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <span className="st-muted">Self-hosted H3-Base renders 768p (1344×768 at 16:9).</span>
            <label className="st-toggle">
              <input type="checkbox" checked={look.upscale} onChange={(e) => set("upscale", e.target.checked)} />
              Upscale at export (master-upscaled preset)
            </label>
          </div>
          <div className="st-card st-stack">
            <span className="st-label">LoRAs</span>
            <LoraPicker value={look.loras} onChange={(v) => set("loras", v)} />
            <span className="st-muted">Project defaults for every shot; a shot can override them. A speed LoRA’s steps hint becomes the default step count.</span>
          </div>
          <div className="st-card st-stack">
            <span className="st-label">Constraints (negative)</span>
            <Chips
              values={look.negative}
              onRemove={(i) => set("negative", look.negative.filter((_, j) => j !== i))}
              onAdd={(v) => look.negative.length < 10 && set("negative", [...look.negative, v])}
              placeholder="no on-screen text"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
