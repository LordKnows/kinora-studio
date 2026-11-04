"use client";

import { useCallback, useEffect, useState } from "react";

import type { GpuState } from "@/studio/gpu";
import type { GpuTypeStats } from "@/studio/types";

import { describe, get, post, usd } from "./api";
import { Button, ErrorBanner, Lamp, useAction } from "./common";

/* The GPU pod, as a compact card in the project rail and as a full section on
   the settings page. One fetch on mount, then a poll whose pace follows the
   pod: fast while it is starting, slow while it is running or off. */

export function useGpu() {
  const [state, setState] = useState<GpuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await get<GpuState>("/api/gpu"));
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const busy = state?.status === "starting" || state?.status === "creating" || state?.status === "stopping" || (state?.pendingTakes ?? 0) > 0;
    const t = window.setInterval(() => void reload(), busy ? 5000 : 30000);
    return () => window.clearInterval(t);
  }, [state?.status, state?.pendingTakes, reload]);
  return { state, error, reload };
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
  const stop = useAction(async () => {
    await post("/api/gpu/stop");
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
      <ErrorBanner error={start.error ?? stop.error} onConfirm={start.error ? () => void start.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); }} />
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
  const stop = useAction(async () => {
    await post("/api/gpu/stop");
    await reload();
  });
  const terminate = useAction(async () => {
    if (!window.confirm("Terminate the pod? Its container disk is deleted; models on the network volume stay.")) return;
    await post("/api/gpu/terminate");
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
      <ErrorBanner error={start.error ?? stop.error ?? terminate.error} onConfirm={start.error ? () => void start.confirm() : undefined} onDismiss={() => { start.dismiss(); stop.dismiss(); terminate.dismiss(); }} />
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
          <Button kind="danger" busy={terminate.busy} onClick={() => void terminate.fire()}>Terminate</Button>
        )}
        <Button kind="quiet" onClick={() => void loadTypes()}>GPU types</Button>
      </div>
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
