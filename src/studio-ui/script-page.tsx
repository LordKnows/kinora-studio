"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { StoredTreatment, TreatmentWarning } from "@/studio/treatment";
import type { Script } from "@/studio/types";

import { get, post, when } from "./api";
import { Button, Empty, ErrorBanner, Lamp, Section, useAction } from "./common";
import { filmShots, shotPicture, tc } from "./film";
import { Markdown } from "./markdown";
import { diffSentences, scriptSections } from "./script-text";
import { useProjectContext } from "./shell";

export function ScriptPage() {
  const { projectId, view, reload } = useProjectContext();
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [treatment, setTreatment] = useState<StoredTreatment | null>(null);
  const [treatmentWarnings, setTreatmentWarnings] = useState<TreatmentWarning[]>([]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"read" | "board" | "changes">("read");

  const load = useCallback(async () => {
    const { scripts, treatment, treatmentWarnings } = await get<{ scripts: Script[]; treatment?: StoredTreatment | null; treatmentWarnings?: TreatmentWarning[] }>(`/api/projects/${projectId}/scripts`);
    setScripts(scripts);
    setTreatment(treatment ?? null);
    setTreatmentWarnings(treatmentWarnings ?? []);
    setOpen((cur) => cur ?? scripts[0]?.id ?? null);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, view?.script?.id, view?.script?.approval]);

  const save = useAction(async () => {
    if (!draft.trim()) return;
    await post(`/api/projects/${projectId}/scripts`, { text: draft });
    setDraft("");
    await load();
    await reload();
  });

  const approve = useAction(async (_confirm, id: string) => {
    await post(`/api/scripts/${id}/approve`);
    await load();
    await reload();
  });

  const latest = scripts?.[0];
  const current = scripts?.find((s) => s.id === open) ?? latest;
  const look = view?.project.look;

  function promptPack() {
    const pack = [
      `You are the director of a short film project called "${view?.project.name ?? "Untitled"}".`,
      look ? `Look: ${[look.genre, look.palette, look.camera, look.lens, look.lighting].filter(Boolean).join("; ")}. Aspect ratio ${look.aspectRatio}.` : "",
      "Write a screenplay for it: scene headings, action, dialogue. Shots will be 5–15 seconds each and rendered by MiniMax H3 (768p, native audio), so keep every moment visual and concrete.",
      "Return only the screenplay text. I will paste it into the Script page.",
    ]
      .filter(Boolean)
      .join("\n\n");
    void navigator.clipboard.writeText(pack).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Script</h1>
          <p className="st-subtitle">Checkpoint 1. Every new version returns to draft; nothing renders until the latest version is approved.</p>
        </div>
        <div className="st-actions">
          <Button kind="quiet" onClick={promptPack}>
            {copied ? "Copied" : "Copy prompt pack"}
          </Button>
          {latest && latest.approval === "approved" && view?.delegated?.script && (
            <span className="st-chip" title="Approved under delegated approval; overturn it in Settings → Director → Decisions">Approved by the director</span>
          )}
          {latest && latest.approval !== "approved" && (
            <Button kind="primary" busy={approve.busy} onClick={() => void approve.fire(latest.id)}>
              Approve v{latest.version}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={save.error ?? approve.error} onDismiss={() => { save.dismiss(); approve.dismiss(); }} />

      <div className="st-split st-split--wide-right">
        <div className="st-stack">
          <div className="st-card st-stack">
            <span className="st-label">New version</span>
            <textarea className="st-textarea" rows={12} placeholder="Paste the screenplay here, or let the director agent call save_script." value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="st-row st-row--between">
              <span className="st-muted st-num">{draft.length.toLocaleString()} chars</span>
              <Button kind="primary" busy={save.busy} disabled={!draft.trim()} onClick={() => void save.fire()}>
                Save as v{(latest?.version ?? 0) + 1}
              </Button>
            </div>
          </div>
          <Section title="Versions" aside={<small>{scripts?.length ?? 0}</small>}>
            {!scripts ? null : scripts.length === 0 ? (
              <Empty title="No script yet" hint="Paste one above or ask your director agent for a draft." />
            ) : (
              <div className="st-card st-card--pad0">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>State</th>
                      <th>Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scripts.map((s) => (
                      <tr key={s.id} style={{ cursor: "pointer", background: s.id === current?.id ? "var(--s2)" : undefined }} onClick={() => setOpen(s.id)}>
                        <td>v{s.version}</td>
                        <td>
                          <Lamp state={s.approval} label={s.approval} />
                        </td>
                        <td>{when(s.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
        <div className="st-stack">
          <div className="st-card st-stack">
            <div className="st-row st-row--between">
              <span className="st-row">
                <span className="st-label" style={{ marginBottom: 0 }}>{current ? `v${current.version}` : "Preview"}</span>
                {current && <Lamp state={current.approval} label={current.approval} />}
              </span>
              {current && (
                <div className="st-seg" role="group" aria-label="How to show the script">
                  <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>Read</button>
                  <button type="button" aria-pressed={mode === "board"} onClick={() => setMode("board")}>Beside the board</button>
                  <button type="button" aria-pressed={mode === "changes"} disabled={!scripts?.some((x) => x.version < current.version)} onClick={() => setMode("changes")}>Changes</button>
                </div>
              )}
            </div>
            {!current ? <span className="st-muted">Select a version to read it.</span>
              : mode === "board" ? <BesideTheBoard text={current.text} />
              : mode === "changes" ? <Changes before={scripts?.find((x) => x.version < current.version)} after={current} />
              : <div style={{ maxHeight: 720, overflow: "auto" }}><Markdown source={current.text} /></div>}
          </div>
          {scripts && scripts.length > 0 && <TreatmentPanel treatment={treatment} warnings={treatmentWarnings} />}
        </div>
      </div>
    </div>
  );
}

/* Why the film is shaped the way it is: what the director wrote down before
   the screenplay, and what the lint says is missing from it. */
function TreatmentPanel({ treatment, warnings }: { treatment: StoredTreatment | null; warnings: TreatmentWarning[] }) {
  const t = treatment?.treatment;
  return (
    <Section title="Treatment" aside={treatment ? <small>for v{treatment.scriptVersion}</small> : undefined}>
      <div className="st-stack">
      {warnings.length > 0 && (
        <div className="st-card st-stack" style={{ gap: 6 }}>
          {warnings.map((w, i) => (
            <div key={i} className="st-row" style={{ alignItems: "baseline", gap: 8 }}>
              <Lamp state={w.severity === "info" ? "draft" : "failed"} label={w.severity} />
              <span className="st-muted" style={{ flex: 1 }}>{w.message}</span>
            </div>
          ))}
        </div>
      )}
      {!t ? (
        <Empty title="No treatment yet" hint="The director sends it with save_script: logline, arc, the three structures it weighed, the sound design." />
      ) : (
        <div className="st-card st-stack">
          <div>
            <span className="st-label">Logline</span>
            <p style={{ margin: 0 }}>{t.logline}</p>
          </div>
          <div>
            <span className="st-label">Arc</span>
            <p className="st-muted" style={{ margin: 0 }}>{t.arc.setup} → {t.arc.turn} → {t.arc.ending}</p>
          </div>
          <div>
            <span className="st-label">Structure</span>
            {t.candidates.map((c) => (
              <p key={c.name} className={c.name === t.chosen ? undefined : "st-muted"} style={{ margin: "0 0 4px" }}>
                <strong>{c.name}{c.name === t.chosen ? " (chosen)" : ""}.</strong> {c.shape}
              </p>
            ))}
            <p className="st-muted" style={{ margin: 0 }}>{t.whyChosen}</p>
          </div>
          <div>
            <span className="st-label">Hook, signature, ending</span>
            <p className="st-muted" style={{ margin: 0 }}>{t.hook.atSecond} s: {t.hook.description}. Signature shot: {t.signatureShot}. Native move: {t.nativeMove}. The ending answers the opening: {t.endingEcho}</p>
          </div>
          <div>
            <span className="st-label">Benchmark</span>
            {t.benchmark.map((b) => (
              <p key={b.work} className="st-muted" style={{ margin: "0 0 4px" }}><strong>{b.work}.</strong> Learn: {b.learn}. Leave: {b.dontLearn}.</p>
            ))}
          </div>
          <div className="st-card st-card--pad0" style={{ overflowX: "auto" }}>
            <table className="st-table">
              <thead>
                <tr><th>Sequence</th><th>s</th><th>Pace</th><th>Ambience</th><th>Foley</th><th>Music</th></tr>
              </thead>
              <tbody>
                {t.sequences.map((s) => {
                  const sound = t.soundDesign.find((r) => r.sequence === s.name);
                  return (
                    <tr key={s.name}>
                      <td title={s.purpose}>{s.name}</td>
                      <td className="st-num">{s.seconds}</td>
                      <td>{s.pace}</td>
                      <td>{sound?.ambience ?? "—"}</td>
                      <td>{sound?.foley ?? "—"}</td>
                      <td>{sound?.music ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(t.silences.length > 0 || t.audioBridges.length > 0) && (
            <p className="st-muted" style={{ margin: 0 }}>
              {t.silences.length > 0 && <>Silences: {t.silences.map((x) => `${x.atSecond} s (${x.why})`).join("; ")}. </>}
              {t.audioBridges.length > 0 && <>Sound bridges: {t.audioBridges.map((b) => `${b.atSecond} s ${b.kind === "j_cut" ? "J-cut" : "L-cut"} (${b.what})`).join("; ")}.</>}
            </p>
          )}
        </div>
      )}
      </div>
    </Section>
  );
}

/* The script laid beside the board: each section next to the scene it pairs
   with (by order, when the counts match), with the time its heading states
   against the seconds the board gives that scene. */
function BesideTheBoard({ text }: { text: string }) {
  const { projectId, view } = useProjectContext();
  if (!view) return null;
  const { preamble, sections } = scriptSections(text);
  const shots = filmShots(view);
  const paired = sections.length > 0 && sections.length === view.scenes.length;
  const base = `/p/${projectId}`;
  if (sections.length === 0) return <p className="st-muted">No scene headings were found in this version (a line like “INT. KITCHEN – NIGHT”, “序列一 · …” or a time range such as 0:00–0:18), so there is nothing to pair with the board.</p>;
  return (
    <div className="scr-lined">
      {!paired && <div className="st-alert st-alert--info"><span>{sections.length} {sections.length === 1 ? "section" : "sections"} in the script, {view.scenes.length} {view.scenes.length === 1 ? "scene" : "scenes"} on the board: they are shown side by side in order, not paired.</span></div>}
      {preamble && <p className="sc-song scr-lined-pre">{preamble}</p>}
      {sections.map((sec, i) => {
        const scene = paired ? view.scenes[i] : undefined;
        const mine = scene ? shots.filter((s) => s.scene.id === scene.id) : [];
        const boardS = mine.reduce((n, s) => n + s.durationS, 0);
        const scriptS = sec.fromS !== undefined && sec.toS !== undefined ? sec.toS - sec.fromS : undefined;
        return (
          <section key={i} className="scr-lined-sec">
            <div className="scr-lined-head">
              <span className="sc-slate">{i + 1}</span>
              <strong className="sc-song">{sec.heading}</strong>
              {scene && <span className="st-num">script {scriptS !== undefined ? `${scriptS} s` : "no time"} · board {boardS} s{scriptS !== undefined && scriptS !== boardS ? ` · ${boardS > scriptS ? "+" : "−"}${Math.abs(boardS - scriptS)} s` : ""}</span>}
            </div>
            <div className="scr-lined-row">
              <p className="sc-song scr-lined-text">{sec.body}</p>
              {scene && (
                <div className="scr-lined-shots">
                  {mine.map((s) => {
                    const pic = shotPicture(s.shot);
                    return (
                      <Link key={s.shot.id} href={`${base}/board?shot=${s.shot.id}`} className="scr-lined-shot" title={s.shot.spec.intent}>
                        {pic ? <img src={pic} alt="" loading="lazy" /> : <span className="sc-frame-empty" />}
                        <span className="st-num"><b>{s.slate}</b> {s.durationS} s · {tc(s.startS)}<br />{String(s.shot.spec.cinematography?.size ?? "").toUpperCase()} {String(s.shot.spec.camera?.move ?? "").replace(/_/g, " ")}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* What this version changed from the one before it, sentence by sentence. */
function Changes({ before, after }: { before?: Script; after: Script }) {
  if (!before) return <p className="st-muted">This is the first version; there is nothing to compare it with.</p>;
  const parts = diffSentences(before.text, after.text);
  const added = parts.filter((p) => p.kind === "added" && p.text !== "\n").length;
  const removed = parts.filter((p) => p.kind === "removed" && p.text !== "\n").length;
  return (
    <div className="st-stack st-stack--tight">
      <span className="st-muted st-num">v{after.version} against v{before.version} · {added} {added === 1 ? "passage" : "passages"} added · {removed} removed</span>
      <div className="sc-song scr-diff">
        {parts.map((p, i) => (p.text === "\n" ? <br key={i} /> : p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "added" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
      </div>
    </div>
  );
}
