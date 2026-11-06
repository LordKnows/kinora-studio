"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

import { del, patch } from "./api";
import { Button, ErrorBanner, Field, useAction } from "./common";
import { DirectorPanel } from "./director-panel";
import { useProjectContext } from "./shell";

/* Project settings: what belongs to this film only. The pod, the library
   and the MCP connection are global pages. */
export function SettingsPage() {
  const { projectId, view, reload } = useProjectContext();
  const router = useRouter();
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  useEffect(() => {
    if (view) {
      setName(view.project.name);
      setCap(String(view.project.budgetCapUsd));
    }
  }, [view]);
  const save = useAction(async () => {
    await patch(`/api/projects/${projectId}`, { name: name.trim(), budgetCapUsd: Number(cap) || 0 });
    await reload();
  });
  const remove = useAction(async () => {
    if (!window.confirm(`Delete "${view?.project.name}" and everything in it? This cannot be undone.`)) return;
    await del(`/api/projects/${projectId}`);
    router.push("/");
  });
  return (
    <div className="st-page st-page--narrow">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Project settings</h1>
          <p className="st-subtitle">Name, budget, and what the director keeps for you. The GPU, the library and the director connection live under Machine, Library and Connect.</p>
        </div>
      </div>
      <ErrorBanner error={save.error ?? remove.error} onDismiss={() => { save.dismiss(); remove.dismiss(); }} />
      <div className="st-card st-stack">
        <div className="st-fields">
          <Field label="Project name">
            <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Budget cap (USD)" hint="Takes, 2K passes and exports are refused once reservations would cross it.">
            <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
        </div>
        <div className="st-row st-row--between">
          <span className="st-muted st-num">spent so far {view ? `$${view.project.spentUsd.toFixed(3)}` : "…"}</span>
          <Button kind="primary" busy={save.busy} onClick={() => void save.fire()}>Save</Button>
        </div>
      </div>
      <DirectorPanel projectId={projectId} />
      <div className="st-card st-stack" style={{ marginTop: 20 }}>
        <span className="st-h2">Elsewhere</span>
        <div className="st-row">
          <Link className="st-btn" href="/machine">Machine</Link>
          <Link className="st-btn" href="/library">Library</Link>
          <Link className="st-btn" href="/connect">Connect</Link>
        </div>
      </div>
      <div className="st-card st-card--quiet st-stack" style={{ marginTop: 20 }}>
        <span className="st-h2">Danger zone</span>
        <p className="st-muted">Deleting the project removes its script, elements, shotlist, takes and exports. Files already on R2 are not reclaimed automatically.</p>
        <div>
          <Button kind="danger" busy={remove.busy} onClick={() => void remove.fire()}>Delete project</Button>
        </div>
      </div>
    </div>
  );
}
