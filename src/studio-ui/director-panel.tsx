"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { AGENT_IMAGE_MODELS, findModel } from "@/studio/models";
import type { LoraRef } from "@/studio/schemas";
import type { DirectorNote, StageReview } from "@/studio/types";

import { del, get, patch, post, put } from "./api";
import { Button, ErrorBanner, Field, Loading, useAction, whenT } from "./common";
import { useT } from "./i18n";
import { BanIcon, CheckCircleIcon, CheckIcon, ChevronIcon, UndoIcon } from "./icons";
import { LoraPicker, useLoraLibrary } from "./lora-picker";
import { useProjectContext } from "./shell";

type Autopilot = { active: boolean; envelopeUsd?: number; usedUsd?: number; leftUsd?: number; expiresAt?: number; rule?: string };
type ImagingSummary = {
  enabled: boolean; model: string; modelLabel: string; runtime: "api" | "pod"; backend: string; license?: string;
  loras?: Array<{ id: string; name: string; strength: number; adult?: boolean }>; agentCanvas?: boolean; settings?: string; settingsFrom?: string[]; warnings?: string[]; maxImages: number; usedImages: number; leftImages: number; quality: "low" | "medium" | "high"; selfCheck: boolean; autoRedraws: number; stoppedReason?: string; backendReady: boolean; note?: string };
type ModelReadiness = { id: string; painters?: { ready: boolean; note?: string } };
type VoicingSummary = { enabled: boolean; model: string; maxChars: number; usedChars: number; leftChars: number; keyReady: boolean; note?: string; models: Array<{ id: string; label: string; provider?: "tokensail" | "pod"; modes: string[]; note: string }> };
type Delegation = { script: boolean; shotlist: boolean; grantedBy?: string; grantedAt?: number };
type Notes = { requirements: DirectorNote[]; decisions: DirectorNote[]; reviews: StageReview[] };
type LogSection = "requirements" | "decisions" | "reviews";

/* What is edited in "What the director may do" is a draft until Save: the switches and fields change here, and
   one Save sends what differs from what the server has (image generation, voice generation, delegated approval). */
type ImgDraft = { enabled: boolean; model: string; quality: "low" | "medium" | "high"; maxImages: string; agentCanvas: boolean; selfCheck: boolean; autoRedraws: number; loras: LoraRef[] };
type VoiceDraft = { enabled: boolean; model: string; maxChars: string };
type Draft = { img: ImgDraft | null; voice: VoiceDraft | null; deleg: { script: boolean; shotlist: boolean } | null };
const imgDraftOf = (i: ImagingSummary): ImgDraft => ({ enabled: i.enabled, model: i.model, quality: i.quality, maxImages: String(i.maxImages), agentCanvas: !!i.agentCanvas, selfCheck: i.selfCheck, autoRedraws: i.autoRedraws, loras: (i.loras ?? []).map((l) => ({ id: l.id, strength: l.strength })) });
const voiceDraftOf = (v: VoicingSummary): VoiceDraft => ({ enabled: v.enabled, model: v.model, maxChars: String(v.maxChars) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* What the director may do and what it keeps for you, in two parts.
   `settings` (the project's Settings page): image and voice generation, the
   spend envelope you grant it, delegated approval. `log` (the Director panel
   beside every page): everything you asked for, the decisions it took
   (overturn any), and the cold-reader reviews of the story, the shots and the
   cut. The log is three headings that are always on the panel; one of them is
   open at a time and its entries scroll between the other two. */
export function DirectorPanel({ projectId, part }: { projectId: string; part: "settings" | "log" }) {
  const [ap, setAp] = useState<Autopilot | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [img, setImg] = useState<ImagingSummary | null>(null);
  const [voice, setVoice] = useState<VoicingSummary | null>(null);
  const [ready, setReady] = useState<ModelReadiness[]>([]);
  const [adult, setAdult] = useState(false);
  const { loras: library } = useLoraLibrary();
  /* the draft being edited, and what the server had when it was last read (the draft is kept while it differs) */
  const [draft, setDraft] = useState<Draft | null>(null);
  const server = useRef<Draft | null>(null);
  const resetDraft = useRef(false);
  const [envelope, setEnvelope] = useState("5");
  const [hours, setHours] = useState("12");
  /* The project view every page shares (switches read it): refresh it with ours. */
  const { reload } = useProjectContext();
  const t = useT();
  const refresh = useCallback(async () => {
    const [a, n, d] = await Promise.all([get<Autopilot>(`/api/projects/${projectId}/autopilot`), get<Notes>(`/api/projects/${projectId}/notes`), get<Delegation>(`/api/projects/${projectId}/delegation`)]);
    setAp(a);
    setNotes(n);
    const im = await get<ImagingSummary>(`/api/projects/${projectId}/imaging`);
    setImg(im);
    void get<{ models: ModelReadiness[] }>("/api/models?kind=image").then((r) => setReady(r.models)).catch(() => undefined);
    void get<{ adultContent?: boolean }>("/api/me/settings").then((s) => setAdult(!!s.adultContent)).catch(() => undefined);
    const vo = await get<VoicingSummary>(`/api/projects/${projectId}/voicing`).catch(() => null);
    setVoice(vo);
    /* an unsaved draft survives a refresh (a grant, a resume); after a Save it is read afresh */
    const fresh: Draft = { img: imgDraftOf(im), voice: vo ? voiceDraftOf(vo) : null, deleg: { script: d.script, shotlist: d.shotlist } };
    const was = server.current;
    const force = resetDraft.current;
    resetDraft.current = false;
    server.current = fresh;
    setDraft((prev) => (force || prev === null || same(prev, was) ? fresh : prev));
    await reload();
  }, [projectId, reload]);
  /* the first load of the log: until it answers the three headings say they are loading; if it fails they say so */
  const [loadFailed, setLoadFailed] = useState(false);
  const firstLoad = useCallback(() => {
    setLoadFailed(false);
    void refresh().catch(() => setLoadFailed(true));
  }, [refresh]);
  useEffect(() => {
    firstLoad();
  }, [firstLoad]);

  const grant = useAction(async () => {
    await post(`/api/projects/${projectId}/autopilot`, { envelopeUsd: Number(envelope), ...(Number(hours) ? { hours: Number(hours) } : {}) });
    await refresh();
  });
  const revoke = useAction(async () => {
    await del(`/api/projects/${projectId}/autopilot`);
    await refresh();
  });
  /* Save: every change in the draft, together. The questions about money and approval are asked first, for
     all of it, so declining one saves nothing; then image generation, voice generation and delegated
     approval are sent, each only if it changed. */
  const save = useAction(async () => {
    const now = draft;
    const was = server.current;
    if (!now || !was) return;
    const ni = now.img, si = was.img, nv = now.voice, sv = was.voice, nd = now.deleg, sd = was.deleg;
    const imgChanged = !!ni && !same(ni, si);
    const voiceChanged = !!nv && !same(nv, sv);
    const delegChanged = !!nd && !same(nd, sd);
    if (imgChanged && ni!.enabled && !si?.enabled && !window.confirm(t("Allow image generation on this project? The director (Claude, Grok…) and the buttons may then draw pictures with {model}, up to the image limit below.", { model: findModel(ni!.model)?.label ?? img?.modelLabel ?? t("the model below") }))) return;
    const pick = ni ? findModel(ni.model) : undefined;
    if (imgChanged && ni!.enabled && si?.enabled && ni!.model !== si.model && pick?.runtime === "pod" && !window.confirm(t("{model} draws on the GPU pod, only while it runs (it bills per hour); its pictures get no Codex self-check. Use it for this project's pictures?", { model: pick.label }))) return;
    const chosen = voice?.models.find((m) => m.id === nv?.model);
    const onPod = chosen?.provider === "pod";
    const voiceLabel = chosen?.label ?? t("the model below");
    if (voiceChanged && nv!.enabled && !sv?.enabled && !window.confirm(onPod
      ? t("Allow voice generation on this project? The director may then speak lines with {model} on the GPU pod, only while it runs (it bills per hour), several takes for you to pick from, up to the character budget below.", { model: voiceLabel })
      : t("Allow voice generation on this project? The director may then make voices and speak lines through the voice API (TokenSail) with {model}, billed per character, up to the budget below.", { model: voiceLabel }))) return;
    if (voiceChanged && nv!.enabled && sv?.enabled && nv!.model !== sv.model && onPod && !window.confirm(t("{model} speaks on the GPU pod, only while it runs (it bills per hour). Use it for this project's voices?", { model: voiceLabel }))) return;
    if (delegChanged && ((nd!.script && !sd?.script) || (nd!.shotlist && !sd?.shotlist))) {
      const ask = nd!.script && !sd?.script
        ? t("Let the director approve the script on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.")
        : t("Let the director approve the shotlist on your behalf? It still needs a fresh reviewer's pass (script) or a clean lint (shotlist), every approval is logged, and overturning it puts the checkpoint back in draft.");
      if (!window.confirm(ask)) return;
    }
    try {
      if (imgChanged && ni) {
        const body: Record<string, unknown> = { enabled: ni.enabled };
        if (ni.enabled) {
          if (ni.model !== si?.model) body.model = ni.model;
          if (ni.quality !== si?.quality) body.quality = ni.quality;
          if (ni.maxImages !== si?.maxImages) body.maxImages = Math.max(1, Number(ni.maxImages) || 1);
          if (ni.agentCanvas !== si?.agentCanvas) body.agentCanvas = ni.agentCanvas;
          if (ni.selfCheck !== si?.selfCheck) body.selfCheck = ni.selfCheck;
          if (ni.autoRedraws !== si?.autoRedraws) body.autoRedraws = ni.autoRedraws;
          if (!same(ni.loras, si?.loras)) body.loras = ni.loras;
        }
        await put(`/api/projects/${projectId}/imaging`, body);
      }
      if (voiceChanged && nv) {
        const body: Record<string, unknown> = { enabled: nv.enabled };
        if (nv.enabled) {
          if (nv.model !== sv?.model) body.model = nv.model;
          if (nv.maxChars !== sv?.maxChars) body.maxChars = Math.max(100, Number(nv.maxChars) || 100);
        }
        await put(`/api/projects/${projectId}/voicing`, body);
      }
      if (delegChanged && nd) await put(`/api/projects/${projectId}/delegation`, nd);
      resetDraft.current = true;
    } finally {
      await refresh();
    }
  });
  /* not settings but things to do: let the stopped pictures go on, and zero the character count */
  const resume = useAction(async () => {
    await put(`/api/projects/${projectId}/imaging`, { enabled: img?.enabled ?? false, clearStop: true });
    await refresh();
  });
  const resetUsed = useAction(async () => {
    await put(`/api/projects/${projectId}/voicing`, { enabled: voice?.enabled ?? false, resetUsed: true });
    await refresh();
  });
  const editImg = (p: Partial<ImgDraft>) => setDraft((d) => (d && d.img ? { ...d, img: { ...d.img, ...p } } : d));
  const editVoice = (p: Partial<VoiceDraft>) => setDraft((d) => (d && d.voice ? { ...d, voice: { ...d.voice, ...p } } : d));
  const editDeleg = (p: Partial<{ script: boolean; shotlist: boolean }>) => setDraft((d) => (d && d.deleg ? { ...d, deleg: { ...d.deleg, ...p } } : d));
  const dirty = draft !== null && server.current !== null && !same(draft, server.current);
  const setReq = useAction(async (_c, id: string, status: "open" | "met" | "dropped") => {
    await patch(`/api/notes/${id}`, { status });
    await refresh();
  });
  const [newReq, setNewReq] = useState("");
  const [openSection, setOpenSection] = useState<LogSection | null>("requirements");
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
  const error = grant.error ?? revoke.error ?? setReq.error ?? addReq.error ?? overturn.error ?? save.error ?? resume.error ?? resetUsed.error;

  const settings = part === "settings";
  const banner = <ErrorBanner error={error} onDismiss={() => { grant.dismiss(); revoke.dismiss(); setReq.dismiss(); addReq.dismiss(); overturn.dismiss(); save.dismiss(); resume.dismiss(); resetUsed.dismiss(); }} />;
  if (!settings) {
    const section = (id: LogSection, title: string, meta: string, children: ReactNode) => (
      <LogSectionBox id={id} title={title} meta={meta} open={openSection === id} onToggle={() => setOpenSection((now) => (now === id ? null : id))}>
        {children}
      </LogSectionBox>
    );
    const openReqs = notes?.requirements.filter((r) => r.status === "open").length ?? 0;
    const waiting = notes ? null : loadFailed ? (
      <div className="st-row">
        <span className="st-muted">{t("Could not load this.")}</span>
        <Button size="sm" onClick={firstLoad}>{t("Try again")}</Button>
      </div>
    ) : <Loading />;
    return (
      <div className="dir-log">
        {banner}
        {section("requirements", t("Requirements"), notes ? t("{open} open · {n} in all", { open: openReqs, n: notes.requirements.length }) : "", <>
          <form className="st-row dir-req-new" onSubmit={(e) => { e.preventDefault(); void addReq.fire(); }}>
            <input className="st-input" style={{ flex: 1, minWidth: 160 }} aria-label={t("A requirement in your own words")} placeholder={t("In your own words, e.g. the cat never looks into the camera")} maxLength={500} value={newReq} onChange={(e) => setNewReq(e.target.value)} />
            <Button type="submit" busy={addReq.busy} disabled={!newReq.trim()}>{t("Add")}</Button>
          </form>
          {waiting}
          {notes?.requirements.length === 0 && <span className="st-muted">{t("A requirement is a sentence the film is held to at every review. The director records what you ask for here; you can add one yourself.")}</span>}
          {notes?.requirements.map((r) => (
            <div key={r.id} className="dir-entry dir-req" data-status={r.status}>
              <span className="dir-req-mark" role="img" aria-label={t(`${r.status}||requirement status`)} title={t(`${r.status}||requirement status`)}>
                {r.status === "met" ? <CheckCircleIcon size={16} /> : r.status === "dropped" ? <BanIcon size={16} /> : <span className="dir-req-open" />}
              </span>
              <span className="dir-req-text">{String(r.body.text)}</span>
              <span className="dir-req-acts">
                {r.status !== "met" && <button type="button" className="st-btn st-btn--sm dir-act" data-act="met" disabled={setReq.busy} onClick={() => void setReq.fire(r.id, "met")}><CheckIcon size={12} />{t("Met")}</button>}
                {r.status !== "dropped" && <button type="button" className="st-btn st-btn--sm dir-act" data-act="drop" disabled={setReq.busy} onClick={() => void setReq.fire(r.id, "dropped")}><BanIcon size={12} />{t("Drop||requirement")}</button>}
                {r.status !== "open" && <button type="button" className="st-btn st-btn--sm st-btn--quiet dir-act" disabled={setReq.busy} onClick={() => void setReq.fire(r.id, "open")}><UndoIcon size={12} />{t("Reopen")}</button>}
              </span>
            </div>
          ))}
        </>)}
        {section("decisions", t("Decisions"), notes ? String(notes.decisions.length) : "", <>
          {waiting}
          {notes?.decisions.length === 0 && <span className="st-muted">{t("None logged yet.")}</span>}
          {notes?.decisions.slice().reverse().slice(0, 30).map((d) => (
            <div key={d.id} className="dir-entry dir-decision" data-status={d.status}>
              <span className="st-muted st-num">{whenT(t, d.createdAt)} · {d.body.by === "agent" ? t("agent||reviewer") : String(d.body.by ?? "")}{d.body.confidence ? ` · ${t(`${String(d.body.confidence)}||confidence`)}` : ""}</span>
              <span className="dir-decision-text">
                {String(d.body.decision)}
                {d.body.why ? <span className="st-muted"> — {String(d.body.why)}</span> : null}
              </span>
              {d.status !== "overturned" && <span className="dir-req-acts"><Button size="sm" kind="quiet" onClick={() => void overturn.fire(d.id)}>{t("Overturn")}</Button></span>}
            </div>
          ))}
        </>)}
        {section("reviews", t("Reviews"), notes ? String(notes.reviews.length) : "", <>
          {waiting}
          {notes?.reviews.length === 0 && <span className="st-muted">{t("No cold-reader reviews yet (review_packet → a fresh agent → record_review).")}</span>}
          {notes?.reviews.slice(0, 20).map((r) => (
            <details key={r.id} className="dir-entry dir-review" data-verdict={r.verdict}>
              <summary>
                <span className="st-num">{t(`${r.stage}||review stage`)}{r.shotId ? ` ${r.shotId.slice(-6)}` : ""}</span> · <strong>{t(`${r.verdict.toUpperCase()}||verdict`)}</strong> · {t(`${r.reviewer.replace("_", " ")}||reviewer`)} · {t("{n} finding(s)", { n: r.findings.length })} · <span className="st-muted">{whenT(t, r.createdAt)}</span>
              </summary>
              <div className="st-muted">{t("Basis: {basis}", { basis: r.basis })}</div>
              <ul>
                {r.findings.map((f, i) => <li key={i}><strong>{f.where}</strong>: {f.problem}{f.fix ? ` → ${f.fix}` : ""}{f.sure === false ? t(" (maybe)") : ""}</li>)}
              </ul>
            </details>
          ))}
        </>)}
        <div className="dir-log-foot">
          <a className="st-btn st-btn--sm" href={`/api/projects/${projectId}/retro`} target="_blank" rel="noreferrer">{t("Retro (Markdown)")}</a>
        </div>
      </div>
    );
  }
  const di = draft?.img ?? null;
  const dv = draft?.voice ?? null;
  const dd = draft?.deleg ?? null;
  const dm = di ? findModel(di.model) : undefined;
  const runtime = dm?.runtime ?? img?.runtime;
  const backend = dm?.backend ?? img?.backend;
  /* what the server says about the model (notes, licence, settings) is about the saved one */
  const savedModel = !!img && di?.model === img.model;
  return (
    <div className="st-card st-stack">
      <span className="st-h2">{t("What the director may do")}</span>
      {banner}

      <div className="st-stack st-stack--tight">
        <strong>{t("Image generation")}</strong>
        <span className="st-muted">
          {t("Lets the buttons and the director draw pictures with the model below. Off by default.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!di || save.busy} checked={!!di?.enabled} onChange={(e) => editImg({ enabled: e.target.checked })} />
          <span>{t("Allow image generation by agent")}</span>
        </label>
        {img && di?.enabled && (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={t("Model")}>
              <select className="st-select st-input--sm" value={di.model} disabled={save.busy} onChange={(e) => editImg({ model: e.target.value })}>
                {AGENT_IMAGE_MODELS.map((m) => {
                  const r = ready.find((x) => x.id === m.id)?.painters;
                  return <option key={m.id} value={m.id}>{m.label}{m.runtime === "pod" ? t(" · GPU pod") : ""}{r && !r.ready && m.runtime !== "pod" ? t(" · not ready") : ""}</option>;
                })}
              </select>
            </Field>
            {(backend === "codex" || backend === "api") && (
              <Field label={t("Quality")}>
                <select className="st-select st-input--sm" value={di.quality} disabled={save.busy} onChange={(e) => editImg({ quality: e.target.value as "low" | "medium" | "high" })}>
                  <option value="low">{t("low (drafts)")}</option>
                  <option value="medium">{t("medium||quality")}</option>
                  <option value="high">{t("high||quality")}</option>
                </select>
              </Field>
            )}
            <Field label={t("Image limit")}>
              <input className="st-input st-input--sm" type="number" min={1} max={2000} value={di.maxImages} disabled={save.busy} onChange={(e) => editImg({ maxImages: e.target.value })} style={{ width: 90 }} />
            </Field>
            <span className="st-muted st-num">{t("{used} used · {left} left", { used: img.usedImages, left: img.leftImages })}</span>
          </div>
        )}
        {img && di?.enabled && runtime === "pod" && (() => {
          const family = dm?.family;
          const has = library?.some((l) => l.baseModel === family);
          const adultLora = savedModel ? img.loras?.find((l) => l.adult) : undefined;
          return (
            <div className="st-stack st-stack--tight">
              {has && family ? (
                <Field label={t("LoRAs")} hint={t("Picking one applies its card's settings to the director's pictures.")} group>
                  <LoraPicker compact family={family} adult={adult} value={di.loras} onChange={(next) => editImg({ loras: next })} />
                </Field>
              ) : (
                <span className="st-muted">{t("No LoRA in the library is trained for {model} (Library → LoRAs).", { model: dm?.label ?? img.modelLabel })}</span>
              )}
              {savedModel && img.settings && <span className="st-muted st-num">{t("Settings: {s}", { s: img.settings })}{img.settingsFrom?.length ? t(" (from {list})", { list: img.settingsFrom.join(", ") }) : ""}</span>}
              {savedModel && (img.warnings ?? []).map((w) => <span key={w} className="st-warn">{w}</span>)}
              {adultLora && (
                <span className="st-warn">
                  {adult
                    ? t("{name} is 18+: it draws only from Studio pictures and the reference library; uploads and imports are refused.", { name: adultLora.name })
                    : t("{name} is 18+: it draws only from Studio pictures and the reference library; uploads and imports are refused. 18+ is off for you: switch it on on the Canvas page, or its pictures are refused.", { name: adultLora.name })}
                </span>
              )}
            </div>
          );
        })()}
        {di?.enabled && (
          <div className="st-stack st-stack--tight">
            <label className="st-row" style={{ gap: 8 }}>
              <input type="checkbox" disabled={save.busy} checked={di.agentCanvas} onChange={(e) => editImg({ agentCanvas: e.target.checked })} />
              <span>{t("Agent use Canvas")}</span>
            </label>
            <span className="st-muted">
              {di.agentCanvas
                ? t("The director may build a character's look from the Canvas library. It counts against the image limit.")
                : t("Off: the director draws characters from element sheets only.")}
            </span>
          </div>
        )}
        {di?.enabled && runtime !== "pod" && (
          <div className="st-row" style={{ alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <label className="st-row" style={{ gap: 8 }} title={t("A fresh Codex session looks at every drawn picture beside its references and brief (anatomy, extra people, identity, mirrored features, text, framing) before it reaches you. Uses Codex usage, not image quota.")}>
              <input type="checkbox" disabled={save.busy} checked={di.selfCheck} onChange={(e) => editImg({ selfCheck: e.target.checked })} />
              <span>{t("Self-check every picture")}</span>
            </label>
            <Field label={t("Redraws on a blocker")}>
              <select className="st-select st-input--sm" value={di.autoRedraws} disabled={!di.selfCheck || save.busy} onChange={(e) => editImg({ autoRedraws: Number(e.target.value) })}>
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
            <Button size="sm" busy={resume.busy} onClick={() => void resume.fire()}>{t("Resume||images")}</Button>
          </div>
        )}
        {savedModel && img?.enabled && img.note && <span className="st-muted">{img.note}</span>}
        {savedModel && img?.enabled && (() => {
          const r = ready.find((x) => x.id === img.model)?.painters;
          return r && !r.ready && r.note ? <span className="st-warn">{r.note}</span> : null;
        })()}
        {savedModel && img?.enabled && img.license && <span className="st-warn">{img.license}</span>}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Voice generation")}</strong>
        <span className="st-muted">
          {t("Lets the director make character voices and speak lines with the model below, up to the character budget. Off by default.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!dv || save.busy} checked={!!dv?.enabled} onChange={(e) => editVoice({ enabled: e.target.checked })} />
          <span>{t("Allow voice API use by agent")}</span>
        </label>
        {voice && dv?.enabled && (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label={t("Voice model")}>
              <select className="st-select st-input--sm" value={dv.model} disabled={save.busy} onChange={(e) => editVoice({ model: e.target.value })}>
                {voice.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.provider === "pod" ? t(" · our GPU, takes to pick from") : m.modes.includes("design") ? t(" · clone or design") : t(" · clone")}</option>)}
              </select>
            </Field>
            <Field label={t("Character budget")}>
              <input className="st-input st-input--sm" type="number" min={100} max={10000000} value={dv.maxChars} disabled={save.busy} onChange={(e) => editVoice({ maxChars: e.target.value })} style={{ width: 110 }} />
            </Field>
            <span className="st-muted">{t("{used} used · {left} left", { used: voice.usedChars.toLocaleString(), left: voice.leftChars.toLocaleString() })}</span>
            {voice.usedChars > 0 && <Button size="sm" busy={resetUsed.busy} onClick={() => void resetUsed.fire()}>{t("Reset count")}</Button>}
          </div>
        )}
        {voice && dv?.enabled && <span className="st-muted">{voice.models.find((m) => m.id === dv.model)?.note}</span>}
        {voice && dv?.enabled && !voice.keyReady && (voice.models.find((m) => m.id === dv.model)?.provider === "pod"
          ? <span className="st-warn">{t("Without the Worker's TOKENSAIL_API_KEY the takes get no pronunciation check.")}</span>
          : voice.note && <span className="st-warn">{voice.note}</span>)}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>{t("Spend envelope")}</strong>
        <span className="st-muted">
          {t("Inside it the director renders reviewed shots without asking. Every spend is logged under Decisions.")}
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
          {t("Lets the director approve for you: the script after a fresh review passes, the shotlist with no lint errors. Overturn any under Decisions. Off by default.")}
        </span>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!dd || save.busy} checked={!!dd?.script} onChange={(e) => editDeleg({ script: e.target.checked })} />
          <span>{t("Let the director approve the script")}</span>
        </label>
        <label className="st-row" style={{ gap: 8 }}>
          <input type="checkbox" disabled={!dd || save.busy} checked={!!dd?.shotlist} onChange={(e) => editDeleg({ shotlist: e.target.checked })} />
          <span>{t("Let the director approve the shotlist")}</span>
        </label>
      </div>

      {/* the changes above are only a draft until this: image generation, voice generation and delegated approval are saved together */}
      <div className="dir-save" data-dirty={dirty ? "true" : undefined}>
        <span className="st-muted">{dirty ? t("Unsaved changes") : t("All saved")}</span>
        <span className="st-row">
          <Button kind="quiet" disabled={!dirty || save.busy} onClick={() => setDraft(server.current)}>{t("Discard changes")}</Button>
          <Button kind="primary" busy={save.busy} disabled={!dirty} onClick={() => void save.fire()}>{t("Save")}</Button>
        </span>
      </div>
    </div>
  );
}

/* One heading of the log. The heading is always there; its entries only while it is the open one. */
function LogSectionBox({ id, title, meta, open, onToggle, children }: { id: LogSection; title: string; meta: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="dir-sec" data-open={open ? "true" : undefined}>
      <h3>
        <button type="button" className="dir-sec-head" aria-expanded={open} aria-controls={`dir-sec-${id}`} onClick={onToggle}>
          <ChevronIcon size={13} />
          <span>{title}</span>
          <span className="dir-sec-meta">{meta}</span>
        </button>
      </h3>
      {open && <div id={`dir-sec-${id}`} className="dir-sec-body">{children}</div>}
    </section>
  );
}
