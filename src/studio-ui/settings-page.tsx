"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

import { del, get, patch, put } from "./api";
import { Button, ErrorBanner, Field, useAction } from "./common";
import { useT } from "./i18n";
import { useProjectContext } from "./shell";

/* Project settings: what belongs to this film only. The pod, the library
   and the MCP connection are global pages. */
export function SettingsPage() {
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
    if (!window.confirm(t('Delete "{name}" and everything in it? For 14 days it can be put back from the Projects page (Recently deleted).', { name: String(view?.project.name) }))) return;
    await del(`/api/projects/${projectId}`);
    router.push("/");
  });
  return (
    <div className="st-page st-page--narrow">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Project settings")}</h1>
          <p className="st-subtitle">{t("Name, budget and who sees the film. What the director may do is on the Director page; the GPU, the library and the connection live under Machine, Library and Connect.")}</p>
        </div>
      </div>
      <ErrorBanner error={save.error ?? remove.error} onDismiss={() => { save.dismiss(); remove.dismiss(); }} />
      <div className="st-card st-stack">
        <div className="st-fields">
          <Field label={t("Project name")}>
            <input className="st-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("Budget cap (USD)")} hint={t("Takes, 2K passes and exports are refused once reservations would cross it.")}>
            <input className="st-input" type="number" min={0} step={1} value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
        </div>
        <div className="st-row st-row--between">
          <span className="st-muted st-num">{t("spent so far {usd}", { usd: view ? `$${view.project.spentUsd.toFixed(3)}` : "…" })}</span>
          <Button kind="primary" busy={save.busy} onClick={() => void save.fire()}>{t("Save")}</Button>
        </div>
      </div>
      <SharingCard />
      <div className="st-card st-stack" style={{ marginTop: 20 }}>
        <span className="st-h2">{t("Elsewhere")}</span>
        <div className="st-row">
          <Link className="st-btn" href={`/p/${projectId}/director`}>{t("Director")}</Link>
          <Link className="st-btn" href="/machine">{t("Machine")}</Link>
          <Link className="st-btn" href="/library">{t("Library")}</Link>
          <Link className="st-btn" href="/connect">{t("Connect")}</Link>
        </div>
      </div>
      <div className="st-card st-card--quiet st-stack" style={{ marginTop: 20 }}>
        <span className="st-h2">{t("Danger zone")}</span>
        <p className="st-muted">{t("Deleting the project removes its script, elements, shotlist, takes and exports. For 14 days it can be put back from the Projects page (Recently deleted); after that it is gone. Files already on R2 are not reclaimed automatically.")}</p>
        <div>
          <Button kind="danger" busy={remove.busy} onClick={() => void remove.fire()}>{t("Delete project")}</Button>
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
    <div className="st-card st-stack" style={{ marginTop: 20 }}>
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
      <p className="st-muted">
        {p.owner ? t("Owner: {who}. ", { who: mine ? t("you") : p.owner }) : t("This project is from before private projects and has no owner{rest} ", { rest: me?.admin ? t(": making it private makes it yours.") : t("; an admin can make it private.") })}
        {t("A private project is hidden from everyone else, on the web and through their director connectors. The GPU pod, the painters and the libraries stay shared: other users see that the pod is busy, not with what. Picture links (/media/…) work for whoever has them.")}
      </p>
    </div>
  );
}
