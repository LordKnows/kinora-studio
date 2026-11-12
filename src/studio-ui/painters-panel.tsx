"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";

import type { Painter, PainterPod } from "@/studio/types";

import { del, get, post, usd } from "./api";
import { Button, ErrorBanner, Lamp, useAction, whenT } from "./common";
import { plural, useT } from "./i18n";

type Listed = Painter & { online: boolean };
type Setup = { studioUrl: string; tokenSet: boolean; ownToken: boolean; painterOnPod: boolean };
type PodState = {
  configured: boolean;
  why?: string;
  settings: { volumeId?: string; dataCenterId?: string; image: string; flavors: string[]; vcpuCount: number; idleStopMinutes: number };
  pod?: PainterPod & { live: boolean; painter?: { id: string; name: string; online: boolean; busy: number } };
  uptimeSeconds: number;
  sessionUsd: number;
  lifetimeUsd: number;
};
/** A translated sentence with elements in its {holes} (a link, a code span): the words around them follow the language. */
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return key && key in nodes ? <Fragment key={i}>{nodes[key]}</Fragment> : part;
  });
}

type Remake = { ready: boolean; modes: { edit: boolean; swap: boolean }; nodes: boolean; download: string; log?: string };

/* Painters: the machines that draw pictures away from the GPU (a small CPU
   box, a VPS, the GPU pod as the fallback). Each polls the Studio, so this
   lists what they last said; the Codex login is a command the painter picks
   up on its next heartbeat, and its code shows up here. */
export function PaintersPanel() {
  const t = useT();
  const [painters, setPainters] = useState<Listed[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [why, setWhy] = useState("");
  const [showHow, setShowHow] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const r = await get<{ painters: Listed[]; setup: Setup }>("/api/painters");
      setPainters(r.painters);
      setSetup(r.setup);
      setWhy("");
    } catch (caught) {
      setWhy(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const pending = painters?.some((p) => p.commands.length > 0 || p.info.login?.state === "pending");
  useEffect(() => {
    const t = setInterval(() => void refresh(), pending ? 3000 : 15000);
    return () => clearInterval(t);
  }, [pending, refresh]);
  const login = useAction(async (_c, id: string) => {
    await post(`/api/painters/${encodeURIComponent(id)}/login`);
    await refresh();
  });
  const forget = useAction(async (_c, id: string) => {
    await del(`/api/painters/${encodeURIComponent(id)}`);
    await refresh();
  });
  const online = (painters ?? []).filter((p) => p.online);
  const cpu = online.filter((p) => !p.info.onPod);
  const tokenName = setup?.ownToken ? "PAINTER_TOKEN" : "STUDIO_WORKER_TOKEN";
  const oneLiner = setup
    ? `export STUDIO_URL=${setup.studioUrl} PAINTER_TOKEN=<the ${tokenName} secret>\nmkdir -p ~/cinema-painter && curl -fsSL "$STUDIO_URL/api/pod/bundle?token=$PAINTER_TOKEN" | tar xz -C ~/cinema-painter\nbash ~/cinema-painter/h3-runpod/run_painter.sh`
    : "";
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={login.error ?? forget.error} onDismiss={() => { login.dismiss(); forget.dismiss(); }} />
      {why && <span className="st-warn">{why}</span>}
      <div className="st-row st-row--between">
        <span>
          <strong>{t("Painters")}</strong>{" "}
          <span className="st-muted">{t("— draw sheets, frames, edits, crops and frame extracts before the GPU pod starts")}</span>
        </span>
        <span className="st-row">
          <Button size="sm" kind="quiet" onClick={() => setShowHow((v) => !v)}>{showHow ? t("Hide setup") : t("Add a painter")}</Button>
          <Button size="sm" kind="quiet" onClick={() => void refresh()}>{t("Refresh")}</Button>
        </span>
      </div>
      {painters && cpu.length === 0 && (
        <span className="st-warn">
          {t("No painter is online{except}: picture jobs wait in the queue{orPod}. With a painter pod below, the Studio starts it by itself when pictures are queued; otherwise start a painter on any small machine — see “Add a painter”.", { except: online.length ? t(" except the GPU pod") : "", orPod: setup?.painterOnPod ? t(" (or until the GPU pod runs, which also draws)") : "" })}
        </span>
      )}
      {showHow && setup && (
        <div className="st-card st-stack st-stack--tight">
          <span>{t("On any Linux machine with Python 3 (a RunPod CPU pod, a VPS): the painter only calls out, so it needs no open port.")}</span>
          <pre className="st-pre" style={{ whiteSpace: "pre-wrap" }}>{oneLiner}</pre>
          <span className="st-muted">
            {withNodes(t("Or with Docker: {build}, then {run}. The token is the Worker secret {token}{unset}. Add {painterPath} and {podPath} to the Cloudflare Access bypass application. On a RunPod CPU pod, attach a volume at /workspace so the Codex login survives a restart.", {
              token: tokenName,
              unset: setup.tokenSet ? "" : t(" — not set yet: add PAINTER_TOKEN in the Worker's secrets"),
            }), {
              build: <code>docker build -t cinema-painter workers/painter</code>,
              run: <code>docker run -d --restart unless-stopped -v painter:/data -e STUDIO_URL=… -e PAINTER_TOKEN=… cinema-painter</code>,
              painterPath: <code>/api/painter/*</code>,
              podPath: <code>/api/pod/*</code>,
            })}
          </span>
        </div>
      )}
      <PainterPodCard onChange={refresh} />
      {(painters ?? []).map((p) => {
        const codex = p.info.codex;
        const l = p.info.login;
        const loginAsked = p.commands.some((c) => c.type === "codex_login");
        return (
          <div key={p.id} className="st-card st-stack st-stack--tight">
            <div className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
              <span className="st-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{p.info.onPod ? t("GPU pod (fallback)") : p.name}</strong>
                <Lamp state={p.online ? "ok" : "draft"} label={p.online ? t("online · {busy}/{slots} drawing", { busy: (p.info.running ?? []).length, slots: p.info.slots ?? 1 }) : t("offline · last seen {when}", { when: whenT(t, p.lastSeenAt) })} />
                <Lamp state={codex?.logged_in ? "ok" : codex?.installed ? "warn" : "draft"} label={codex?.logged_in ? t("Codex logged in") : codex?.installed ? t("Codex not logged in") : t("Codex not installed")} />
                {codex?.installed && codex.code_mode_host === false && <Lamp state="warn" label={t("code-mode helper missing")} />}
                {(p.info.backends ?? []).includes("api") && <Lamp state="ok" label={t("images API")} />}
              </span>
              <span className="st-row">
                {p.online && codex?.installed && !codex.logged_in && (
                  <Button size="sm" kind="primary" busy={login.busy} disabled={loginAsked} onClick={() => void login.fire(p.id)}>
                    {loginAsked ? t("Asking the painter…") : t("Log in with a device code")}
                  </Button>
                )}
                {!p.online && <Button size="sm" kind="quiet" busy={forget.busy} onClick={() => void forget.fire(p.id)}>{t("Forget")}</Button>}
              </span>
            </div>
            {l && l.state === "pending" && (
              <div className="st-stack st-stack--tight">
                <span>{withNodes(t("1. Open {link} on any device and sign in to ChatGPT."), { link: l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.url}</a> : t("the link") })}</span>
                <span>{t("2. Enter this code:")} <strong className="st-num" style={{ fontSize: 20, letterSpacing: 2 }}>{l.code ?? "…"}</strong></span>
                <span className="st-muted">{t("Device-code sign-in must be on in ChatGPT → Settings → Security. The code expires after a few minutes; press the button again for a new one.")}</span>
                {!l.code && l.lines?.length ? <pre className="st-muted" style={{ whiteSpace: "pre-wrap" }}>{l.lines.join("\n")}</pre> : null}
              </div>
            )}
            {l && l.state === "failed" && <span className="st-warn">{l.error ? t("Login failed: {error}.", { error: l.error }) : t("Login failed.")} {l.lines?.slice(-2).join(" ")}</span>}
            {p.info.lastError && <span className="st-muted">{t("Last error: {error}", { error: p.info.lastError })}</span>}
            {codex?.logged_in && codex.home && <span className="st-muted">{t("Login kept in {home}", { home: codex.home })}{p.info.host ? t(" on {host}", { host: p.info.host }) : ""}{p.info.version ? t(" · painter {version}", { version: p.info.version }) : ""}</span>}
          </div>
        );
      })}
    </div>
  );
}

function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* The painter pod: a RunPod CPU pod the Studio creates when pictures are
   queued and terminates after idling, on the network volume that keeps the
   Codex login — billed only while it draws. */
function PainterPodCard({ onChange }: { onChange: () => Promise<void> }) {
  const t = useT();
  const [state, setState] = useState<PodState | null>(null);
  const load = useCallback(async () => {
    try {
      setState(await get<PodState>("/api/painters/pod"));
    } catch {
      setState(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);
  const act = useAction(async (_c, what: "start" | "stop") => {
    setState(await post<PodState>(`/api/painters/pod/${what}`));
    await onChange();
  });
  if (!state) return null;
  const pod = state.pod;
  const live = !!pod?.live;
  const s = state.settings;
  return (
    <div className="st-card st-stack st-stack--tight">
      <ErrorBanner error={act.error} onDismiss={act.dismiss} />
      <div className="st-row st-row--between" style={{ flexWrap: "wrap" }}>
        <span className="st-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <strong>{t("Painter pod")}</strong>
          {state.configured ? (
            <Lamp state={!pod ? "draft" : pod.status === "running" ? "ok" : pod.status === "starting" ? "warn" : pod.status === "unavailable" ? "danger" : "draft"} label={t(`${!pod || pod.status === "terminated" ? "off" : pod.status}||gpu`)} />
          ) : (
            <Lamp state="draft" label={t("not set up")} />
          )}
          {live && pod?.painter && <Lamp state={pod.painter.online ? "ok" : "draft"} label={pod.painter.online ? t("painter online · {n} drawing", { n: pod.painter.busy }) : t("painter not up yet")} />}
        </span>
        {state.configured && (
          <span className="st-row">
            {!live && <Button size="sm" kind="primary" busy={act.busy} onClick={() => void act.fire("start")}>{t("Start||gpu")}</Button>}
            {live && <Button size="sm" busy={act.busy} onClick={() => void act.fire("stop")}>{t("Stop||gpu")}</Button>}
          </span>
        )}
      </div>
      {state.configured ? (
        <span className="st-muted">
          {t("Created by itself when pictures are queued and no painter can draw them, terminated after {n} idle minutes — a new pod each time ({flavors}, {vcpu} vCPU, {image}) in {dc}, with volume {volume} at /workspace keeping the Codex login.", { n: s.idleStopMinutes, flavors: s.flavors.join(" / "), vcpu: s.vcpuCount, image: s.image, dc: s.dataCenterId ?? "", volume: s.volumeId ?? "" })}
        </span>
      ) : (
        <span className="st-muted">
          {t("Not set up: {why}. Set PAINTER_POD_VOLUME_ID and PAINTER_POD_DATACENTER (Worker variables, wrangler.jsonc) and the Studio creates a CPU pod only while pictures wait.", { why: state.why ?? "" })}
        </span>
      )}
      {(live || state.lifetimeUsd > 0) && (
        <span className="st-muted st-num">
          {pod?.costPerHr && live ? `${usd(pod.costPerHr)}/h · ` : ""}
          {state.uptimeSeconds ? t("up {time} ({usd}) · ", { time: duration(state.uptimeSeconds), usd: usd(state.sessionUsd) }) : ""}
          {t("{usd} so far", { usd: usd(state.lifetimeUsd) })}
        </span>
      )}
      {pod?.message && <span className={pod.status === "unavailable" ? "st-warn" : "st-muted"}>{pod.message}</span>}
    </div>
  );
}

/* The Viggle Remake models live on the GPU pod's volume (Remake renders there). */
export function RemakeModels() {
  const t = useT();
  const [remake, setRemake] = useState<Remake | null>(null);
  const [why, setWhy] = useState("");
  const refresh = useCallback(async () => {
    try {
      setRemake(await get<Remake>("/api/gpu/remake"));
      setWhy("");
    } catch (caught) {
      setWhy(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (remake?.download !== "downloading") return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [remake?.download, refresh]);
  const install = useAction(async (_c, modes: Array<"edit" | "swap">) => {
    if (!window.confirm(plural(t, modes.length, "Download the Viggle Remake {modes} model onto the volume (about {gb} GB)?", "Download the Viggle Remake {modes} models onto the volume (about {gb} GB)?", { modes: modes.join(t(" and ||list")), gb: 21 * modes.length }))) return;
    await post("/api/gpu/remake", { modes });
    await refresh();
  });
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={install.error} onDismiss={install.dismiss} />
      {why && <span className="st-muted">{t("Start the GPU pod to see this ({why}).", { why })}</span>}
      <div className="st-row st-row--between">
        <span>
          <strong>Viggle Remake</strong>
          <br />
          {remake ? (
            <span className="st-row" style={{ gap: 8 }}>
              <Lamp state={remake.nodes ? "ok" : "warn"} label={remake.nodes ? t("nodes installed") : t("nodes missing (restart the pod)")} />
              <Lamp state={remake.modes.edit ? "ok" : "draft"} label={remake.modes.edit ? t("edit ready") : t("edit not downloaded")} />
              <Lamp state={remake.modes.swap ? "ok" : "draft"} label={remake.modes.swap ? t("swap ready") : t("swap not downloaded")} />
            </span>
          ) : null}
        </span>
        <span className="st-row">
          {remake && (!remake.modes.edit || !remake.modes.swap) && (
            <Button size="sm" busy={install.busy} disabled={remake.download === "downloading"} onClick={() => void install.fire((["edit", "swap"] as const).filter((m) => !remake.modes[m]))}>
              {remake.download === "downloading" ? t("Downloading…") : t("Download models")}
            </Button>
          )}
          <Button size="sm" kind="quiet" onClick={() => void refresh()}>{t("Refresh")}</Button>
        </span>
      </div>
      {remake?.download === "downloading" && <span className="st-muted st-num">{remake.log}</span>}
    </div>
  );
}
