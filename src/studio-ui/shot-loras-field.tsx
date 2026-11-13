"use client";

import { describeParams, findModel, resolveParams, type ModelEntry } from "@/studio/models";
import type { ShotInput } from "@/studio/schemas";
import { assignedRefs, fitsShot, shotSwitches, shotWorkflows, trainedFor, turboFor } from "@/studio/shot-loras";
import type { Lora } from "@/studio/types";

import { useT } from "./i18n";
import { LORA_KIND_LABEL, useLoraLibrary } from "./lora-picker";

/* A shot's LoRAs, as the user sees them: two switches. Use turbo loads the
   speed LoRA for the shot's workflow; use LoRA loads the style / effect LoRAs
   the director assigned once the board was designed, listed with why. The
   user never picks a LoRA here; the settings line says what the switches set. */

const H3 = findModel("minimax-h3") as ModelEntry;

type Spec = Pick<ShotInput, "mode" | "link" | "loras" | "useTurbo" | "useLoras">;

export function ShotLorasField({ value, onChange }: { value: Spec; onChange: (patch: Pick<ShotInput, "useTurbo" | "useLoras">) => void }) {
  const tr = useT();
  const { loras: library, error } = useLoraLibrary();
  const on = shotSwitches(value);
  const workflows = shotWorkflows(value);
  const byId = new Map((library ?? []).map((l) => [l.id, l]));
  const turbo = library ? turboFor(library, workflows[0]!) : undefined;
  const assigned = assignedRefs(value, (id) => byId.get(id)?.kind);
  /* not considered yet, considered and none suits, or assigned (a speed LoRA left in an older list counts as none) */
  const state = value.loras === undefined ? "unassigned" : assigned.length ? "assigned" : "none";
  const loading = (on.turbo && turbo ? [{ ...turbo, strength: turbo.defaultStrength }] : []).concat(
    on.loras ? assigned.flatMap((r) => { const l = byId.get(r.id); return l && workflows.some((w) => trainedFor(l, w)) ? [{ ...l, strength: r.strength ?? l.defaultStrength }] : []; }) : [],
  );
  const settings = resolveParams(H3, { workflow: workflows[0], loras: loading }).params;

  return (
    <div className="st-card st-stack sl-field">
      <div className="st-row st-row--between">
        <span className="st-label" style={{ marginBottom: 0 }}>{tr("LoRAs")}</span>
        <span className="st-muted st-num">{workflows.join(" / ")}</span>
      </div>
      {error && <span className="st-danger">{error}</span>}

      <label className="sl-switch">
        <input type="checkbox" checked={on.turbo} onChange={(e) => onChange({ useTurbo: e.target.checked })} />
        <span className="sl-switch-text">
          <strong>{tr("Use turbo")}</strong>
          <span className="st-muted">
            {!library ? tr("Loading library…") : on.turbo ? (turbo ? tr("{name}: the speed LoRA for {workflow}", { name: turbo.name, workflow: workflows.join(" / ") }) : tr("The library has no speed LoRA for {workflow}: the base chain.", { workflow: workflows.join(" / ") })) : tr("Off: the base chain, about 2.5× the render time.")}
          </span>
        </span>
      </label>

      <label className="sl-switch" data-disabled={assigned.length === 0 ? "true" : undefined}>
        <input type="checkbox" checked={on.loras && assigned.length > 0} disabled={assigned.length === 0} onChange={(e) => onChange({ useLoras: e.target.checked })} />
        <span className="sl-switch-text">
          <strong>{tr("Use LoRA")}</strong>
          <span className="st-muted">
            {state === "unassigned" ? tr("The director has not assigned LoRAs to this shot yet: it does once the board is designed.") : state === "none" ? tr("The director found no LoRA that suits this shot.") : on.loras ? tr("The LoRAs the director assigned to this shot:") : tr("Off: the LoRAs the director assigned stay out of the take.")}
          </span>
        </span>
      </label>
      {assigned.length > 0 && (
        <ul className="sl-assigned" data-off={on.loras ? undefined : "true"}>
          {assigned.map((r) => {
            const l = byId.get(r.id);
            const fits = l ? workflows.some((w) => trainedFor(l, w)) : false;
            return (
              <li key={r.id}>
                <span className="sl-assigned-head">
                  <span className="sl-assigned-name">{l?.name ?? r.id}</span>
                  {l && <span className="st-lora-kind">{tr(`${LORA_KIND_LABEL[l.kind] ?? l.kind}||LoRA kind`)}</span>}
                  <span className="st-num st-muted">×{r.strength ?? l?.defaultStrength ?? 1}</span>
                </span>
                {r.why && <span className="sl-assigned-why">{r.why}</span>}
                {library && !l && <span className="st-warn">{tr("Not in the library any more: it will not load.")}</span>}
                {l && !fits && <span className="st-warn">{tr("Not trained for {workflow}: it will not load. Ask the director to assign again.", { workflow: workflows.join(" / ") })}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {library && (
        <span className="st-muted st-num sl-settings">
          {tr("Settings: {params}", { params: describeParams(settings) })}
        </span>
      )}
    </div>
  );
}

/** The chips a shot card shows: what loads beyond the default, by name. */
export function shotLoraChips(spec: Spec, library: Lora[] | null): Array<{ key: string; label: string; off?: boolean; title?: string }> {
  const on = shotSwitches(spec);
  const byId = new Map((library ?? []).map((l) => [l.id, l]));
  const chips: Array<{ key: string; label: string; off?: boolean; title?: string }> = [];
  if (!on.turbo) chips.push({ key: "turbo", label: "no turbo" });
  for (const r of assignedRefs(spec, (id) => byId.get(id)?.kind)) {
    const lora = byId.get(r.id);
    /* struck while use LoRA is off, or when it cannot load on this shot (the lint says why) */
    chips.push({ key: r.id, label: lora?.name ?? r.id, off: !on.loras || (library !== null && (!lora || !fitsShot(lora, spec))), title: r.why });
  }
  return chips;
}
