import type { TakeProgress } from "../types";

export type BackendStatus =
  | { state: "queued" }
  | { state: "running"; progress?: TakeProgress }
  | { state: "completed"; output: Record<string, unknown>; executionMs?: number }
  | { state: "failed"; error: string; executionMs?: number }
  | { state: "canceled" }
  | { state: "timeout" };

/** The seam between the orchestrator and whoever renders: RunPod for video
    and assembly, Higgsfield for stills. */
export interface GenerationBackend {
  submit(input: Record<string, unknown>, opts?: { webhook?: string; executionTimeoutMs?: number }): Promise<{ requestId: string }>;
  status(requestId: string): Promise<BackendStatus>;
  cancel(requestId: string): Promise<void>;
  retry?(requestId: string): Promise<{ requestId: string }>;
}
