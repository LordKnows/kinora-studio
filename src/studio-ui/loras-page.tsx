"use client";

import { useCallback, useEffect, useState } from "react";

import { OpenOutIcon } from "./icons";
import { LORA_KINDS, type LoraInput } from "@/studio/schemas";
import type { Lora } from "@/studio/types";

import { del, describe, get, patch, post } from "./api";
import { Button, Drawer, Empty, ErrorBanner, Field, Section, Skeleton, useAction } from "./common";
import { LORA_KIND_LABEL } from "./lora-picker";

/* The global LoRA library: speed LoRAs (fewer steps), style and effect LoRAs.
   Files live in the pod's models/loras; a HuggingFace link lets the pod fetch
   a missing file on first use. Projects pick defaults on the Look page. */

const WORKFLOWS = ["T2VA", "I2VA", "FL2VA", "R2VA"] as const;

type Draft = LoraInput;

function emptyDraft(): Draft {
  return { name: "", kind: "speed", filename: "", hfUrl: undefined, triggerWords: "", defaultStrength: 1, stepsHint: undefined, workflows: [], notes: "" };
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
  const [loras, setLoras] = useState<Lora[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Lora | "new" | null>(null);

  const reload = useCallback(async () => {
    try {
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
    if (!window.confirm(`Delete ${lora.name} from the library? Projects that reference it will simply skip it.`)) return;
    await del(`/api/loras/${lora.id}`);
    await reload();
  });

  return (
    <div className={embedded ? "st-stack" : "st-page"}>
      <div className="st-page-head" style={embedded ? { marginBottom: 4 } : undefined}>
        <div>
          {!embedded && <h1 className="st-title">LoRAs</h1>}
          <p className="st-subtitle">Speed LoRAs cut the step count; style and effect LoRAs shape the look. Projects pick defaults on Brief & style; a shot can override.</p>
        </div>
        <div className="st-actions">
          <Button kind="primary" onClick={() => setEditing("new")}>
            Add LoRA
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
          <Empty title="No LoRAs yet" hint="Add the acceleration LoRA first (e.g. lightx2v 8-step), then any style or effect LoRAs you use.">
            <Button kind="primary" onClick={() => setEditing("new")}>
              Add LoRA
            </Button>
          </Empty>
        </div>
      ) : (
        LORA_KINDS.map((kind) => {
          const group = loras.filter((l) => l.kind === kind);
          if (group.length === 0) return null;
          return (
            <Section key={kind} title={`${LORA_KIND_LABEL[kind]} LoRAs`}>
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>File</th>
                    <th>Strength</th>
                    <th>Steps</th>
                    <th>Trigger words</th>
                    <th>Workflows</th>
                    <th>Source</th>
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
                      <td className="st-num">{l.defaultStrength}</td>
                      <td className="st-num">{l.stepsHint ?? "—"}</td>
                      <td className="st-lora-trigger">{l.triggerWords || "—"}</td>
                      <td>{l.workflows.length ? l.workflows.join(", ") : "all"}</td>
                      <td>
                        {l.hfUrl ? (
                          <a className="st-link st-link--ext" href={l.hfUrl} target="_blank" rel="noreferrer noopener">
                            {hfLabel(l.hfUrl)} <OpenOutIcon size={11} />
                          </a>
                        ) : (
                          <span className="st-muted">on the volume</span>
                        )}
                      </td>
                      <td>
                        <Button size="sm" kind="quiet" onClick={() => setEditing(l)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
  const [draft, setDraft] = useState<Draft>(
    lora
      ? { name: lora.name, kind: lora.kind, filename: lora.filename, hfUrl: lora.hfUrl, triggerWords: lora.triggerWords, defaultStrength: lora.defaultStrength, stepsHint: lora.stepsHint, workflows: lora.workflows as Draft["workflows"], notes: lora.notes }
      : emptyDraft(),
  );
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setDraft({ ...draft, [key]: v });

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
      title={lora ? lora.name : "New LoRA"}
      onClose={onClose}
      head={
        <span className="st-row">
          {onDelete && (
            <Button kind="danger" size="sm" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button kind="primary" size="sm" busy={save.busy} disabled={!draft.name.trim() || !draft.filename.trim()} onClick={() => void save.fire()}>
            {lora ? "Save" : "Create"}
          </Button>
        </span>
      }
    >
      <div className="st-stack">
        <ErrorBanner error={save.error} onDismiss={save.dismiss} />
        <div className="st-fields">
          <Field label="Kind">
            <select className="st-select" value={draft.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
              {LORA_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LORA_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input className="st-input" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="lightx2v 8-step" />
          </Field>
        </div>
        <Field label="Filename" hint="Inside ComfyUI's models/loras on the pod.">
          <input className="st-input" value={draft.filename} onChange={(e) => set("filename", e.target.value)} placeholder="h3_lightx2v_8step.safetensors" />
        </Field>
        <Field label="HuggingFace link" hint="Paste the file's HuggingFace link (…/blob/main/xxx.safetensors); the pod downloads it into models/loras when missing.">
          <input className="st-input" value={draft.hfUrl ?? ""} onChange={(e) => set("hfUrl", e.target.value || undefined)} placeholder="https://huggingface.co/…/blob/main/xxx.safetensors" />
        </Field>
        <div className="st-fields">
          <Field label={`Default strength · ${draft.defaultStrength.toFixed(2)}`}>
            <input type="range" min={0} max={2} step={0.05} value={draft.defaultStrength} onChange={(e) => set("defaultStrength", Number(e.target.value))} className="st-range" />
          </Field>
          <Field label="Steps hint" hint="Speed LoRAs: the step count they are trained for; becomes the project default.">
            <input className="st-input" type="number" min={1} max={60} value={draft.stepsHint ?? ""} onChange={(e) => set("stepsHint", e.target.value ? Math.max(1, Math.min(60, Math.round(Number(e.target.value)))) : undefined)} placeholder="8" />
          </Field>
        </div>
        <Field label="Trigger words" hint="Appended to the LOOK block when this LoRA is active.">
          <input className="st-input" value={draft.triggerWords} onChange={(e) => set("triggerWords", e.target.value)} placeholder="anime style, flat shading" />
        </Field>
        <Field label="Workflows" hint="None selected = applies to every workflow.">
          <div className="st-chips">
            {WORKFLOWS.map((w) => (
              <button key={w} type="button" className="st-chip st-chip--btn" aria-pressed={draft.workflows.includes(w)} onClick={() => toggleWorkflow(w)}>
                {w}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Notes">
          <textarea className="st-textarea" rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
    </Drawer>
  );
}
