"use client";

import { useCallback, useEffect, useState } from "react";

import type { DirectorNote, StageReview } from "@/studio/types";

import { del, get, patch, post, when } from "./api";
import { Button, ErrorBanner, Field, useAction } from "./common";

type Autopilot = { active: boolean; envelopeUsd?: number; usedUsd?: number; leftUsd?: number; expiresAt?: number; rule?: string };
type Notes = { requirements: DirectorNote[]; decisions: DirectorNote[]; reviews: StageReview[] };

/* What the director keeps for you: the spend envelope you grant it, the list
   of everything you asked for, the decisions it took (overturn any), and the
   cold-reader reviews of the story, the shots and the cut. */
export function DirectorPanel({ projectId }: { projectId: string }) {
  const [ap, setAp] = useState<Autopilot | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [envelope, setEnvelope] = useState("5");
  const [hours, setHours] = useState("12");
  const refresh = useCallback(async () => {
    const [a, n] = await Promise.all([get<Autopilot>(`/api/projects/${projectId}/autopilot`), get<Notes>(`/api/projects/${projectId}/notes`)]);
    setAp(a);
    setNotes(n);
  }, [projectId]);
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
  const setReq = useAction(async (_c, id: string, status: "open" | "met" | "dropped") => {
    await patch(`/api/notes/${id}`, { status });
    await refresh();
  });
  const overturn = useAction(async (_c, id: string) => {
    const reason = window.prompt("Why overturn this decision? The director reads it.") ?? "";
    await post(`/api/notes/${id}/overturn`, { reason });
    await refresh();
  });
  const error = grant.error ?? revoke.error ?? setReq.error ?? overturn.error;

  return (
    <div className="st-card st-stack" style={{ marginTop: 20 }}>
      <span className="st-h2">Director</span>
      <ErrorBanner error={error} onDismiss={() => { grant.dismiss(); revoke.dismiss(); setReq.dismiss(); overturn.dismiss(); }} />

      <div className="st-stack st-stack--tight">
        <strong>Spend envelope</strong>
        <span className="st-muted">
          Inside it the director renders a shot without asking — only when a fresh reviewer passed that exact prompt and those frames, and never a re-run of a rejected take. Every spend lands in the decision log. Script and shotlist approvals stay yours.
        </span>
        {ap?.active ? (
          <div className="st-row st-row--between">
            <span className="st-num">${ap.usedUsd?.toFixed(2)} of ${ap.envelopeUsd?.toFixed(2)} used{ap.expiresAt ? ` · until ${new Date(ap.expiresAt).toLocaleString()}` : ""}</span>
            <Button kind="quiet" busy={revoke.busy} onClick={() => void revoke.fire()}>Revoke</Button>
          </div>
        ) : (
          <div className="st-row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <Field label="Envelope (USD)">
              <input className="st-input st-input--sm" type="number" min={0.5} step={0.5} value={envelope} onChange={(e) => setEnvelope(e.target.value)} style={{ width: 100 }} />
            </Field>
            <Field label="For (hours)">
              <input className="st-input st-input--sm" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 80 }} />
            </Field>
            <Button busy={grant.busy} onClick={() => void grant.fire()}>Grant</Button>
          </div>
        )}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>Requirements {notes ? `· ${notes.requirements.filter((r) => r.status === "open").length} open` : ""}</strong>
        {notes?.requirements.length === 0 && <span className="st-muted">The director records what you ask for here (add_requirements).</span>}
        {notes?.requirements.map((r) => (
          <div key={r.id} className="st-row st-row--between">
            <span style={{ textDecoration: r.status === "dropped" ? "line-through" : undefined }}>{r.status === "met" ? "✓ " : ""}{String(r.body.text)}</span>
            <span className="st-row">
              {r.status !== "met" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "met")}>Met</Button>}
              {r.status !== "dropped" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "dropped")}>Drop</Button>}
              {r.status !== "open" && <Button size="sm" kind="quiet" onClick={() => void setReq.fire(r.id, "open")}>Reopen</Button>}
            </span>
          </div>
        ))}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>Decisions</strong>
        {notes?.decisions.length === 0 && <span className="st-muted">None logged yet.</span>}
        {notes?.decisions.slice().reverse().slice(0, 30).map((d) => (
          <div key={d.id} className="st-row st-row--between" style={{ alignItems: "flex-start" }}>
            <span style={{ textDecoration: d.status === "overturned" ? "line-through" : undefined }}>
              <span className="st-muted st-num">{when(d.createdAt)} · {String(d.body.by ?? "")}{d.body.confidence ? ` · ${String(d.body.confidence)}` : ""}</span>
              <br />
              {String(d.body.decision)}
              {d.body.why ? <span className="st-muted"> — {String(d.body.why)}</span> : null}
            </span>
            {d.status !== "overturned" && <Button size="sm" kind="quiet" onClick={() => void overturn.fire(d.id)}>Overturn</Button>}
          </div>
        ))}
      </div>

      <div className="st-stack st-stack--tight">
        <strong>Reviews</strong>
        {notes?.reviews.length === 0 && <span className="st-muted">No cold-reader reviews yet (review_packet → a fresh agent → record_review).</span>}
        {notes?.reviews.slice(0, 20).map((r) => (
          <details key={r.id}>
            <summary>
              <span className="st-num">{r.stage}{r.shotId ? ` ${r.shotId.slice(-6)}` : ""}</span> · <strong>{r.verdict.toUpperCase()}</strong> · {r.reviewer.replace("_", " ")} · {r.findings.length} finding(s) · <span className="st-muted">{when(r.createdAt)}</span>
            </summary>
            <div className="st-muted">Basis: {r.basis}</div>
            <ul>
              {r.findings.map((f, i) => <li key={i}><strong>{f.where}</strong>: {f.problem}{f.fix ? ` → ${f.fix}` : ""}{f.sure === false ? " (maybe)" : ""}</li>)}
            </ul>
          </details>
        ))}
      </div>

      <div className="st-row">
        <a className="st-btn" href={`/api/projects/${projectId}/retro`} target="_blank" rel="noreferrer">Retro (Markdown)</a>
      </div>
    </div>
  );
}
