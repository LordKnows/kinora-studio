"use client";

import { useCallback, useEffect, useState } from "react";

import { OpenOutIcon } from "./icons";
import { describeParams, MODELS, type InferenceParams } from "@/studio/models";
import { LORA_KINDS, type LoraInput } from "@/studio/schemas";
import type { Lora } from "@/studio/types";

import { del, describe, get, patch, post } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, NumberInput, Section, Skeleton, useAction } from "./common";
import { useT } from "./i18n";
import { invalidateLoraLibrary, LORA_KIND_LABEL } from "./lora-picker";

/* The global LoRA library: speed LoRAs (fewer steps), style and effect LoRAs.
   Files live in the pod's models/loras; a HuggingFace link lets the pod fetch
   a missing file on first use. Projects pick defaults on the Look page. */

const WORKFLOWS = ["T2VA", "I2VA", "FL2VA", "R2VA"] as const;

/* the model families a LoRA can be trained for, named after their first model */
export const FAMILIES: Array<[string, string]> = MODELS.filter((m) => m.runtime === "pod").reduce<Array<[string, string]>>((out, m) => (out.some(([f]) => f === m.family) ? out : [...out, [m.family, `${m.label} (${m.kind})`]]), []);

type Draft = LoraInput;

function emptyDraft(): Draft {
  return { name: "", kind: "speed", filename: "", hfUrl: undefined, triggerWords: "", defaultStrength: 1, stepsHint: undefined, workflows: [], notes: "", baseModel: "minimax-h3", params: {} };
}

function hfLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("huggingface.co")) {
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.slice(0, 2).join("/") || u.pathname;
    }
    return u.hostname;
  } catch {
    return url;
  }
}

export function LorasPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const [loras, setLoras] = useState<Lora[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Lora | "new" | null>(null);

  const reload = useCallback(async () => {
    try {
      invalidateLoraLibrary();
      setLoras((await get<{ loras: Lora[] }>("/api/loras")).loras);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
      setLoras([]);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = useAction(async (_confirm, lora: Lora) => {
    if (!window.confirm(t("Delete {name} from the library? Shots it was assigned to will simply skip it.", { name: lora.name }))) return;
    await del(`/api/loras/${lora.id}`);
    await reload();
  });

  return (
    <div className={embedded ? "st-stack" : "st-page"}>
      <div className="st-page-head" style={embedded ? { marginBottom: 4 } : undefined}>
        <div>
          {!embedded && <h1 className="st-title">{t("LoRAs")}</h1>}
          <p className="st-subtitle">{t("Speed LoRAs cut the step count; style and effect LoRAs shape the look. Each carries the settings its card recommends. Nobody picks them per project: every shot has Use turbo (the speed LoRA for its workflow) and Use LoRA (the style and effect LoRAs the director assigned it, from their notes) on the Board.")}</p>
        </div>
        <div className="st-actions">
          <Button kind="primary" onClick={() => setEditing("new")}>
            {t("Add LoRA")}
          </Button>
        </div>
      </div>
      {error && <div style={{ marginTop: 12 }}><ErrorBanner error={error} onDismiss={() => setError(null)} /></div>}
      <ErrorBanner error={remove.error} onDismiss={remove.dismiss} />

      {loras === null ? (
        <div className="st-section">
          <Skeleton height={120} />
        </div>
      ) : loras.length === 0 ? (
        <div className="st-section">
          <Empty title={t("No LoRAs yet")} hint={t("Add the acceleration LoRA first (e.g. lightx2v 8-step), then any style or effect LoRAs you use.")}>
            <Button kind="primary" onClick={() => setEditing("new")}>
              {t("Add LoRA")}
            </Button>
          </Empty>
        </div>
      ) : (
        LORA_KINDS.map((kind) => {
          const group = loras.filter((l) => l.kind === kind);
          if (group.length === 0) return null;
          return (
            <Section key={kind} title={t("{kind} LoRAs", { kind: t(`${LORA_KIND_LABEL[kind]}||LoRA kind`) })}>
              <div className="st-table-scroll"><table className="st-table">
                <thead>
                  <tr>
                    <th>{t("Name")}</th>
                    <th>{t("File")}</th>
                    <th>{t("Model")}</th>
                    <th>{t("Recommended")}</th>
                    <th>{t("Trigger words")}</th>
                    <th>{t("Workflows")}</th>
                    <th>{t("Source")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {group.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <button type="button" className="st-link st-link--btn" onClick={() => setEditing(l)}>
                          {l.name}
                        </button>
                        {l.notes && <div className="st-muted st-lora-notes">{l.notes}</div>}
                      </td>
                      <td className="st-num st-lora-file">{l.filename}</td>
                      <td>{FAMILIES.find(([f]) => f === l.baseModel)?.[1] ?? l.baseModel}</td>
                      <td className="st-num">{describeParams(l.recommended) || "—"}</td>
                      <td className="st-lora-trigger">{l.triggerWords || "—"}</td>
                      <td>{l.workflows.length ? l.workflows.join(", ") : t("all||workflows")}</td>
                      <td>
                        {l.hfUrl ? (
                          <a className="st-link st-link--ext" href={l.hfUrl} target="_blank" rel="noreferrer noopener">
                            {hfLabel(l.hfUrl)} <OpenOutIcon size={11} />
                          </a>
                        ) : (
                          <span className="st-muted">{t("on the volume")}</span>
                        )}
                      </td>
                      <td>
                        <Button size="sm" kind="quiet" onClick={() => setEditing(l)}>
                          {t("Edit")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Section>
          );
        })
      )}

      {editing && (
        <LoraEditor
          lora={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
          onDelete={editing === "new" ? undefined : () => void remove.fire(editing)}
        />
      )}
    </div>
  );
}

function LoraEditor({ lora, onClose, onSaved, onDelete }: { lora?: Lora; onClose: () => void; onSaved: () => Promise<void>; onDelete?: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(
    lora
      ? { name: lora.name, kind: lora.kind, filename: lora.filename, hfUrl: lora.hfUrl, triggerWords: lora.triggerWords, defaultStrength: lora.defaultStrength, stepsHint: lora.stepsHint, workflows: lora.workflows as Draft["workflows"], notes: lora.notes, baseModel: lora.baseModel, params: lora.params }
      : emptyDraft(),
  );
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setDraft({ ...draft, [key]: v });
  const setParam = <K extends keyof InferenceParams>(key: K, v: InferenceParams[K] | undefined) => {
    const next = { ...draft.params } as InferenceParams;
    if (v === undefined || v === "" || (Array.isArray(v) && v.some((x) => x === undefined))) delete next[key];
    else next[key] = v;
    setDraft({ ...draft, params: next });
  };
  /* what the Studio already knows (its card, as seeded) shows through as placeholders */
  const known = lora?.recommended ?? {};

  const save = useAction(async () => {
    const body = { ...draft, hfUrl: draft.hfUrl?.trim() ? draft.hfUrl.trim() : lora ? null : undefined, stepsHint: draft.stepsHint ?? (lora ? null : undefined) };
    if (lora) await patch(`/api/loras/${lora.id}`, body);
    else await post("/api/loras", body);
    await onSaved();
  });

  const toggleWorkflow = (w: (typeof WORKFLOWS)[number]) =>
    set("workflows", draft.workflows.includes(w) ? draft.workflows.filter((x) => x !== w) : [...draft.workflows, w]);

  return (
    <Drawer
      title={lora ? lora.name : t("New LoRA")}
      onClose={onClose}
      head={
        <span className="st-row">
          {onDelete && (
            <Button kind="danger" size="sm" onClick={onDelete}>
              {t("Delete")}
            </Button>
          )}
          <Button kind="primary" size="sm" busy={save.busy} disabled={!draft.name.trim() || !draft.filename.trim()} onClick={() => void save.fire()}>
            {lora ? t("Save") : t("Create")}
          </Button>
        </span>
      }
    >
      <div className="st-stack">
        <ErrorBanner error={save.error} onDismiss={save.dismiss} />
        <div className="st-fields">
          <Field label={t("Kind")}>
            <select className="st-select" value={draft.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
              {LORA_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`${LORA_KIND_LABEL[k]}||LoRA kind`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Name")}>
            <input className="st-input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="lightx2v 8-step" />
          </Field>
        </div>
        <Field label={t("Filename")} hint={t("Inside ComfyUI's models/loras on the pod.")}>
          <input className="st-input" value={draft.filename} onChange={(e) => set("filename", e.target.value)} placeholder="h3_lightx2v_8step.safetensors" />
        </Field>
        <Field label={t("HuggingFace link")} hint={t("Paste the file's HuggingFace link (…/blob/main/xxx.safetensors); the pod downloads it into models/loras when missing.")}>
          <input className="st-input" value={draft.hfUrl ?? ""} onChange={(e) => set("hfUrl", e.target.value || undefined)} placeholder="https://huggingface.co/…/blob/main/xxx.safetensors" />
        </Field>
        <div className="st-fields">
          <Field label={t("Default strength · {n}", { n: draft.defaultStrength.toFixed(2) })}>
            <input type="range" min={0} max={2} step={0.05} value={draft.defaultStrength} onChange={(e) => set("defaultStrength", Number(e.target.value))} className="st-range" />
          </Field>
          <Field label={t("Steps hint")} hint={t("Speed LoRAs: the step count they are trained for; becomes the project default.")}>
            <NumberInput min={1} max={60} allowEmpty value={draft.stepsHint} onCommit={(v) => set("stepsHint", v ?? undefined)} placeholder="8" />
          </Field>
        </div>
        <Field label={t("Base model")} hint={t("The model family it was trained for; it only loads with that family's workflows.")}>
          <select className="st-select" value={draft.baseModel} onChange={(e) => set("baseModel", e.target.value)}>
            {FAMILIES.map(([f, label]) => <option key={f} value={f}>{label}</option>)}
          </select>
        </Field>
        <div className="st-stack st-stack--tight">
          <span className="st-label">{t("Recommended settings")} <span className="st-muted">{t("— from its model card; a speed LoRA's replace the base model's when it is picked")}</span></span>
          <div className="st-fields st-canvas-fields">
            <Field label={t("Sampler")}><input className="st-input" value={draft.params.sampler ?? ""} placeholder={known.sampler ?? "euler"} onChange={(e) => setParam("sampler", e.target.value.trim() || undefined)} /></Field>
            <Field label={t("Scheduler")}><input className="st-input" value={draft.params.scheduler ?? ""} placeholder={known.scheduler ?? "simple"} onChange={(e) => setParam("scheduler", e.target.value.trim() || undefined)} /></Field>
            <Field label="CFG"><NumberInput integer={false} min={0} max={30} allowEmpty value={draft.params.cfg} placeholder={known.cfg !== undefined ? String(known.cfg) : "—"} onCommit={(v) => setParam("cfg", v ?? undefined)} /></Field>
            <Field label={t("Shift (video)")}><NumberInput integer={false} min={0} max={30} allowEmpty value={draft.params.shiftVideo} placeholder={known.shiftVideo !== undefined ? String(known.shiftVideo) : "—"} onCommit={(v) => setParam("shiftVideo", v ?? undefined)} /></Field>
            <Field label={t("Shift (audio)")}><NumberInput integer={false} min={0} max={30} allowEmpty value={draft.params.shiftAudio} placeholder={known.shiftAudio !== undefined ? String(known.shiftAudio) : "—"} onCommit={(v) => setParam("shiftAudio", v ?? undefined)} /></Field>
            <Field label={t("Strength from")}><NumberInput integer={false} min={0} max={2} allowEmpty value={draft.params.strengthRange?.[0]} placeholder={known.strengthRange ? String(known.strengthRange[0]) : "—"} onCommit={(v) => setParam("strengthRange", v === null ? undefined : [v, draft.params.strengthRange?.[1] ?? known.strengthRange?.[1] ?? 2])} /></Field>
            <Field label={t("Strength to")}><NumberInput integer={false} min={0} max={2} allowEmpty value={draft.params.strengthRange?.[1]} placeholder={known.strengthRange ? String(known.strengthRange[1]) : "—"} onCommit={(v) => setParam("strengthRange", v === null ? undefined : [draft.params.strengthRange?.[0] ?? known.strengthRange?.[0] ?? 0, v])} /></Field>
          </div>
          {lora && <span className="st-muted st-num">{t("In effect: {params}", { params: describeParams(lora.recommended) || t("the base model's settings") })}</span>}
        </div>
        <Field label={t("Trigger words")} hint={t("Appended to the LOOK block when this LoRA is active.")}>
          <input className="st-input" value={draft.triggerWords} onChange={(e) => set("triggerWords", e.target.value)} placeholder="anime style, flat shading" />
        </Field>
        <Field label={t("Workflows")} hint={t("None selected = applies to every workflow.")} group>
          <div className="st-chips">
            {WORKFLOWS.map((w) => (
              <button key={w} type="button" className="st-chip st-chip--btn" aria-pressed={draft.workflows.includes(w)} onClick={() => toggleWorkflow(w)}>
                {w}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t("Notes")} hint={t("What it suits and what to watch for: the director reads this when it assigns LoRAs to shots.")}>
          <textarea className="st-textarea" rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
    </Drawer>
  );
}
