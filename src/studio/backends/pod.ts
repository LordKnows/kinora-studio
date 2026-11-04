import { StudioError } from "../errors";
import { mapRunPodStatus } from "./runpod";
import type { BackendStatus, GenerationBackend } from "./types";

/* The studio's own job server inside the pod (workers/h3-runpod/server.py),
   reached through RunPod's HTTP proxy. It speaks the same job shape as the
   serverless API — /run, /status/{id}, /cancel/{id} — so the orchestrator's
   status mapping is shared. A shared token keeps the public proxy private. */

export type PodBackendOptions = { hostUrl: string; token: string; fetch?: typeof fetch; kind?: "video" | "assemble" };

export class PodBackend implements GenerationBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly runPath: string;

  constructor(private readonly opts: PodBackendOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.runPath = opts.kind === "assemble" ? "/assemble" : "/run";
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.hostUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "X-Studio-Token": this.opts.token,
          /* RunPod's proxy sits behind Cloudflare, which answers 403 to clients
             without a browser-like User-Agent (handoff verify script). */
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 CinemaStudio/1.0",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (caught) {
      throw new StudioError("backend_error", `pod unreachable: ${caught instanceof Error ? caught.message : caught}`, { unreachable: true });
    }
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new StudioError("backend_error", `pod not ready (${res.status})`, { unreachable: true });
    }
    if (!res.ok) throw new StudioError("backend_error", `pod ${method} ${path} failed (${res.status})`, payload);
    return payload;
  }

  async health(): Promise<{ ok: boolean; detail?: unknown }> {
    try {
      const payload = (await this.call("GET", "/health")) as { ok?: unknown };
      return { ok: payload?.ok === true, detail: payload };
    } catch (caught) {
      return { ok: false, detail: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  async submit(input: Record<string, unknown>, opts?: { webhook?: string }): Promise<{ requestId: string }> {
    const job = (await this.call("POST", this.runPath, { input, ...(opts?.webhook ? { webhook: opts.webhook } : {}) })) as { id?: string };
    if (!job?.id) throw new StudioError("backend_error", "pod did not return a job id", job);
    return { requestId: job.id };
  }

  async status(requestId: string): Promise<BackendStatus> {
    return mapRunPodStatus((await this.call("GET", `/status/${encodeURIComponent(requestId)}`)) as Parameters<typeof mapRunPodStatus>[0]);
  }

  async cancel(requestId: string): Promise<void> {
    await this.call("POST", `/cancel/${encodeURIComponent(requestId)}`);
  }
}
