"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectView } from "@/studio/orchestrator";
import type { Job, Take } from "@/studio/types";

import { del, get, post } from "./api";
import { Button, ErrorBanner, Lamp, statusLabel, useAction, whenT } from "./common";
import { filmShots } from "./film";
import { useT } from "./i18n";
import { useGpu } from "./gpu-panel";
import { useProjectContext } from "./shell";

/* The queue: everything of this project that is waiting or under way and
   costs money or a painter's time — takes on the GPU, regenerations, and
   pictures — each with a way to call it off. It opens beside any page
   (?panel=queue), from the Queue button of the project bar, whose number is
   how many are in it. */

const ACTIVE = (s: string) => s === "queued" || s === "running";

/** The project's image jobs that are queued or being drawn. Asked for when the project loads, every
    few seconds while any is under way or the panel is open, and now and then otherwise. */
export function useImageQueue(projectId: string, watching: boolean, onJobs: (jobs: Job[]) => void): () => Promise<void> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    let active: Job[] = [];
    try {
      active = (await get<{ jobs: Job[] }>(`/api/projects/${projectId}/images`)).jobs.filter((j) => ACTIVE(j.status));
      onJobs(active);
    } catch {
      /* keep what was last known */
    }
    return active.length;
  }, [projectId, onJobs]);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const n = await load();
      if (!stopped) timer.current = setTimeout(() => void tick(), n > 0 || watching ? 5_000 : 30_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, watching]);
  return async () => { await load(); };
}

/** What a picture job is drawing, in a few words. */
function jobLabel(job: Job, t: ReturnType<typeof useT>): string {
  const i = job.input as { label?: string; purpose?: string; op?: string };
  return i.label || (i.purpose ? t(i.purpose.replaceAll("_", " ")) : i.op ? t(i.op) : t("picture"));
}

export function QueuePanel({ view, jobs, refreshJobs }: { view: ProjectView | null; jobs: Job[]; refreshJobs: () => Promise<void> }) {
  const t = useT();
  const { projectId, reload } = useProjectContext();
  const shots = view ? filmShots(view) : [];
  /* The line is in the order things were asked for: what is rendering first, then the rest by when each was
     added, so what is added later stands last (the film's shot order is not the queue's). */
  const takes = shots.flatMap((s) => s.shot.takes.filter((x) => ACTIVE(x.status)).map((take) => ({ s, take })))
    .sort((a, b) => Number(b.take.status === "running") - Number(a.take.status === "running") || a.take.createdAt - b.take.createdAt);
  const regens = shots.flatMap((s) => s.shot.takes.filter((x) => x.upscale && ACTIVE(x.upscale.status)).map((take) => ({ s, take })))
    .sort((a, b) => Number(b.take.upscale!.status === "running") - Number(a.take.upscale!.status === "running") || a.take.upscale!.createdAt - b.take.upscale!.createdAt);
  const lined = [...jobs].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.createdAt - b.createdAt);
  /* only what is still waiting can be called off; what is rendering runs to its end */
  const waiting = takes.filter((x) => x.take.status === "queued");

  const cancelTakes = useAction(async (_c, list: Take[]) => {
    for (const take of list) await post(`/api/takes/${take.id}/cancel`);
    await reload();
  });
  const cancelRegen = useAction(async (_c, take: Take) => {
    await del(`/api/takes/${take.id}/regenerate`);
    await reload();
  });
  const cancelJobs = useAction(async (_c, list: Job[]) => {
    for (const job of list) await post(`/api/jobs/${job.id}/cancel`);
    await refreshJobs();
  });
  const empty = takes.length === 0 && regens.length === 0 && jobs.length === 0;
  /* Ask for where everything stands, now: the GPU first (its state decides whether a waiting take can go), then each
     shot with a take in flight (the server asks the pod, and hands a waiting take over), then the page's own view and
     the pictures. The page also follows by itself, a few seconds behind; this is for when it has not caught up. */
  const refreshAll = useAction(async () => {
    await gpuReload();
    const inFlight = new Set(shots.filter((s) => s.shot.takes.some((x) => ACTIVE(x.status) || (x.upscale && ACTIVE(x.upscale.status)))).map((s) => s.shot.id));
    await Promise.all([...inFlight].map((id) => get(`/api/shots/${id}/takes`).catch(() => undefined)));
    await Promise.all([reload(), refreshJobs()]);
  });
  const refreshButton = <Button size="sm" kind="secondary" busy={refreshAll.busy} onClick={() => void refreshAll.fire()} title={t("Ask where everything stands, now")}>{t("Refresh")}</Button>;
  /* the GPU is one for all projects: the check stops it once nothing of anyone's is left, one time */
  const gpu = useGpu();
  const gpuReload = gpu.reload;
  /* the GPU store is the browser's: drawn after mount, so the page the server sent and the first draw agree */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const gpuUp = mounted && gpu.state?.mode === "pod" && gpu.state.configured && ["running", "starting", "creating"].includes(gpu.state.status);
  const stopWhenDone = useAction(async (_c, enabled: boolean) => {
    await post("/api/gpu/stop-when-done", { enabled });
    await gpu.reload();
  });

  return (
    <div className="side-body">
      <ErrorBanner error={refreshAll.error ?? cancelTakes.error ?? cancelRegen.error ?? cancelJobs.error ?? stopWhenDone.error} projectId={projectId} onDismiss={() => { cancelTakes.dismiss(); cancelRegen.dismiss(); cancelJobs.dismiss(); stopWhenDone.dismiss(); refreshAll.dismiss(); }} />
      {gpuUp && (
        <label className="q-autostop" title={t("Stops the GPU one time, once every take, export and picture of every project has finished. Turn it on again for the next run.")}>
          <input type="checkbox" checked={!!gpu.state?.stopWhenDone} disabled={stopWhenDone.busy} onChange={(e) => void stopWhenDone.fire(e.target.checked)} />
          <span>{t("Stop the GPU when everything has rendered")}</span>
        </label>
      )}
      {empty && <p className="st-muted">{t("Nothing is queued or under way.")}</p>}

      {(takes.length > 0 || regens.length > 0) && (
        <section className="q-sec" aria-label={t("Takes")}>
          <div className="q-head">
            <h3>{t("Takes")}</h3>
            <span className="st-num">{takes.length + regens.length}</span>
            <span className="q-acts">
              {refreshButton}
              {waiting.length > 1 && <Button size="sm" busy={cancelTakes.busy} onClick={() => void cancelTakes.fire(waiting.map((x) => x.take))}>{t("Cancel all {n}", { n: waiting.length })}</Button>}
            </span>
          </div>
          {takes.map(({ s, take }) => (
            <div key={take.id} className="q-row">
              <div className="q-what">
                <Link className="st-link" href={`/p/${projectId}/board?shot=${s.shot.id}&tab=takes`}><span className="st-num">{s.slate}</span> · {t("Take {n}", { n: take.n })}</Link>
                <span className="st-muted">{s.shot.spec.intent}</span>
                <span className="st-row q-state">
                  <Lamp state={take.status} label={t(statusLabel(take.status, take))} />
                  <span className="st-muted st-num">{take.progress?.stage === "sampling" && take.progress.total ? t("step {a}/{b}", { a: take.progress.step ?? 0, b: take.progress.total }) : whenT(t, take.createdAt)}</span>
                </span>
              </div>
              {take.status === "queued" && <Button size="sm" busy={cancelTakes.busy} onClick={() => void cancelTakes.fire([take])}>{t("Cancel")}</Button>}
            </div>
          ))}
          {regens.map(({ s, take }) => (
            <div key={`up-${take.id}`} className="q-row">
              <div className="q-what">
                <Link className="st-link" href={`/p/${projectId}/board?shot=${s.shot.id}&tab=takes`}><span className="st-num">{s.slate}</span> · {t("Take {n}", { n: take.n })}</Link>
                <span className="st-row q-state">
                  <Lamp state={take.upscale!.status} label={t("Regenerate {res}: {status}", { res: take.upscale!.resolution.toUpperCase(), status: t(take.upscale!.status) })} />
                </span>
              </div>
              {take.upscale!.status === "queued" && <Button size="sm" busy={cancelRegen.busy} onClick={() => void cancelRegen.fire(take)}>{t("Cancel")}</Button>}
            </div>
          ))}
        </section>
      )}

      {jobs.length > 0 && (
        <section className="q-sec" aria-label={t("Pictures")}>
          <div className="q-head">
            <h3>{t("Pictures")}</h3>
            <span className="st-num">{jobs.length}</span>
            {jobs.length > 1 && <Button size="sm" busy={cancelJobs.busy} onClick={() => void cancelJobs.fire(jobs)}>{t("Cancel all {n}", { n: jobs.length })}</Button>}
          </div>
          {lined.map((job) => (
            <div key={job.id} className="q-row">
              <div className="q-what">
                <strong>{jobLabel(job, t)}</strong>
                <span className="st-row q-state">
                  <Lamp state={job.status} label={job.status === "running" || job.claimedAt ? t("drawing||picture job") : t("waiting for a painter")} />
                  <span className="st-muted st-num">{typeof job.input.model === "string" ? `${job.input.model} · ` : ""}{whenT(t, job.createdAt)}</span>
                </span>
              </div>
              <Button size="sm" busy={cancelJobs.busy} onClick={() => void cancelJobs.fire([job])}>{t("Cancel")}</Button>
            </div>
          ))}
          <p className="st-muted">{t("A painter that is already drawing a cancelled picture finishes it, but the picture is not kept or counted.")}</p>
        </section>
      )}
    </div>
  );
}
