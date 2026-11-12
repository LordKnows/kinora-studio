"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AGENT_IMAGE_MODELS, findModel } from "@/studio/models";
import type { LoraRef } from "@/studio/schemas";
import type { DirectorNote, StageReview } from "@/studio/types";

import { del, get, patch, post, put, when } from "./api";
import { Button, ErrorBanner, Field, useAction } from "./common";
import { useT } from "./i18n";
import { LoraPicker, useLoraLibrary } from "./lora-picker";
import { useProjectContext } from "./shell";

type Autopilot = { active: boolean; envelopeUsd?: number; usedUsd?: number; leftUsd?: number; expiresAt?: number; rule?: string };
type ImagingSummary = {
  enabled: boolean; model: string; modelLabel: string; runtime: "api" | "pod"; backend: string; license?: string;
  loras?: Array<{ id: string; name: string; strength: number; adult?: boolean }>; agentCanvas?: boolean; settings?: string; settingsFrom?: string[]; warnings?: string[]; maxImages: number; usedImages: number; leftImages: number; quality: "low" | "medium" | "high"; selfCheck: boolean; autoRedraws: number; stoppedReason?: string; backendReady: boolean; note?: string };
type ModelReadiness = { id: string; painters?: { ready: boolean; note?: string } };
type VoicingSummary = { enabled: boolean; model: string; maxChars: number; usedChars: number; leftChars: number; keyReady: boolean; note?: string; models: Array<{ id: string; label: string; modes: string[]; note: string }> };
type Delegation = { script: boolean; shotlist: boolean; grantedBy?: string; grantedAt?: number };
type Notes = { requirements: DirectorNote[]; decisions: DirectorNote[]; reviews: StageReview[] };

/* What the director keeps for you: the spend envelope you grant it, the list
   of everything you asked for, the decisions it took (overturn any), and the
   cold-reader reviews of the story, the shots and the cut. */
export function DirectorPanel({ projectId }: { projectId: string }) {
  const [ap, setAp] = useState<Autopilot | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [deleg, setDeleg] = useState<Delegation | null>(null);
  const [img, setImg] = useState<ImagingSummary | null>(null);
  const [voice, setVoice] = useState<VoicingSummary | null>(null);
  const [voiceMax, setVoiceMax] = useState("20000");
  const [ready, setReady] = useState<ModelReadiness[]>([]);
  const [adult, setAdult] = useState(false);
  /* the LoRAs as picked, shown at once; a strength typed in is saved when the typing pauses */
  const [loraDraft, setLoraDraft] = useState<LoraRef[] | null>(null);
  const loraSave = useRef<{ timer?: ReturnType<typeof setTimeout>; seq: number }>({ seq: 0 });
  const { loras: library } = useLoraLibrary();
  const [imgMax, setImgMax] = useState("40");
  const [envelope, setEnvelope] = useState("5");
  const [hours, setHours] = useState("12");
  /* The project view every page shares (switches read it): refresh it with ours. */
  const { reload } = useProjectContext();
  const t = useT();
  const refresh = useCallback(async () => {
    const [a, n, d] = await Promise.all([get<Autopilot>(`/api/projects/${projectId}/autopilot`), get<Notes>(`/api/projects/${projectId}/notes`), get<Delegation>(`/api/projects/${projectId}/delegation`)]);
    setAp(a);
    setNotes(n);
    setDeleg(d);
    const im = await get<ImagingSummary>(`/api/projects/${projectId}/imaging`);
    setImg(im);
    void get<{ models: ModelReadiness[] }>("/api/models?kind=image").then((r) => setReady(r.models)).catch(() => undefined);
    void get<{ adultContent?: boolean }>("/api/me/settings").then((s) => setAdult(!!s.adultContent)).catch(() => undefined);
    setImgMax(String(im.maxImages));
    const vo = await get<VoicingSummary>(`/api/projects/${projectId}/voicing`).catch(() => null);
    setVoice(vo);
    if (vo) setVoiceMax(String(vo.maxChars));
    await reload();
  }, [projectId, reload]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const grant = useAction(async () => {
    await post(`/api/projects/${projectId}/autopilot`, { envelopeUsd: Number(envelope), ...(Number(hours) ? { hours: Number(hours) } : {}) });
    await refresh();
  });
  const revoke = useAction(async () => {
    await del(`/api/projects/${projectId}/autopilot`);
    await refresh();
  });
  const delegate = useAction(async (_c, next: { script: boolean; shotlist: boolean }) => {
    if ((next.script && !deleg?.script) || (next.shotlist && !deleg?.shotlist)) {
      const ask = next.script && !deleg?.script
        ? t("Let the director approve the script on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.")
        : t("Let the director approve the shotlist on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.");
      if (!window.confirm(ask)) return;
    }
    await put(`/api/projects/${projectId}/delegation`, next);
    await refresh();
  });
  const setImaging = useAction(async (_c, next: Partial<{ enabled: boolean; model: string; loras: LoraRef[]; agentCanvas: boolean; maxImages: number; quality: "low" | "medium" | "high"; selfCheck: boolean; autoRedraws: number; clearStop: boolean }>) => {
    if (next.enabled && !img?.enabled && !window.confirm(t("Allow image generation on this project? The director (Claude, Grok…) and the buttons may then draw pictures with {model}, up to the image limit below.", { model: img?.modelLabel ?? t("the model below") }))) return;
    const pick = next.model ? findModel(next.model) : undefined;
    if (pick?.runtime === "pod" && img?.enabled && !window.confirm(t("{model} draws on the GPU pod, only while it runs (it bills per hour); its pictures get no Codex self-check. Use it for this project's pictures?", { model: pick.label }))) return;
    await put(`/api/projects/${projectId}/imaging`, { enabled: next.enabled ?? img?.enabled ?? false, ...next });
    await refresh();
  });
  const setVoicing = useAction(async (_c, next: Partial<{ enabled: boolean; model: string; maxChars: number; resetUsed: boolean }>) => {
    const label = voice?.models.find((m) => m.id === (next.model ?? voice?.model))?.label ?? t("the model below");
    if (next.enabled && !voice?.enabled && !window.confirm(t("Allow voice generation on this project? The director may then make voices and speak lines through the voice API (TokenSail) with {model}, billed per character, up to the budget below.", { model: label }))) return;
    await put(`/api/projects/${projectId}/voicing`, { enabled: next.enabled ?? voice?.enabled ?? false, ...next });
    await refresh();
  });
  const pickLoras = (next: LoraRef[]) => {
    const prev = loraDraft ?? img?.loras ?? [];
    const sameSet = next.length === prev.length && next.every((r) => prev.some((p) => p.id === r.id));
    setLoraDraft(next);
    const save = loraSave.current;
    clearTimeout(save.timer);
    const seq = ++save.seq;
    save.timer = setTimeout(() => {
      void setImaging.fire({ loras: next }).finally(() => {
        if (save.seq === seq) setLoraDraft(null);
      });
    }, sameSet ? 700 : 0);
  };
  const setReq = useAction(async (_c, id: string, status: "open" | "met" | "dropped") => {
    await patch(`/api/notes/${id}`, { status });
    await refresh();
  });
  const [newReq, setNewReq] = useState("");
  const addReq = useAction(async () => {
    const text = newReq.trim();
    if (!text) return;
    await post(`/api/projects/${projectId}/notes`, { text });
    setNewReq("");
    await refresh();
  });
  const overturn = useAction(async (_c, id: string) => {
    const reason = window.prompt(t("Why overturn this decision? The director reads it.")) ?? "";
    await post(`/api/notes/${id}/overturn`, { reason });
    await refresh();
  });
  const error = grant.error ?? revoke.error ?? setReq.error ?? addReq.error ?? overturn.error ?? delegate.error ?? setImaging.error ?? setVoicing.error;

  return (
    <div className="st-card st-stack">
      <span className="st-h2">{t("What the director may do, and what it has decided")}</span>
      <ErrorBanner error={error} onDismiss={() => { grant.dismiss(); revoke.dismiss(); setReq.dismiss(); addReq.dismiss(); overturn.dismiss(); delegate.dismiss(); setImaging.dismiss(); setVoicing.dismiss(); }} />

      <div className="st-stack st-stack--tight">
        <strong>{t("Image generation")}</strong>
        <span className="st-muted">
          {t("Off by default. Switched on, character sheets, first and last frames, region edits, style frames and Remake keyframes can be drawn — by the buttons on the Elements, Board, Takes and Look pages, and by the director (Claude, Grok…) — with the model picked here, the same models as Canvas. GPT Image and Qwen-Image 3.0 Pro are drawn by a painter away from the GPU (Machine page → Painters): Codex uses your ChatGPT plan, the API models are paid per picture. MiniMax H3 Image draws on the GPU pod, only while it runs.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!img || setImaging.busy} checked={!!img?.enabled} onChange={(e) => void setImaging.fire({ enabled: e.target.checked })} />
          <span>{t("Allow image generation by agent")}</span>
        </label>
        {img?.enabled && (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={t("Model")}>
              <select className="st-select st-input--sm" value={img.model} disabled={setImaging.busy} onChange={(e) => void setImaging.fire({ model: e.target.value })}>
                {AGENT_IMAGE_MODELS.map((m) => {
                  const r = ready.find((x) => x.id === m.id)?.painters;
                  return <option key={m.id} value={m.id}>{m.label}{m.runtime === "pod" ? t(" · GPU pod") : ""}{r && !r.ready && m.runtime !== "pod" ? t(" · not ready") : ""}</option>;
                })}
              </select>
            </Field>
            {(img.backend === "codex" || img.backend === "api") && (
              <Field label={t("Quality")}>
                <select className="st-select st-input--sm" value={img.quality} onChange={(e) => void setImaging.fire({ quality: e.target.value as "low" | "medium" | "high" })}>
                  <option value="low">{t("low (drafts)")}</option>
                  <option value="medium">{t("medium||quality")}</option>
                  <option value="high">{t("high||quality")}</option>
                </select>
              </Field>
            )}
            <Field label={t("Image limit")}>
              <input className="st-input st-input--sm" type="number" min={1} max={2000} value={imgMax} onChange={(e) => setImgMax(e.target.value)} onBlur={() => Number(imgMax) !== img.maxImages && void setImaging.fire({ maxImages: Math.max(1, Number(imgMax) || 1) })} style={{ width: 90 }} />
            </Field>
            <span className="st-muted st-num">{t("{used} used · {left} left", { used: img.usedImages, left: img.leftImages })}</span>
          </div>
        )}
        {img?.enabled && img.runtime === "pod" && (() => {
          const family = findModel(img.model)?.family;
          const has = library?.some((l) => l.baseModel === family);
          const adultLora = img.loras?.find((l) => l.adult);
          return (
            <div className="st-stack st-stack--tight">
              {has && family ? (
                <Field label={t("LoRAs")} hint={t("Trained for this model; picking one applies its card's settings to every picture the director draws")} group>
                  <LoraPicker compact family={family} adult={adult} value={loraDraft ?? (img.loras ?? []).map((l) => ({ id: l.id, strength: l.strength }))} onChange={pickLoras} />
                </Field>
              ) : (
                <span className="st-muted">{t("No LoRA in the library is trained for {model} (Library → LoRAs).", { model: img.modelLabel })}</span>
              )}
              {img.settings && <span className="st-muted st-num">{t("Settings: {s}", { s: img.settings })}{img.settingsFrom?.length ? t(" (from {list})", { list: img.settingsFrom.join(", ") }) : ""}</span>}
              {(img.warnings ?? []).map((w) => <span key={w} className="st-warn">{w}</span>)}
              {adultLora && (
                <span className="st-warn">
                  {adult
                    ? t("{name} is 18+: the director's pictures with it are drawn only from pictures the Studio drew and the reference library — a picture that is, or was drawn from, an upload or an imported image is refused (it may be a real person).", { name: adultLora.name })
                    : t("{name} is 18+: the director's pictures with it are drawn only from pictures the Studio drew and the reference library — a picture that is, or was drawn from, an upload or an imported image is refused (it may be a real person). 18+ is off for you now: show 18+ on the Canvas page, or the pictures are refused.", { name: adultLora.name })}
                </span>
              )}
            </div>
          );
        })()}
        {img?.enabled && (
          <div className="st-stack st-stack--tight">
            <label className="st-row" style={{ gap: 8 }}>
              <input type="checkbox" disabled={setImaging.busy} checked={!!img.agentCanvas} onChange={(e) => void setImaging.fire({ agentCanvas: e.target.checked })} />
              <span>{t("Agent use Canvas")}</span>
            </label>
            <span className="st-muted">
              {img.agentCanvas
                ? t("The director may compose a character from the Canvas library — a portrait, a costume, a pose — when it decides a look is needed (compose_character), drawn with {model}{loras}, and put it on the character as its look. It counts against the image limit.", { model: img.modelLabel, loras: img.loras?.length ? t(" and the LoRAs above") : "" })
                : t("Off: the director draws characters with element sheets only; the Canvas page stays yours.")}
            </span>
          </div>
        )}
        {img?.enabled && img.runtime !== "pod" && (
          <div className="st-row" style={{ alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <label className="st-row" style={{ gap: 8 }} title={t("A fresh Codex session looks at every drawn picture beside its references and brief (anatomy, extra people, identity, mirrored features, text, framing) before it reaches you. Uses Codex usage, not image quota.")}>
              <input type="checkbox" disabled={setImaging.busy} checked={img.selfCheck} onChange={(e) => void setImaging.fire({ selfCheck: e.target.checked })} />
              <span>{t("Self-check every picture")}</span>
            </label>
            <Field label={t("Redraws on a blocker")}>
              <select className="st-select st-input--sm" value={img.autoRedraws} disabled={!img.selfCheck} onChange={(e) => void setImaging.fire({ autoRedraws: Number(e.target.value) })}>
                <option value={0}>{t("0 (just flag it)")}</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </Field>
            <span className="st-muted">{t("A redraw counts as a picture.")}</span>
          </div>
        )}
        {img?.stoppedReason && (
          <div className="st-row st-row--between">
            <span className="st-warn">{t("Stopped: {reason}", { reason: img.stoppedReason })}</span>
            <Button size="sm" onClick={() => void setImaging.fire({ clearStop: true })}>{t("Resume||images")}</Button>
          </div>
        )}
        {img?.enabled && img.note && <span className="st-muted">{img.note}</span>}
        {img?.enabled && (() => {
          const r = ready.find((x) => x.id === img.model)?.painters;
          return r && !r.ready && r.note ? <span className="st-warn">{r.note}</span> : null;
        })()}
        {img?.enabled && img.license && <span className="st-warn">{img.license}</span>}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Voice generation")}</strong>
        <span className="st-muted">
          {t("Off by default. Switched on, the director may make character voices on the voice API (TokenSail, with the Worker's TOKENSAIL_API_KEY) — cloned from a voice card's reference audio, or designed from its description with CosyVoice — speak lines with them (off-screen lines, inner monologue, audition samples) and transcribe audio to check pronunciation. Speech is billed per character, up to the budget below.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!voice || setVoicing.busy} checked={!!voice?.enabled} onChange={(e) => void setVoicing.fire({ enabled: e.target.checked })} />
          <span>{t("Allow voice API use by agent")}</span>
        </label>
        {voice?.enabled && (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={t("Voice model")}>
              <select className="st-select st-input--sm" value={voice.model} disabled={setVoicing.busy} onChange={(e) => void setVoicing.fire({ model: e.target.value })}>
                {voice.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.modes.includes("design") ? t(" · clone or design") : t(" · clone")}</option>)}
              </select>
            </Field>
            <Field label={t("Character budget")}>
              <input className="st-input st-input--sm" type="number" min={100} max={10000000} value={voiceMax} onChange={(e) => setVoiceMax(e.target.value)} onBlur={() => Number(voiceMax) !== voice.maxChars && void setVoicing.fire({ maxChars: Math.max(100, Number(voiceMax) || 100) })} style={{ width: 110 }} />
            </Field>
            <span className="st-muted">{t("{used} used · {left} left", { used: voice.usedChars.toLocaleString(), left: voice.leftChars.toLocaleString() })}</span>
            {voice.usedChars > 0 && <Button size="sm" onClick={() => void setVoicing.fire({ resetUsed: true })}>{t("Reset count")}</Button>}
          </div>
        )}
        {voice?.enabled && <span className="st-muted">{voice.models.find((m) => m.id === voice.model)?.note}</span>}
        {voice?.enabled && !voice.keyReady && voice.note && <span className="st-warn">{voice.note}</span>}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Spend envelope")}</strong>
        <span className="st-muted">
          {t("Inside it the director renders a shot without asking — only when a fresh reviewer passed that exact prompt and those frames, and never a re-run of a rejected take. Every spend lands in the decision log. Script and shotlist approvals stay yours.")}
        </span>
        {ap?.active ? (
          <div className="st-row st-row--between">
            <span className="st-num">{t("${used} of ${envelope} used", { used: ap.usedUsd?.toFixed(2) ?? "", envelope: ap.envelopeUsd?.toFixed(2) ?? "" })}{ap.expiresAt ? t(" · until {date}", { date: new Date(ap.expiresAt).toLocaleString() }) : ""}</span>
            <Button kind="quiet" busy={revoke.busy} onClick={() => void revoke.fire()}>{t("Revoke")}</Button>
          </div>
        ) : (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={t("Envelope (USD)")}>
              <input className="st-input st-input--sm" type="number" min={0.5} step={0.5} value={envelope} onChange={(e) => setEnvelope(e.target.value)} style={{ width: 100 }} />
            </Field>
            <Field label={t("For (hours)")}>
              <input className="st-input st-input--sm" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 80 }} />
            </Field>
            <Button busy={grant.busy} onClick={() => void grant.fire()}>{t("Grant")}</Button>
          </div>
        )}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Delegated approval")}</strong>
        <span className="st-muted">
          {t("Off by default: you approve the script and the shotlist yourself. Switched on, the director may approve for you — the script only after a fresh reviewer passed the current text, the shotlist only with the script approved and no lint errors. Each approval appears under Decisions; overturn it and the checkpoint goes back to draft.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!deleg || delegate.busy} checked={!!deleg?.script} onChange={(e) => void delegate.fire({ script: e.target.checked, shotlist: !!deleg?.shotlist })} />
          <span>{t("Let the director approve the script")}</span>
        </label>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!deleg || delegate.busy} checked={!!deleg?.shotlist} onChange={(e) => void delegate.fire({ script: !!deleg?.script, shotlist: e.target.checked })} />
          <span>{t("Let the director approve the shotlist")}</span>
        </label>
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Requirements")} {notes ? t("· {n} open", { n: notes.requirements.filter((r) => r.status === "open").length }) : ""}</strong>
        {notes?.requirements.length === 0 && <span className="st-muted">{t("A requirement is a sentence the film is held to at every review. The director records what you ask for here; you can add one yourself.")}</span>}
        <form className="st-row" onSubmit={(e) => { e.preventDefault(); void addReq.fire(); }}>
          <input className="st-input" style={{ flex: 1, minWidth: 160 }} aria-label={t("A requirement in your own words")} placeholder={t("In your own words, e.g. the cat never looks into the camera")} maxLength={500} value={newReq} onChange={(e) => setNewReq(e.target.value)} />
          <Button type="submit" busy={addReq.busy} disabled={!newReq.trim()}>{t("Add")}</Button>
        </form>
        {notes?.requirements.map((r) => (
          <div key={r.id} className="st-row st-row--between">
            <span style={{ textDecoration: r.status === "dropped" ? "line-through" : undefined }}>{r.status === "met" ? "✓ " : ""}{String(r.body.text)}</span>
            <span className="st-row">
              {r.status !== "met" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "met")}>{t("Met")}</Button>}
              {r.status !== "dropped" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "dropped")}>{t("Drop||requirement")}</Button>}
              {r.status !== "open" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "open")}>{t("Reopen")}</Button>}
            </span>
          </div>
        ))}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Decisions")}</strong>
        {notes?.decisions.length === 0 && <span className="st-muted">{t("None logged yet.")}</span>}
        {notes?.decisions.slice().reverse().slice(0, 30).map((d) => (
          <div key={d.id} className="st-row st-row--between" style={{ alignItems: "flex-start" }}>
            <span style={{ textDecoration: d.status === "overturned" ? "line-through" : undefined }}>
              <span className="st-muted st-num">{when(d.createdAt)} · {String(d.body.by ?? "")}{d.body.confidence ? ` · ${String(d.body.confidence)}` : ""}</span>
              <br />
              {String(d.body.decision)}
              {d.body.why ? <span className="st-muted"> — {String(d.body.why)}</span> : null}
            </span>
            {d.status !== "overturned" && <Button size="sm" kind="quiet" onClick={() => void overturn.fire(d.id)}>{t("Overturn")}</Button>}
          </div>
        ))}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Reviews")}</strong>
        {notes?.reviews.length === 0 && <span className="st-muted">{t("No cold-reader reviews yet (review_packet → a fresh agent → record_review).")}</span>}
        {notes?.reviews.slice(0, 20).map((r) => (
          <details key={r.id}>
            <summary>
              <span className="st-num">{t(`${r.stage}||review stage`)}{r.shotId ? ` ${r.shotId.slice(-6)}` : ""}</span> · <strong>{t(`${r.verdict.toUpperCase()}||verdict`)}</strong> · {t(`${r.reviewer.replace("_", " ")}||reviewer`)} · {t("{n} finding(s)", { n: r.findings.length })} · <span className="st-muted">{when(r.createdAt)}</span>
            </summary>
            <div className="st-muted">{t("Basis: {basis}", { basis: r.basis })}</div>
            <ul>
              {r.findings.map((f, i) => <li key={i}><strong>{f.where}</strong>: {f.problem}{f.fix ? ` → ${f.fix}` : ""}{f.sure === false ? t(" (maybe)") : ""}</li>)}
            </ul>
          </details>
        ))}
      </div>

      <div className="st-row">
        <a className="st-btn" href={`/api/projects/${projectId}/retro`} target="_blank" rel="noreferrer">{t("Retro (Markdown)")}</a>
      </div>
    </div>
  );
}
