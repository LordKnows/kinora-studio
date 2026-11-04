"use client";

import { useCallback, useEffect, useState } from "react";

import directorGuide from "@/mcp/guide";

import { get, post } from "./api";
import { Button, CopyRow, Empty, ErrorBanner, Lamp, Section, Stars, useAction } from "./common";
import { useProjectContext } from "./shell";

type Me = { user: string; via: string; authMode: string; runpodConfigured: boolean; r2Configured: boolean; imagesConfigured: boolean };

export function SettingsPage() {
  const { projectId } = useProjectContext();
  const [me, setMe] = useState<Me | null>(null);
  const [origin, setOrigin] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    void get<Me>("/api/me").then(setMe).catch(() => setMe(null));
  }, []);

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">Settings</h1>
          <p className="st-subtitle">Backends, the MCP connection for your director agent, and the blind evaluation mode.</p>
        </div>
      </div>

      <Section title="Backends">
        <div className="st-card">
          {me ? (
            <dl className="st-kv">
              <dt>Signed in</dt>
              <dd>
                {me.user} <span className="st-muted">({me.authMode === "dev" ? "dev mode, no auth" : "Cloudflare Access"})</span>
              </dd>
              <dt>RunPod H3</dt>
              <dd>
                <Lamp state={me.runpodConfigured ? "approved" : "draft"} label={me.runpodConfigured ? "configured" : "missing RUNPOD_* env"} />
              </dd>
              <dt>R2 storage</dt>
              <dd>
                <Lamp state={me.r2Configured ? "approved" : "draft"} label={me.r2Configured ? "configured" : "missing R2_* env"} />
              </dd>
              <dt>Image models</dt>
              <dd>
                <Lamp state={me.imagesConfigured ? "approved" : "draft"} label={me.imagesConfigured ? "configured" : "missing HF_API_BASE_URL / HF_API_KEY"} />
              </dd>
            </dl>
          ) : (
            <span className="st-muted">Loading…</span>
          )}
        </div>
      </Section>

      <Section title="Connect your director agent (MCP)">
        <div className="st-card st-stack">
          <CopyRow label="MCP endpoint" value={`${origin}/mcp`} />
          <CopyRow label="OAuth metadata" value={`${origin}/.well-known/oauth-authorization-server`} />
          <p className="st-muted">
            <strong>Claude:</strong> Settings → Connectors → Add custom connector, paste the MCP endpoint, sign in on the consent page that opens. <strong>Grok:</strong> grok.com → Connectors → New Connector → Custom, paste the same endpoint and complete the sign-in. Then paste the director guide below into the chat’s project or custom instructions and say “start a new film”.
          </p>
          <div className="st-row">
            <Button size="sm" onClick={() => setShowGuide((s) => !s)}>
              {showGuide ? "Hide director guide" : "Show director guide"}
            </Button>
            <Button size="sm" kind="quiet" onClick={() => void navigator.clipboard.writeText(directorGuide)}>
              Copy guide
            </Button>
          </div>
          {showGuide && <pre className="st-pre">{directorGuide}</pre>}
        </div>
      </Section>

      <Section title="Evaluation mode">
        <EvalPanel projectId={projectId} />
      </Section>
    </div>
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
  if (pair === null) return <Empty title="Nothing to compare" hint="Evaluation needs at least two completed takes of the same shot. Blind pairs are shown in random order." />;
  const complete = winner && Object.values(scores).every((v) => v > 0);
  return (
    <div className="st-card st-stack">
      <ErrorBanner error={vote.error} onDismiss={vote.dismiss} />
      <p className="st-muted">
        Shot intent: <strong style={{ color: "var(--tx)" }}>{pair.intent}</strong> · {count} votes this session
      </p>
      <div className="st-eval">
        {(["a", "b"] as const).map((side) => (
          <div key={side} className="st-stack st-stack--tight">
            <video className="st-video" src={pair[side].url} controls preload="metadata" />
            <Button kind={winner === side ? "primary" : "default"} onClick={() => setWinner(side)}>
              {side.toUpperCase()} is better
            </Button>
          </div>
        ))}
      </div>
      <div className="st-row">
        <Button kind={winner === "tie" ? "primary" : "quiet"} size="sm" onClick={() => setWinner("tie")}>
          Tie
        </Button>
      </div>
      <dl className="st-kv">
        {(["consistency", "action", "camera", "audio"] as const).map((k) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ alignSelf: "center" }}>{k}</dt>
            <dd>
              <Stars value={scores[k] || undefined} onChange={(n) => setScores({ ...scores, [k]: n })} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="st-row st-row--between">
        <Button kind="quiet" size="sm" onClick={() => void next()}>
          Skip pair
        </Button>
        <Button kind="primary" busy={vote.busy} disabled={!complete} onClick={() => void vote.fire()}>
          Submit vote
        </Button>
      </div>
    </div>
  );
}
