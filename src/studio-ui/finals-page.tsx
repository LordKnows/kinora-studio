"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { ShotView } from "@/studio/orchestrator";
import type { Take } from "@/studio/types";

import { get, post, usd } from "./api";
import { Button, Empty, ErrorBanner, Lamp, Section, Stars, useAction } from "./common";
import { useProjectContext } from "./shell";

/* Finals: one row per shot — the pick, its 2K pass, the score — and the
   blind A/B used to decide between takes. */

export function FinalsPage() {
  const { projectId, view, reload } = useProjectContext();
  const [resolution, setResolution] = useState<"1080p" | "2k" | "4k">("2k");
  const [closeToDraft, setCloseToDraft] = useState(true);
  const shots = (view?.scenes ?? []).flatMap((s) => s.shots.map((sh) => ({ scene: s.slug, shot: sh })));
  const picks = shots.map(({ shot }) => shot.selectedTake ?? shot.takes.find((t) => t.status === "completed")).filter((t): t is Take => Boolean(t));
  const missing2k = picks.filter((t) => t.upscale?.status !== "completed");
  const batch = useAction(async (confirm) => {
    for (const take of missing2k) {
      if (take.upscale && (take.upscale.status === "queued" || take.upscale.status === "running")) continue;
      await post(`/api/takes/${take.id}/regenerate`, { resolution, startSigma: closeToDraft ? 0.8 : 0, confirm });
    }
    await reload();
  });
  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Finals</h1>
          <p className="st-subtitle">The pick of every shot, regenerated at full resolution before the cut. Open-H3-Regenerate runs three refine steps on the pod; “close to the draft” keeps faces and layout.</p>
        </div>
        <div className="st-actions">
          <select className="st-input st-input--sm" value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)} style={{ width: 96 }}>
            <option value="1080p">1080p</option>
            <option value="2k">2K</option>
            <option value="4k">4K</option>
          </select>
          <label className="st-toggle">
            <input type="checkbox" checked={closeToDraft} onChange={(e) => setCloseToDraft(e.target.checked)} />
            close to the draft
          </label>
          <Button kind="primary" busy={batch.busy} disabled={missing2k.length === 0} onClick={() => void batch.fire()}>
            Regenerate {missing2k.length} pick{missing2k.length === 1 ? "" : "s"} at {resolution.toUpperCase()}
          </Button>
        </div>
      </div>
      <ErrorBanner error={batch.error} projectId={projectId} onConfirm={() => void batch.confirm()} onDismiss={batch.dismiss} />
      {shots.length === 0 ? (
        <Empty title="No shots yet" hint="Finals fill in once the Board has shots with finished takes." />
      ) : (
        <div className="st-card st-card--pad0">
          <table className="st-table">
            <thead>
              <tr>
                <th>Shot</th>
                <th>Pick</th>
                <th>Full resolution</th>
                <th className="st-num">Cost</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {shots.map(({ scene, shot }) => (
                <FinalsRow key={shot.id} projectId={projectId} scene={scene} shot={shot} onChange={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Section title="Blind comparison" aside={<small>two takes of one shot, random order</small>}>
        <EvalPanel projectId={projectId} />
      </Section>
    </div>
  );
}

function FinalsRow({ projectId, scene, shot, onChange }: { projectId: string; scene: string; shot: ShotView; onChange: () => Promise<void> }) {
  const pick = shot.selectedTake ?? shot.takes.find((t) => t.status === "completed");
  const up = pick?.upscale;
  const regen = useAction(async (confirm) => {
    if (!pick) return;
    await post(`/api/takes/${pick.id}/regenerate`, { resolution: "2k", startSigma: 0.8, confirm });
    await onChange();
  });
  const review = useAction(async (_c, score: number) => {
    if (!pick) return;
    await post(`/api/takes/${pick.id}/review`, { score, notes: pick.review?.notes ?? "" });
    await onChange();
  });
  return (
    <tr>
      <td>
        <div className="st-stack st-stack--tight" style={{ gap: 2 }}>
          <Link className="st-link" href={`/p/${projectId}/board`} style={{ textDecoration: "none" }}>
            <span className="st-num" style={{ color: "var(--tx3)", marginRight: 8 }}>{scene} #{shot.index + 1}</span>
            {shot.spec.intent}
          </Link>
          <span className="st-muted st-num">{shot.spec.durationS} s · {shot.spec.mode}{shot.spec.link?.type ? ` · ${shot.spec.link.type}` : ""}</span>
        </div>
      </td>
      <td>
        {pick ? (
          <div className="st-row" style={{ flexWrap: "nowrap" }}>
            {pick.thumbUrls[0] ? <img src={pick.thumbUrls[0]} alt="" style={{ width: 72, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 6 }} /> : null}
            <span className="st-stack st-stack--tight" style={{ gap: 0 }}>
              <span>Take {pick.n}{shot.selectedTakeId === pick.id ? "" : " (latest)"}</span>
              <span className="st-muted st-num">{pick.workflow} · seed {pick.seed ?? "—"}</span>
            </span>
          </div>
        ) : (
          <Lamp state="draft" label={shot.takes.length ? "no finished take" : "no take"} />
        )}
      </td>
      <td>
        {!pick ? (
          <span className="st-muted">—</span>
        ) : up?.status === "completed" && up.url ? (
          <a className="st-link st-link--ext" href={up.url} target="_blank" rel="noreferrer noopener">{up.resolution.toUpperCase()} ready</a>
        ) : up?.status === "queued" || up?.status === "running" ? (
          <Lamp state="running" label={`${up.resolution.toUpperCase()} ${up.progress?.stage ?? up.status}${up.progress?.stage === "sampling" && up.progress.total ? ` ${up.progress.step ?? 0}/${up.progress.total}` : ""}`} />
        ) : (
          <span className="st-row" style={{ flexWrap: "nowrap" }}>
            <Button size="sm" busy={regen.busy} onClick={() => void regen.fire()}>Regenerate 2K</Button>
            {up?.status === "failed" && <span className="st-danger" title={up.error}>failed</span>}
            <ErrorBanner error={regen.error} projectId={projectId} onConfirm={() => void regen.confirm()} onDismiss={regen.dismiss} />
          </span>
        )}
      </td>
      <td className="st-num">{pick ? usd((pick.costUsd ?? 0) + (up?.costUsd ?? 0)) : "—"}</td>
      <td>{pick ? <Stars value={pick.review?.score} onChange={(n) => void review.fire(n)} /> : null}</td>
    </tr>
  );
}

type Pair = { shotId: string; intent: string; a: { id: string; url: string }; b: { id: string; url: string } } | null;

function EvalPanel({ projectId }: { projectId: string }) {
  const [pair, setPair] = useState<Pair | undefined>(undefined);
  const [winner, setWinner] = useState<"a" | "b" | "tie" | null>(null);
  const [scores, setScores] = useState({ consistency: 0, action: 0, camera: 0, audio: 0 });
  const [count, setCount] = useState(0);
  const next = useCallback(async () => {
    const { pair } = await get<{ pair: Pair }>(`/api/projects/${projectId}/eval/pairs`);
    setPair(pair);
    setWinner(null);
    setScores({ consistency: 0, action: 0, camera: 0, audio: 0 });
  }, [projectId]);
  useEffect(() => {
    void next().catch(() => setPair(null));
  }, [next]);
  const vote = useAction(async () => {
    if (!pair || !winner) return;
    await post("/api/eval/votes", { takeA: pair.a.id, takeB: pair.b.id, winner, scores });
    setCount((c) => c + 1);
    await next();
  });
  if (pair === undefined) return <span className="st-muted">Loading…</span>;
  if (pair === null) return <Empty title="Nothing to compare" hint="The blind comparison needs at least two finished takes of the same shot." />;
  const complete = winner && Object.values(scores).every((v) => v > 0);
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={vote.error} onDismiss={vote.dismiss} />
      <p className="st-muted">Shot intent: <strong style={{ color: "var(--tx)" }}>{pair.intent}</strong> · {count} votes this session</p>
      <div className="st-eval">
        {(["a", "b"] as const).map((side) => (
          <div key={side} className="st-stack st-stack--tight">
            <video className="st-video" src={pair[side].url} controls preload="metadata" />
            <Button kind={winner === side ? "primary" : "default"} onClick={() => setWinner(side)}>{side.toUpperCase()} is better</Button>
          </div>
        ))}
      </div>
      <div className="st-row">
        <Button kind={winner === "tie" ? "primary" : "quiet"} size="sm" onClick={() => setWinner("tie")}>Tie</Button>
      </div>
      <dl className="st-kv">
        {(["consistency", "action", "camera", "audio"] as const).map((k) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ alignSelf: "center" }}>{k}</dt>
            <dd><Stars value={scores[k] || undefined} onChange={(n) => setScores({ ...scores, [k]: n })} /></dd>
          </div>
        ))}
      </dl>
      <div className="st-row st-row--between">
        <Button kind="quiet" size="sm" onClick={() => void next()}>Skip pair</Button>
        <Button kind="primary" busy={vote.busy} disabled={!complete} onClick={() => void vote.fire()}>Submit vote</Button>
      </div>
    </div>
  );
}
