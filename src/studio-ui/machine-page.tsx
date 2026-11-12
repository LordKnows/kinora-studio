"use client";

import { useEffect, useState } from "react";

import { get } from "./api";
import { Lamp, Section } from "./common";
import { GpuSection } from "./gpu-panel";
import { useT } from "./i18n";
import { PaintersPanel, RemakeModels } from "./painters-panel";

type Me = { user: string; via: string; authMode: string; runpodConfigured: boolean; r2Configured: boolean; imageGeneration: string };

/* Machine: the GPU pod and the backends behind every project. */
export function MachinePage() {
  const t = useT();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    void get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);
  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Machine")}</h1>
          <p className="st-subtitle">{t("The RunPod pod that renders every take, the painters that draw the pictures before it starts, what it costs, and the storage behind it.")}</p>
        </div>
      </div>
      <div className="st-card">
        <GpuSection />
      </div>
      <Section title={t("Pictures (painters, off the GPU)")}>
        <PaintersPanel />
      </Section>
      <Section title={t("Remake models (on the pod)")}>
        <RemakeModels />
      </Section>
      <Section title={t("Backends")}>
        <div className="st-card">
          {me ? (
            <dl className="st-kv">
              <dt>{t("Signed in")}</dt>
              <dd>{me.user} <span className="st-muted">({me.authMode === "dev" ? t("dev mode, no auth") : "Cloudflare Access"})</span></dd>
              <dt>RunPod</dt>
              <dd><Lamp state={me.runpodConfigured ? "ok" : "warn"} label={me.runpodConfigured ? t("configured") : t("missing RUNPOD_* secrets")} /></dd>
              <dt>{t("R2 storage")}</dt>
              <dd><Lamp state={me.r2Configured ? "ok" : "warn"} label={me.r2Configured ? t("configured") : t("missing R2_* secrets")} /></dd>
              <dt>{t("Image models")}</dt>
              <dd><Lamp state="ok" label={t("GPT Image and Qwen-Image 3.0 Pro on the painters, MiniMax H3 Image on the GPU pod; each project picks its model on its Settings page")} /></dd>
            </dl>
          ) : (
            <span className="st-muted">{t("Loading…")}</span>
          )}
        </div>
      </Section>
    </div>
  );
}
