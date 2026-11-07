"use client";

import { useCallback, useEffect, useState } from "react";

import { get, post } from "./api";
import { Button, ErrorBanner, Lamp, useAction } from "./common";

type Login = { state: string; url?: string; code?: string; lines?: string[]; error?: string };
type Codex = { installed: boolean; logged_in: boolean; detail?: string; home?: string; login?: Login };
type Remake = { ready: boolean; modes: { edit: boolean; swap: boolean }; nodes: boolean; download: string; log?: string };

/* The pod's image side: Codex logged in with the user's ChatGPT plan (device
   code, once per volume) and the Viggle Remake models on the volume. Both
   need the pod running. */
export function PodImaging() {
  const [codex, setCodex] = useState<Codex | null>(null);
  const [remake, setRemake] = useState<Remake | null>(null);
  const [why, setWhy] = useState<string>("");
  const refresh = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([get<Codex>("/api/gpu/codex"), get<Remake>("/api/gpu/remake")]);
      setCodex(c);
      setRemake(r);
      setWhy("");
    } catch (caught) {
      setWhy(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const pending = codex?.login?.state === "pending" || remake?.download === "downloading";
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [pending, refresh]);
  const login = useAction(async () => {
    const state = await post<Login>("/api/gpu/codex");
    setCodex((c) => (c ? { ...c, login: state } : c));
    await refresh();
  });
  const install = useAction(async (_c, modes: Array<"edit" | "swap">) => {
    if (!window.confirm(`Download the Viggle Remake ${modes.join(" and ")} model${modes.length > 1 ? "s" : ""} onto the volume (about ${21 * modes.length} GB)?`)) return;
    await post("/api/gpu/remake", { modes });
    await refresh();
  });
  const l = codex?.login;
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={login.error ?? install.error} onDismiss={() => { login.dismiss(); install.dismiss(); }} />
      {why && <span className="st-muted">Start the GPU pod to see this ({why}).</span>}
      <div className="st-row st-row--between">
        <span>
          <strong>Codex (GPT Image with your ChatGPT plan)</strong>
          <br />
          {codex ? (
            <Lamp state={codex.logged_in ? "ok" : codex.installed ? "warn" : "draft"} label={codex.logged_in ? "logged in" : codex.installed ? "installed, not logged in" : "not installed (the pod installs it at boot)"} />
          ) : null}
        </span>
        <span className="st-row">
          {codex && !codex.logged_in && <Button size="sm" kind="primary" busy={login.busy} onClick={() => void login.fire()}>Log in with a device code</Button>}
          <Button size="sm" kind="quiet" onClick={() => void refresh()}>Refresh</Button>
        </span>
      </div>
      {l && l.state === "pending" && (
        <div className="st-card st-stack st-stack--tight">
          <span>1. Open {l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.url}</a> : "the link below"} on any device and sign in to ChatGPT.</span>
          <span>2. Enter this code: <strong className="st-num" style={{ fontSize: 20, letterSpacing: 2 }}>{l.code ?? "…"}</strong></span>
          <span className="st-muted">Device-code sign-in must be on in ChatGPT → Settings → Security. The code expires after a few minutes; press the button again for a new one.</span>
          {!l.code && l.lines?.length ? <pre className="st-muted" style={{ whiteSpace: "pre-wrap" }}>{l.lines.join("\n")}</pre> : null}
        </div>
      )}
      {l && l.state === "failed" && <span className="st-warn">Login failed{l.error ? `: ${l.error}` : ""}. {l.lines?.slice(-2).join(" ")}</span>}
      {codex?.logged_in && <span className="st-muted">The login lives on the volume ({codex.home}); a new pod reuses it.</span>}

      <div className="st-row st-row--between" style={{ marginTop: 8 }}>
        <span>
          <strong>Viggle Remake</strong>
          <br />
          {remake ? (
            <span className="st-row" style={{ gap: 8 }}>
              <Lamp state={remake.nodes ? "ok" : "warn"} label={remake.nodes ? "nodes installed" : "nodes missing (restart the pod)"} />
              <Lamp state={remake.modes.edit ? "ok" : "draft"} label={`edit ${remake.modes.edit ? "ready" : "not downloaded"}`} />
              <Lamp state={remake.modes.swap ? "ok" : "draft"} label={`swap ${remake.modes.swap ? "ready" : "not downloaded"}`} />
            </span>
          ) : null}
        </span>
        {remake && (!remake.modes.edit || !remake.modes.swap) && (
          <Button size="sm" busy={install.busy} disabled={remake.download === "downloading"} onClick={() => void install.fire((["edit", "swap"] as const).filter((m) => !remake.modes[m]))}>
            {remake.download === "downloading" ? "Downloading…" : "Download models"}
          </Button>
        )}
      </div>
      {remake?.download === "downloading" && <span className="st-muted st-num">{remake.log}</span>}
    </div>
  );
}
