import { hmacHex, hmacVerify } from "@/auth/hmac";

import { StudioError } from "../errors";
import type { BackendStatus, GenerationBackend } from "./types";

/* RunPod Serverless: POST /run, GET /status/{id}, POST /cancel/{id},
   POST /retry/{id}. Results are kept 30 minutes after completion, so the
   worker writes its outputs to R2 and the status payload only carries URLs. */

export type RunPodOptions = { apiKey: string; endpointId: string; baseUrl?: string; fetch?: typeof fetch };

type RunPodJob = {
  id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | string;
  output?: unknown;
  error?: unknown;
  executionTime?: number;
  delayTime?: number;
};

export class RunPodBackend implements GenerationBackend {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RunPodOptions) {
    this.base = `${(opts.baseUrl ?? "https://api.runpod.ai/v2").replace(/\/$/, "")}/${opts.endpointId}`;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<RunPodJob> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!res.ok) throw new StudioError("backend_error", `RunPod ${method} ${path} failed (${res.status})`, payload);
    return payload as RunPodJob;
  }

  async submit(input: Record<string, unknown>, opts?: { webhook?: string; executionTimeoutMs?: number }): Promise<{ requestId: string }> {
    const job = await this.call("POST", "/run", {
      input,
      ...(opts?.webhook ? { webhook: opts.webhook } : {}),
      ...(opts?.executionTimeoutMs ? { policy: { executionTimeout: opts.executionTimeoutMs } } : {}),
    });
    if (!job.id) throw new StudioError("backend_error", "RunPod did not return a job id", job);
    return { requestId: job.id };
  }

  async status(requestId: string): Promise<BackendStatus> {
    return mapRunPodStatus(await this.call("GET", `/status/${encodeURIComponent(requestId)}`));
  }

  async cancel(requestId: string): Promise<void> {
    await this.call("POST", `/cancel/${encodeURIComponent(requestId)}`);
  }

  async retry(requestId: string): Promise<{ requestId: string }> {
    const job = await this.call("POST", `/retry/${encodeURIComponent(requestId)}`);
    return { requestId: job.id ?? requestId };
  }
}

export function mapRunPodStatus(job: RunPodJob): BackendStatus {
  switch (job.status) {
    case "IN_QUEUE":
      return { state: "queued" };
    case "IN_PROGRESS":
      return { state: "running" };
    case "COMPLETED":
      return { state: "completed", output: asRecord(job.output), executionMs: job.executionTime };
    case "FAILED":
      return { state: "failed", error: errorText(job.error ?? job.output), executionMs: job.executionTime };
    case "CANCELLED":
      return { state: "canceled" };
    case "TIMED_OUT":
      return { state: "timeout" };
    default:
      return { state: "running" };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function errorText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "error" in v && typeof (v as { error: unknown }).error === "string") return (v as { error: string }).error;
  return v ? JSON.stringify(v) : "worker failed";
}

/* ---------- webhook URL signing ---------- */

export async function signHookUrl(publicUrl: string, path: string, secret: string, subject: string): Promise<string> {
  const ts = Date.now();
  const sig = await hmacHex(secret, `${subject}|${ts}`);
  const url = new URL(path, publicUrl);
  url.searchParams.set("id", subject);
  url.searchParams.set("ts", String(ts));
  url.searchParams.set("sig", sig);
  return url.toString();
}

const HOOK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function verifyHookUrl(url: URL, secret: string): Promise<string> {
  const id = url.searchParams.get("id") ?? "";
  const ts = Number(url.searchParams.get("ts") ?? "0");
  const sig = url.searchParams.get("sig") ?? "";
  if (!id || !ts || !sig) throw new StudioError("unauthorized", "hook signature missing");
  if (Math.abs(Date.now() - ts) > HOOK_MAX_AGE_MS) throw new StudioError("unauthorized", "hook signature expired");
  if (!(await hmacVerify(secret, `${id}|${ts}`, sig))) throw new StudioError("unauthorized", "hook signature invalid");
  return id;
}
