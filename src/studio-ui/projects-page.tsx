"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { Project } from "@/studio/types";

import { del, describe, get, post, usd, when } from "./api";
import { Button, Empty, ErrorBanner, Field, Skeleton } from "./common";

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

  async function remove(project: Project) {
    if (!window.confirm(`Delete "${project.name}" and everything in it? This cannot be undone.`)) return;
    try {
      await del(`/api/projects/${project.id}`);
      await reload();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Projects</h1>
          <p className="st-subtitle">Script, elements, shotlist, takes, timeline. One project per film.</p>
        </div>
        <div className="st-actions">
          <Link className="st-btn st-btn--quiet" href="/playground">
            Playground
          </Link>
        </div>
      </div>

      <form className="st-card" onSubmit={create}>
        <div className="st-row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <Field label="New project">
              <input className="st-input" placeholder="Neon rain chase" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div style={{ width: 140 }}>
            <Field label="Budget cap (USD)">
              <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" kind="primary" busy={busy} disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>

      {error ? <div style={{ marginTop: 12 }}><ErrorBanner error={error} onDismiss={() => setError(null)} /></div> : null}

      <div className="st-section">
        {projects === null ? (
          <div className="st-grid">
            <Skeleton height={110} />
            <Skeleton height={110} />
          </div>
        ) : projects.length === 0 ? (
          <Empty title="No projects yet" hint="Create one above, or let your director agent call create_project over MCP." />
        ) : (
          <div className="st-grid">
            {projects.map((p) => (
              <div key={p.id} className="st-project">
                <Link href={`/p/${p.id}/board`} className="st-project-name" style={{ textDecoration: "none", color: "inherit" }}>
                  {p.name}
                </Link>
                <div className="st-project-meta">
                  <span>{when(p.updatedAt)}</span>
                  <span>
                    {usd(p.spentUsd)} / {usd(p.budgetCapUsd)}
                  </span>
                </div>
                <div className="st-row st-row--between">
                  <span className="st-muted">{p.shotlistApproval === "approved" ? "Shotlist approved" : "Shotlist draft"}</span>
                  <Button size="sm" kind="danger" onClick={() => void remove(p)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function describeUnknown(caught: unknown): string {
  return describe(caught);
}
