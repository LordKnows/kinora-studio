"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { LoraRef } from "@/studio/schemas";
import type { Lora } from "@/studio/types";

import { describe, get } from "./api";

/* The library, loaded once per mount, for pickers on the Look page and in the
   shot editor. Checked LoRAs carry a strength that defaults to the library's. */

export function useLoraLibrary() {
  const [loras, setLoras] = useState<Lora[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    get<{ loras: Lora[] }>("/api/loras")
      .then((r) => live && setLoras(r.loras))
      .catch((caught) => live && setError(describe(caught)));
    return () => {
      live = false;
    };
  }, []);
  return { loras, error };
}

export const LORA_KIND_LABEL: Record<string, string> = { speed: "Speed", style: "Style", effect: "Effect" };

export function LoraPicker({ value, onChange, compact }: { value: LoraRef[]; onChange: (next: LoraRef[]) => void; compact?: boolean }) {
  const { loras, error } = useLoraLibrary();
  if (error) return <span className="st-danger">{error}</span>;
  if (!loras) return <span className="st-muted">Loading library…</span>;
  if (loras.length === 0) {
    return (
      <span className="st-muted">
        The LoRA library is empty. <Link className="st-link" href="/loras">Add LoRAs</Link>.
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
              <input type="checkbox" checked={on} disabled={!on && value.length >= 6} onChange={(e) => onChange(e.target.checked ? [...value, { id: l.id, strength: l.defaultStrength }] : value.filter((r) => r.id !== l.id))} />
              <span className="st-lora-name">{l.name}</span>
              <span className="st-lora-kind">{LORA_KIND_LABEL[l.kind] ?? l.kind}</span>
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
                  aria-label={`${l.name} strength`}
                />
                {l.kind === "speed" && l.stepsHint ? <span className="st-muted st-num">{l.stepsHint} steps</span> : null}
              </span>
            )}
          </div>
        );
      })}
      {!compact && (
        <span className="st-muted">
          <Link className="st-link" href="/loras">Manage the library</Link>
        </span>
      )}
    </div>
  );
}
