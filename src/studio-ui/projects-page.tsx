"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { Project } from "@/studio/types";

import { get, post, usd, when } from "./api";
import { Button, Empty, ErrorBanner, Field, Skeleton } from "./common";

/* Home: the films, and the path a new one takes. */
export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [cap, setCap] = useState("50");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { projects } = await get<{ projects: Project[] }>("/api/projects");
      setProjects(projects);
    } catch (caught) {
      setError(caught);
      setProjects([]);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/projects", { name: name.trim(), budgetCapUsd: Number(cap) || 50 });
      setName("");
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Projects</h1>
          <p className="st-subtitle">One project per film. Brief and style, script, elements, shotlist, takes, finals, timeline — in that order, with two approvals along the way.</p>
        </div>
      </div>

      <form className="st-card" onSubmit={create}>
        <div className="st-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <div style={{ flex: 2, minWidth: 220 }}>
            <Field label="New project">
              <input className="st-input" placeholder="Neon rain chase" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div style={{ width: 150 }}>
            <Field label="Budget cap (USD)">
              <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" kind="primary" busy={busy} disabled={!name.trim()}>Create</Button>
        </div>
      </form>

      {error ? <div style={{ marginTop: 14 }}><ErrorBanner error={error} onDismiss={() => setError(null)} /></div> : null}

      <div className="st-section">
        {projects === null ? (
          <div className="st-grid">
            <Skeleton height={140} />
            <Skeleton height={140} />
          </div>
        ) : projects.length === 0 ? (
          <Empty title="No projects yet" hint="Create one above, or let your director agent call start_film over MCP." />
        ) : (
          <div className="st-grid">
            {projects.map((p) => {
              const steps = [Boolean(p.brief), p.shotlistApproval === "approved", p.spentUsd > 0];
              return (
                <Link key={p.id} href={`/p/${p.id}/board`} className="st-project">
                  <span className="st-project-name">{p.name}</span>
                  <span className="st-project-meta">
                    <span>{when(p.updatedAt)}</span>
                    <span className="st-num">{usd(p.spentUsd)} / {usd(p.budgetCapUsd)}</span>
                  </span>
                  <span className="st-project-steps" aria-label="progress">
                    {steps.map((done, i) => <span key={i} data-done={done ? "true" : "false"} />)}
                  </span>
                  <span className="st-muted">{p.shotlistApproval === "approved" ? "Shotlist approved" : p.brief ? "Brief written" : "Just created"}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="st-section">
        <div className="st-section-title"><span>How a film moves through the studio</span></div>
        <div className="st-steps">
          <div className="st-stepcard"><span className="st-step">01</span><strong>Brief & style</strong><span>What the film is, how long, which of the 16 looks.</span></div>
          <div className="st-stepcard"><span className="st-step">02</span><strong>Script</strong><span>Treatment and screenplay; you approve it.</span></div>
          <div className="st-stepcard"><span className="st-step">03</span><strong>Elements</strong><span>Characters, places, props with reference images.</span></div>
          <div className="st-stepcard"><span className="st-step">04</span><strong>Board</strong><span>Shots with links and cinematography; you approve, then render.</span></div>
          <div className="st-stepcard"><span className="st-step">05</span><strong>Finals</strong><span>Pick takes, regenerate them at 2K.</span></div>
          <div className="st-stepcard"><span className="st-step">06</span><strong>Timeline</strong><span>Order, trim, music, export.</span></div>
        </div>
      </div>
    </div>
  );
}
