"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { Project, ProjectVisibility } from "@/studio/types";

import { get, post, usd } from "./api";
import { Button, Empty, ErrorBanner, Field, Skeleton, whenT } from "./common";
import { CheckCircleIcon, ChevronIcon, InfoIcon } from "./icons";
import { NavIcon, type NavIconName } from "./nav-icons";
import { useT } from "./i18n";
import { RecentlyDeleted } from "./recently-deleted";

type ListedProject = Project & { mine: boolean };

/* Home: the films, and the path a new one takes. Your private projects come
   first; the shared ones are everyone's (the GPU, painters and director
   connector are shared either way). */
export function ProjectsPage() {
  const t = useT();
  const [projects, setProjects] = useState<ListedProject[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [cap, setCap] = useState("50");
  const [visibility, setVisibility] = useState<ProjectVisibility>("shared");
  const [busy, setBusy] = useState(false);
  /* the path a film takes is one click away, not always on the page */
  const [flow, setFlow] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { projects } = await get<{ projects: ListedProject[] }>("/api/projects");
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
      await post("/api/projects", { name: name.trim(), budgetCapUsd: Number(cap) || 50, visibility });
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
          <h1 className="st-title">{t("Projects")}</h1>
          <p className="st-subtitle">
            {t("One project per film, with two approvals along the way.")}
            <button type="button" className="st-flow-toggle" aria-expanded={flow} aria-controls="film-flow" title={t("How a film moves through the studio")} aria-label={t("How a film moves through the studio")} onClick={() => setFlow(!flow)}>
              <InfoIcon size={16} />
            </button>
          </p>
        </div>
      </div>
      {flow && <FilmFlow />}

      <form className="st-card" onSubmit={create}>
        <div className="st-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <div style={{ flex: 2, minWidth: 220 }}>
            <Field label={t("New project")}>
              <input className="st-input" placeholder={t("Neon rain chase")} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div style={{ width: 150 }}>
            <Field label={t("Budget cap (USD)")}>
              <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
          </div>
          <Field label={t("Who sees it")} group>
            <div className="st-seg" role="group" aria-label={t("Who sees it")}>
              <button type="button" aria-pressed={visibility === "shared"} onClick={() => setVisibility("shared")} title={t("Every signed-in user of this studio")}>{t("Shared")}</button>
              <button type="button" aria-pressed={visibility === "private"} onClick={() => setVisibility("private")} title={t("Only you, on the web and through your director connector")}>{t("Private")}</button>
            </div>
          </Field>
          <Button type="submit" kind="primary" busy={busy} disabled={!name.trim()}>{t("Create")}</Button>
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
          <Empty title={t("No projects yet")} hint={t("Create one above, or let your director agent call start_film over MCP.")} />
        ) : (
          <>
            {groups(projects).map((g) => (
              <div key={g.key} className="st-stack" style={{ marginTop: g.key === "shared" && projects.some((p) => p.visibility === "private") ? 22 : 0 }}>
                {g.title && <div className="st-section-title"><span>{t(g.title)}</span></div>}
                <div className="st-grid">
                  {g.items.map((p) => <ProjectCard key={p.id} p={p} />)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="st-section">
        <RecentlyDeleted onRestored={reload} />
      </div>
    </div>
  );
}

/* The film's path, one card a stage, each in its own colour; the two stages you approve say so. */
const FLOW: Array<{ icon: NavIconName; name: string; text: string; hue: string; approval?: boolean }> = [
  { icon: "story", name: "Story", text: "What the film is and how long; the treatment and the screenplay. You approve it.", hue: "info", approval: true },
  { icon: "design", name: "Design", text: "One of the 16 looks; characters, places and props with reference images.", hue: "warn" },
  { icon: "board", name: "Board", text: "Shots with links and cinematography; you approve, then render.", hue: "ok", approval: true },
  { icon: "screen", name: "Screening", text: "Takes side by side; score them, circle one per shot.", hue: "accent" },
  { icon: "cut", name: "Cut", text: "Order, trim, titles, sound; every pick at 2K; export.", hue: "ink" },
];

function FilmFlow() {
  const t = useT();
  return (
    <section id="film-flow" className="st-flow" aria-label={t("How a film moves through the studio")}>
      <div className="st-flow-head">
        <h2 className="st-h2">{t("How a film moves through the studio")}</h2>
        <span className="st-flow-key"><CheckCircleIcon size={14} />{t("You approve before it goes on")}</span>
      </div>
      <ol className="st-flow-steps">
        {FLOW.map((f, i) => (
          <li key={f.name} className="st-flow-step" data-hue={f.hue}>
            <span className="st-flow-ico"><NavIcon name={f.icon} size={26} /></span>
            <span className="st-flow-no">{String(i + 1).padStart(2, "0")}</span>
            <strong>{t(f.name)}</strong>
            <span className="st-flow-text">{t(f.text)}</span>
            {f.approval && <span className="st-flow-ok"><CheckCircleIcon size={13} />{t("Approval")}</span>}
            {i < FLOW.length - 1 && <span className="st-flow-next" aria-hidden="true"><ChevronIcon size={16} /></span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function groups(projects: ListedProject[]): Array<{ key: string; title?: string; items: ListedProject[] }> {
  const mine = projects.filter((p) => p.visibility === "private");
  const shared = projects.filter((p) => p.visibility !== "private");
  if (!mine.length) return [{ key: "shared", items: shared }];
  return [
    { key: "private", title: "Private · only you", items: mine },
    ...(shared.length ? [{ key: "shared", title: "Shared", items: shared }] : []),
  ];
}

function ProjectCard({ p }: { p: ListedProject }) {
  const t = useT();
  const steps = [Boolean(p.brief), p.shotlistApproval === "approved", p.spentUsd > 0];
  return (
    <Link href={`/p/${p.id}`} className="st-project">
      <span className="st-row st-row--between" style={{ alignItems: "flex-start", gap: 8 }}>
        <span className="st-project-name">{p.name}</span>
        {p.visibility === "private" ? (
          <span className="st-chip st-chip--mono" title={t("Only you see it")}>{t("Private")}</span>
        ) : p.owner && !p.mine ? (
          <span className="st-chip st-chip--mono" title={t("Shared by {owner}", { owner: p.owner })}>{p.owner.split("@")[0]}</span>
        ) : null}
      </span>
      <span className="st-project-meta">
        <span>{whenT(t, p.updatedAt)}</span>
        <span className="st-num">{usd(p.spentUsd)} / {usd(p.budgetCapUsd)}</span>
      </span>
      <span className="st-project-steps" aria-label={t("progress")}>
        {steps.map((done, i) => <span key={i} data-done={done ? "true" : "false"} />)}
      </span>
      <span className="st-muted">{p.shotlistApproval === "approved" ? t("Shotlist approved") : p.brief ? t("Brief written") : t("Just created")}</span>
    </Link>
  );
}
