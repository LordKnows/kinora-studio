"use client";

import { useCallback, useEffect, useState } from "react";

import type { StoredTreatment, TreatmentWarning } from "@/studio/treatment";
import type { Script } from "@/studio/types";

import { get, post, when } from "./api";
import { Button, Empty, ErrorBanner, Lamp, Section, useAction } from "./common";
import { Markdown } from "./markdown";
import { useProjectContext } from "./shell";

export function ScriptPage() {
  const { projectId, view, reload } = useProjectContext();
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [treatment, setTreatment] = useState<StoredTreatment | null>(null);
  const [treatmentWarnings, setTreatmentWarnings] = useState<TreatmentWarning[]>([]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
              <span className="st-label" style={{ marginBottom: 0 }}>{current ? `v${current.version}` : "Preview"}</span>
              {current && <Lamp state={current.approval} label={current.approval} />}
            </div>
            {current ? <div style={{ maxHeight: 720, overflow: "auto" }}><Markdown source={current.text} /></div> : <span className="st-muted">Select a version to read it.</span>}
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
