"use client";

import { useEffect, useState } from "react";

import { describeParams, type ModelEntry } from "@/studio/models";
import type { Lora } from "@/studio/types";

import { get } from "./api";
import { ErrorBanner, Lamp, Skeleton } from "./common";
import { OpenOutIcon } from "./icons";

/* Library → Models: what the Studio runs, sorted out. Each model with its
   runtime (a hosted service drawn by a painter, or a ComfyUI workflow on the
   GPU pod), the settings its authors recommend — the ones a render uses when
   nothing overrides them — its licence and moderation, its files, and the
   LoRAs trained for it with theirs. */

type Listed = ModelEntry & { painters?: { ready: boolean; note?: string; drawers: string[] } };
type Answer = { models: Listed[]; gpu: { status: string; configured: boolean } | null; loras: Lora[] };

export function ModelsGallery() {
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    get<Answer>("/api/models").then(setData).catch(setError);
  }, []);
  if (error) return <ErrorBanner error={error} onDismiss={() => setError(null)} />;
  if (!data) return <div className="st-models"><Skeleton height={220} /><Skeleton height={220} /></div>;
  return (
    <div className="st-stack" style={{ gap: 28 }}>
      {(["image", "video"] as const).map((kind) => (
        <section key={kind}>
          <div className="st-section-title" style={{ marginBottom: 12 }}>
            <span>{kind === "image" ? "Image models · 图像" : "Video models · 视频"}</span>
            {kind === "image" && data.gpu && <small>GPU pod: {data.gpu.configured ? data.gpu.status : "not set up"}</small>}
          </div>
          <div className="st-models">
            {data.models.filter((m) => m.kind === kind).map((m) => <ModelCard key={m.id} m={m} loras={data.loras.filter((l) => (l.baseModel ?? "minimax-h3") === m.family)} first={data.models.find((x) => x.family === m.family)?.id === m.id} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function ModelCard({ m, loras, first }: { m: Listed; loras: Lora[]; first: boolean }) {
  const gb = (m.files ?? []).reduce((n, f) => n + f.gb, 0);
  return (
    <article className="st-card st-model">
      <div className="st-row st-row--between">
        <div>
          <div className="st-h2">{m.label}</div>
          <div className="st-muted">{m.zh}</div>
        </div>
        <span className="st-chips">
          <span className="st-chip st-chip--mono">{m.runtime === "pod" ? "GPU pod" : "painter · API"}</span>
          {m.moderation === "openai" ? <span className="st-chip st-chip--mono">OpenAI moderation</span> : <span className="st-chip st-chip--mono">no filter</span>}
        </span>
      </div>
      {m.painters && (m.painters.ready ? <Lamp state="ok" label={`can draw now · ${m.painters.drawers.join(", ")}`} /> : <span className="st-muted">{m.painters.note}</span>)}
      <dl className="st-dl st-model-dl">
        <dt>Settings</dt>
        <dd className="st-num">{describeParams(m.params) || "set by the service"}{m.variants ? <span className="st-muted"> · {Object.entries(m.variants).map(([w, p]) => `${w}: ${describeParams(p)}`).join("; ")}</span> : null}</dd>
        {m.maxRefs ? (<><dt>Pictures</dt><dd>up to {m.maxRefs} per call{m.refStyle === "qwen" ? " · named <image1>…" : ""}</dd></>) : null}
        {m.workflows?.length ? (<><dt>Workflows</dt><dd className="st-num">{m.workflows.join(", ")}</dd></>) : null}
        <dt>Licence</dt>
        <dd>{m.license}{m.commercial === false ? <strong className="st-warn"> · not for commercial use</strong> : null}</dd>
        {m.files?.length ? (<><dt>Files</dt><dd className="st-num st-model-files">{m.files.map((f) => <div key={f.file}>{f.dir}/{f.file} · {f.gb} GB</div>)}<div className="st-muted">{Math.round(gb * 10) / 10} GB, downloaded onto the pod at boot</div></dd></>) : null}
      </dl>
      <p className="st-muted st-model-notes">{m.notes}</p>
      {first && loras.length > 0 && (
        <div className="st-stack st-stack--tight">
          <span className="st-label">LoRAs for {m.family}</span>
          <ul className="st-model-loras">
            {loras.map((l) => (
              <li key={l.id}><span>{l.name}</span> <span className="st-muted st-num">{l.kind} · {describeParams(l.recommended) || "—"}</span></li>
            ))}
          </ul>
        </div>
      )}
      <a className="st-link st-link--ext" href={m.source} target="_blank" rel="noopener noreferrer">{m.source.replace(/^https:\/\//, "")} <OpenOutIcon size={11} /></a>
    </article>
  );
}
