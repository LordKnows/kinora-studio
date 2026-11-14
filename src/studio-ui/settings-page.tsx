"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

import { del, get, patch, put } from "./api";
import { Button, ConfirmButton, ErrorBanner, Field, useAction } from "./common";
import { useT } from "./i18n";
import { DirectorPanel } from "./director-panel";
import { RecentlyDeleted } from "./recently-deleted";
import { useProjectContext } from "./shell";

/* Project settings, in the panel beside the page (?panel=settings): what
   belongs to this film only — its name and budget, who sees it, what the
   director may do without asking (image and voice generation, the spend
   envelope, delegated approval), and what was deleted lately. Every item
   says what it is in a line. The pod, the library and the MCP connection
   are global pages. */
export function SettingsPanel({ onDone }: { onDone?: () => void }) {
  const t = useT();
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
    await del(`/api/projects/${projectId}`);
    onDone?.();
    router.push("/");
  });
  return (
    <div className="side-body set-body">
      <ErrorBanner error={save.error ?? remove.error} onDismiss={() => { save.dismiss(); remove.dismiss(); }} />
      <div className="st-card st-stack">
        <Field label={t("Project name")}>
          <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("Budget cap (USD)")}>
          <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <div className="st-row st-row--between">
          <span className="st-muted st-num">{t("spent so far {usd}", { usd: view ? `$${view.project.spentUsd.toFixed(3)}` : "…" })}</span>
          <Button kind="primary" busy={save.busy} onClick={() => void save.fire()}>{t("Save")}</Button>
        </div>
      </div>
      <SharingCard />
      <DirectorPanel projectId={projectId} part="settings" />
      <div className="st-card st-stack">
        <RecentlyDeleted projectId={projectId} onRestored={reload} />
      </div>
      <div className="st-card st-stack">
        <span className="st-h2">{t("Elsewhere")}</span>
        <div className="st-row">
          <Link className="st-btn st-btn--sm" href="/machine">{t("Machine")}</Link>
          <Link className="st-btn st-btn--sm" href="/library">{t("Library")}</Link>
          <Link className="st-btn st-btn--sm" href="/connect">{t("Connect")}</Link>
        </div>
      </div>
      <div className="st-card st-card--quiet st-stack">
        <span className="st-h2">{t("Delete the project")}</span>
        <p className="st-muted">{t("Everything in it goes. For 14 days it can be put back from the Projects page.")}</p>
        <div>
          <ConfirmButton kind="danger" busy={remove.busy} placement="above" align="start" confirmLabel={t("Delete project")} onConfirm={() => void remove.fire()}
            question={t('Delete "{name}" and everything in it? For 14 days it can be put back from the Projects page (Recently deleted).', { name: String(view?.project.name) })}>
            {t("Delete project")}
          </ConfirmButton>
        </div>
      </div>
    </div>
  );
}

type Me = { user: string; admin: boolean };

/* Who sees this project. Only its owner switches it, here (never the
   director); a project from before private projects is claimed by an admin. */
function SharingCard() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);
  const change = useAction(async (_confirm, visibility: "shared" | "private") => {
    if (visibility === "shared" && !window.confirm(t("Share this project? Every signed-in user of this studio will see its script, pictures, takes and exports, and can change them."))) return;
    await put(`/api/projects/${projectId}/sharing`, { visibility });
    await reload();
  });
  if (!view) return null;
  const p = view.project;
  const mine = !!me && !!p.owner && p.owner === me.user;
  const canChange = !!me && (mine || (!p.owner && me.admin));
  return (
    <div className="st-card st-stack">
      <span className="st-h2">{t("Sharing")}</span>
      <ErrorBanner error={change.error} onDismiss={change.dismiss} />
      <div className="st-seg" role="group" aria-label={t("Who sees it")} style={{ alignSelf: "flex-start" }}>
        <button type="button" aria-pressed={p.visibility !== "private"} disabled={!canChange || change.busy} onClick={() => void change.fire("shared")}>
          {t("Shared")}<small>{t("every signed-in user")}</small>
        </button>
        <button type="button" aria-pressed={p.visibility === "private"} disabled={!canChange || change.busy} onClick={() => void change.fire("private")}>
          {t("Private")}<small>{mine || !p.owner ? t("only you") : t("only its owner")}</small>
        </button>
      </div>
      {p.owner && <p className="st-muted">{t("Owner: {who}. ", { who: mine ? t("you") : p.owner })}</p>}
    </div>
  );
}
