"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { describeParams } from "@/studio/models";
import type { LoraRef } from "@/studio/schemas";
import type { Lora } from "@/studio/types";

import { describe, get } from "./api";
import { useT } from "./i18n";

/* The library, loaded once per page and shared by every reader (the Board's
   shot cards, the shot editor, the image settings' picker). The LoRAs page
   drops the copy when it changes the library. Checked LoRAs in a picker carry
   a strength that defaults to the library's. */

let shared: Promise<Lora[]> | null = null;

export function invalidateLoraLibrary(): void {
  shared = null;
}

export function useLoraLibrary() {
  const [loras, setLoras] = useState<Lora[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    shared ??= get<{ loras: Lora[] }>("/api/loras").then((r) => r.loras);
    shared
      .then((r) => live && setLoras(r))
      .catch((caught) => {
        shared = null;
        if (live) setError(describe(caught));
      });
    return () => {
      live = false;
    };
  }, []);
  return { loras, error };
}

export const LORA_KIND_LABEL: Record<string, string> = { speed: "Speed", style: "Style", effect: "Effect" };

export function LoraPicker({ value, onChange, compact, family = "minimax-h3", adult = true }: { value: LoraRef[]; onChange: (next: LoraRef[]) => void; compact?: boolean; family?: string; adult?: boolean }) {
  const { loras: all, error } = useLoraLibrary();
  const tr = useT();
  /* only LoRAs trained for this model family load into its workflows */
  const loras = all?.filter((l) => (l.baseModel ?? "minimax-h3") === family || value.some((r) => r.id === l.id)) ?? null;
  if (error) return <span className="st-danger">{error}</span>;
  if (!loras) return <span className="st-muted">{tr("Loading library…")}</span>;
  if (loras.length === 0) {
    return (
      <span className="st-muted">
        {tr("The LoRA library is empty.")} <Link className="st-link" href="/loras">{tr("Add LoRAs")}</Link>{tr(".")}
      </span>
    );
  }
  const refOf = (id: string) => value.find((r) => r.id === id);
  return (
    <div className="st-lora-list" data-compact={compact ? "true" : undefined}>
      {loras.map((l) => {
        const ref = refOf(l.id);
        const on = Boolean(ref);
        return (
          <div key={l.id} className="st-lora-row" data-on={on ? "true" : undefined}>
            <label className="st-toggle">
              <input type="checkbox" checked={on} disabled={!on && (value.length >= 6 || (l.adult && !adult))} title={l.adult && !adult ? tr("18+: show 18+ references first (Canvas, top right)") : undefined} onChange={(e) => onChange(e.target.checked ? [...value, { id: l.id, strength: l.recommended?.strength ?? l.defaultStrength }] : value.filter((r) => r.id !== l.id))} />
              <span className="st-lora-name">{l.name}</span>
              {l.adult && <span className="st-ref-badge st-lora-adult">18+</span>}
              <span className="st-lora-kind">{tr(`${LORA_KIND_LABEL[l.kind] ?? l.kind}||LoRA kind`)}</span>
            </label>
            {on && (
              <span className="st-lora-strength">
                <input
                  className="st-input st-input--sm st-num"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={ref?.strength ?? l.defaultStrength}
                  onChange={(e) => onChange(value.map((r) => (r.id === l.id ? { ...r, strength: Math.max(0, Math.min(2, Number(e.target.value) || 0)) } : r)))}
                  aria-label={tr("{name} strength", { name: l.name })}
                />
                {(() => {
                  const r = l.recommended ?? {};
                  const strength = ref?.strength ?? l.defaultStrength;
                  const off = r.strengthRange && (strength < r.strengthRange[0] || strength > r.strengthRange[1]);
                  /* a speed LoRA sets the sampling chain; the others only their strength */
                  const text = l.kind === "speed" ? describeParams({ ...r, strength: undefined, strengthRange: undefined }) : r.strengthRange ? tr("card: {a}–{b}", { a: r.strengthRange[0], b: r.strengthRange[1] }) : "";
                  return text ? <span className={off ? "st-warn st-num" : "st-muted st-num"} title={l.kind === "speed" ? tr("Picking it sets these") : undefined}>{l.kind === "speed" ? tr("sets {params}", { params: text }) : text}</span> : null;
                })()}
              </span>
            )}
          </div>
        );
      })}
      {!compact && (
        <span className="st-muted">
          <Link className="st-link" href="/loras">{tr("Manage the library")}</Link>
        </span>
      )}
    </div>
  );
}
