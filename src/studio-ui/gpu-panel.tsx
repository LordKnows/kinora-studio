"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useState } from "react";

import type { GpuState } from "@/studio/gpu";
import type { GpuTypeStats } from "@/studio/types";

import { describe, get, post, usd } from "./api";
import { Button, CopyRow, ErrorBanner, Lamp, useAction, usePopover } from "./common";

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

const SHORT: Record<string, string> = { none: "GPU off", off: "GPU off", starting: "GPU starting", creating: "GPU creating", running: "GPU on", stopping: "GPU stopping", stopped: "GPU off", unavailable: "no GPU", terminated: "GPU off" };

/** The GPU in the top bar of every page: always shown, opens a menu with its state and Start / Stop. */
export function GpuMenu() {
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
  const label = !state ? (error ? "GPU ?" : "GPU …") : state.mode !== "pod" ? "GPU (serverless)" : !state.configured ? "GPU not set up" : SHORT[state.status] ?? "GPU off";
  return (
    <div className="st-gpu-menu-anchor" ref={box}>
      <button type="button" className="st-pill" data-live={live ? "true" : undefined} aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen((o) => !o); void refreshGpuStore(); }} title={error ?? state?.message ?? state?.pod?.gpuName ?? "GPU pod"}>
        <Lamp state={lamp} label={label} />
        {state?.pod?.gpuName && live && <span className="st-num st-gpu-pill-name">{state.pod.gpuName.replace(/^NVIDIA (GeForce )?/, "")}</span>}
        {live && state && <span className="st-num">{usd(state.sessionUsd)}</span>}
      </button>
      {/* The menu never runs past the screen: the state scrolls, the actions
          (and a spend confirmation) stay pinned at the bottom. */}
      {open && (
        <div className="st-gpu-menu" role="dialog" aria-label="GPU pod">
          <div className="st-gpu-menu-body">
            <div className="st-row st-row--between">
              <strong>GPU pod</strong>
              <span className="st-muted">one for all projects</span>
            </div>
            {!state ? (
              <span className={error ? "st-warn" : "st-muted"}>{error ? `Could not read the GPU state: ${error}` : "Loading…"}</span>
            ) : (
              <>
                <Lamp state={lampState(state.status)} label={GPU_LABEL[state.status] ?? state.status} />
                {state.pod?.gpuName && <span className="st-muted">{state.pod.gpuName}{state.pod.dataCenter ? ` · ${state.pod.dataCenter}` : ""}</span>}
                {live && <span className="st-num">{clock(state.uptimeSeconds)} · {usd(state.sessionUsd)}{state.pod?.costPerHr ? ` · ${usd(state.pod.costPerHr)}/h` : ""}</span>}
                {state.pendingTakes > 0 && <span className="st-muted">{state.pendingTakes} take(s) waiting for the GPU</span>}
                {state.message && <span className="st-muted">{state.message}</span>}
                {error && <span className="st-warn">Last refresh failed: {error}</span>}
              </>
            )}
          </div>
          {state && (
            <div className="st-gpu-menu-foot">
              <ErrorBanner error={start.error ?? stop.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); }} />
              <div className="st-row">
                {!state.configured ? (
                  <span className="st-muted">RunPod is not configured</span>
                ) : live ? (
                  <Button size="sm" busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>Stop</Button>
                ) : (
                  <Button size="sm" kind="primary" busy={start.busy} onClick={() => void start.fire()}>{state.status === "unavailable" ? "Retry" : "Start"}</Button>
                )}
                <Link className="st-btn st-btn--sm st-btn--quiet" href="/machine" onClick={() => setOpen(false)}>Machine page</Link>
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
  if (!data) return <p className="st-muted">Loading stats…</p>;
  const rows = [...data.stats].sort((a, b) => (a.usdPerVideoSecond ?? Infinity) - (b.usdPerVideoSecond ?? Infinity));
  return (
    <div className="st-stack">
      {rows.length === 0 ? (
        <p className="st-muted">No completed takes yet.</p>
      ) : (
        <table className="st-table">
          <thead>
            <tr>
              <th>GPU type</th>
              <th>Takes</th>
              <th>Generation</th>
              <th>Video s</th>
              <th>GPU-s / video-s</th>
              <th>USD/h</th>
              <th>USD / video-s</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.gpuTypeId} data-basis={data.estimateBasis.gpuTypeId === r.gpuTypeId ? "true" : undefined}>
                <td>
                  {r.gpuTypeId}
                  {data.estimateBasis.gpuTypeId === r.gpuTypeId && <span className="st-muted"> · estimate basis</span>}
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
        </table>
      )}
      <span className="st-muted">Sorted by USD per second of video. Set RUNPOD_GPU_PRIORITY=cost to order the allow-list by this column when a pod is created.</span>
    </div>
  );
}

export function GpuRailCard() {
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
        <Lamp state={lampState(state.status)} label={GPU_LABEL[state.status] ?? state.status} />
      </div>
      {state.pod?.gpuName && <div className="st-gpu-line" title={state.pod.gpuTypeId}>{state.pod.gpuName}</div>}
      {on && (
        <div className="st-gpu-line st-num">
          {clock(state.uptimeSeconds)} · {usd(state.sessionUsd)}
          {state.pod?.costPerHr ? ` · ${usd(state.pod.costPerHr)}/h` : ""}
        </div>
      )}
      {state.pendingTakes > 0 && <div className="st-gpu-line">{state.pendingTakes} take(s) waiting for the GPU</div>}
      {state.status === "unavailable" && <div className="st-gpu-line st-danger">{state.message}</div>}
      <ErrorBanner error={start.error ?? stop.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); }} />
      <div className="st-row">
        {!state.configured ? (
          <span className="st-muted">not configured</span>
        ) : on ? (
          <Button size="sm" busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" kind="primary" busy={start.busy} onClick={() => void start.fire()}>
            {state.status === "unavailable" ? "Retry" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function GpuSection() {
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
    if (!window.confirm("Terminate the pod? Its container disk is deleted; models on the network volume stay.")) return;
    await post("/api/gpu/terminate");
    await reload();
  });
  const repair = useAction(async () => {
    if (!window.confirm("Apply the studio's boot command and env to this pod and restart it?")) return;
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
  if (!state) return <p className="st-muted">{error ?? "Loading…"}</p>;
  const on = state.status === "running" || state.status === "starting" || state.status === "creating";
  return (
    <div className="st-stack">
      <ErrorBanner error={start.error ?? stop.error ?? terminate.error ?? repair.error} onConfirm={start.error ? () => void start.confirm() : stop.error ? () => void stop.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); terminate.dismiss(); repair.dismiss(); }} />
      <dl className="st-dl">
        <dt>Mode</dt>
        <dd>{state.mode === "pod" ? "RunPod pod (Secure Cloud)" : "RunPod serverless (TODO)"}</dd>
        <dt>Status</dt>
        <dd>
          <Lamp state={lampState(state.status)} label={GPU_LABEL[state.status] ?? state.status} />
          {state.message && <span className="st-muted" style={{ marginLeft: 8 }}>{state.message}</span>}
        </dd>
        {state.pod && (
          <>
            <dt>Pod</dt>
            <dd className="st-num">
              {state.pod.name} · {state.pod.id}
              {state.pod.dataCenter ? ` · ${state.pod.dataCenter}` : ""}
              {state.pod.adopted ? " · adopted (created by hand; never replaced)" : ""}
            </dd>
            <dt>GPU</dt>
            <dd>{state.pod.gpuName ?? state.pod.gpuTypeId ?? "—"}</dd>
            <dt>Cost</dt>
            <dd className="st-num">
              {state.pod.costPerHr ? `${usd(state.pod.costPerHr)}/h · ` : ""}this session {usd(state.sessionUsd)} ({clock(state.uptimeSeconds)}) · lifetime {usd(state.lifetimeUsd)}
            </dd>
          </>
        )}
        <dt>Allowed GPUs</dt>
        <dd>{state.allowedGpuTypes.length ? state.allowedGpuTypes.join(", ") : <span className="st-danger">RUNPOD_GPU_TYPES is empty</span>}</dd>
        <dt>Idle stop</dt>
        <dd className="st-num">after {state.idleStopMinutes} min without work</dd>
        <dt>Queue</dt>
        <dd className="st-num">{state.pendingTakes} take(s) waiting for the GPU</dd>
      </dl>
      <div className="st-row">
        {on ? (
          <Button busy={stop.busy || state.status === "stopping"} onClick={() => void stop.fire()}>Stop</Button>
        ) : (
          <Button kind="primary" busy={start.busy} disabled={!state.configured} onClick={() => void start.fire()}>
            {state.status === "unavailable" ? "Retry on allowed GPUs" : "Start"}
          </Button>
        )}
        {state.pod && state.status !== "terminated" && (
          <Button busy={repair.busy} onClick={() => void repair.fire()} title="Set the studio's start command and env on the pod, then restart it">Apply boot &amp; restart</Button>
        )}
        {state.pod && state.status !== "terminated" && (
          <Button kind="danger" busy={terminate.busy} onClick={() => void terminate.fire()}>Terminate</Button>
        )}
        <Button kind="quiet" onClick={() => void loadTypes()}>GPU types</Button>
      </div>
      <AdoptPod onAdopted={reload} />
      <div className="st-stack">
        <span className="st-label">Generation stats by GPU</span>
        <GpuStatsTable />
      </div>
      {typesError && <p className="st-danger">{typesError}</p>}
      {types && (
        <table className="st-table">
          <thead>
            <tr>
              <th>GPU</th>
              <th>VRAM</th>
              <th>Secure $/h</th>
              <th>Allowed</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id} data-allowed={t.allowed ? "true" : undefined}>
                <td>{t.displayName}</td>
                <td className="st-num">{t.memoryInGb ? `${t.memoryInGb} GB` : "—"}</td>
                <td className="st-num">{t.securePrice ? usd(t.securePrice) : "—"}</td>
                <td>{t.allowed ? "yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type ManualRecipe = { image: string; ports: string[]; containerDiskGb: number; volumeMountPath: string; env: Record<string, string>; dockerStartCmd: string; entrypoint: string[]; gpuTypes: string[]; notes: string[] };

/* The way around a volume the REST API cannot attach: create the pod in the
   RunPod console with these values, then hand its id to the studio. */
function AdoptPod({ onAdopted }: { onAdopted: () => Promise<void> }) {
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
      <span className="st-label">Adopt a pod created by hand</span>
      <p className="st-muted">
        If the studio cannot create the pod itself (for example the model volume is not attachable through the API), create it in the RunPod console
        and paste its id here. The studio then starts, stops and runs jobs on it, but never terminates or replaces it.
      </p>
      <ErrorBanner error={adopt.error} onDismiss={adopt.dismiss} />
      <div className="st-row">
        <input
          className="st-input"
          placeholder="RunPod pod id"
          value={podId}
          onChange={(e) => setPodId(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <Button kind="primary" busy={adopt.busy} disabled={podId.trim().length < 6} onClick={() => void adopt.fire()}>Adopt</Button>
        <Button kind="quiet" onClick={() => (recipe ? setRecipe(null) : void loadRecipe())}>{recipe ? "Hide recipe" : "Show what to paste into RunPod"}</Button>
      </div>
      {recipeError && <p className="st-danger">{recipeError}</p>}
      {recipe && (
        <div className="st-stack st-stack--tight">
          <p className="st-muted">The env block contains the worker token and R2 keys. Paste it only into the pod&apos;s environment variables.</p>
          <CopyRow label="Container image" value={recipe.image} />
          <CopyRow label="Expose HTTP ports" value={recipe.ports.join(", ")} />
          <CopyRow label="Container disk (GB)" value={String(recipe.containerDiskGb)} />
          <CopyRow label="Volume mount path" value={recipe.volumeMountPath} />
          <CopyRow label="Entrypoint (JSON, overrides the image's /start.sh)" value={JSON.stringify(recipe.entrypoint)} />
          <CopyRow label="Start command (only for images without an ENTRYPOINT)" value={recipe.dockerStartCmd} />
          <CopyRow label="GPU types (in priority order)" value={recipe.gpuTypes.join(", ")} />
          <div className="st-field">
            <span className="st-label">Environment variables</span>
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
