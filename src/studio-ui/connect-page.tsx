"use client";

import { useEffect, useState } from "react";

import directorGuide from "@/mcp/guide";

import { Button, CopyRow } from "./common";

/* Connect: the MCP endpoint a director agent (Claude, Grok) attaches to. */
export function ConnectPage() {
  const [origin, setOrigin] = useState("");
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <div className="st-page st-page--narrow">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Connect a director</h1>
          <p className="st-subtitle">Your subscription Claude or Grok works through the Studio MCP: script, elements, shotlist, batch plan, renders. Every paid action still asks you to confirm.</p>
        </div>
      </div>
      <div className="st-card st-stack">
        <CopyRow label="MCP endpoint" value={`${origin}/mcp`} />
        <CopyRow label="OAuth metadata" value={`${origin}/.well-known/oauth-authorization-server`} />
        <div className="st-steps">
          <div className="st-stepcard"><span className="st-step">01</span><strong>Claude</strong><span>Settings → Connectors → Add custom connector → paste the endpoint → sign in on the consent page.</span></div>
          <div className="st-stepcard"><span className="st-step">02</span><strong>Grok</strong><span>grok.com → Connectors → New Connector → Custom → paste the same endpoint → sign in.</span></div>
          <div className="st-stepcard"><span className="st-step">03</span><strong>Start a film</strong><span>Say “start a new film”. The agent reads the director guide through the connector; pasting it into project instructions is optional.</span></div>
        </div>
        <div className="st-row">
          <Button size="sm" onClick={() => setShowGuide((s) => !s)}>{showGuide ? "Hide director guide" : "Show director guide"}</Button>
          <Button size="sm" kind="quiet" onClick={() => void navigator.clipboard.writeText(directorGuide)}>Copy guide</Button>
        </div>
        {showGuide && <pre className="st-pre">{directorGuide}</pre>}
        <p className="st-muted">Added a tool lately? Remove and re-add the connector in the chat client so its tool list refreshes.</p>
      </div>
    </div>
  );
}
