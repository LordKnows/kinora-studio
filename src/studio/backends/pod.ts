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

  /** ok only when the job server answers AND it can reach ComfyUI; `why`
      says which half is still missing so the pod card can show it. */
  async health(): Promise<{ ok: boolean; why?: string; detail?: unknown }> {
    try {
      const payload = (await this.call("GET", "/health")) as { ok?: unknown; comfy?: { reachable?: unknown; status?: unknown; error?: unknown } };
      if (payload?.ok !== true) return { ok: false, why: "job server answered without ok", detail: payload };
      const comfy = payload.comfy;
      if (comfy && comfy.reachable === false) return { ok: false, why: `job server up; ComfyUI not answering yet${comfy.error ? ` (${String(comfy.error).slice(0, 120)})` : comfy.status ? ` (HTTP ${comfy.status})` : ""}`, detail: payload };
      return { ok: true, detail: payload };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const status = /\((\d{3})\)/.exec(message)?.[1];
      const why = status === "401" ? "job server up but it rejects STUDIO_WORKER_TOKEN: the pod's token differs from the Worker secret"
        : status === "502" || status === "503" || status === "504" ? `nothing listening on the job-server port yet (proxy ${status}); the boot script is still running or failed — see the container log`
        : message;
      return { ok: false, why, detail: message };
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
