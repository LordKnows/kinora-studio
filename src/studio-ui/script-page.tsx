"use client";

import { useCallback, useEffect, useState } from "react";

import type { Script } from "@/studio/types";

import { get, post, when } from "./api";
import { Button, Empty, ErrorBanner, Lamp, Section, useAction } from "./common";
import { useProjectContext } from "./shell";

export function ScriptPage() {
  const { projectId, view, reload } = useProjectContext();
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { scripts } = await get<{ scripts: Script[] }>(`/api/projects/${projectId}/scripts`);
    setScripts(scripts);
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
          {latest && latest.approval !== "approved" && (
            <Button kind="primary" busy={approve.busy} onClick={() => void approve.fire(latest.id)}>
              Approve v{latest.version}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={save.error ?? approve.error} onDismiss={() => { save.dismiss(); approve.dismiss(); }} />

      <div className="st-split" style={{ marginTop: 12 }}>
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
        <div className="st-card st-stack">
          <div className="st-row st-row--between">
            <span className="st-label" style={{ marginBottom: 0 }}>{current ? `v${current.version}` : "Preview"}</span>
            {current && <Lamp state={current.approval} label={current.approval} />}
          </div>
          {current ? <pre className="st-pre" style={{ maxHeight: 640 }}>{current.text}</pre> : <span className="st-muted">Select a version to read it.</span>}
        </div>
      </div>
    </div>
  );
}
