"use client";

import { useEffect, useState } from "react";

import { get } from "./api";
import { Lamp, Section } from "./common";
import { GpuSection } from "./gpu-panel";

type Me = { user: string; via: string; authMode: string; runpodConfigured: boolean; r2Configured: boolean; imageGeneration: string };

/* Machine: the GPU pod and the backends behind every project. */
export function MachinePage() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);
  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Machine</h1>
          <p className="st-subtitle">The RunPod pod that renders every take, what it costs, and the storage behind it. One pod serves all projects.</p>
        </div>
      </div>
      <div className="st-card">
        <GpuSection />
      </div>
      <Section title="Backends">
        <div className="st-card">
          {me ? (
            <dl className="st-kv">
              <dt>Signed in</dt>
              <dd>{me.user} <span className="st-muted">({me.authMode === "dev" ? "dev mode, no auth" : "Cloudflare Access"})</span></dd>
              <dt>RunPod</dt>
              <dd><Lamp state={me.runpodConfigured ? "ok" : "warn"} label={me.runpodConfigured ? "configured" : "missing RUNPOD_* secrets"} /></dd>
              <dt>R2 storage</dt>
              <dd><Lamp state={me.r2Configured ? "ok" : "warn"} label={me.r2Configured ? "configured" : "missing R2_* secrets"} /></dd>
              <dt>Image models</dt>
              <dd><Lamp state="draft" label="off — references and hero frames are uploads (TODO)" /></dd>
            </dl>
          ) : (
            <span className="st-muted">Loading…</span>
          )}
        </div>
      </Section>
    </div>
  );
}
