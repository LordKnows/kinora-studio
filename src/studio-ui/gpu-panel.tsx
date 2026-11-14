"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useState } from "react";

import type { GpuState } from "@/studio/gpu";
import type { GpuTypeStats } from "@/studio/types";

import { describe, get, post, usd } from "./api";
import { Button, CopyRow, ErrorBanner, Lamp, Loading, useAction, usePopover } from "./common";
import { useT } from "./i18n";
import { WarningIcon } from "./icons";

/* The GPU pod — one for the whole Studio, shared by every project. Its state
   lives in ONE store for the page (the top-bar menu, the Machine page and any
   other view read the same object), polled at a pace that follows the pod
   (fast while it changes, slow otherwise), refreshed when the window regains
   focus, and announced to the other open tabs after every Start / Stop. */

type GpuStore = { state: GpuState | null; error: string | null };
let gpuStore: GpuStore = { state: null, error: null };
const gpuSubscribers = new Set<() => void>();
let gpuTimer: number | undefined;
let gpuInflight: Promise<void> | null = null;
let gpuChannel: BroadcastChannel | null = null;

function scheduleGpuPoll(): void {
  if (typeof window === "undefined") return;
  if (gpuTimer) window.clearTimeout(gpuTimer);
  const s = gpuStore.state;
  const busy = s?.status === "starting" || s?.status === "creating" || s?.status === "stopping" || (s?.pendingTakes ?? 0) > 0;
  gpuTimer = window.setTimeout(() => void refreshGpuStore(), gpuStore.error ? 10000 : busy ? 5000 : 30000);
}

function refreshGpuStore(): Promise<void> {
  if (gpuInflight) return gpuInflight;
  gpuInflight = (async () => {
    try {
      gpuStore = { state: await get<GpuState>("/api/gpu"), error: null };
    } catch (caught) {
      gpuStore = { ...gpuStore, error: describe(caught) };
    } finally {
      gpuInflight = null;
      gpuSubscribers.forEach((f) => f());
      scheduleGpuPoll();
    }
  })();
  return gpuInflight;
}

function channel(): BroadcastChannel | null {
  if (gpuChannel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return gpuChannel;
  gpuChannel = new BroadcastChannel("studio-gpu");
  gpuChannel.onmessage = () => void refreshGpuStore();
  return gpuChannel;
}

export function useGpu() {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    gpuSubscribers.add(rerender);
    channel();
    if (!gpuStore.state && !gpuInflight) void refreshGpuStore();
    const onFocus = () => void refreshGpuStore();
    window.addEventListener("focus", onFocus);
    return () => {
      gpuSubscribers.delete(rerender);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  /* after a Start / Stop: refresh here and tell the other tabs */
  const reload = useCallback(async () => {
    await refreshGpuStore();
    channel()?.postMessage("changed");
  }, []);
  return { state: gpuStore.state, error: gpuStore.error, reload };
}

/** Whether a render has to wait for the GPU: pod mode, set up, and the pod not running. (Serverless has no pod to start.) */
export function gpuBlocksRender(state: GpuState | null): boolean {
  return !!state && state.mode === "pod" && state.configured && state.status !== "running";
}

/** The GPU as a thing to settle before a render: while it is off or coming up, a notice with the way to
    start it; once it runs, one quiet line. Nothing for serverless or an unconfigured pod. `what` is what is
    about to be done ("rendering", "rolling a take"). */
export function GpuGate({ what }: { what: string }) {
  const t = useT();
  const { state, error, reload } = useGpu();
  const start = useAction(async (confirm) => {
    await post("/api/gpu/start", { confirm });
    await reload();
  });
  if (!state) return error ? <span className="st-warn">{t("Could not read the GPU state: {error}", { error })}</span> : <Loading label={t("Checking the GPU…")} />;
  if (state.mode !== "pod" || !state.configured) return null;
  if (state.status === "running") return <span className="st-muted"><Lamp state="approved" label={t("GPU running||gpu")} /></span>;
  const coming = state.status === "starting" || state.status === "creating";
  return (
    <div className="st-stack st-stack--tight">
      <div className="st-alert st-alert--accent" role="alert">
        <WarningIcon size={14} />
        <span>
          <strong>{t("The GPU is not running.")}</strong>{" "}
          {coming
            ? t("It is {status}; {what} can begin once it runs.", { status: t(`${GPU_LABEL[state.status] ?? state.status}||gpu`), what })
            : t("Start it before {what}. It bills per hour while it runs.", { what })}
          {state.message ? ` ${state.message}` : ""}
        </span>
        <Button kind="primary" size="sm" busy={start.busy || coming} onClick={() => void start.fire()}>
          {state.status === "unavailable" ? t("Retry||gpu") : coming ? t("Starting…") : t("Start the GPU")}
        </Button>
      </div>
      <ErrorBanner error={start.error} onConfirm={() => void start.confirm()} onDismiss={start.dismiss} />
    </div>
  );
}

const SHORT: Record<string, string> = { none: "GPU off", off: "GPU off", starting: "GPU starting", creating: "GPU creating", running: "GPU on", stopping: "GPU stopping", stopped: "GPU off", unavailable: "no GPU", terminated: "GPU off" };

/** The GPU in the top bar of every page: always shown, opens a menu with its state and Start / Stop. */
export function GpuMenu() {
  const t = useT();
  const { state, error, reload } = useGpu();
  const { open, setOpen, ref: box } = usePopover();
  const start = useAction(async (confirm) => {
    await post("/api/gpu/start", { confirm });
    await reload();
  });
  const stop = useAction(async (confirm) => {
    await post("/api/gpu/stop", { confirm });
    await reload();
  });
  const live = !!state && (state.status === "running" || state.status === "starting" || state.status === "creating");
  const lamp = !state ? "draft" : !state.configured ? "draft" : state.status === "running" ? "live" : state.status === "starting" || state.status === "creating" || state.status === "stopping" ? "queued" : state.status === "unavailable" ? "warn" : "draft";
  const label = !state ? (error ? "GPU ?" : "GPU …") : state.mode !== "pod" ? t("GPU (serverless)") : !state.configured ? t("GPU not set up") : t(SHORT[state.status] ?? "GPU off");
  return (
    <div className="st-gpu-menu-anchor" ref={box}>
      <button type="button" className="st-pill" data-live={live ? "true" : undefined} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen((o) => !o); void refreshGpuStore(); }} title={error ?? state?.message ?? state?.pod?.gpuName ?? t("GPU pod")}>
        <Lamp state={lamp} label={label} />
        {state?.pod?.gpuName && live && <span className="st-num st-gpu-pill-name">{state.pod.gpuName.replace(/^NVIDIA (GeForce )?/, "")}</span>}
        {live && state && <span className="st-num">{usd(state.sessionUsd)}</span>}
      </button>
      {/* The menu never runs past the screen: the state scrolls, the actions
          (and a spend confirmation) stay pinned at the bottom. */}
      {open && (
        <div className="st-gpu-menu" role="dialog" aria-label={t("GPU pod")}>
          <div className="st-gpu-menu-body">
            <div className="st-row st-row--between">
              <strong>{t("GPU pod")}</strong>
              <span className="st-muted">{t("one for all projects")}</span>
            </div>
            {!state ? (
              <span className={error ? "st-warn" : "st-muted"}>{error ? t("Could not read the GPU state: {error}", { error }) : t("Loading…")}</span>
            ) : (
              <>
                <Lamp state={lampState(state.status)} label={t(`${GPU_LABEL[state.status] ?? state.status}||gpu`)} />
                {state.pod?.gpuName && <span className="st-muted">{state.pod.gpuName}{state.pod.dataCenter ? ` · ${state.pod.dataCenter}` : ""}</span>}
                {live && <span className="st-num">{clock(state.uptimeSeconds)} · {usd(state.sessionUsd)}{state.pod?.costPerHr ? ` · ${usd(state.pod.costPerHr)}/h` : ""}</span>}
                {state.pendingTakes > 0 && <span className="st-muted">{t("{n} take(s) waiting for the GPU", { n: state.pendingTakes })}</span>}
                {state.message && <span className="st-muted">{state.message}</span>}
                {error && <span className="st-warn">{t("Last refresh failed: {error}", { error })}</span>}
              </>
            )}
          </div>
          {state && (
            <div className="st-gpu-menu-foot">
              <ErrorBanner error={start.error ?? stop.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); }} />
              <div className="st-row">
                {!state.configured ? (
                  <span className="st-muted">{t("RunPod is not configured")}</span>
                ) : live ? (
                  <Button size="sm" busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>{t("Stop||gpu")}</Button>
                ) : (
                  <Button size="sm" kind="primary" busy={start.busy} onClick={() => void start.fire()}>{state.status === "unavailable" ? t("Retry||gpu") : t("Start||gpu")}</Button>
                )}
                <Link className="st-btn st-btn--sm st-btn--quiet" href="/machine" onClick={() => setOpen(false)}>{t("Machine page")}</Link>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const GPU_LABEL: Record<string, string> = {
  none: "off",
  creating: "creating",
  starting: "starting",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  unavailable: "暂时没资源",
  terminated: "off",
};

function lampState(status: string): string {
  if (status === "running") return "approved";
  if (status === "starting" || status === "creating" || status === "stopping") return "running";
  if (status === "unavailable") return "failed";
  return "draft";
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

type StatsResponse = { stats: GpuTypeStats[]; estimateBasis: { secondsPerOutputSecond?: number; usdPerHr?: number; gpuTypeId?: string } };

/* The per-GPU ledger: which card bought how many seconds of video for how
   much. The allow-list can be ranked by its last column. */
export function GpuStatsTable() {
  const t = useT();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    get<StatsResponse>("/api/gpu/stats")
      .then((r) => live && setData(r))
      .catch((caught) => live && setError(describe(caught)));
    return () => {
      live = false;
    };
  }, []);
  if (error) return <p className="st-danger">{error}</p>;
  if (!data) return <p className="st-muted">{t("Loading stats…")}</p>;
  const rows = [...data.stats].sort((a, b) => (a.usdPerVideoSecond ?? Infinity) - (b.usdPerVideoSecond ?? Infinity));
  return (
    <div className="st-stack">
      {rows.length === 0 ? (
        <p className="st-muted">{t("No completed takes yet.")}</p>
      ) : (
        <div className="st-table-scroll"><table className="st-table">
          <thead>
            <tr>
              <th>{t("GPU type")}</th>
              <th>{t("Takes")}</th>
              <th>{t("Generation")}</th>
              <th>{t("Video s")}</th>
              <th>{t("GPU-s / video-s")}</th>
              <th>USD/h</th>
              <th>{t("USD / video-s")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.gpuTypeId} data-basis={data.estimateBasis.gpuTypeId === r.gpuTypeId ? "true" : undefined}>
                <td>
                  {r.gpuTypeId}
                  {data.estimateBasis.gpuTypeId === r.gpuTypeId && <span className="st-muted">{t(" · estimate basis")}</span>}
                </td>
                <td className="st-num">{r.takes}</td>
                <td className="st-num">{mmss(r.genSeconds)}</td>
                <td className="st-num">{r.videoSeconds}</td>
                <td className="st-num">{r.secondsPerOutputSecond}</td>
                <td className="st-num">{r.usdPerHr !== undefined ? usd(r.usdPerHr) : "—"}</td>
                <td className="st-num">{r.usdPerVideoSecond !== undefined ? usd(r.usdPerVideoSecond) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <span className="st-muted">{t("Sorted by USD per second of video. Set RUNPOD_GPU_PRIORITY=cost to order the allow-list by this column when a pod is created.")}</span>
    </div>
  );
}

export function GpuRailCard() {
  const t = useT();
  const { state, reload } = useGpu();
  const start = useAction(async (confirm) => {
    await post("/api/gpu/start", { confirm });
    await reload();
  });
  const stop = useAction(async (confirm) => {
    await post("/api/gpu/stop", { confirm });
    await reload();
  });
  if (!state) return null;
  if (state.mode !== "pod") return null;
  const on = state.status === "running" || state.status === "starting" || state.status === "creating";
  return (
    <div className="st-gpu">
      <div className="st-gpu-head">
        <span className="st-gpu-title">GPU</span>
        <Lamp state={lampState(state.status)} label={t(`${GPU_LABEL[state.status] ?? state.status}||gpu`)} />
      </div>
      {state.pod?.gpuName && <div className="st-gpu-line" title={state.pod.gpuTypeId}>{state.pod.gpuName}</div>}
      {on && (
        <div className="st-gpu-line st-num">
          {clock(state.uptimeSeconds)} · {usd(state.sessionUsd)}
          {state.pod?.costPerHr ? ` · ${usd(state.pod.costPerHr)}/h` : ""}
        </div>
      )}
      {state.pendingTakes > 0 && <div className="st-gpu-line">{t("{n} take(s) waiting for the GPU", { n: state.pendingTakes })}</div>}
      {state.status === "unavailable" && <div className="st-gpu-line st-danger">{state.message}</div>}
      <ErrorBanner error={start.error ?? stop.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); }} />
      <div className="st-row">
        {!state.configured ? (
          <span className="st-muted">{t("not configured")}</span>
        ) : on ? (
          <Button size="sm" busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>
            {t("Stop||gpu")}
          </Button>
        ) : (
          <Button size="sm" kind="primary" busy={start.busy} onClick={() => void start.fire()}>
            {state.status === "unavailable" ? t("Retry||gpu") : t("Start||gpu")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function GpuSection() {
  const tr = useT();
  const { state, error, reload } = useGpu();
  const [types, setTypes] = useState<Array<{ id: string; displayName: string; memoryInGb?: number; securePrice?: number; allowed: boolean }> | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const start = useAction(async (confirm) => {
    await post("/api/gpu/start", { confirm });
    await reload();
  });
  const stop = useAction(async (confirm) => {
    await post("/api/gpu/stop", { confirm });
    await reload();
  });
  const terminate = useAction(async () => {
    if (!window.confirm(tr("Terminate the pod? Its container disk is deleted; models on the network volume stay."))) return;
    await post("/api/gpu/terminate");
    await reload();
  });
  const repair = useAction(async () => {
    if (!window.confirm(tr("Apply the studio's boot command and env to this pod and restart it?"))) return;
    await post("/api/gpu/repair");
    await reload();
  });
  const loadTypes = useCallback(async () => {
    try {
      setTypes((await get<{ types: typeof types }>("/api/gpu/types")).types);
      setTypesError(null);
    } catch (caught) {
      setTypesError(describe(caught));
    }
  }, []);
  if (!state) return <p className="st-muted">{error ?? tr("Loading…")}</p>;
  const on = state.status === "running" || state.status === "starting" || state.status === "creating";
  return (
    <div className="st-stack">
      <ErrorBanner error={start.error ?? stop.error ?? terminate.error ?? repair.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); terminate.dismiss(); repair.dismiss(); }} />
      <dl className="st-dl">
        <dt>{tr("Mode")}</dt>
        <dd>{state.mode === "pod" ? tr("RunPod pod (Secure Cloud)") : tr("RunPod serverless (TODO)")}</dd>
        <dt>{tr("Status")}</dt>
        <dd>
          <Lamp state={lampState(state.status)} label={tr(`${GPU_LABEL[state.status] ?? state.status}||gpu`)} />
          {state.message && <span className="st-muted" style={{ marginLeft: 8 }}>{state.message}</span>}
        </dd>
        {state.pod && (
          <>
            <dt>{tr("Pod")}</dt>
            <dd className="st-num">
              {state.pod.name} · {state.pod.id}
              {state.pod.dataCenter ? ` · ${state.pod.dataCenter}` : ""}
              {state.pod.adopted ? tr(" · adopted (created by hand; never replaced)") : ""}
            </dd>
            <dt>GPU</dt>
            <dd>{state.pod.gpuName ?? state.pod.gpuTypeId ?? "—"}</dd>
            <dt>{tr("Cost")}</dt>
            <dd className="st-num">
              {state.pod.costPerHr ? `${usd(state.pod.costPerHr)}/h · ` : ""}{tr("this session {usd} ({time}) · lifetime {total}", { usd: usd(state.sessionUsd), time: clock(state.uptimeSeconds), total: usd(state.lifetimeUsd) })}
            </dd>
          </>
        )}
        <dt>{tr("Allowed GPUs")}</dt>
        <dd>{state.allowedGpuTypes.length ? state.allowedGpuTypes.join(", ") : <span className="st-danger">{tr("RUNPOD_GPU_TYPES is empty")}</span>}</dd>
        <dt>{tr("Idle stop")}</dt>
        <dd className="st-num">{tr("after {n} min without work", { n: state.idleStopMinutes })}</dd>
        <dt>{tr("Queue")}</dt>
        <dd className="st-num">{tr("{n} take(s) waiting for the GPU", { n: state.pendingTakes })}</dd>
      </dl>
      <div className="st-row">
        {on ? (
          <Button busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>{tr("Stop||gpu")}</Button>
        ) : (
          <Button kind="primary" busy={start.busy} disabled={!state.configured} onClick={() => void start.fire()}>
            {state.status === "unavailable" ? tr("Retry on allowed GPUs") : tr("Start||gpu")}
          </Button>
        )}
        {state.pod && state.status !== "terminated" && (
          <Button busy={repair.busy} onClick={() => void repair.fire()} title={tr("Set the studio's start command and env on the pod, then restart it")}>{tr("Apply boot & restart")}</Button>
        )}
        {state.pod && state.status !== "terminated" && (
          <Button kind="danger" busy={terminate.busy} onClick={() => void terminate.fire()}>{tr("Terminate")}</Button>
        )}
        <Button kind="quiet" onClick={() => void loadTypes()}>{tr("GPU types")}</Button>
      </div>
      <AdoptPod onAdopted={reload} />
      <div className="st-stack">
        <span className="st-label">{tr("Generation stats by GPU")}</span>
        <GpuStatsTable />
      </div>
      {typesError && <p className="st-danger">{typesError}</p>}
      {types && (
        <div className="st-table-scroll"><table className="st-table">
          <thead>
            <tr>
              <th>GPU</th>
              <th>{tr("VRAM")}</th>
              <th>{tr("Secure $/h")}</th>
              <th>{tr("Allowed")}</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id} data-allowed={t.allowed ? "true" : undefined}>
                <td>{t.displayName}</td>
                <td className="st-num">{t.memoryInGb ? `${t.memoryInGb} GB` : "—"}</td>
                <td className="st-num">{t.securePrice ? usd(t.securePrice) : "—"}</td>
                <td>{t.allowed ? tr("yes") : ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

type ManualRecipe = { image: string; ports: string[]; containerDiskGb: number; volumeMountPath: string; env: Record<string, string>; dockerStartCmd: string; entrypoint: string[]; gpuTypes: string[]; notes: string[] };

/* The way around a volume the REST API cannot attach: create the pod in the
   RunPod console with these values, then hand its id to the studio. */
function AdoptPod({ onAdopted }: { onAdopted: () => Promise<void> }) {
  const t = useT();
  const [podId, setPodId] = useState("");
  const [recipe, setRecipe] = useState<ManualRecipe | null>(null);
  const [recipeError, setRecipeError] = useState<string | null>(null);
  const adopt = useAction(async () => {
    await post("/api/gpu/adopt", { podId: podId.trim() });
    setPodId("");
    await onAdopted();
  });
  const loadRecipe = useCallback(async () => {
    try {
      setRecipe(await get<ManualRecipe>("/api/gpu/manual"));
      setRecipeError(null);
    } catch (caught) {
      setRecipeError(describe(caught));
    }
  }, []);
  const envLines = recipe ? Object.entries(recipe.env).map(([k, v]) => `${k}=${v}`).join("\n") : "";
  return (
    <div className="st-stack">
      <span className="st-label">{t("Adopt a pod created by hand")}</span>
      <p className="st-muted">
        {t("If the studio cannot create the pod itself (for example the model volume is not attachable through the API), create it in the RunPod console and paste its id here. The studio then starts, stops and runs jobs on it, but never terminates or replaces it.")}
      </p>
      <ErrorBanner error={adopt.error} onDismiss={adopt.dismiss} />
      <div className="st-row">
        <input
          className="st-input"
          placeholder={t("RunPod pod id")}
          value={podId}
          onChange={(e) => setPodId(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <Button kind="primary" busy={adopt.busy} disabled={podId.trim().length < 6} onClick={() => void adopt.fire()}>{t("Adopt")}</Button>
        <Button kind="quiet" onClick={() => (recipe ? setRecipe(null) : void loadRecipe())}>{recipe ? t("Hide recipe") : t("Show what to paste into RunPod")}</Button>
      </div>
      {recipeError && <p className="st-danger">{recipeError}</p>}
      {recipe && (
        <div className="st-stack st-stack--tight">
          <p className="st-muted">{t("The env block contains the worker token and R2 keys. Paste it only into the pod's environment variables.")}</p>
          <CopyRow label={t("Container image")} value={recipe.image} />
          <CopyRow label={t("Expose HTTP ports")} value={recipe.ports.join(", ")} />
          <CopyRow label={t("Container disk (GB)")} value={String(recipe.containerDiskGb)} />
          <CopyRow label={t("Volume mount path")} value={recipe.volumeMountPath} />
          <CopyRow label={t("Entrypoint (JSON, overrides the image's /start.sh)")} value={JSON.stringify(recipe.entrypoint)} />
          <CopyRow label={t("Start command (only for images without an ENTRYPOINT)")} value={recipe.dockerStartCmd} />
          <CopyRow label={t("GPU types (in priority order)")} value={recipe.gpuTypes.join(", ")} />
          <div className="st-field">
            <span className="st-label">{t("Environment variables")}</span>
            <textarea className="st-input" readOnly rows={Object.keys(recipe.env).length + 1} value={envLines} onFocus={(e) => e.currentTarget.select()} />
          </div>
          <ul className="st-muted">
            {recipe.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
