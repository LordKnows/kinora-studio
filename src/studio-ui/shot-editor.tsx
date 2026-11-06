"use client";

import { CloseIcon } from "./icons";
import { CINEMA, type CinemaCategoryKey } from "@/studio/cinematography";
import { EDIT_GRAMMAR, type LinkType } from "@/studio/editing";
import { CAMERA_MOVES, MOTION_SOURCES, SCREEN_POSITIONS, SHOT_MODES, type ShotInput } from "@/studio/schemas";
import type { Element, Take } from "@/studio/types";

import { Button, Chips, Field } from "./common";
import { LoraPicker } from "./lora-picker";
import { useProjectContext } from "./shell";

/* The structured shot form. Validation mirrors ShotInput's refinements so the
   obvious mistakes (beats not tiling the duration) are caught before the
   request leaves the browser. */

export type ShotDraft = ShotInput;

export function validateDraft(d: ShotDraft): string[] {
  const problems: string[] = [];
  const sorted = [...d.beats].sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const b of sorted) {
    if (Math.abs(b.from - cursor) > 0.01) {
      problems.push(`Beats must tile the shot: expected a beat starting at ${cursor}s.`);
      break;
    }
    if (b.to <= b.from) {
      problems.push("Each beat must end after it starts.");
      break;
    }
    cursor = b.to;
  }
  if (Math.abs(cursor - d.durationS) > 0.01) problems.push(`Beats end at ${cursor}s but the shot is ${d.durationS}s.`);
  if (d.beats.filter((b) => b.cut).length > 3) problems.push("At most 3 cuts per shot.");
  if (d.beats.some((b) => b.action.trim().length < 5)) problems.push("Every beat needs an action.");
  if (d.intent.trim().length < 5) problems.push("Intent is required.");
  if (d.mode === "edit" && !d.sourceTakeId) problems.push("Edit mode needs a source take.");
  if (d.mode === "edit" && !d.editInstruction?.trim()) problems.push("Edit mode needs an edit instruction.");
  return problems;
}

export function ShotEditor({
  value,
  onChange,
  elements,
  takes,
  shotId,
}: {
  value: ShotDraft;
  onChange: (next: ShotDraft) => void;
  elements: Element[];
  takes: Take[];
  /** The shot being edited, so the anchor picker lists only earlier shots. */
  shotId?: string;
}) {
  const { view } = useProjectContext();
  const set = <K extends keyof ShotDraft>(key: K, v: ShotDraft[K]) => onChange({ ...value, [key]: v });
  const characters = elements.filter((e) => e.kind === "character");
  const locations = elements.filter((e) => e.kind === "location");
  const props = elements.filter((e) => e.kind === "prop");

  /* Tier 2: the link. `linkToPrev` is mirrored for older readers. */
  const linkType: LinkType = value.link?.type ?? (value.linkToPrev === "continuous" ? "continuous" : "cut");
  const grammar = EDIT_GRAMMAR.find((g) => g.type === linkType)!;
  const setLink = (next: Partial<NonNullable<ShotDraft["link"]>> & { type?: LinkType }) => {
    const type = next.type ?? linkType;
    const g = EDIT_GRAMMAR.find((x) => x.type === type)!;
    const link = { ...(value.link ?? {}), type, ...next };
    if (next.type && next.type !== linkType) {
      delete link.anchorShotId;
      link.anchor = g.mechanism === "none" ? undefined : g.defaultAnchor;
    }
    if (g.mechanism === "none") {
      delete link.anchor;
      delete link.anchorShotId;
    }
    onChange({ ...value, link, linkToPrev: type === "continuous" ? "continuous" : "cut" });
  };
  const earlier = (() => {
    const all = (view?.scenes ?? []).flatMap((sc) => sc.shots.map((sh) => ({ id: sh.id, scene: sc.slug, index: sh.index, intent: sh.spec.intent })));
    const at = shotId ? all.findIndex((x) => x.id === shotId) : -1;
    return at >= 0 ? all.slice(0, at) : all;
  })();

  /* Tier 3: cinematography keys. */
  const cine = value.cinematography ?? {};
  const setCine = (key: CinemaCategoryKey, v: string | string[] | undefined) => {
    const next = { ...cine, [key]: v && (Array.isArray(v) ? v.length : v) ? v : undefined };
    const clean = Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined));
    set("cinematography", Object.keys(clean).length ? (clean as ShotDraft["cinematography"]) : undefined);
  };

  return (
    <div className="st-stack">
      <div className="st-fields">
        <Field label="Duration (s)">
          <input className="st-input" type="number" min={5} max={15} step={1} value={value.durationS} onChange={(e) => set("durationS", Math.max(5, Math.min(15, Math.round(Number(e.target.value) || 5))))} />
        </Field>
        <Field label="Mode">
          <select className="st-select" value={value.mode} onChange={(e) => set("mode", e.target.value as ShotDraft["mode"])}>
            {SHOT_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Edit</span>
        <div className="st-fields">
          <Field label="Link to earlier shots">
            <select className="st-select" value={linkType} onChange={(e) => setLink({ type: e.target.value as LinkType })}>
              {EDIT_GRAMMAR.map((g) => (
                <option key={g.type} value={g.type} title={g.when}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          {grammar.mechanism !== "none" && (
            <Field label="Anchor (offset)" hint="-1 = previous shot, -2 = the one before it.">
              <input
                className="st-input"
                type="number"
                min={-8}
                max={-1}
                step={1}
                value={value.link?.anchor ?? grammar.defaultAnchor}
                disabled={Boolean(value.link?.anchorShotId)}
                onChange={(e) => setLink({ anchor: Math.max(-8, Math.min(-1, Math.round(Number(e.target.value) || grammar.defaultAnchor))) })}
              />
            </Field>
          )}
          {grammar.mechanism !== "none" && (
            <Field label="Or a specific shot">
              <select className="st-select" value={value.link?.anchorShotId ?? ""} onChange={(e) => setLink({ anchorShotId: e.target.value || undefined })}>
                <option value="">— by offset —</option>
                {earlier.map((sh) => (
                  <option key={sh.id} value={sh.id}>
                    {sh.scene} · {sh.index + 1} · {sh.intent.slice(0, 40)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="st-edit-when">
          <strong>{grammar.label}:</strong> {grammar.when}. <span className="st-muted">{grammar.how} Workflow: {grammar.workflow}.</span>
        </div>
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Cinematography</span>
        <div className="st-cine-grid">
          {CINEMA.filter((c) => !c.multi).map((c) => (
            <Field key={c.key} label={c.label}>
              <select className="st-select st-input--sm" value={(cine[c.key] as string | undefined) ?? ""} onChange={(e) => setCine(c.key, e.target.value || undefined)}>
                <option value="">—</option>
                {c.terms.map((t) => (
                  <option key={t.key} value={t.key} title={t.use}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>
        {CINEMA.filter((c) => c.multi).map((c) => {
          const chosen = (cine[c.key] as string[] | undefined) ?? [];
          return (
            <Field key={c.key} label={`${c.label} (max 4)`}>
              <div className="st-chips">
                {c.terms.map((t) => {
                  const on = chosen.includes(t.key);
                  return (
                    <button
                      key={t.key}
                      type="button"
                      className="st-chip st-chip--btn"
                      aria-pressed={on}
                      title={t.use}
                      disabled={!on && chosen.length >= 4}
                      onClick={() => setCine(c.key, on ? chosen.filter((k) => k !== t.key) : [...chosen, t.key])}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </Field>
          );
        })}
      </div>

      <Field label="Intent" hint="One sentence: what this shot is for.">
        <input className="st-input" value={value.intent} onChange={(e) => set("intent", e.target.value)} />
      </Field>

      {value.mode === "edit" && (
        <div className="st-card st-stack">
          <Field label="Source take">
            <select className="st-select" value={value.sourceTakeId ?? ""} onChange={(e) => set("sourceTakeId", e.target.value || undefined)}>
              <option value="">Choose a completed take…</option>
              {takes.filter((t) => t.status === "completed").map((t) => (
                <option key={t.id} value={t.id}>
                  Take {t.n} · {t.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Edit instruction" hint="Only what changes. Everything else is kept.">
            <textarea className="st-textarea" rows={3} value={value.editInstruction ?? ""} onChange={(e) => set("editInstruction", e.target.value)} />
          </Field>
        </div>
      )}

      <div className="st-card st-stack">
        <div className="st-row st-row--between">
          <span className="st-label" style={{ marginBottom: 0 }}>Beats</span>
          <Button
            size="sm"
            disabled={value.beats.length >= 6}
            onClick={() => {
              const last = value.beats[value.beats.length - 1];
              const from = last ? last.to : 0;
              set("beats", [...value.beats, { from, to: Math.min(value.durationS, from + Math.max(1, value.durationS - from)), action: "" }]);
            }}
          >
            Add beat
          </Button>
        </div>
        {value.beats.map((b, i) => (
          <div key={i} className="st-beat">
            <input className="st-input st-input--sm" type="number" step={0.5} value={b.from} onChange={(e) => set("beats", value.beats.map((x, j) => (j === i ? { ...x, from: Number(e.target.value) } : x)))} aria-label="From" />
            <input className="st-input st-input--sm" type="number" step={0.5} value={b.to} onChange={(e) => set("beats", value.beats.map((x, j) => (j === i ? { ...x, to: Number(e.target.value) } : x)))} aria-label="To" />
            <input className="st-input st-input--sm" placeholder="Start state → one action → end state" value={b.action} onChange={(e) => set("beats", value.beats.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))} />
            <label className="st-toggle" title="Hard cut opens this beat">
              <input type="checkbox" checked={Boolean(b.cut)} onChange={(e) => set("beats", value.beats.map((x, j) => (j === i ? { ...x, cut: e.target.checked || undefined } : x)))} />
              cut
            </label>
            <button type="button" className="st-btn st-btn--quiet st-btn--sm" aria-label="Remove beat" disabled={value.beats.length <= 1} onClick={() => set("beats", value.beats.filter((_, j) => j !== i))}>
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Camera</span>
        <div className="st-fields">
          <Field label="Move">
            <select className="st-select" value={value.camera.move} onChange={(e) => set("camera", { ...value.camera, move: e.target.value as ShotDraft["camera"]["move"] })}>
              {CAMERA_MOVES.map((m) => (
                <option key={m} value={m}>
                  {m.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amplitude">
            <select className="st-select" value={value.camera.amplitude} onChange={(e) => set("camera", { ...value.camera, amplitude: e.target.value as ShotDraft["camera"]["amplitude"] })}>
              <option>subtle</option>
              <option>moderate</option>
              <option>strong</option>
            </select>
          </Field>
          <Field label="Speed">
            <select className="st-select" value={value.camera.speed} onChange={(e) => set("camera", { ...value.camera, speed: e.target.value as ShotDraft["camera"]["speed"] })}>
              <option>slow</option>
              <option>medium</option>
              <option>fast</option>
            </select>
          </Field>
        </div>
        <Field label="Note" hint="Free text; does not reset the approval.">
          <input className="st-input" value={value.camera.note ?? ""} onChange={(e) => set("camera", { ...value.camera, note: e.target.value || undefined })} />
        </Field>
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Staging</span>
        <Field label="What moves" hint="At least one; a static camera with nothing moving is a dead frame.">
          <div className="st-chips">
            {MOTION_SOURCES.map((m) => {
              const on = (value.motion ?? []).includes(m);
              return (
                <button key={m} type="button" className="st-chip st-chip--btn" aria-pressed={on} onClick={() => {
                  const next = on ? (value.motion ?? []).filter((x) => x !== m) : [...(value.motion ?? []), m];
                  set("motion", next.length ? next : undefined);
                }}>{m}</button>
              );
            })}
          </div>
        </Field>
        <div className="st-fields">
          <Field label="Subject at" hint="Eyes on the 38 % or 62 % line; centre only for symmetry.">
            <select className="st-select" value={value.composition?.subjectX ?? ""} onChange={(e) => set("composition", e.target.value ? { ...(value.composition ?? {}), subjectX: e.target.value as "left" | "center" | "right" } : undefined)}>
              <option value="">—</option>
              <option value="left">left third (38 %)</option>
              <option value="center">centre</option>
              <option value="right">right third (62 %)</option>
            </select>
          </Field>
          <Field label="Headroom">
            <select className="st-select" disabled={!value.composition} value={value.composition?.headroom ?? ""} onChange={(e) => value.composition && set("composition", { ...value.composition, headroom: (e.target.value || undefined) as "tight" | "normal" | "generous" | undefined })}>
              <option value="">—</option>
              <option value="tight">tight</option>
              <option value="normal">normal</option>
              <option value="generous">generous</option>
            </select>
          </Field>
          <Field label="On screen (s)" hint="Render at least this + 0.5 s for handles.">
            <input className="st-input st-input--sm" type="number" min={1} max={15} step={0.5} value={value.screenS ?? ""} onChange={(e) => set("screenS", e.target.value ? Number(e.target.value) : undefined)} />
          </Field>
        </div>
        <div className="st-row st-row--between">
          <span className="st-muted">Blocking — who enters, crosses or leaves which side of the frame</span>
          <Button size="sm" disabled={(value.blocking?.length ?? 0) >= 6} onClick={() => set("blocking", [...(value.blocking ?? []), { who: characters[0]?.id ?? "someone", from: "off_left", to: "center" }])}>Add</Button>
        </div>
        {(value.blocking ?? []).map((b, i) => (
          <div key={i} className="st-line">
            <input className="st-input st-input--sm" list="st-blocking-who" placeholder="who" value={characters.find((c) => c.id === b.who)?.name ?? b.who} onChange={(e) => {
              const hit = characters.find((c) => c.name === e.target.value);
              set("blocking", (value.blocking ?? []).map((x, j) => (j === i ? { ...x, who: hit?.id ?? e.target.value } : x)));
            }} style={{ width: 120 }} />
            <select className="st-select st-input--sm" value={b.from ?? ""} onChange={(e) => set("blocking", (value.blocking ?? []).map((x, j) => (j === i ? { ...x, from: (e.target.value || undefined) as typeof x.from } : x)))}>
              <option value="">from —</option>
              {SCREEN_POSITIONS.map((p) => <option key={p} value={p}>from {p.replace("_", " ")}</option>)}
            </select>
            <select className="st-select st-input--sm" value={b.to ?? ""} onChange={(e) => set("blocking", (value.blocking ?? []).map((x, j) => (j === i ? { ...x, to: (e.target.value || undefined) as typeof x.to } : x)))}>
              <option value="">to —</option>
              {SCREEN_POSITIONS.map((p) => <option key={p} value={p}>to {p.replace("_", " ")}</option>)}
            </select>
            <input className="st-input st-input--sm" placeholder="path / pace" value={b.note ?? ""} onChange={(e) => set("blocking", (value.blocking ?? []).map((x, j) => (j === i ? { ...x, note: e.target.value || undefined } : x)))} />
            <button type="button" className="st-btn st-btn--quiet st-btn--sm" aria-label="Remove" onClick={() => { const next = (value.blocking ?? []).filter((_, j) => j !== i); set("blocking", next.length ? next : undefined); }}>
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
        <datalist id="st-blocking-who">{characters.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        <div className="st-fields">
          <Field label="First frame shows" hint="Who stands where, facing where, which props are visible. Reviewed before anyone draws it.">
            <textarea className="st-textarea" rows={2} value={value.frames?.first ?? ""} onChange={(e) => set("frames", e.target.value || value.frames?.last ? { ...(value.frames ?? {}), first: e.target.value || undefined } : undefined)} />
          </Field>
          <Field label="Last frame shows">
            <textarea className="st-textarea" rows={2} value={value.frames?.last ?? ""} onChange={(e) => set("frames", e.target.value || value.frames?.first ? { ...(value.frames ?? {}), last: e.target.value || undefined } : undefined)} />
          </Field>
        </div>
      </div>

      <div className="st-card st-stack">
        <div className="st-row st-row--between">
          <span className="st-label" style={{ marginBottom: 0 }}>Dialogue</span>
          <Button size="sm" disabled={value.dialogue.length >= 8 || characters.length === 0} onClick={() => set("dialogue", [...value.dialogue, { speaker: characters[0]!.id, text: "", language: "en", delivery: "neutral" }])}>
            Add line
          </Button>
        </div>
        {characters.length === 0 && <span className="st-muted">Create a character element to add dialogue.</span>}
        {value.dialogue.map((l, i) => (
          <div key={i} className="st-line">
            <select className="st-select st-input--sm" value={l.speaker} onChange={(e) => set("dialogue", value.dialogue.map((x, j) => (j === i ? { ...x, speaker: e.target.value } : x)))}>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input className="st-input st-input--sm" placeholder="The exact line" value={l.text} onChange={(e) => set("dialogue", value.dialogue.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            <input className="st-input st-input--sm" placeholder="en" value={l.language} onChange={(e) => set("dialogue", value.dialogue.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)))} aria-label="Language" />
            <input className="st-input st-input--sm" placeholder="delivery" value={l.delivery} onChange={(e) => set("dialogue", value.dialogue.map((x, j) => (j === i ? { ...x, delivery: e.target.value } : x)))} aria-label="Delivery" />
            <button type="button" className="st-btn st-btn--quiet st-btn--sm" aria-label="Remove line" onClick={() => set("dialogue", value.dialogue.filter((_, j) => j !== i))}>
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Sound</span>
        <Field label="SFX (events)">
          <Chips values={value.sound.sfx} onRemove={(i) => set("sound", { ...value.sound, sfx: value.sound.sfx.filter((_, j) => j !== i) })} onAdd={(v) => value.sound.sfx.length < 8 && set("sound", { ...value.sound, sfx: [...value.sound.sfx, v] })} placeholder="rain on tin roof" />
        </Field>
        <div className="st-fields">
          <Field label="Ambience">
            <input className="st-input" value={value.sound.ambience} onChange={(e) => set("sound", { ...value.sound, ambience: e.target.value })} placeholder="distant traffic, wet street" />
          </Field>
          <Field label="Music" hint="N/A suppresses score.">
            <input className="st-input" value={value.sound.music} onChange={(e) => set("sound", { ...value.sound, music: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="st-card st-stack">
        <span className="st-label" style={{ marginBottom: 0 }}>Who and where</span>
        <Field label="Characters (max 3)">
          <ElementPick options={characters} value={value.characters} max={3} onChange={(v) => set("characters", v)} />
        </Field>
        <Field label="Location">
          <select className="st-select" value={value.location ?? ""} onChange={(e) => set("location", e.target.value || undefined)}>
            <option value="">—</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Props (max 3)">
          <ElementPick options={props} value={value.props} max={3} onChange={(v) => set("props", v)} />
        </Field>
      </div>

      <div className="st-card st-stack">
        <div className="st-row st-row--between">
          <span className="st-label" style={{ marginBottom: 0 }}>LoRAs</span>
          <select
            className="st-select st-input--sm"
            value={value.loras === undefined ? "inherit" : value.loras.length === 0 ? "none" : "override"}
            onChange={(e) => set("loras", e.target.value === "inherit" ? undefined : e.target.value === "none" ? [] : value.loras?.length ? value.loras : [])}
            aria-label="LoRA mode"
          >
            <option value="inherit">inherit project LoRAs</option>
            <option value="override">override</option>
            <option value="none">none</option>
          </select>
        </div>
        {value.loras === undefined ? (
          <span className="st-muted">Uses the project Look’s LoRAs.</span>
        ) : (
          <LoraPicker compact value={value.loras} onChange={(v) => set("loras", v)} />
        )}
      </div>

      <Field label="Prompt override" hint="Replaces the compiled prompt entirely. Leave empty to let the compiler write it.">
        <textarea className="st-textarea" rows={4} value={value.promptOverride ?? ""} onChange={(e) => set("promptOverride", e.target.value || undefined)} />
      </Field>
    </div>
  );
}

function ElementPick({ options, value, max, onChange }: { options: Element[]; value: string[]; max: number; onChange: (v: string[]) => void }) {
  if (options.length === 0) return <span className="st-muted">None available</span>;
  return (
    <div className="st-chips">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            className="st-chip st-chip--btn"
            aria-pressed={on}
            disabled={!on && value.length >= max}
            onClick={() => onChange(on ? value.filter((id) => id !== o.id) : [...value, o.id])}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}
