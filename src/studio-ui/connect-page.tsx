"use client";

import { useEffect, useState } from "react";

import directorGuide from "@/mcp/guide";

import { Button, CopyRow } from "./common";
import { useT } from "./i18n";

/* Connect: the MCP endpoint a director agent (Claude, Grok) attaches to. */
export function ConnectPage() {
  const t = useT();
  const [origin, setOrigin] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <div className="st-page st-page--narrow">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Connect a director")}</h1>
          <p className="st-subtitle">{t("Your subscription Claude or Grok works through the Studio MCP: script, elements, shotlist, batch plan, renders. Every paid action still asks you to confirm.")}</p>
        </div>
      </div>
      <div className="st-card st-stack">
        <CopyRow label={t("MCP endpoint")} value={`${origin}/mcp`} />
        <CopyRow label={t("OAuth metadata")} value={`${origin}/.well-known/oauth-authorization-server`} />
        <div className="st-steps">
          <div className="st-stepcard"><span className="st-step">01</span><strong>Claude</strong><span>{t("Settings → Connectors → Add custom connector → paste the endpoint → sign in on the consent page.")}</span></div>
          <div className="st-stepcard"><span className="st-step">02</span><strong>Grok</strong><span>{t("grok.com → Connectors → New Connector → Custom → paste the same endpoint → sign in.")}</span></div>
          <div className="st-stepcard"><span className="st-step">03</span><strong>{t("Start a film")}</strong><span>{t("Say “start a new film”. The agent reads the director guide through the connector; pasting it into project instructions is optional.")}</span></div>
        </div>
        <div className="st-row">
          <Button size="sm" onClick={() => setShowGuide((s) => !s)}>{showGuide ? t("Hide director guide") : t("Show director guide")}</Button>
          <Button size="sm" kind="quiet" onClick={() => void navigator.clipboard.writeText(directorGuide)}>{t("Copy guide")}</Button>
        </div>
        {showGuide && <pre className="st-pre">{directorGuide}</pre>}
        <p className="st-muted">{t("Added a tool lately? Remove and re-add the connector in the chat client so its tool list refreshes.")}</p>
      </div>
    </div>
  );
}
